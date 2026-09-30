// Baseline, text-boundary and wait-budget contracts used by the agent block.

import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadActivityItem, ThreadItem, ThreadMessageItem, ThreadSnapshotPayload, Turn } from "@orquester/api/agent-chat";
import { activityLine, failureAfterBaseline, isNewTurn, itemsAfterBaseline, takeBaseline, type AgentBaseline } from "./classify.ts";
import { renderSessionTitle } from "./create.ts";
import type { AgentBlockOutput } from "./executor.ts";
import { account, agentNode, testWorkflow } from "./testing/fake-context.ts";
import { byAccount } from "./testing/fake-chat-host.ts";
import { Scenario } from "./testing/scenario.ts";
import { resetWaitUntil } from "./failover.ts";

const T = (s: number): string => new Date(Date.UTC(2026, 8, 28, 12, 0, s)).toISOString();

function msg(id: string, text: string, over: Partial<ThreadMessageItem> = {}): ThreadMessageItem {
  return { kind: "message", id, role: "assistant", text, turnId: "t1", streaming: false, createdAt: T(1), updatedAt: T(1), ...over };
}

function act(id: string, activityKind: string, payload: unknown, over: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  return { kind: "activity", id, tone: "error", activityKind, summary: activityKind, payload, turnId: "t1", createdAt: T(2), updatedAt: T(2), ...over };
}

function turn(turnId: string, state: Turn["state"] = "completed"): Turn {
  return { turnId, state, turnCount: 1, requestedAt: T(0), startedAt: T(0), completedAt: state === "running" ? null : T(5), assistantMessageId: null };
}

function snap(items: ThreadItem[], turns: Turn[]): ThreadSnapshotPayload {
  return {
    head: {
      id: "s1", projectPath: "/w/ws/app", cwd: "/w/ws/app", title: "t", adapter: "claude", refId: "claude", accountId: "", home: "system",
      modelSelection: { model: "m" }, runtimeMode: "full-access", session: { status: "ready", activeTurnId: null }, turnCount: turns.length, seq: 1, createdAt: T(0), updatedAt: T(0)
    },
    items, turns, checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: 1
  };
}

test("only failures after this block's baseline count", () => {
  const old = act("i1", "runtime.error", { message: "x", reason: "usage_limit" });
  const warning = act("i2", "runtime.warning", { message: "parked", reason: "usage_limit", resetsAt: "2026-09-28T15:00:00Z" }, { tone: "info" });
  const baseline: AgentBaseline = { turn: { turnId: null, completedAt: null, running: false }, lastItemId: "i1", at: T(1) };
  assert.equal(failureAfterBaseline(snap([old], []), baseline), null);
  assert.equal(failureAfterBaseline(snap([old, warning], []), baseline)?.resetsAt, "2026-09-28T15:00:00.000Z");
});

test("a baseline row that left the window falls back to the time cut", () => {
  const baseline: AgentBaseline = { turn: { turnId: null, completedAt: null, running: false }, lastItemId: "gone", at: T(1) };
  const rows = itemsAfterBaseline([msg("m1", "a", { createdAt: T(1) }), msg("m2", "b", { createdAt: T(3) })], baseline);
  assert.deepEqual(rows.map((r) => r.id), ["m2"]);
});

test("the baseline takes the thread's latest turn over a lagging summary", () => {
  const s = snap([], [turn("t5", "completed")]);
  const base = takeBaseline({ latestTurn: { turnId: "t5", state: "running", startedAt: T(0), completedAt: null } } as never, s, new Date(T(9)));
  assert.deepEqual(base.turn, { turnId: "t5", completedAt: T(5), running: false });
  assert.equal(isNewTurn({ turnId: "t5", state: "completed", startedAt: T(0), completedAt: T(5) }, base.turn), false, "the lagging summary catching up is no new turn");
  assert.equal(isNewTurn({ turnId: "t6", state: "running", startedAt: T(6), completedAt: null }, base.turn), true);
});

test("the output text is capped at 2 MiB", async () => {
  const sc = new Scenario({ accounts: [account("claude", "a1")], behaviour: () => [{ kind: "say", text: "x" + "é".repeat(1_200_000) }] });
  const { result } = await sc.run(testWorkflow([agentNode("n1")]), "n1");
  assert.equal(result.status, "succeeded");
  const out = (result as { output: AgentBlockOutput }).output;
  assert.equal(out.textTruncated, true);
  assert.equal(Buffer.byteLength(out.text), 2 * 1024 * 1024 - 1);
  assert.doesNotMatch(out.text, /�/);
});

