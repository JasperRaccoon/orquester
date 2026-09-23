import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanImplementationPrompt, type ThreadItem } from "@orquester/api/agent-chat";
import { activity, message, snapshot, stamp, turn } from "./fixtures.ts";
import { TRANSCRIPT_HINT_BYTES, transcriptEntries, type TranscriptResult } from "./transcript.ts";

const ALL = new Set(["reasoning", "tools", "activity"] as const);
/** A result's size as `maxChars` counts it: the whole result's JSON, in UTF-8 bytes (what ok() caps). */
const budgetSize = (r: TranscriptResult): number => Buffer.byteLength(JSON.stringify(r), "utf8");
/** What a result must fit in: a truncated one leaves the caller room for its hint. */
const room = (r: TranscriptResult, maxChars: number): number => (r.truncated ? maxChars - TRANSCRIPT_HINT_BYTES : maxChars);
/** The result with the kept head of its only row's text one code point longer: over budget when the cut is exact. */
const oneMore = (r: TranscriptResult, whole: string): TranscriptResult => {
  const head = [...r.entries[0]!.text!.slice(0, -1)]; // drop the "…"
  return { ...r, entries: [{ ...r.entries[0]!, text: `${[...whole].slice(0, head.length + 1).join("")}…` }] };
};

function twoTurns() {
  const items = [
      message("user", "hello", { turnId: "t1" }), message("reasoning", "thinking…", { turnId: "t1" }), message("assistant", "hi", { turnId: "t1" }),
      message("user", "edit it", { turnId: "t2", attachments: [{ type: "image", id: "a1", name: "shot.png", mimeType: "image/png", sizeBytes: 10 }] }),
      activity("tool.started", { itemType: "command_execution", toolUseId: "tu1", title: "Run pnpm check", command: "pnpm check", status: "inProgress" }, { turnId: "t2", tone: "tool" }),
      activity("tool.updated", { itemType: "command_execution", toolUseId: "tu1", detail: "…" }, { turnId: "t2", tone: "tool" }),
      activity("tool.completed", { itemType: "command_execution", toolUseId: "tu1", title: "Run pnpm check", status: "completed", detail: "ok\n", changedFiles: ["src/a.ts"] }, { turnId: "t2", tone: "tool" }),
      activity("task.started", { taskId: "task-1", title: "Explore", status: "running" }, { turnId: "t2" }),
      message("assistant", "sub says", { turnId: "t2", agentId: "task-1" }),
      activity("tool.started", { itemType: "command_execution", toolUseId: "tu-sub", title: "ls", status: "inProgress" }, { turnId: "t2", tone: "tool", agentId: "task-1" }),
      activity("task.completed", { taskId: "task-1", title: "Explore", status: "completed" }, { turnId: "t2" }),
      activity("approval.requested", { requestId: "r1", requestKind: "command", detail: "rm x" }, { turnId: "t2", tone: "approval" }),
      activity("approval.resolved", { requestId: "r1", decision: "accept" }, { turnId: "t2", tone: "approval" }),
      activity("user-input.requested", { requestId: "q1", questions: [{ id: "a", header: "A", question: "Pick?", options: [] }] }, { turnId: "t2" }),
      activity("turn.proposed.completed", { planId: "p1", planMarkdown: "# plan" }, { turnId: "t2" }),
      activity("context-compaction", { state: "compacted", beforeTokens: 100, afterTokens: 10 }, { turnId: "t2" }),
      activity("runtime.warning", { detail: "careful" }, { turnId: "t2", summary: "History not available" }),
      activity("provider.turn.start.failed", { detail: "Attachment rejected" }, { turnId: "t2", tone: "error", summary: "Turn failed" }),
      message("assistant", "done", { turnId: "t2" })
  ];
  // The fixture stamps are a module-wide counter, so anchor the checkpoint to the
  // error row's stamp: a stable sort then places "changes" after it and before "done".
  const changesAt = items[items.length - 2]!.createdAt;
  return snapshot({
    turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: items[3]!.createdAt, startedAt: items[3]!.createdAt, completedAt: items[items.length - 1]!.createdAt })],
    checkpoints: [{ turnId: "t2", checkpointTurnCount: 2, checkpointRef: "refs/x", status: "ready", files: [{ path: "src/a.ts", additions: 3, deletions: 1 }], assistantMessageId: null, completedAt: changesAt }],
    items,
    roster: [{ id: "task-1", kind: "subagent", agentKind: "agent", title: "Explore", status: "completed" } as never]
  });
}

