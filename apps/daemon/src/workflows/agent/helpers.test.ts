// Unit tests of the agent block's pure helpers: prompts, the failure classifier, the watcher's
// answers, the output text, the create body and the account preview.

import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadActivityItem, ThreadItem, ThreadMessageItem, ThreadSnapshotPayload, Turn } from "@orquester/api/agent-chat";
import { activityLine, failureAfterBaseline, isNewTurn, itemsAfterBaseline, takeBaseline, type AgentBaseline } from "./classify.ts";
import { buildCreateBody, MAX_TITLE_CHARS, renderSessionTitle, sessionTitle } from "./create.ts";
import { finalText, parentAssistantText } from "./executor.ts";
import { excludedKeys, resetWaitUntil, emptyMemory } from "./failover.ts";
import { clipUtf8, clipUtf8Tail } from "./prompt.ts";

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

function snap(items: ThreadItem[], turns: Turn[], adapter: ThreadSnapshotPayload["head"]["adapter"] = "claude"): ThreadSnapshotPayload {
  return {
    head: {
      id: "s1", projectPath: "/w/ws/app", cwd: "/w/ws/app", title: "t", adapter, refId: adapter, accountId: "", home: "system",
      modelSelection: { model: "m" }, runtimeMode: "full-access", session: { status: "ready", activeTurnId: null }, turnCount: turns.length, seq: 1, createdAt: T(0), updatedAt: T(0)
    },
    items, turns, checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: 1
  };
}

test("UTF-8 clipping never splits a code point; the tail keeps the newest part", () => {
  assert.deepEqual(clipUtf8("héllo", 2), { text: "h", truncated: true });
  assert.deepEqual(clipUtf8("abc", 3), { text: "abc", truncated: false });
  assert.deepEqual(clipUtf8Tail("abc€", 3), { text: "€", truncated: true });
});