test("the handoff reads the parent's words since the block began in the session", async () => {
  const sc = new Scenario({ accounts: [account("claude", "a1"), account("codex", "c1")], behaviour: () => [{ kind: "say", text: "earlier block" }] });
  const policy = { strategy: "fixed" as const, includeSystem: false, soonestResetWindow: "weekly" as const, leastUsedMetric: "max" as const, unknownUsage: "last" as const };
  const wf = testWorkflow([
    agentNode("first", { chain: [{ agent: "claude", model: "opus", accounts: policy }, { agent: "codex", model: "gpt-5", accounts: policy }] }, "Writer"),
    agentNode("next", { session: { kind: "continue", fromNode: "Writer" } })
  ]);
  const first = (await sc.run(wf, "first")).result;
  assert.equal(first.status, "succeeded");
  sc.host.behaviour = byAccount({ a1: [{ kind: "say", text: "current work" }, { kind: "say", text: "subagent text", agentId: "sub" }, { kind: "limit" }], c1: [{ kind: "say", text: "finished" }] });
  const next = (await sc.run(wf, "next", { upstream: { Writer: (first as { output: AgentBlockOutput }).output } })).result;
  assert.equal(next.status, "succeeded");
  const handoff = sc.host.turnLog.find((turn) => turn.refId === "codex")!.input;
  assert.ok(handoff.includes("current work"));
  assert.doesNotMatch(handoff, /earlier block|subagent text/);
});

test("wait-for-reset honours maxWaitHours from the first wait", () => {
  const now = new Date(T(0));
  const decision = { chosen: null, reason: "", skipped: [], earliestResetAt: new Date(now.getTime() + 3 * 3600_000).toISOString() };
  assert.equal(resetWaitUntil(decision, { now, firstWaitAt: now, maxWaitHours: 4 })?.toISOString(), decision.earliestResetAt);
  assert.equal(resetWaitUntil(decision, { now, firstWaitAt: new Date(now.getTime() - 2 * 3600_000), maxWaitHours: 4 }), null);
  assert.equal(resetWaitUntil({ chosen: null, reason: "", skipped: [] }, { now, firstWaitAt: now, maxWaitHours: 4 }), null);
});

test("the activity line reads tool calls and assistant text, never a provider's stderr or warnings", () => {
  const stderr = act("w1", "runtime.warning", { message: "Linux sandbox uses bubblewrap…" }, { summary: "Linux sandbox uses bubblewrap…", tone: "info" });
  const error = act("e1", "runtime.error", { message: "boom" }, { summary: "stderr: boom" });
  const output = act("o1", "tool.output", { delta: "raw bytes" }, { summary: "raw bytes", tone: "tool" });
  const tool = act("c1", "tool.started", {}, { summary: "Run npm test", tone: "tool" });
  assert.equal(activityLine(snap([msg("m1", "Looking at the tests\nmore"), tool, output, stderr, error], [turn("t1", "running")])), "Run npm test");
  assert.equal(activityLine(snap([msg("m1", "Looking at the tests\nmore"), stderr], [turn("t1", "running")])), "Looking at the tests");
  assert.equal(activityLine(snap([stderr], [turn("t1", "completed")])), undefined);
});

test("a chat title renders its {{…}} like the prompt, but never a secret's value", () => {
  const ctx = {
    expressionContext: () => ({
      input: null,
      nodes: { Plan: { output: { text: "Ship\n  the fix" }, status: "succeeded" } },
      trigger: { kind: "manual", input: { ticket: "ABC-1" } },
      run: { id: "r1", startedAt: T(0), workflowId: "w1", workflowName: "Nightly", attempt: 1 },
      project: { path: "/w/ws/app", name: "app", workspace: "ws", branch: "main" }
    }),
    secrets: { TOKEN: "s3cr3t-value", PIN: "12" }
  } as unknown as Parameters<typeof renderSessionTitle>[1];
  assert.equal(renderSessionTitle("Fix {{ trigger.input.ticket }} on {{ project.branch }}", ctx), "Fix ABC-1 on main");
  assert.equal(renderSessionTitle("{{ nodes.Plan.output.text }}", ctx), "Ship the fix", "whitespace runs become one space");
  // A secret reference renders as its placeholder, even one too short for the redactor.
  assert.equal(renderSessionTitle("key {{ secrets.TOKEN }} / {{ secrets.PIN }}", ctx), "key «secret:TOKEN» / «secret:PIN»");
  // A value that carries a secret in from elsewhere is redacted.
  const leaky = { ...ctx, expressionContext: () => ({ ...ctx.expressionContext(), trigger: { kind: "manual", input: "s3cr3t-value" } }) } as typeof ctx;
  assert.equal(renderSessionTitle("got {{ trigger.input }}", leaky), "got «secret:TOKEN»");
  // Plain text passes through; nothing set, blank, or a render that throws → the default.
  assert.equal(renderSessionTitle("Nightly review", ctx), "Nightly review");
  assert.equal(renderSessionTitle(undefined, ctx), undefined);
  assert.equal(renderSessionTitle("   ", ctx), undefined);
  const broken = { ...ctx, expressionContext: () => { throw new Error("boom"); } } as typeof ctx;
  assert.equal(renderSessionTitle("{{ trigger.input }}", broken), undefined);
});