test("parent view: every kind, tools folded per toolUseId, subagent rows as anchors, ordered by time", () => {
  const r = transcriptEntries(twoTurns(), { turns: 5, include: ALL, maxChars: 100_000 });
  assert.equal(r.turnCount, 2); assert.deepEqual(r.coveredTurns, [1, 2]); assert.equal(r.truncated, false);
  assert.deepEqual(r.entries.map((e) => e.kind), ["user", "reasoning", "assistant", "user", "tool", "subagent", "approval", "question", "plan", "compaction", "warning", "error", "changes", "assistant"]);
  const tool = r.entries.find((e) => e.kind === "tool")!;
  assert.deepEqual(tool.tool, { type: "command_execution", title: "Run pnpm check", status: "completed", command: "pnpm check", detail: "ok\n", changedFiles: ["src/a.ts"] });
  assert.equal(tool.createdAt, r.entries[4].createdAt);
  assert.deepEqual(r.entries.find((e) => e.kind === "subagent")!.subagent, { id: "task-1", title: "Explore", status: "completed" });
  const approval = r.entries.find((e) => e.kind === "approval")!;
  assert.equal(approval.requestId, "r1"); assert.equal(approval.decision, "accept"); assert.equal(approval.requestKind, "command");
  const question = r.entries.find((e) => e.kind === "question")!;
  assert.deepEqual(question.questions, ["Pick?"]); assert.equal(question.answered, false);
  assert.deepEqual(r.entries.find((e) => e.kind === "changes")!.files, [{ path: "src/a.ts", additions: 3, deletions: 1 }]);
  assert.deepEqual(r.entries.find((e) => e.kind === "user" && e.turn === 2)!.attachments, [{ name: "shot.png", type: "image" }]);
  assert.equal(r.entries.find((e) => e.kind === "error")!.text, "Turn failed: Attachment rejected");
  assert.ok(!r.entries.some((e) => e.agentId), "subagent-owned rows stay out of the parent view");
  assert.deepEqual(r.subagents, [{ id: "task-1", title: "Explore", status: "completed" }]);
});

test("drill-in view shows only that agent's rows; reasoning and tools are opt-in", () => {
  const sub = transcriptEntries(twoTurns(), { turns: 5, agentId: "task-1", include: ALL, maxChars: 100_000 });
  assert.deepEqual(sub.entries.map((e) => [e.kind, e.agentId]), [["assistant", "task-1"], ["tool", "task-1"]]);
  assert.deepEqual(sub.subagents, []);
  const lean = transcriptEntries(twoTurns(), { turns: 5, include: new Set(), maxChars: 100_000 });
  assert.deepEqual(lean.entries.map((e) => e.kind), ["user", "assistant", "user", "subagent", "plan", "changes", "assistant"]);
});

test("turns selects the last N turns; shedding drops reasoning, then tool detail, then the oldest turn", () => {
  const last = transcriptEntries(twoTurns(), { turns: 1, include: ALL, maxChars: 100_000 });
  assert.deepEqual(last.coveredTurns, [2, 2]); assert.ok(last.entries.every((e) => e.turn === 2), "only the last turn");
  const big = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(10), startedAt: stamp(10), completedAt: stamp(20) })],
    items: [message("user", "a".repeat(3000), { turnId: "t1" }), message("reasoning", "r".repeat(3000), { turnId: "t1" }), message("assistant", "b".repeat(3000), { turnId: "t1" }),
      activity("tool.completed", { itemType: "command_execution", toolUseId: "x", title: "t", status: "completed", detail: "d".repeat(3000) }, { turnId: "t2", tone: "tool" }), message("assistant", "c".repeat(3000), { turnId: "t2" })] });
  const shed1 = transcriptEntries(big, { turns: 5, include: ALL, maxChars: 12_000 });
  assert.equal(shed1.truncated, true); assert.ok(!shed1.entries.some((e) => e.kind === "reasoning"), "reasoning shed first");
  assert.ok(shed1.entries.find((e) => e.kind === "tool")!.tool!.detail!.length <= 200, "tool detail shed second");
  const shed2 = transcriptEntries(big, { turns: 5, include: ALL, maxChars: 4_000 });
  assert.deepEqual(shed2.coveredTurns, [2, 2]); assert.equal(shed2.truncated, true);
});