test("failures are read structurally, only after the baseline, with the legacy prefix only for reason-less rows", () => {
  const old = act("i1", "runtime.error", { message: "x", reason: "usage_limit" });
  const warning = act("i2", "runtime.warning", { message: "parked", reason: "usage_limit", resetsAt: "2026-09-28T15:00:00Z" }, { tone: "info" });
  const baseline: AgentBaseline = { turn: { turnId: null, completedAt: null, running: false }, lastItemId: "i1", at: T(1) };
  const hit = failureAfterBaseline(snap([old, warning], []), baseline);
  assert.equal(hit?.reason, "usage_limit");
  assert.equal(hit?.resetsAt, "2026-09-28T15:00:00.000Z");
  assert.equal(failureAfterBaseline(snap([old], []), baseline), null, "a row before the baseline is not this block's");
  const legacy = act("i3", "runtime.error", { message: "Claude usage limit reached. Try later." });
  assert.equal(failureAfterBaseline(snap([old, legacy], []), baseline)?.legacy, true);
  const textOnly = act("i4", "runtime.error", { message: "Claude usage limit reached.", reason: "something-new" });
  assert.equal(failureAfterBaseline(snap([old, textOnly], []), baseline), null, "a reason the reader does not know is never second-guessed by its text");
  const other = act("i5", "runtime.error", { message: "boom" });
  assert.equal(failureAfterBaseline(snap([old, other], []), baseline), null);
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

test("the output is the latest settled turn's parent answer: commentary only when it is all, agents' words never, re-emitted Claude copies dropped", () => {
  const items: ThreadItem[] = [
    msg("m1", "I'll look", { turnId: "t2", messageKind: "commentary" }),
    msg("m2", "sub words", { turnId: "t2", agentId: "sub" }),
    msg("m3", "{\"ok\":true}", { turnId: "t2" })
  ];
  assert.equal(finalText(snap(items, [turn("t1"), turn("t2")], "codex"), null).text, "{\"ok\":true}");
  assert.equal(finalText(snap([msg("c", "only narration", { turnId: "t2", messageKind: "commentary" })], [turn("t2")], "codex"), null).text, "only narration");
  // A Claude turn whose opening answer was written a second time at its end (an old host's log).
  const copies: ThreadItem[] = [msg("x1", "Summary.", { turnId: "t3" }), msg("x2", "Details.", { turnId: "t3" }), msg("x3", "Summary.", { turnId: "t3" })];
  assert.equal(finalText(snap(copies, [turn("t3")], "claude"), null).text, "Summary.\n\nDetails.");
  // Never a turn from before the block (continue mode).
  assert.equal(finalText(snap([msg("p", "previous block", { turnId: "t1" })], [turn("t1"), turn("t2")], "claude"), "t1").text, "");
  // A running turn is not read; the newest settled one with text is.
  assert.equal(finalText(snap([msg("a", "done", { turnId: "t1" })], [turn("t1"), turn("t2", "running")], "claude"), null).text, "done");
});

test("the output text is capped at 2 MiB", () => {
  const big = "é".repeat(1_200_000);
  const out = finalText(snap([msg("m", big, { turnId: "t1" })], [turn("t1")], "codex"), null);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(out.text) <= 2 * 1024 * 1024);
});

test("the handoff reads the parent's words since the block began in the session", () => {
  const items: ThreadItem[] = [msg("a", "before", { turnId: "t1" }), msg("b", "mine", { turnId: "t2" }), msg("c", "sub", { turnId: "t2", agentId: "x" }), msg("d", "more", { turnId: "t3" })];
  assert.equal(parentAssistantText(snap(items, []), "t1"), "mine\n\nmore");
  assert.equal(parentAssistantText(snap(items, []), null), "before\n\nmine\n\nmore");
});

test("the create body: explicit account, full access, owner; the model only in the chat selection", () => {
  const owner = { kind: "workflow" as const, workflowId: "w", runId: "r", nodeId: "n" };
  const codex = buildCreateBody({ candidate: { chainIndex: 0, agent: "codex", model: "gpt-5-codex", options: [], accountId: "system", family: "codex" }, projectPath: "/w/ws/app", title: "T", owner });
  assert.equal(codex.refId, "codex");
  assert.equal(codex.accountId, "system", "system is explicit, never omitted");
  assert.equal(codex.chat?.accountId, "system");
  assert.equal(codex.chat?.runtimeMode, "full-access");
  assert.deepEqual(codex.owner, owner);
  const claude = buildCreateBody({ candidate: { chainIndex: 0, agent: "claude", model: "opus", options: [{ id: "effort", value: "high" }], accountId: "a1", family: "claude" }, projectPath: "/p", title: "T", owner });
  assert.equal("model" in claude, false);
  assert.deepEqual(claude.chat?.modelSelection, { model: "opus", options: [{ id: "effort", value: "high" }] });
});

test("exclusions: tried accounts only while their cooldown runs; unusable ones for good", () => {
  const memory = emptyMemory();
  memory.tried["claude:a1"] = T(10);
  memory.tried["claude:a2"] = T(1);
  memory.unusable.push("codex:c1");
  assert.deepEqual([...excludedKeys(memory, new Date(T(5)))].sort(), ["claude:a1", "codex:c1"]);
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
  assert.equal(activityLine(snap([stderr, error], [turn("t1", "running")])), "Working", "only noise: the turn's state");
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
  assert.equal(sessionTitle("Nightly", "Build", renderSessionTitle("{{ trigger.input.missing }}", ctx)), "Nightly · Build", "an empty render falls back");
  assert.equal(sessionTitle("W", "B", "x".repeat(400)).length, MAX_TITLE_CHARS);
  assert.equal(sessionTitle("W", "B", `${"x".repeat(MAX_TITLE_CHARS - 2)}😀😀`), `${"x".repeat(MAX_TITLE_CHARS - 2)}…`, "a cut never splits a pair");
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
  assert.equal(renderSessionTitle("{{ trigger }}", ctx), "a [31mred b 2Jc evil d e f g");
  assert.equal(renderSessionTitle("\u202E\u200B\u0007", ctx), undefined, "nothing printable left → the default");
  assert.equal(sessionTitle("Nightly", "Build", renderSessionTitle("\u001b\u009b", ctx)), "Nightly · Build");
});
