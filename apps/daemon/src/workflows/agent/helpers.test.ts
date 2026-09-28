// Unit tests of the agent block's pure helpers: prompts, the failure classifier, the watcher's
// answers, the output text, the create body and the account preview.

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAccount, UsageResponse } from "@orquester/api";
import type { ThreadActivityItem, ThreadItem, ThreadMessageItem, ThreadSnapshotPayload, Turn } from "@orquester/api/agent-chat";
import { activityLine, failureAfterBaseline, isNewTurn, itemsAfterBaseline, takeBaseline, type AgentBaseline } from "./classify.ts";
import { buildCreateBody, sessionTitle } from "./create.ts";
import { finalText, parentAssistantText } from "./executor.ts";
import { excludedKeys, resetWaitUntil, emptyMemory } from "./failover.ts";
import { createAccountPreview } from "./preview.ts";
import { AUTONOMY_NOTE, buildHandoffPrompt, clipUtf8, clipUtf8Tail, handoffNotice, withAutonomyNote } from "./prompt.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { account, MemoryCooldowns, staticUsage } from "./testing/fake-context.ts";
import { AUTONOMOUS_ANSWER } from "./prompt.ts";
import { autonomousAnswers, autonomousDecision } from "./watch.ts";

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

test("the autonomy note is appended exactly as the spec words it", () => {
  assert.equal(AUTONOMY_NOTE, "You are running unattended inside an automated workflow. No human will answer. Never ask questions or wait for confirmation; make reasonable decisions and complete the task fully.");
  assert.equal(withAutonomyNote("Do X.", true), `Do X.\n\n${AUTONOMY_NOTE}`);
  assert.equal(withAutonomyNote("Do X.", false), "Do X.");
});

test("UTF-8 clipping never splits a code point; the tail keeps the newest part", () => {
  assert.deepEqual(clipUtf8("héllo", 2), { text: "h", truncated: true });
  assert.deepEqual(clipUtf8("abc", 3), { text: "abc", truncated: false });
  assert.deepEqual(clipUtf8Tail("abc€", 3), { text: "€", truncated: true });
});

test("the handoff prompt: original prompt, notice, messages, git status, autonomy note", () => {
  const text = buildHandoffPrompt({ originalPrompt: "Fix #7.", previousAgent: "claude", previousMessages: "did A", gitStatus: " M a.ts\n", autonomyNote: true });
  assert.ok(text.startsWith(`Fix #7.\n\n${handoffNotice("claude")}`));
  assert.match(text, /did A/);
  assert.match(text, / M a\.ts/);
  assert.ok(text.endsWith(AUTONOMY_NOTE));
  const noGit = buildHandoffPrompt({ originalPrompt: "P", previousAgent: "codex", previousMessages: "", gitStatus: null, autonomyNote: false });
  assert.equal(noGit, `P\n\n${handoffNotice("codex")}`);
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

test("autonomous answers and decisions", () => {
  const answers = autonomousAnswers({
    requestId: "r", createdAt: T(0), dismissible: false,
    questions: [
      { id: "a", header: "", question: "", options: [], allowCustomAnswer: false },
      { id: "b", header: "", question: "", options: [{ label: "One", description: "" }, { label: "Two (recommended)", description: "" }] },
      { id: "c", header: "", question: "", options: [{ label: "One", description: "", value: "1" }], multiSelect: true }
    ]
  });
  assert.deepEqual(answers, { a: AUTONOMOUS_ANSWER, b: "Two (recommended)", c: ["1"] });
  assert.equal(autonomousDecision({ requestId: "r", requestKind: "command", createdAt: T(0) }), "accept");
  assert.equal(autonomousDecision({ requestId: "r", requestKind: "command", createdAt: T(0), options: [{ decision: "acceptForSession", label: "" }, { decision: "decline", label: "" }] }), "acceptForSession");
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

test("the create body: explicit account, full access, owner; a top-level model for claudex only", () => {
  const owner = { kind: "workflow" as const, workflowId: "w", runId: "r", nodeId: "n" };
  const claudex = buildCreateBody({ candidate: { chainIndex: 0, agent: "claudex", model: "gpt-5-codex", options: [], accountId: "system", family: "codex" }, projectPath: "/w/ws/app", title: "T", owner });
  assert.equal(claudex.model, "gpt-5-codex");
  assert.equal(claudex.accountId, "system", "system is explicit, never omitted");
  assert.equal(claudex.chat?.accountId, "system");
  assert.equal(claudex.chat?.runtimeMode, "full-access");
  const claudemix = buildCreateBody({ candidate: { chainIndex: 0, agent: "claudemix", model: "opus", options: [{ id: "effort", value: "high" }], accountId: "a1", family: "claude" }, projectPath: "/p", title: "T", owner });
  assert.equal("model" in claudemix, false);
  assert.deepEqual(claudemix.chat?.modelSelection, { model: "opus", options: [{ id: "effort", value: "high" }] });
  assert.equal(sessionTitle("WF", "Fix"), "WF · Fix");
  assert.equal(sessionTitle("WF", "Fix", "  Custom "), "Custom");
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

test("the account preview decides as the block does (the owner's example), cooldowns included", async () => {
  const clock = new FakeClock("2026-09-28T12:00:00.000Z");
  const at = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();
  const DAY = 86_400_000;
  const accounts: AgentAccount[] = [account("claude", "a-jasper", "jasperclaude"), account("claude", "a-eduard", "therealeduard465"), account("claude", "a-ara", "arakuma")];
  const usage: UsageResponse = {
    agents: [{
      id: "claude", available: true, stale: false, session: null, weekly: null, asOf: at(-60_000),
      aggregate: { strategy: "worst-account", accountCount: 3 },
      accounts: [
        { id: "a-jasper", label: "jasperclaude", available: true, stale: false, session: null, weekly: { percent: 63, resetsAt: at(4 * DAY) }, asOf: at(-60_000) },
        { id: "a-eduard", label: "therealeduard465", available: true, stale: false, session: null, weekly: { percent: 90, resetsAt: at(DAY) }, asOf: at(-60_000) },
        { id: "a-ara", label: "arakuma", available: true, stale: false, session: null, weekly: { percent: 16, resetsAt: at(5 * DAY) }, asOf: at(-60_000) }
      ]
    }]
  };
  const cooldowns = new MemoryCooldowns(clock);
  const preview = createAccountPreview({ usage: staticUsage(usage), accounts: { list: () => ({ accounts, defaults: { claude: null, codex: null, grok: null } }), seededAccountIds: () => new Set() }, cooldowns, clock });
  const chain = [{ agent: "claude", model: "opus", accounts: { strategy: "soonest-reset", maxWeeklyPct: 85 } }] as never;
  const first = await preview(chain);
  assert.equal(first.chosen?.accountLabel, "jasperclaude");
  assert.ok(first.skipped.some((s) => s.label === "therealeduard465" && s.why === "threshold"));
  await cooldowns.set("claude", "a-jasper", { until: at(3600_000), reason: "usage_limit", setAt: at(0) });
  const second = await preview(chain);
  assert.equal(second.chosen?.accountLabel, "arakuma");
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