test("an agent's anchor stamped with its own agentId stays in the parent view, a stamped background shell's does not; the roster decides title and status", () => {
  const snap = snapshot({
    items: [
      message("user", "fan out", { turnId: "t1" }),
      activity("task.started", { taskId: "agent-7", title: "worker", agentKind: "agent", agentId: "agent-7" }, { turnId: "t1", agentId: "agent-7" }),
      message("assistant", "sub text", { turnId: "t1", agentId: "agent-7" }),
      activity("task.completed", { taskId: "agent-7", status: "stopped", agentKind: "agent", agentId: "agent-7" }, { turnId: "t1", agentId: "agent-7" }),
      activity("task.started", { taskId: "shell-1", title: "npm test", agentKind: "background" }, { turnId: "t1" }),
      activity("task.completed", { taskId: "shell-1", status: "stopped" }, { turnId: "t1" }),
      // Grok stamps its background shells with their own id too; the GUI keeps no parent row for them.
      activity("task.started", { taskId: "grok-sh", title: "sleep 5", agentKind: "background", agentId: "grok-sh" }, { turnId: "t1", agentId: "grok-sh" })
    ],
    // agent-7 was resumed after it stopped and runs again; shell-1 has aged out of the roster.
    roster: [{ id: "agent-7", kind: "subagent", agentKind: "agent", title: "worker", status: "running" } as never,
      { id: "grok-sh", kind: "subagent", agentKind: "background", title: "sleep 5", status: "running" } as never]
  });
  const r = transcriptEntries(snap, { turns: 5, include: new Set(), maxChars: 100_000 });
  assert.deepEqual(r.entries.map((e) => e.kind), ["user", "subagent", "subagent"]);
  assert.ok(!r.entries.some((e) => "agentId" in e), "an anchor names its agent in subagent.id, not as an owner stamp");
  assert.deepEqual(r.entries.filter((e) => e.kind === "subagent").map((e) => e.subagent), [
    { id: "agent-7", title: "worker", status: "running" },
    { id: "shell-1", title: "npm test", status: "interrupted" }
  ]);
  assert.deepEqual(r.subagents, [{ id: "agent-7", title: "worker", status: "running" }, { id: "grok-sh", title: "sleep 5", status: "running" }]);
  const sub = transcriptEntries(snap, { turns: 5, agentId: "agent-7", include: new Set(), maxChars: 100_000 });
  assert.deepEqual(sub.entries.map((e) => [e.kind, e.agentId]), [["assistant", "agent-7"]]);
});

test("a plan is actionable while it is the latest one and no later message implements it", () => {
  const plan = (id: string) => activity("turn.proposed.completed", { planId: id, planMarkdown: `# ${id}` }, { turnId: "t1" });
  const plans = (items: ThreadItem[]) =>
    transcriptEntries(snapshot({ items }), { turns: 5, include: new Set(), maxChars: 100_000 }).entries.filter((e) => e.kind === "plan").map((e) => [e.text, e.actionable]);
  const proposed = [message("user", "plan it", { turnId: "t1" }), plan("p1"), plan("p2")];
  assert.deepEqual(plans(proposed), [["# p1", false], ["# p2", true]]);
  assert.deepEqual(plans([...proposed, message("user", buildPlanImplementationPrompt("# p2"), { turnId: "t1" })]), [["# p1", false], ["# p2", false]]);
});

test("an error or warning without a detail reads the payload's message, where runtime.error keeps its text", () => {
  // Ingestion labels a warning with its own message cut to 120 characters (truncateDetail).
  const long = `The provider's history for this conversation could not be read: ${"the transcript file was rotated away. ".repeat(3)}`;
  const snap = snapshot({ items: [
    activity("runtime.error", { message: "Provider process exited (code 1)", class: "provider_error" }, { turnId: "t1", tone: "error", summary: "Runtime error" }),
    activity("runtime.warning", { message: "History not available" }, { turnId: "t1", summary: "History not available" }),
    activity("runtime.warning", { message: long }, { turnId: "t1", summary: `${long.slice(0, 117)}...` })
  ] });
  const r = transcriptEntries(snap, { turns: 5, include: new Set(["activity"]), maxChars: 100_000 });
  assert.deepEqual(r.entries.map((e) => [e.kind, e.text]), [["error", "Runtime error: Provider process exited (code 1)"], ["warning", "History not available"], ["warning", long]]);
});