test("a chat title never shows a secret the render escaped, transformed or nested", () => {
  const PW = 'p@ss"w\\rd';
  const PEM = "-----BEGIN KEY-----\nabcd\nefgh\n-----END KEY-----";
  const base = {
    input: null,
    run: { id: "r1", startedAt: T(0), workflowId: "w1", workflowName: "Nightly", attempt: 1 },
    project: { path: "/w/ws/app", name: "app", workspace: "ws" }
  };
  const ctx = {
    expressionContext: () => ({
      ...base,
      trigger: { pw: PW, key: PEM, [PW]: "as a key" },
      nodes: { Fetch: { output: { deep: { list: [{ token: PW }, `x${PEM}y`] } }, status: "succeeded" } }
    }),
    secrets: { PW, PEM }
  } as unknown as Parameters<typeof renderSessionTitle>[1];
  const leaks = (title: string | undefined): boolean =>
    title === undefined || [PW, PEM, JSON.stringify(PW).slice(1, -1), JSON.stringify(PEM).slice(1, -1), "p@ss", "abcd"].some((part) => title.includes(part));
  for (const template of [
    "{{ trigger }}",
    "{{ trigger.pw | json }}",
    "{{ trigger.key | json }}",
    "{{ trigger.key }}",
    "{{ trigger.pw | upper }}",
    "{{ trigger | compact }}",
    "{{ nodes.Fetch.output }}",
    "{{ nodes.Fetch.output.deep.list | json }}",
    "{{ nodes }}"
  ]) {
    const title = renderSessionTitle(template, ctx);
    assert.ok(!leaks(title), `${template} → ${title}`);
    assert.match(title!, /«secret:(PW|PEM)»/i, template);
  }
  assert.equal(renderSessionTitle("{{ trigger.pw | json }}", ctx), '"«secret:PW»"');
  assert.equal(renderSessionTitle("{{ trigger.key }}", ctx), "«secret:PEM»", "a multi-line key is one placeholder");
  assert.equal(renderSessionTitle("{{ trigger.pw | upper }}", ctx), "«SECRET:PW»");
  // Text the flattening turns into a secret is redacted too.
  const spaced = { expressionContext: () => ({ ...base, trigger: "open\tsesame", nodes: {} }), secrets: { WORD: "open sesame" } } as unknown as typeof ctx;
  assert.equal(renderSessionTitle("{{ trigger }}", spaced), "«secret:WORD»");
});

test("a chat title drops control and format characters", () => {
  const ctx = {
    expressionContext: () => ({
      input: null,
      nodes: {},
      trigger: "a\u001b[31mred\u0007b\u009b2Jc\u202Eevil\u200Bd\u2066e\uFEFFf\r\ng",
      run: { id: "r1", startedAt: T(0), workflowId: "w1", workflowName: "Nightly", attempt: 1 },
      project: { path: "/w/ws/app", name: "app", workspace: "ws" }
    }),
    secrets: {}
  } as unknown as Parameters<typeof renderSessionTitle>[1];
  const title = renderSessionTitle("{{ trigger }}", ctx);
  assert.ok(title);
  assert.doesNotMatch(title, /[\p{Cc}\p{Cf}]/u);
  assert.match(title, /red.*evil/);
  assert.equal(renderSessionTitle("\u202E\u200B\u0007", ctx), undefined, "nothing printable left → the default");
});