test("a turn's opening message, written with the idle session's null turnId, is numbered through Turn.userMessageId", () => {
  const items = [message("user", "first", { turnId: null, id: "user:1" }), message("assistant", "one", { turnId: "t1" }),
    message("user", "second", { turnId: null, id: "user:2" }), message("assistant", "two", { turnId: "t2" })];
  const snap = snapshot({ items, turns: [turn({ turnId: "t1", requestedAt: items[0]!.createdAt, userMessageId: "user:1" }),
    turn({ turnId: "t2", turnCount: 2, requestedAt: items[2]!.createdAt, startedAt: items[2]!.createdAt, completedAt: items[3]!.createdAt, userMessageId: "user:2" })] });
  const all = transcriptEntries(snap, { turns: 5, include: new Set(), maxChars: 100_000 });
  assert.deepEqual(all.entries.map((e) => [e.text, e.turn, e.turnId]), [["first", 1, "t1"], ["one", 1, "t1"], ["second", 2, "t2"], ["two", 2, "t2"]]);
  const last = transcriptEntries(snap, { turns: 1, include: new Set(), maxChars: 100_000 });
  assert.deepEqual(last.entries.map((e) => [e.text, e.turn, e.turnId]), [["second", 2, "t2"], ["two", 2, "t2"]]);
});

test("a turn the host never started stays visible: alone, and before the first turn that did start", () => {
  const failed = (summary: string) => activity("provider.turn.start.failed", { detail: "Attachment rejected" }, { turnId: null, tone: "error", summary });
  const never = transcriptEntries(snapshot({ turns: [], items: [message("user", "hi", { turnId: null }), failed("Turn failed")] }), { turns: 5, include: ALL, maxChars: 100_000 });
  assert.deepEqual(never.entries.map((e) => [e.kind, e.turn]), [["user", null], ["error", null]]);
  assert.equal(never.turnCount, 0); assert.equal(never.coveredTurns, null);
  const items = [message("user", "hi", { turnId: null }), failed("Turn failed"), message("user", "again", { turnId: null }), message("assistant", "ok", { turnId: "t1" })];
  const retried = snapshot({ items, turns: [turn({ turnId: "t1", requestedAt: items[2]!.createdAt, startedAt: items[2]!.createdAt, userMessageId: items[2]!.id })] });
  assert.deepEqual(transcriptEntries(retried, { turns: 5, include: ALL, maxChars: 100_000 }).entries.map((e) => [e.kind, e.turn]), [["user", null], ["error", null], ["user", 1], ["assistant", 1]]);
});

test("maxChars is a hard budget: an oversized newest turn sheds its oldest rows and keeps its final reply", () => {
  // Built in order: the fixture stamps are a module-wide counter.
  const items: ThreadItem[] = [message("user", "do it all", { turnId: "t1" })];
  for (let i = 0; i < 300; i += 1) items.push(activity("tool.completed", { itemType: "command_execution", toolUseId: `tu${i}`, title: `Run step ${i}`, status: "completed", command: `pnpm run step-${i} ${"--flag ".repeat(40)}`, detail: "ok" }, { turnId: "t1", tone: "tool" }));
  items.push(message("assistant", "all 300 steps done", { turnId: "t1" }));
  const busy = snapshot({ items });
  const r = transcriptEntries(busy, { turns: 5, include: ALL, maxChars: 40_000 });
  assert.ok(budgetSize(r) <= room(r, 40_000), "within the budget"); assert.equal(r.truncated, true);
  assert.deepEqual([r.entries.at(-1)!.kind, r.entries.at(-1)!.text], ["assistant", "all 300 steps done"]);
  assert.equal(r.entries.at(-2)!.tool!.title, "Run step 299", "the newest rows are kept");
  assert.ok(!r.entries.some((e) => e.kind === "user"), "the oldest rows go first");
  // A final reply that alone is over the budget keeps its head.
  const report = snapshot({ items: [message("user", "report", { turnId: "t1" }), message("assistant", "z".repeat(10_000), { turnId: "t1" })] });
  const capped = transcriptEntries(report, { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(budgetSize(capped) <= room(capped, 2_000), "within the budget"); assert.equal(capped.truncated, true);
  assert.deepEqual(capped.entries.map((e) => e.kind), ["assistant"]);
  assert.match(capped.entries[0]!.text!, /^z{1000,}…$/u);
});

test("at maxChars 2 000 a final reply whose JSON outgrows its code points survives, cut to fill the budget exactly", () => {
  // Each line costs more in JSON than in code points (the quotes and the newline escape): a cut counted in code
  // points under-fills, and at this budget it dropped the reply altogether.
  const reply = 'say "hi"\n'.repeat(1_000);
  const r = transcriptEntries(snapshot({ items: [message("user", "report", { turnId: "t1" }), message("assistant", reply, { turnId: "t1" })] }), { turns: 5, include: ALL, maxChars: 2_000 });
  assert.equal(r.truncated, true);
  assert.deepEqual(r.entries.map((e) => e.kind), ["assistant"], "the final reply survives");
  const text = r.entries[0]!.text!;
  assert.ok(text.endsWith("…") && reply.startsWith(text.slice(0, -1)), "the head of the reply, marked as cut");
  assert.ok(budgetSize(r) <= room(r, 2_000), "within the budget");
  assert.ok(budgetSize(oneMore(r, reply)) > room(r, 2_000), "one code point more would not fit: the cut is exact");
});

test("maxChars counts UTF-8 bytes: a CJK reply is cut to what fits in bytes, never through a character", () => {
  const reply = "漢字かな😀".repeat(2_000); // 3 bytes a character, 4 for the emoji (a surrogate pair)
  const r = transcriptEntries(snapshot({ items: [message("user", "report", { turnId: "t1" }), message("assistant", reply, { turnId: "t1" })] }), { turns: 5, include: ALL, maxChars: 2_000 });
  assert.deepEqual(r.entries.map((e) => e.kind), ["assistant"]); assert.equal(r.truncated, true);
  const head = r.entries[0]!.text!.slice(0, -1);
  assert.ok(reply.startsWith(head) && Buffer.from(head, "utf8").toString("utf8") === head, "a head of whole characters");
  assert.ok(budgetSize(r) <= room(r, 2_000), "within the budget, in bytes");
  assert.ok(budgetSize(oneMore(r, reply)) > room(r, 2_000), "one code point more would not fit: the cut is exact");
});

/** A roster row as the host folds it, with the fields the transcript reads; the roster lists rows first seen first. */
const agent = (i: number, title: string, status = "completed") => ({ id: `task-${i}`, kind: "subagent", agentKind: "agent", title, status, firstSeenAt: stamp(i) }) as never;
const oneTurn = (reply = "Done: every package is surveyed.") => [message("user", "Survey the packages, one subagent each.", { turnId: "t1" }), message("assistant", reply, { turnId: "t1" })];

test("a roster over the budget is trimmed, oldest settled rows first, before any row of the latest turn", () => {
  // The reviewer's case: 30 subagents (3.4 KB), one short turn, maxChars 2 000 — the entries used to come back empty.
  const roster = Array.from({ length: 30 }, (_, i) => agent(i, `Survey package ${i}: list its exports, callers and test coverage`));
  const snap = snapshot({ items: oneTurn(), roster });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 100_000 });
  assert.ok(Buffer.byteLength(JSON.stringify(whole.subagents)) > 3_000, "the roster alone is over the budget");
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(budgetSize(r) <= 2_000 - TRANSCRIPT_HINT_BYTES, `within the budget, the hint's room kept (${budgetSize(r)})`);
  assert.deepEqual(r.entries, whole.entries, "both rows of the only turn, untouched");
  assert.deepEqual([r.coveredTurns, r.truncated, r.subagentsTruncated], [[1, 1], true, true]);
  const kept = r.subagents.map((s) => s.id);
  assert.ok(kept.length > 0 && kept.length < 30, `some rows kept (${kept.length})`);
  assert.deepEqual(kept, whole.subagents.slice(30 - kept.length).map((s) => s.id), "the oldest rows went first");
  assert.equal(whole.subagentsTruncated, undefined, "an untrimmed roster carries no flag");
});

test("100 long-titled subagents at 55 000: titles capped at 200 code points, every live row kept, the oldest settled ones dropped", () => {
  const long = "調査して報告する".repeat(125); // 1 000 code points, 3 bytes each
  const live = (i: number): boolean => i % 10 === 3;
  const roster = Array.from({ length: 100 }, (_, i) => agent(i, `${i}: ${long}`, live(i) ? "running" : "completed"));
  const r = transcriptEntries(snapshot({ items: oneTurn(), roster }), { turns: 5, include: ALL, maxChars: 55_000 });
  assert.ok(budgetSize(r) <= 55_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`);
  assert.deepEqual(r.entries.map((e) => e.kind), ["user", "assistant"], "the turn's rows are all there");
  assert.ok(r.subagents.every((s) => [...s.title!].length === 200 && s.title!.endsWith("…")), "every title cut to 200 code points, the cut marked");
  assert.equal(r.subagentsTruncated, true);
  const kept = r.subagents.map((s) => Number(s.id.slice(5)));
  const all = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(kept.filter(live), all.filter(live), "every running agent kept");
  const settled = all.filter((i) => !live(i));
  assert.deepEqual(kept.filter((i) => !live(i)), settled.slice(settled.length - kept.filter((i) => !live(i)).length), "the newest settled rows kept");
  assert.ok(kept.length < 100, "some settled rows dropped");
});

test("live subagents outlast the reply's tail, and go last — oldest first — only when not even a head of the reply fits", () => {
  const reply = "The survey is done. ".repeat(500);
  const title = (i: number): string => `Agent ${i} ${"still auditing the dependency graph ".repeat(6)}`;
  const few = transcriptEntries(snapshot({ items: oneTurn(reply), roster: [agent(0, title(0)), agent(1, title(1), "running"), agent(2, title(2), "waiting"), agent(3, title(3), "pending")] }), { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(budgetSize(few) <= 2_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(few)})`);
  assert.deepEqual(few.subagents.map((s) => s.id), ["task-1", "task-2", "task-3"], "the settled row went, the live ones stayed");
  assert.deepEqual(few.entries.map((e) => e.kind), ["assistant"]); assert.match(few.entries[0]!.text!, /^The survey is done\. .+…$/su, "the reply cut around them");
  const many = transcriptEntries(snapshot({ items: oneTurn(reply), roster: Array.from({ length: 12 }, (_, i) => agent(i, title(i), "running")) }), { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(budgetSize(many) <= 2_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(many)})`);
  assert.deepEqual(many.entries.map((e) => e.kind), ["assistant"], "a head of the reply survives");
  const kept = many.subagents.map((s) => s.id);
  assert.ok(kept.length > 0 && kept.length < 12, `some live rows kept (${kept.length})`);
  assert.deepEqual(kept, Array.from({ length: 12 }, (_, i) => `task-${i}`).slice(12 - kept.length), "the oldest live rows went first");
  assert.equal(many.subagentsTruncated, true);
});

test("coveredTurns names only turns with rows present: null when the window shows none", () => {
  // A drill-in on an agent that worked only in the first turn, reading the last one.
  const items = [message("user", "one", { turnId: "t1" }), message("assistant", "sub", { turnId: "t1", agentId: "task-1" }), message("user", "two", { turnId: "t2" })];
  const snap = snapshot({ items, turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: items[2]!.createdAt, startedAt: items[2]!.createdAt, completedAt: items[2]!.createdAt })] });
  const r = transcriptEntries(snap, { turns: 1, agentId: "task-1", include: ALL, maxChars: 100_000 });
  assert.deepEqual([r.entries, r.coveredTurns, r.turnCount], [[], null, 2]);
});

test("when the newest row cannot fit even alone, an older row of the latest turn is kept rather than none", () => {
  // No reply yet, and the newest row is a tool call whose command alone is over the budget: nothing in it to cut.
  const items = [message("user", "Write the fixture file.", { turnId: "t1" }),
    activity("tool.started", { itemType: "command_execution", toolUseId: "big", title: "Write fixture", command: `cat > fixture.json <<'EOF'\n${'{"k": 1},\n'.repeat(400)}EOF`, status: "inProgress" }, { turnId: "t1", tone: "tool" })];
  const r = transcriptEntries(snapshot({ items }), { turns: 5, include: ALL, maxChars: 2_000 });
  assert.deepEqual(r.entries.map((e) => [e.kind, e.text]), [["user", "Write the fixture file."]]);
  assert.ok(budgetSize(r) <= 2_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`); assert.deepEqual(r.coveredTurns, [1, 1]);
});

test("a randomized probe (fixed seed): every result fits, keeps the latest turn, sheds in order and says what it covers", () => {
  let seed = 0x5eedb1;
  const rand = (): number => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  // No "…" in the alphabet: a text ending in one was cut.
  const text = (max: number): string => pick(["a", "é", "漢", "😀", '"', "\n", "word "]).repeat(int(1, max));
  const statuses = ["running", "waiting", "pending", "idle", "completed", "failed", "interrupted"];
  const isLive = (status: string): boolean => ["running", "waiting", "pending"].includes(status);
  for (let run = 0; run < 120; run += 1) {
    const turnCount = int(1, 5);
    const items: ThreadItem[] = [];
    const turns = [];
    for (let t = 1; t <= turnCount; t += 1) {
      const turnId = `t${t}`;
      const opening = message("user", text(3_000), { turnId });
      items.push(opening);
      if (rand() < 0.5) items.push(message("reasoning", text(4_000), { turnId }));
      for (let k = int(0, 6); k > 0; k -= 1) items.push(activity("tool.completed", { itemType: "command_execution", toolUseId: `${turnId}-${k}`, title: text(60), command: text(200), status: "completed", detail: text(3_000) }, { turnId, tone: "tool" }));
      if (rand() < 0.8) items.push(message("assistant", text(20_000), { turnId }));
      turns.push(turn({ turnId, turnCount: t, requestedAt: opening.createdAt, startedAt: opening.createdAt, completedAt: items.at(-1)!.createdAt }));
    }
    const roster = Array.from({ length: int(0, 100) }, (_, i) => agent(i, text(400), pick(statuses))) as unknown as { id: string; status: string }[];
    const maxChars = int(2_000, 55_000);
    const window = int(1, 5);
    const snap = snapshot({ items, turns, roster: roster as never });
    const r = transcriptEntries(snap, { turns: window, include: ALL, maxChars });
    const where = `run ${run}: ${turnCount} turns, ${roster.length} agents, maxChars ${maxChars}`;
    assert.ok(budgetSize(r) <= room(r, maxChars), `${where}: ${budgetSize(r)} bytes`);
    if (!r.truncated) assert.deepEqual(r, transcriptEntries(snap, { turns: window, include: ALL, maxChars: Number.MAX_SAFE_INTEGER }), `${where}: nothing shed when it fits`);
    assert.ok(r.entries.some((e) => e.turn === turnCount), `${where}: the latest turn keeps a row`);
    assert.ok(r.coveredTurns !== null && r.coveredTurns[1] === turnCount && r.entries.every((e) => e.turn === null || e.turn >= r.coveredTurns![0]), `${where}: coveredTurns ${JSON.stringify(r.coveredTurns)}`);
    assert.equal(r.subagentsTruncated === true, r.subagents.length < roster.length, `${where}: subagentsTruncated`);
    assert.ok(r.subagents.every((s) => [...(s.title ?? "")].length <= 200), `${where}: titles capped`);
    // Shed order in the roster: settled rows oldest first, live ones only after every settled row, oldest first.
    const kept = new Set(r.subagents.map((s) => s.id));
    const keptOf = (live: boolean) => roster.filter((a) => isLive(a.status) === live).map((a) => kept.has(a.id));
    for (const flags of [keptOf(false), keptOf(true)]) assert.ok(flags.every((k, i) => !k || flags.slice(i).every(Boolean)), `${where}: rows dropped oldest first`);
    if (keptOf(true).includes(false)) assert.ok(!keptOf(false).includes(true), `${where}: a live row went before a settled one`);
    // The roster's settled rows go before any row of the latest turn is cut.
    if (keptOf(false).includes(true)) assert.ok(r.entries.every((e) => !e.text?.endsWith("…")), `${where}: a text was cut while settled subagent rows remained`);
  }
});
