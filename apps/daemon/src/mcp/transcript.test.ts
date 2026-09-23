import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanImplementationPrompt, commandOutputText, slimActivityPayload, type ThreadItem, type Turn } from "@orquester/api/agent-chat";
import { activity, message, snapshot, stamp, turn } from "./fixtures.ts";
import { mergeHistoryPages } from "./history.ts";
import { cutTail, fitEntries, fitRoster, jsonTextBytes, ROSTER_SHARE, TRANSCRIPT_HINT_BYTES, transcriptEntries, transcriptRange, type TranscriptEntry, type TranscriptResult } from "./transcript.ts";

const ALL = new Set(["reasoning", "tools", "activity"] as const);
/** A result's size as `maxChars` counts it: the whole result's JSON, in UTF-8 bytes (what ok() caps). */
const budgetSize = (r: TranscriptResult): number => Buffer.byteLength(JSON.stringify(r), "utf8");
/** What a result must fit in: a truncated one leaves the caller room for its hint. */
const room = (r: TranscriptResult, maxChars: number): number => (r.truncated ? maxChars - TRANSCRIPT_HINT_BYTES : maxChars);
/** The ruling's room: maxChars less the widest frame (both lists empty, every flag set) and the hint's room. */
const roomOf = (r: TranscriptResult, maxChars: number): number => maxChars - TRANSCRIPT_HINT_BYTES - frameOf(r, true);
/** A list's size inside the result: its JSON less the brackets. */
const contentOf = (rows: readonly unknown[]): number => Buffer.byteLength(JSON.stringify(rows), "utf8") - 2;
/** The subagent list's cap once a result is over: what the unshed entries (`e` bytes) leave, never less than its share. */
const rosterCap = (room: number, e: number): number => Math.max(Math.floor(room * ROSTER_SHARE), room - e);
/** The row a shed never drops: the latest turn's final reply (never a commentary row), else that turn's newest row. */
const sparedOf = (entries: readonly TranscriptEntry[]): TranscriptEntry | undefined => {
  const turns = entries.flatMap((e) => (e.turn === null ? [] : [e.turn]));
  const own = entries.filter((e) => e.turn === (turns.length ? Math.max(...turns) : null));
  return [...own].reverse().find((e) => e.kind === "assistant" && !e.commentary) ?? own.at(-1);
};
const hasRow = (r: TranscriptResult, row: TranscriptEntry): boolean => r.entries.some((e) => e.createdAt === row.createdAt && e.kind === row.kind);
/** The roster row a second pass would bring back next: the last one dropped (live rows drop last, the newest last). */
const nextBack = (all: TranscriptResult["subagents"], kept: TranscriptResult["subagents"]): TranscriptResult["subagents"][number] | undefined => {
  const ids = new Set(kept.map((s) => s.id));
  const live = (s: { status: string }): boolean => ["running", "waiting", "pending"].includes(s.status);
  return [...all.filter((s) => !live(s)), ...all.filter(live)].filter((s) => !ids.has(s.id)).at(-1);
};
/** Rows as the fits take them: each with its JSON bytes and a comma, measured once. */
const sizedOf = <T>(rows: readonly T[]): { row: T; bytes: number }[] => rows.map((row) => ({ row, bytes: Buffer.byteLength(JSON.stringify(row), "utf8") + 1 }));
/**
 * The frame the entries are fitted in: both lists empty, the widest coveredTurns and olderTurns (neither is known before
 * the shed), truncated, the roster flag as given — and the result's own unavailableTurns.
 */
function frameOf(r: TranscriptResult, subagentsTruncated: boolean): number {
  return Buffer.byteLength(JSON.stringify({ entries: [], turnCount: r.turnCount, olderTurns: r.turnCount, coveredTurns: r.turnCount ? [r.turnCount, r.turnCount] : null,
    ...(r.unavailableTurns ? { unavailableTurns: r.unavailableTurns } : {}), truncated: true, subagents: [], ...(subagentsTruncated ? { subagentsTruncated } : {}) }), "utf8");
}
/** The biggest row of a list, as it sits in the result: its JSON and a comma. */
const maxRowOf = (rows: readonly unknown[]): number => Math.max(0, ...rows.map((row) => contentOf([row]) + 1));
/** An instant just after the last item: where a checkpoint that closes the turn sorts. */
const after = (items: readonly ThreadItem[]): string => new Date(Date.parse(items.at(-1)!.createdAt) + 500).toISOString();
const checkpoint = (files: { path: string; additions: number; deletions: number }[], completedAt: string, turnId = "t1") =>
  ({ turnId, checkpointTurnCount: 1, checkpointRef: `refs/${turnId}`, status: "ready", files, assistantMessageId: null, completedAt });
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
  // A command's detail is the one the GUI's row shows: trimmed.
  assert.deepEqual(tool.tool, { type: "command_execution", title: "Run pnpm check", status: "completed", command: "pnpm check", detail: "ok", changedFiles: ["src/a.ts"] });
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

test("a result that fits maxChars comes back whole — byte-identical, no flags — even inside the hint's reserve", () => {
  // The case that made the ruling: a 39 900-byte transcript at the default 40 000, trimmed for a hint it did not need.
  const roster = Array.from({ length: 5 }, (_, i) => agent(i, `Survey package ${i}: list its exports`, i % 2 ? "running" : "completed"));
  const at = (reply: string) => snapshot({ items: oneTurn(reply), roster });
  const base = budgetSize(transcriptEntries(at(""), { turns: 5, include: ALL, maxChars: 1_000_000 }));
  const snap = at("x".repeat(39_900 - base));
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 1_000_000 });
  assert.equal(budgetSize(whole), 39_900, "a 39 900-byte transcript");
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 40_000 });
  assert.equal(JSON.stringify(r), JSON.stringify(whole), "byte-identical to the unbudgeted projection");
  assert.equal(r.truncated, false, "not truncated"); assert.equal("subagentsTruncated" in r, false, "no roster flag");
});

test("the boundary: a result of exactly maxChars bytes is whole; one byte more is trimmed to maxChars − TRANSCRIPT_HINT_BYTES", () => {
  const snap = snapshot({ items: oneTurn("y".repeat(5_000)), roster: [agent(0, "Survey package 0"), agent(1, "Survey package 1", "running")] });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 1_000_000 });
  const size = budgetSize(whole);
  const exact = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: size });
  assert.equal(JSON.stringify(exact), JSON.stringify(whole), `exactly ${size} bytes at maxChars ${size}: whole`);
  assert.equal(exact.truncated, false, "not truncated");
  const over = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: size - 1 });
  assert.equal(over.truncated, true, `${size} bytes at maxChars ${size - 1}: trimmed`);
  assert.ok(budgetSize(over) <= size - 1 - TRANSCRIPT_HINT_BYTES, `to ${size - 1 - TRANSCRIPT_HINT_BYTES} bytes at most, before the hint (${budgetSize(over)})`);
});

test("30 running agents beside one short turn: the user row and the reply come back whole, the roster takes the rest", () => {
  const roster = Array.from({ length: 30 }, (_, i) => agent(i, `Survey package ${i}: list its exports, callers and test coverage`, "running"));
  const snap = snapshot({ items: oneTurn(), roster });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 100_000 });
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(budgetSize(r) <= 2_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`);
  assert.deepEqual(r.entries, whole.entries, "both rows whole");
  const kept = r.subagents.map((s) => s.id);
  assert.ok(kept.length > 0 && kept.length < 30, `some running rows kept (${kept.length})`); assert.equal(r.subagentsTruncated, true);
  assert.deepEqual(kept, whole.subagents.slice(30 - kept.length).map((s) => s.id), "the oldest running rows went first");
  assert.ok(contentOf(r.subagents) <= rosterCap(roomOf(r, 2_000), contentOf(whole.entries)), "within the roster's cap");
  const space = roomOf(r, 2_000) - contentOf(whole.entries);
  assert.ok(contentOf(r.subagents) > space - maxRowOf(whole.subagents), `the roster fills to within one row of room − E (${contentOf(r.subagents)} of ${space})`);
});

test("demo (a): 8 running agents beside a turn still at work — its newest row stays, the roster is trimmed", () => {
  // The reviewer's shape: ~1 KB, the newest row the biggest — round 1 kept all 8 agents and dropped it.
  const flags = Array.from({ length: 14 }, (_, i) => `--set image.tag=2026.09.${i} `).join("");
  const items = [message("user", "Deploy the release to staging and tell me once every pod reports healthy.", { turnId: "t1" }),
    activity("tool.completed", { itemType: "command_execution", toolUseId: "pull", title: "git pull", command: "git pull --rebase origin main", status: "completed", detail: "Already up to date." }, { turnId: "t1", tone: "tool" }),
    activity("tool.started", { itemType: "command_execution", toolUseId: "apply", title: "kubectl apply", command: `kubectl apply -f deploy/staging/ --prune -l app=api,tier=backend --server-side ${flags}`, status: "inProgress" }, { turnId: "t1", tone: "tool" })];
  const roster = Array.from({ length: 8 }, (_, i) => agent(i, `Watch rollout ${i}: poll the pods of service ${i} until every replica reports ready`, "running"));
  const snap = snapshot({ items, roster });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 100_000 });
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(budgetSize(r) <= 2_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`);
  assert.ok(hasRow(r, whole.entries.at(-1)!), "the newest row — kubectl apply, in progress — stays");
  assert.deepEqual(r.entries, whole.entries, `the whole turn (${contentOf(whole.entries)} B) fits once the roster yields`);
  assert.ok(r.subagents.length < 8, "the roster is trimmed"); assert.equal(r.subagentsTruncated, true);
});

/** One turn: the user's message and `tools` completed tool rows after it, no reply yet. */
function busyTurn(tools: number): ThreadItem[] {
  const items: ThreadItem[] = [message("user", "Roll the release out and report back.", { turnId: "t1" })];
  for (let i = 0; i < tools; i += 1) items.push(activity("tool.completed", { itemType: "command_execution", toolUseId: `tu${i}`, title: `Step ${i}`, command: `kubectl rollout status deploy/svc-${i}`, status: "completed", detail: "ok ".repeat(100) }, { turnId: "t1", tone: "tool" }));
  return items;
}

test("demo (b): 200 rows and 40 running agents at 10 000 — the latest turn's newest rows stay, the roster keeps to its share", () => {
  const roster = Array.from({ length: 40 }, (_, i) => agent(i, `Agent ${i}: ${"auditing the dependency graph ".repeat(5)}`, "running"));
  const snap = snapshot({ items: busyTurn(199), roster });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 1_000_000 });
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 10_000 });
  assert.ok(budgetSize(r) <= 10_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`);
  assert.ok(hasRow(r, whole.entries.at(-1)!), "the newest row stays");
  assert.deepEqual(r.entries.map((e) => e.createdAt), whole.entries.slice(-r.entries.length).map((e) => e.createdAt), `the latest turn's newest rows (${r.entries.length})`);
  assert.ok(budgetSize(r) > 10_000 - TRANSCRIPT_HINT_BYTES - contentOf([r.entries[0]]) - 1, "filled to within one row of the budget");
  assert.ok(contentOf(r.subagents) <= Math.floor(roomOf(r, 10_000) * ROSTER_SHARE) + maxRowOf(whole.entries), `the roster keeps to its quarter, plus what the entries left unused (${contentOf(r.subagents)} B)`);
  assert.ok(r.subagents.length > 0 && r.subagentsTruncated === true, "and keeps some of it");
});

test("demo (c): 400 rows and 100 running agents with CJK titles at 40 000 — the same shares", () => {
  const roster = Array.from({ length: 100 }, (_, i) => agent(i, `${i}: ${"調査して報告する".repeat(60)}`, "running"));
  const snap = snapshot({ items: busyTurn(399), roster });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 1_000_000 });
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 40_000 });
  assert.ok(budgetSize(r) <= 40_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`);
  assert.ok(hasRow(r, whole.entries.at(-1)!), "the newest row stays");
  assert.deepEqual(r.entries.map((e) => e.createdAt), whole.entries.slice(-r.entries.length).map((e) => e.createdAt), `the latest turn's newest rows (${r.entries.length})`);
  assert.ok(budgetSize(r) > 40_000 - TRANSCRIPT_HINT_BYTES - contentOf([r.entries[0]]) - 1, "filled to within one row of the budget");
  assert.ok(contentOf(r.subagents) <= Math.floor(roomOf(r, 40_000) * ROSTER_SHARE) + maxRowOf(whole.entries), `the roster keeps to its quarter, plus what the entries left unused (${contentOf(r.subagents)} B)`);
  assert.ok(r.subagents.length > 0, "and keeps some of it");
});

test("a long history beside a big settled roster, the transcript needing over ¾ of the room: the roster keeps to its quarter and the oldest turns go", () => {
  const items: ThreadItem[] = [];
  const turns = [];
  for (let t = 1; t <= 6; t += 1) {
    const turnId = `t${t}`;
    const opening = message("user", `Question ${t}: ${"why ".repeat(100)}`, { turnId });
    items.push(opening, message("assistant", `Answer ${t}: ${"because ".repeat(180)}`, { turnId }));
    turns.push(turn({ turnId, turnCount: t, requestedAt: opening.createdAt, startedAt: opening.createdAt, completedAt: items.at(-1)!.createdAt }));
  }
  const roster = Array.from({ length: 60 }, (_, i) => agent(i, `Survey package ${i}: list its exports, callers and test coverage`));
  const snap = snapshot({ items, turns, roster });
  const whole = transcriptEntries(snap, { turns: 10, include: ALL, maxChars: 1_000_000 });
  const r = transcriptEntries(snap, { turns: 10, include: ALL, maxChars: 8_000 });
  const room = roomOf(r, 8_000);
  assert.ok(contentOf(whole.entries) > 0.75 * room, "the transcript needs more than three quarters of the room");
  assert.ok(budgetSize(r) <= 8_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`);
  const quarter = Math.floor(room * ROSTER_SHARE);
  assert.ok(contentOf(r.subagents) <= quarter + maxRowOf(whole.entries), `the roster keeps to its quarter, plus what the entries left unused (${contentOf(r.subagents)} of ${room} B)`);
  assert.ok(contentOf(r.subagents) > quarter - maxRowOf(whole.subagents), `and gets that quarter when it needs it (${contentOf(r.subagents)} of ${quarter})`);
  assert.ok(r.subagents.length > 0, "and keeps some of it");
  assert.ok(r.coveredTurns![0] > 1 && r.coveredTurns![1] === 6, `the oldest turns went (${JSON.stringify(r.coveredTurns)})`);
  assert.ok(hasRow(r, sparedOf(whole.entries)!), "the latest reply stays");
});

test("coveredTurns names only turns with rows present: null when the window shows none", () => {
  // A drill-in on an agent that worked only in the first turn, reading the last one.
  const items = [message("user", "one", { turnId: "t1" }), message("assistant", "sub", { turnId: "t1", agentId: "task-1" }), message("user", "two", { turnId: "t2" })];
  const snap = snapshot({ items, turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: items[2]!.createdAt, startedAt: items[2]!.createdAt, completedAt: items[2]!.createdAt })] });
  const r = transcriptEntries(snap, { turns: 1, agentId: "task-1", include: ALL, maxChars: 100_000 });
  assert.deepEqual([r.entries, r.coveredTurns, r.turnCount], [[], null, 2]);
});

test("a latest turn whose newest row is a tool call with a 16 KB command: that row stays, its command cut to fit", () => {
  const command = `cat > fixture.json <<'EOF'\n${'{"k": 1},\n'.repeat(1_600)}EOF`;
  const items = [message("user", "Write the fixture file.", { turnId: "t1" }),
    activity("tool.started", { itemType: "command_execution", toolUseId: "big", title: "Write fixture", command, status: "inProgress" }, { turnId: "t1", tone: "tool" })];
  const r = transcriptEntries(snapshot({ items }), { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(budgetSize(r) <= 2_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`);
  assert.ok(budgetSize(r) > 2_000 - TRANSCRIPT_HINT_BYTES - 8, `cut to fill it (${budgetSize(r)})`);
  assert.equal(r.truncated, true); assert.deepEqual(r.coveredTurns, [1, 1]);
  const tool = r.entries.find((e) => e.kind === "tool");
  assert.ok(tool, "the newest row stays");
  assert.ok(tool.tool!.command!.endsWith("…") && command.startsWith(tool.tool!.command!.slice(0, -1)), "its command, cut and marked");
  assert.equal(tool.tool!.title, "Write fixture", "its title, shorter, untouched");
});

test("a running turn whose newest row is a 60-file patch: that row stays, its file list capped to a head and a count of the rest", () => {
  // It came back as an 80-byte result with no entries: only strings could be cut.
  const paths = Array.from({ length: 60 }, (_, i) => `packages/ui/src/components/agent-chat/timeline/row-${i}.tsx`);
  const items = [message("user", "Rename the timeline rows.", { turnId: "t1" }),
    activity("tool.started", { itemType: "file_change", toolUseId: "patch", title: "Edit 60 files", status: "inProgress", changedFiles: paths }, { turnId: "t1", tone: "tool" })];
  const r = transcriptEntries(snapshot({ items }), { turns: 5, include: ALL, maxChars: 2_000 });
  const budget = 2_000 - TRANSCRIPT_HINT_BYTES;
  assert.ok(budgetSize(r) <= budget, `within the budget (${budgetSize(r)})`);
  const patch = r.entries.find((e) => e.kind === "tool")?.tool;
  assert.ok(patch?.changedFiles, "the patch row stays");
  const head = patch.changedFiles.slice(0, -1);
  assert.deepEqual(head, paths.slice(0, head.length), `a head of the list (${head.length} paths)`);
  assert.equal(patch.changedFiles.at(-1), `…${60 - head.length} more files`, "then a count of the rest");
  assert.ok(budgetSize(r) > budget - contentOf([paths[head.length]]) - 2, `filled to within one path (${budgetSize(r)} of ${budget})`);
  assert.deepEqual([r.truncated, r.coveredTurns], [true, [1, 1]]);
});

test("a turn whose newest row is a 1 500-file checkpoint: that row stays, its files capped, the rest counted with their line totals", () => {
  // It came back with no entries and 16 181 of 19 680 bytes unused.
  const files = Array.from({ length: 1_500 }, (_, i) => ({ path: `src/generated/schema/table_${i}.ts`, additions: (i % 7) + 1, deletions: i % 3 }));
  const items = [message("user", "Regenerate the schema.", { turnId: "t1" }),
    activity("tool.completed", { itemType: "command_execution", toolUseId: "gen", title: "Generate", command: "pnpm codegen", status: "completed", detail: "done" }, { turnId: "t1", tone: "tool" })];
  const roster = Array.from({ length: 30 }, (_, i) => agent(i, `Survey package ${i}: list its exports, callers and test coverage`));
  const r = transcriptEntries(snapshot({ items, roster, checkpoints: [checkpoint(files, after(items))] as never }), { turns: 5, include: ALL, maxChars: 20_000 });
  const budget = 20_000 - TRANSCRIPT_HINT_BYTES;
  assert.ok(budgetSize(r) <= budget, `within the budget (${budgetSize(r)})`);
  const changes = r.entries.find((e) => e.kind === "changes")?.files;
  assert.ok(changes, "the checkpoint row stays");
  const head = changes.slice(0, -1);
  const rest = files.slice(head.length);
  assert.deepEqual(head, files.slice(0, head.length), `a head of the files (${head.length})`);
  const total = (key: "additions" | "deletions"): number => rest.reduce((n, f) => n + f[key], 0);
  assert.deepEqual(changes.at(-1), { path: `…${rest.length} more files`, additions: total("additions"), deletions: total("deletions") }, "then the rest, counted, with their line totals");
  assert.ok(budgetSize(r) > budget - contentOf([rest[0]]) - 4, `filled to within one file (${budgetSize(r)} of ${budget})`);
  assert.deepEqual([r.subagents.length, r.subagentsTruncated], [30, undefined], "the roster, inside its quarter, whole");
});

test("room the entries leave unused goes back to the roster: a second pass re-adds rows, the last dropped first", () => {
  // The reviewer's case: the 30 KB prompt went, the reply stayed, and 29 614 of 39 680 bytes sat unused.
  const live = (i: number): boolean => i % 4 === 0;
  const roster = Array.from({ length: 400 }, (_, i) => agent(i, `Agent ${i}: ${"reviewing the migration plan ".repeat(3)}`, live(i) ? "running" : "completed"));
  const snap = snapshot({ items: [message("user", "u".repeat(30_000), { turnId: "t1" }), message("assistant", "Done.", { turnId: "t1" })], roster });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 10_000_000 });
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 40_000 });
  const budget = 40_000 - TRANSCRIPT_HINT_BYTES;
  assert.ok(budgetSize(r) <= budget, `within the budget (${budgetSize(r)})`);
  assert.deepEqual(r.entries.map((e) => [e.kind, e.text]), [["assistant", "Done."]], "the 30 KB prompt went, the reply stayed");
  assert.ok(contentOf(r.subagents) > Math.floor(roomOf(r, 40_000) * ROSTER_SHARE), `the roster took back more than its quarter (${contentOf(r.subagents)} B)`);
  const next = nextBack(whole.subagents, r.subagents)!;
  assert.ok(budgetSize(r) + contentOf([next]) + 1 > budget, `filled to within one roster row (${budgetSize(r)} of ${budget})`);
  const kept = r.subagents.map((a) => Number(a.id.slice(5)));
  const all = Array.from({ length: 400 }, (_, i) => i);
  assert.deepEqual(kept.filter(live), all.filter(live), "every running agent came back first");
  const settled = all.filter((i) => !live(i));
  assert.deepEqual(kept.filter((i) => !live(i)), settled.slice(settled.length - kept.filter((i) => !live(i)).length), "then the newest settled ones");
});

test("reasoning goes before tool detail: when dropping it is enough, every tool keeps its whole detail", () => {
  const detail = "x".repeat(1_500);
  const items = [message("user", "Check the build.", { turnId: "t1" }), message("reasoning", "r".repeat(3_000), { turnId: "t1" }),
    activity("tool.completed", { itemType: "command_execution", toolUseId: "b", title: "Build", command: "pnpm build", status: "completed", detail }, { turnId: "t1", tone: "tool" }),
    message("assistant", "Green.", { turnId: "t1" })];
  const snap = snapshot({ items });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 1_000_000 });
  assert.equal(whole.entries[1]!.kind, "reasoning");
  // A budget that dropping the reasoning row alone meets.
  const maxChars = budgetSize(whole) - (contentOf([whole.entries[1]]) + 1) + TRANSCRIPT_HINT_BYTES + 16;
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars });
  assert.equal(r.truncated, true);
  assert.deepEqual(r.entries.map((e) => e.kind), ["user", "tool", "assistant"], "only the reasoning went");
  assert.equal(r.entries[1]!.tool!.detail, detail, "the tool keeps its whole detail");
});

test("the spared row is the latest turn's reply, not a newer row after it: a budget for one row keeps the reply", () => {
  const items = [message("user", "Tidy the imports.", { turnId: "t1" }), message("assistant", "Tidied thirty files.", { turnId: "t1" })];
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `src/module-${i}/index.ts`, additions: 2, deletions: 2 }));
  const snap = snapshot({ items, checkpoints: [checkpoint(files, after(items))] as never });
  const whole = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 1_000_000 });
  assert.deepEqual(whole.entries.map((e) => e.kind), ["user", "assistant", "changes"], "the checkpoint is the newest row");
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(contentOf(whole.entries.slice(1)) > 2_000 - TRANSCRIPT_HINT_BYTES, "the reply and the checkpoint do not fit together");
  assert.deepEqual(r.entries.map((e) => [e.kind, e.text]), [["assistant", "Tidied thirty files."]], "the reply, not the newer checkpoint");
});

test("fitRoster and fitEntries are pure: deep-frozen inputs come through untouched", () => {
  const freeze = <T>(value: T): T => { if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
  const sizedRows = <T>(rows: T[]) => freeze(rows.map((row) => ({ row, bytes: Buffer.byteLength(JSON.stringify(row), "utf8") + 1 })));
  const roster = sizedRows([{ id: "a", title: "settled", status: "completed" }, { id: "b", title: "live", status: "running" }]);
  assert.deepEqual(fitRoster(roster, 60).rows.map((r) => r.id), ["b"], "the settled row (49 B) goes first, the live one (44 B) fits");
  const tool = { turn: 1, turnId: "t1", kind: "tool" as const, createdAt: stamp(1), tool: { type: "command_execution", title: "t", status: "completed", detail: "d".repeat(500) } };
  const reply = { turn: 1, turnId: "t1", kind: "assistant" as const, createdAt: stamp(2), text: "r".repeat(500) };
  const out = fitEntries(sizedRows<TranscriptEntry>([tool, reply]), 400);
  assert.deepEqual(out.entries.map((e) => e.kind), ["assistant"], "the older row went, the reply stayed");
  assert.ok(out.entries[0]!.text!.endsWith("…") && contentOf(out.entries) <= 400, "cut to fit");
  assert.equal(out.bytes, contentOf(out.entries), "and reports the entries' exact size");
});

test("jsonTextBytes counts a string's JSON size exactly as JSON.stringify writes it, without serialising it", () => {
  const units = Array.from({ length: 0x10000 }, (_, cp) => String.fromCharCode(cp)); // every BMP unit, lone surrogates included
  for (let i = 0; i < units.length; i += 4_096) {
    const s = units.slice(i, i + 4_096).join("");
    assert.equal(jsonTextBytes(s), Buffer.byteLength(JSON.stringify(s), "utf8") - 2, `U+${i.toString(16)} onwards`);
  }
  for (const s of ["😀𝄞", 'a\u0000b\u001f"\\\n\t\b\f\r', "\ud800x", "x\udc00", "  \u007f", ""]) assert.equal(jsonTextBytes(s), Buffer.byteLength(JSON.stringify(s), "utf8") - 2, JSON.stringify(s));
});

test("a randomized probe (fixed seed): whole when it fits, else within the reserve, keeping its spared row, sharing and filling", () => {
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
  const tally = { truncated: 0, rosterTrimmed: 0, liveDropped: 0, cut: 0, listCut: 0, secondPass: 0 };
  for (let run = 0; run < 120; run += 1) {
    const turnCount = int(1, 5);
    const items: ThreadItem[] = [];
    const turns = [];
    const checkpoints: ReturnType<typeof checkpoint>[] = [];
    for (let t = 1; t <= turnCount; t += 1) {
      const turnId = `t${t}`;
      const opening = message("user", text(3_000), { turnId });
      items.push(opening);
      if (rand() < 0.5) items.push(message("reasoning", text(4_000), { turnId }));
      for (let k = int(0, 6); k > 0; k -= 1) {
        const changedFiles = rand() < 0.3 ? Array.from({ length: int(1, 80) }, (_, f) => `src/${text(30)}/${f}.ts`) : undefined;
        items.push(activity("tool.completed", { itemType: "command_execution", toolUseId: `${turnId}-${k}`, title: text(60), command: text(200), status: "completed", detail: text(3_000), ...(changedFiles ? { changedFiles } : {}) }, { turnId, tone: "tool" }));
      }
      if (rand() < 0.6) items.push(message("assistant", text(20_000), { turnId }));
      if (rand() < 0.5) checkpoints.push(checkpoint(Array.from({ length: int(1, 1_500) }, (_, f) => ({ path: `src/${text(40)}/${f}.ts`, additions: int(0, 900), deletions: int(0, 900) })), after(items), turnId));
      turns.push(turn({ turnId, turnCount: t, requestedAt: opening.createdAt, startedAt: opening.createdAt, completedAt: items.at(-1)!.createdAt }));
    }
    const roster = Array.from({ length: int(0, 100) }, (_, i) => agent(i, text(400), pick(statuses))) as unknown as { id: string; status: string }[];
    const maxChars = int(2_000, 55_000);
    const window = int(1, 5);
    const snap = snapshot({ items, turns, roster: roster as never, checkpoints: checkpoints as never });
    const whole = transcriptEntries(snap, { turns: window, include: ALL, maxChars: Number.MAX_SAFE_INTEGER });
    const r = transcriptEntries(snap, { turns: window, include: ALL, maxChars });
    const where = `run ${run}: ${turnCount} turns, ${roster.length} agents, maxChars ${maxChars}`;
    const budget = maxChars - TRANSCRIPT_HINT_BYTES;
    // Whole when the untrimmed result fits maxChars; otherwise trimmed to maxChars less the hint's reserve.
    const wholeSize = budgetSize(whole);
    if (wholeSize <= maxChars) assert.equal(JSON.stringify(r), JSON.stringify(whole), `${where}: ${wholeSize} bytes fit, so whole`);
    else assert.ok(r.truncated && budgetSize(r) <= budget, `${where}: ${wholeSize} bytes do not fit, so trimmed to ${budget} (${budgetSize(r)})`);
    if (!r.truncated) assert.deepEqual(r, whole, `${where}: nothing shed when it fits`);
    // The same shape at budgets straddling its whole size: anywhere in [size, size + reserve] it comes back whole; one
    // byte under it, it is trimmed below the reserve.
    const snug = wholeSize + int(0, TRANSCRIPT_HINT_BYTES);
    assert.equal(JSON.stringify(transcriptEntries(snap, { turns: window, include: ALL, maxChars: snug })), JSON.stringify(whole), `${where}: whole at maxChars ${snug}`);
    const tight = transcriptEntries(snap, { turns: window, include: ALL, maxChars: wholeSize - 1 });
    assert.ok(tight.truncated && budgetSize(tight) <= wholeSize - 1 - TRANSCRIPT_HINT_BYTES, `${where}: trimmed at maxChars ${wholeSize - 1}`);
    // The spared row — the latest turn's final reply, else its newest row — always stays (a minimal row always fits here).
    const spared = sparedOf(whole.entries)!;
    assert.ok(hasRow(r, spared), `${where}: the spared row stays`);
    const present = r.entries.flatMap((e) => (e.turn === null ? [] : [e.turn]));
    assert.deepEqual(r.coveredTurns, present.length ? [Math.min(...present), Math.max(...present)] : null, `${where}: coveredTurns names the rows present`);
    assert.equal(r.subagentsTruncated === true, r.subagents.length < roster.length, `${where}: subagentsTruncated`);
    assert.ok(r.subagents.every((s) => [...(s.title ?? "")].length <= 200), `${where}: titles capped`);
    // Shed order in the roster: settled rows oldest first, live ones only after every settled row, oldest first.
    const kept = new Set(r.subagents.map((s) => s.id));
    const keptOf = (live: boolean) => roster.filter((a) => isLive(a.status) === live).map((a) => kept.has(a.id));
    for (const flags of [keptOf(false), keptOf(true)]) assert.ok(flags.every((k, i) => !k || flags.slice(i).every(Boolean)), `${where}: rows dropped oldest first`);
    if (keptOf(true).includes(false)) assert.ok(!keptOf(false).includes(true), `${where}: a live row went before a settled one`);
    // A trimmed roster fills: the next row the second pass would bring back does not fit.
    const next = nextBack(whole.subagents, r.subagents);
    if (next) assert.ok(budgetSize(r) + contentOf([next]) + 1 > budget, `${where}: the roster fills to within one row (${budgetSize(r)} of ${budget})`);
    // A spared list capped to a head and a count of the rest (a checkpoint's files, a tool's changed files).
    const listed = r.entries.find((e) => e.createdAt === spared.createdAt);
    if ((listed?.files?.at(-1)?.path ?? listed?.tool?.changedFiles?.at(-1) ?? "").startsWith("…")) tally.listCut += 1;
    if (r.truncated) {
      const space = roomOf(r, maxChars);
      // The second pass only re-adds roster rows: the entries are exactly what fitEntries gives at the first pass's allowance.
      const firstPass = fitRoster(sizedOf(whole.subagents), rosterCap(space, contentOf(whole.entries)));
      const firstAllowance = budget - frameOf(r, firstPass.trimmed) - firstPass.bytes;
      assert.deepEqual(r.entries, fitEntries(sizedOf(whole.entries), firstAllowance).entries, `${where}: the second pass leaves the fitted entries untouched`);
      if (r.subagents.length > firstPass.rows.length) tally.secondPass += 1;
      // A reply cut to fit: the entries keep at least what the roster's share leaves (no starved reply), and the
      // result ends within one code point of the budget (no under-fill).
      const cut = r.entries.find((e) => e.createdAt === spared.createdAt)!;
      if (spared.text !== undefined && cut.text !== spared.text) {
        // Cut to fit, the entries used their whole allowance: the roster kept within its first-pass cap.
        assert.ok(contentOf(r.subagents) <= rosterCap(space, contentOf(whole.entries)), `${where}: the roster within max(⌊room/4⌋, room − E)`);
        assert.ok(contentOf(r.entries) >= space - Math.floor(space * ROSTER_SHARE) - 6, `${where}: the reply's floor (${contentOf(r.entries)} of ${space})`);
        assert.ok(budgetSize(r) > budget - 7, `${where}: filled (${budgetSize(r)} of ${budget})`);
        tally.cut += 1;
      }
      tally.truncated += 1;
      if (r.subagentsTruncated) tally.rosterTrimmed += 1;
      if (keptOf(true).includes(false)) tally.liveDropped += 1;
    }
  }
  assert.ok(Object.values(tally).every((n) => n >= 5), `the probe reaches every branch: ${JSON.stringify(tally)}`);
});

test("cutTail: seeded random texts — exact against JSON.stringify, never splitting a surrogate pair, never cutting more than needed", () => {
  /** A text's size inside a JSON result, as JSON.stringify writes it: escaped, UTF-8, quotes excluded. */
  const jsonSize = (text: string): number => Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
  // Every kind of character the byte count distinguishes: ASCII, the two-character escapes (quote, backslash, \n, \t),
  // the \u00XX escapes (other control characters), 2-, 3- and 4-byte characters, U+2028 (never escaped), emoji, and
  // lone high and low surrogates (written \uXXXX).
  const pool = ["a", "Z", " ", "\"", "\\", "\n", "\t", "\u0000", "\u0001", "\u001f", "\u007f", "é", "ß", "漢", "…", "\u2028", "\u2029", "😀", "𝄞", "\uD83D", "\uDE00", "\uDBFF", "\uDC00"];
  let seed = 20_260_923; // fixed: the same texts on every run
  const next = (n: number): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
  const pairAt = (text: string, i: number): boolean => i > 0 && i < text.length && (text.charCodeAt(i - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(i) & 0xfc00) === 0xdc00;
  for (let run = 0; run < 3_000; run += 1) {
    const text = Array.from({ length: next(40) }, () => pool[next(pool.length)]!).join("");
    const need = next(90) - 5; // including needs ≤ 0 and needs past the whole text
    const { head, saved } = cutTail(text, need);
    const label = `run ${run}: ${JSON.stringify(text)}, need ${need}`;
    assert.ok(text.startsWith(head), `${label}: a head`);
    assert.equal(saved, jsonSize(text) - jsonSize(head), `${label}: saved is exact`);
    assert.ok(!pairAt(text, head.length), `${label}: no surrogate pair split`);
    if (need <= 0) assert.equal(head, text, `${label}: nothing to cut`);
    else if (head !== "") assert.ok(saved >= need, `${label}: enough`);
    // Minimal: the tail minus its first code point would not have been enough (so an empty head means all was needed).
    if (head.length < text.length && need > 0) {
      const oneLess = head.length + [...text.slice(head.length)][0]!.length;
      assert.ok(jsonSize(text) - jsonSize(text.slice(0, oneLess)) < need, `${label}: no more than needed`);
    }
  }
});

// ---- Older history (design item 3): beforeTurn, olderTurns, the turnless rows' range, merged pages, unavailable turns. ----

/** `n` started turns, each an opening message and a reply, built in order: the fixture's stamps rise with the log. */
function turnsOf(n: number): { turns: Turn[]; items: ThreadItem[] } {
  const turns: Turn[] = [];
  const items: ThreadItem[] = [];
  for (let t = 1; t <= n; t += 1) {
    const ask = message("user", `ask ${t}`, { turnId: `t${t}` });
    items.push(ask, message("assistant", `reply ${t}`, { turnId: `t${t}` }));
    turns.push(turn({ turnId: `t${t}`, turnCount: t, requestedAt: ask.createdAt, startedAt: ask.createdAt, completedAt: items.at(-1)!.createdAt }));
  }
  return { turns, items };
}

test("transcriptRange: the turns just before beforeTurn, else the latest; never outside the thread's turns", () => {
  assert.deepEqual(transcriptRange(10, 3), { start: 8, end: 10 });
  assert.deepEqual(transcriptRange(10, 3, 11), { start: 8, end: 10 }, "beforeTurn turnCount + 1 is the default");
  assert.deepEqual(transcriptRange(10, 3, 6), { start: 3, end: 5 });
  assert.deepEqual(transcriptRange(10, 5, 3), { start: 1, end: 2 }, "never before turn 1");
  assert.deepEqual(transcriptRange(10, 200), { start: 1, end: 10 });
  assert.deepEqual(transcriptRange(10, 3, 99), { start: 8, end: 10 }, "clamped, never past the last turn");
  assert.deepEqual(transcriptRange(0, 3), { start: 1, end: 0 }, "no started turn: an empty range");
});

test("beforeTurn reads the turns just before it; olderTurns counts the started turns before the range", () => {
  const snap = snapshot(turnsOf(6));
  const read = (turns: number, beforeTurn?: number) => transcriptEntries(snap, { turns, ...(beforeTurn === undefined ? {} : { beforeTurn }), include: ALL, maxChars: 100_000 });
  const r = read(2, 5);
  assert.deepEqual(r.entries.map((e) => [e.turn, e.text]), [[3, "ask 3"], [3, "reply 3"], [4, "ask 4"], [4, "reply 4"]]);
  assert.deepEqual([r.turnCount, r.olderTurns, r.coveredTurns], [6, 2, [3, 4]]);
  assert.deepEqual(Object.keys(r), ["entries", "turnCount", "olderTurns", "coveredTurns", "truncated", "subagents"], "olderTurns always, unavailableTurns only when some were not read");
  const latest = read(2);
  assert.deepEqual([latest.olderTurns, latest.coveredTurns], [4, [5, 6]]);
  assert.deepEqual(read(2, 7), latest, "beforeTurn turnCount + 1 reads the latest turns");
  assert.deepEqual([read(9, 3).olderTurns, read(9, 3).coveredTurns], [0, [1, 2]], "a range from turn 1 has none older");
  assert.equal(transcriptEntries(snapshot({ turns: [], items: [] }), { turns: 3, include: ALL, maxChars: 100_000 }).olderTurns, 0);
});

test("a shed that dropped the range's first turns counts olderTurns from the first turn it left: paging back by it never skips a turn", () => {
  // Thirty turns with long replies: ten of them do not fit 9 000 bytes, and the shed drops the oldest rows first.
  const turns: Turn[] = [];
  const items: ThreadItem[] = [];
  for (let n = 1; n <= 30; n += 1) {
    const ask = message("user", `ask ${n}`, { turnId: `t${n}` });
    items.push(ask, message("assistant", `reply ${n} ${"x".repeat(1_000)}`, { turnId: `t${n}` }));
    turns.push(turn({ turnId: `t${n}`, turnCount: n, requestedAt: ask.createdAt, startedAt: ask.createdAt, completedAt: items.at(-1)!.createdAt }));
  }
  const snap = snapshot({ turns, items });
  const read = (beforeTurn?: number) => transcriptEntries(snap, { turns: 10, ...(beforeTurn === undefined ? {} : { beforeTurn }), include: ALL, maxChars: 9_000 });
  const latest = read();
  const [first, last] = latest.coveredTurns!;
  assert.ok(latest.truncated && first > 21 && last === 30, `the range [21, 30] lost its first turns: ${JSON.stringify(latest.coveredTurns)}`);
  assert.equal(latest.olderTurns, first - 1, "counted back from the first turn shown, not from 21");
  // The next read takes in the turns the shed dropped, and so on down to turn 1: every turn is shown once or more.
  const shown = new Set<number>();
  let r = latest;
  for (let calls = 0; calls < 30; calls += 1) {
    for (let n = r.coveredTurns![0]; n <= r.coveredTurns![1]; n += 1) shown.add(n);
    if (r.olderTurns === 0) break;
    const next = read(r.olderTurns + 1);
    assert.ok(next.coveredTurns![1] === r.olderTurns, `the next read ends at the turn just before the first one shown (${r.olderTurns})`);
    r = next;
  }
  assert.equal(shown.size, 30);
  // Without a shed that dropped rows, it is start − 1, as before.
  assert.equal(transcriptEntries(snap, { turns: 10, include: ALL, maxChars: 100_000 }).olderTurns, 20);
});

test("a row with no turn belongs to the range by its time: from the first turn's request (from the very start at turn 1), before the next turn's", () => {
  const failed = (label: string, over: { createdAt?: string } = {}) => activity("provider.turn.start.failed", { detail: label }, { turnId: null, tone: "error", summary: "Turn failed", ...over });
  const items: ThreadItem[] = [failed("f0")];
  const turns: Turn[] = [];
  for (let t = 1; t <= 3; t += 1) {
    const ask = message("user", `ask ${t}`, { turnId: `t${t}` });
    items.push(ask, message("assistant", `reply ${t}`, { turnId: `t${t}` }), failed(`f${t}`));
    turns.push(turn({ turnId: `t${t}`, turnCount: t, requestedAt: ask.createdAt, startedAt: ask.createdAt, completedAt: ask.createdAt }));
  }
  // A failure stamped at the very instant turn 3 was requested lies on turn 3's side of the boundary.
  items.push(failed("at 3", { createdAt: turns[2]!.requestedAt }));
  const snap = snapshot({ turns, items });
  const texts = (beforeTurn?: number) => transcriptEntries(snap, { turns: 1, ...(beforeTurn === undefined ? {} : { beforeTurn }), include: ALL, maxChars: 100_000 }).entries.map((e) => e.text);
  assert.deepEqual(texts(2), ["Turn failed: f0", "ask 1", "reply 1", "Turn failed: f1"], "turn 1: from the very start, up to turn 2's request");
  assert.deepEqual(texts(3), ["ask 2", "reply 2", "Turn failed: f2"], "turn 2: from its request, before turn 3's");
  assert.deepEqual(new Set(texts()), new Set(["ask 3", "reply 3", "Turn failed: f3", "Turn failed: at 3"]), "the latest turn: from its request on, with no end");
});

test("a merged snapshot's rows sort into log order: a call whose start a page holds and whose end the window holds is one row, at its start, in its latest state", () => {
  const ask = message("user", "Run the suite.", { turnId: null, id: "ask-2" });
  const started = activity("tool.started", { itemType: "command_execution", toolUseId: "tu1", title: "pnpm test", command: "pnpm test", status: "inProgress" }, { turnId: "t2", tone: "tool" });
  const completed = activity("tool.completed", { itemType: "command_execution", toolUseId: "tu1", title: "pnpm test", status: "completed", detail: "ok" }, { turnId: "t2", tone: "tool" });
  const reply = message("assistant", "Green.", { turnId: "t2" });
  const turns = [turn({ turnId: "t1", requestedAt: stamp(0) }), turn({ turnId: "t2", turnCount: 2, requestedAt: ask.createdAt, startedAt: ask.createdAt, completedAt: reply.createdAt, userMessageId: ask.id })];
  const window = snapshot({ turns, items: [completed, reply] });
  // The page holds the turn's opening: its prompt and the call's first row.
  const merged = mergeHistoryPages(window, [{ items: [ask, started], checkpoints: [] }]);
  const r = transcriptEntries(merged, { turns: 1, include: ALL, maxChars: 100_000, windowItems: window.items });
  assert.deepEqual(r.entries.map((e) => [e.kind, e.turn]), [["user", 2], ["tool", 2], ["assistant", 2]]);
  const tool = r.entries[1]!;
  assert.equal(tool.createdAt, started.createdAt, "the call's row sits at its start");
  assert.deepEqual(tool.tool, { type: "command_execution", title: "pnpm test", status: "completed", command: "pnpm test", detail: "ok" }, "folded from its start, the window's completion last");
});

test("the actionable plan is judged on the window: a plan only a page holds has aged out, and is not the one implement_plan would send", () => {
  const plan = activity("turn.proposed.completed", { planId: "p1", planMarkdown: "# Old plan" }, { turnId: "t1" });
  const later = message("user", "Something else first.", { turnId: "t2" });
  const turns = [turn({ turnId: "t1", requestedAt: plan.createdAt }), turn({ turnId: "t2", turnCount: 2, requestedAt: later.createdAt, startedAt: later.createdAt, completedAt: later.createdAt })];
  const planRow = (snap: ReturnType<typeof snapshot>, windowItems?: readonly ThreadItem[]) =>
    transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 100_000, ...(windowItems ? { windowItems } : {}) }).entries.find((e) => e.kind === "plan");
  const window = snapshot({ turns, items: [later] });
  assert.equal(planRow(mergeHistoryPages(window, [{ items: [plan], checkpoints: [] }]), window.items)!.actionable, false);
  const kept = snapshot({ turns, items: [plan, later] });
  assert.equal(planRow(kept, kept.items)!.actionable, true, "the same plan in the window is actionable, as the host says");
  assert.equal(planRow(kept)!.actionable, true, "without windowItems, snap.items is the window");
});

test("unavailable turns are reported, and their sentence is held back: whole only when the result fits with it, else shed below both hints' room", () => {
  const hint = "Turn 1 could not be read whole: older turns are unavailable on this host right now. Try again later.";
  const unavailable = { turns: [1, 1] as [number, number], hint };
  const snap = snapshot({ items: oneTurn("r".repeat(5_000)) });
  const opts = { turns: 5, include: ALL, unavailable };
  const whole = transcriptEntries(snap, { ...opts, maxChars: 1_000_000 });
  assert.deepEqual([whole.unavailableTurns, whole.truncated], [[1, 1], false]);
  assert.deepEqual(Object.keys(whole), ["entries", "turnCount", "olderTurns", "coveredTurns", "unavailableTurns", "truncated", "subagents"]);
  // The hint field inside the result: `,"hint":"…"`.
  const field = Buffer.byteLength(JSON.stringify({ hint }), "utf8") - 1;
  const exact = budgetSize(whole) + field;
  assert.equal(JSON.stringify(transcriptEntries(snap, { ...opts, maxChars: exact })), JSON.stringify(whole), "whole when it fits with its hint");
  const over = transcriptEntries(snap, { ...opts, maxChars: exact - 1 });
  assert.equal(over.truncated, true, "one byte less: shed, though the result alone would still fit");
  assert.ok(budgetSize(over) <= exact - 1 - TRANSCRIPT_HINT_BYTES - jsonTextBytes(hint) - 1, `below maxChars less the shed hint's room, the sentence and a space (${budgetSize(over)})`);
  assert.deepEqual(over.unavailableTurns, [1, 1]);
  const plain = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: exact - 1 });
  assert.equal(plain.truncated, false, "without unavailable turns the same budget holds the result whole");
});

test("a randomized probe with beforeTurn and unavailable turns (fixed seed): the range, olderTurns, and the answer within maxChars, its hint's room kept", () => {
  let seed = 0x3c19a7;
  const rand = (): number => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const text = (max: number): string => pick(["a", "é", "漢", "😀", '"', "\n", "word "]).repeat(int(1, max));
  const tally = { whole: 0, shed: 0, unavailable: 0, before: 0, pagedFromCovered: 0 };
  for (let run = 0; run < 120; run += 1) {
    const turnCount = int(1, 8);
    const items: ThreadItem[] = [];
    const turns: Turn[] = [];
    for (let t = 1; t <= turnCount; t += 1) {
      const turnId = `t${t}`;
      const opening = message("user", text(2_000), { turnId });
      items.push(opening);
      for (let k = int(0, 3); k > 0; k -= 1) items.push(activity("tool.completed", { itemType: "command_execution", toolUseId: `${turnId}-${k}`, title: text(40), command: text(100), status: "completed", detail: text(2_000) }, { turnId, tone: "tool" }));
      if (rand() < 0.3) items.push(activity("provider.turn.start.failed", { detail: text(200) }, { turnId: null, tone: "error", summary: "Turn failed" }));
      items.push(message("assistant", text(6_000), { turnId }));
      turns.push(turn({ turnId, turnCount: t, requestedAt: opening.createdAt, startedAt: opening.createdAt, completedAt: items.at(-1)!.createdAt }));
    }
    const roster = Array.from({ length: int(0, 40) }, (_, i) => agent(i, text(200), pick(["running", "completed"])));
    const snap = snapshot({ items, turns, roster });
    const count = int(1, 4);
    const beforeTurn = rand() < 0.7 ? int(2, turnCount + 1) : undefined;
    const { start, end } = transcriptRange(turnCount, count, beforeTurn);
    const unavailable = rand() < 0.6 ? { turns: [start, int(start, Math.max(start, end))] as [number, number], hint: `Turns ${text(60)} could not be read whole.` } : undefined;
    const maxChars = int(2_000, 55_000);
    const opts = { turns: count, ...(beforeTurn === undefined ? {} : { beforeTurn }), include: ALL, ...(unavailable ? { unavailable } : {}) };
    const r = transcriptEntries(snap, { ...opts, maxChars });
    const whole = transcriptEntries(snap, { ...opts, maxChars: Number.MAX_SAFE_INTEGER });
    const where = `run ${run}: ${turnCount} turns, turns ${count}, beforeTurn ${beforeTurn}, maxChars ${maxChars}`;
    // Counted back from the first turn delivered: once the shed dropped rows, from the first turn it left.
    const dropped = r.entries.length < whole.entries.length;
    assert.equal(r.olderTurns, dropped && r.coveredTurns ? r.coveredTurns[0] - 1 : start - 1, `${where}: olderTurns`);
    if (dropped && r.coveredTurns && r.coveredTurns[0] > start) tally.pagedFromCovered += 1;
    assert.deepEqual(r.unavailableTurns, unavailable?.turns, `${where}: unavailableTurns`);
    assert.ok(r.entries.every((e) => e.turn === null || (e.turn >= start && e.turn <= end)), `${where}: every row inside [${start}, ${end}]`);
    // The room the tool's hint takes: the sentence as a field of its own on a whole result; on a shed one, the sentence,
    // a space and the shed hint's reserve.
    const said = unavailable ? jsonTextBytes(unavailable.hint) : 0;
    const wholeRoom = unavailable ? 10 + said : 0;
    if (budgetSize(whole) + wholeRoom <= maxChars) {
      assert.equal(JSON.stringify(r), JSON.stringify(whole), `${where}: fits with its hint, so whole`);
      tally.whole += 1;
    } else {
      assert.ok(r.truncated, `${where}: does not fit with its hint, so shed`);
      assert.ok(budgetSize(r) <= maxChars - TRANSCRIPT_HINT_BYTES - (unavailable ? said + 1 : 0), `${where}: shed below both hints' room (${budgetSize(r)})`);
      tally.shed += 1;
    }
    if (unavailable) tally.unavailable += 1;
    if (beforeTurn !== undefined && beforeTurn <= turnCount) tally.before += 1;
  }
  assert.ok(Object.values(tally).every((n) => n >= 10), `the probe reaches every branch: ${JSON.stringify(tally)}`);
});

// ---- Transcript details (design item 4): command output, failed hooks, commentary, the compaction rule. ----

/**
 * The one tool row of a transcript read with every include, its rows slimmed as every read path slims them
 * (`slimActivityPayload`, the orchestrator's `slimItemsForRead`): the transcript never sees a payload any other way.
 */
const toolRow = (items: ThreadItem[]): NonNullable<TranscriptEntry["tool"]> => {
  const read = items.map((item) => (item.kind === "activity" ? { ...item, payload: slimActivityPayload(item.payload) } : item));
  return transcriptEntries(snapshot({ items: read }), { turns: 5, include: ALL, maxChars: 100_000 }).entries.find((e) => e.kind === "tool")!.tool!;
};

test("a Grok-shaped command whose detail repeats the command shows its output, and an echo with no output never clears it", () => {
  // Grok's ACP call, as the normaliser writes it (fixture grok/03b): `detail` repeats the command, which rides only in
  // `data`. The first `tool_call` frame carries no ACP `kind` yet; the updates say `kind: "execute"` and carry the
  // output in `rawOutput` and in ACP `content` blocks, which the read's slimming turns into one preview line.
  const started = activity("tool.started", {
    itemType: "command_execution", toolUseId: "call-1", title: "run_terminal_command", status: "inProgress", detail: "echo hi",
    data: { toolUseId: "call-1", command: "echo hi", vendorTool: "run_terminal_command", readOnly: false, rawInput: { command: "echo hi", description: "Print hi to stdout" } }
  }, { turnId: "t1", tone: "tool" });
  const call = (activityKind: string, status: string, output?: { rawOutput?: unknown; content?: unknown }) => activity(activityKind, {
    itemType: "command_execution", toolUseId: "call-1", title: "Execute `echo hi`", status, detail: "echo hi",
    data: { toolUseId: "call-1", kind: "execute", command: "echo hi", rawInput: { command: "echo hi" }, ...output }
  }, { turnId: "t1", tone: "tool" });
  const printed = (text: string) => ({ rawOutput: { type: "Bash", output_for_prompt: text, exit_code: 0 }, content: [{ type: "content", content: { type: "text", text } }] });
  // The start only echoes the command: no detail (the GUI drops the start; the title and command say what runs).
  assert.deepEqual(toolRow([started]), { type: "command_execution", title: "run_terminal_command", status: "inProgress", command: "echo hi" });
  assert.deepEqual(toolRow([started, call("tool.completed", "completed", printed("hi\n"))]),
    { type: "command_execution", title: "Execute `echo hi`", status: "completed", command: "echo hi", detail: "hi" });
  // A command that printed nothing: the start's echo is never taken for its output.
  assert.equal(toolRow([started, call("tool.completed", "completed")]).detail, undefined);
  // Both streams on disk: the read keeps the first (stdout), as its one-line preview.
  assert.equal(toolRow([started, call("tool.completed", "completed", { rawOutput: { stdout: "hi\nthere\n", stderr: "note\n" } })]).detail, "hi");
  // An update that carried the output, then an echo that carries none: the output stays.
  assert.equal(toolRow([started, call("tool.updated", "inProgress", printed("partial\n")), call("tool.completed", "completed")]).detail, "partial");
});

test("a Codex command shows its item's aggregatedOutput; a detail that already says more stands", () => {
  const items = [
    activity("tool.started", { itemType: "command_execution", toolUseId: "call-1", title: "Bash", status: "inProgress" }, { turnId: "t1", tone: "tool" }),
    activity("tool.completed", { itemType: "command_execution", toolUseId: "call-1", title: "Bash", status: "completed", data: { item: { command: "ls -1", aggregatedOutput: "a\nb\n" } } }, { turnId: "t1", tone: "tool" })
  ];
  // The read's preview of it: the first line.
  assert.equal(toolRow(items).detail, "a");
  // OpenCode's detail is already the fuller output: its data's one-line result does not replace it.
  const openCode = activity("tool.completed", { itemType: "command_execution", toolUseId: "oc", title: "bash", status: "completed", detail: "first line\nsecond line", data: { command: "cat f", result: "first line" } }, { turnId: "t1", tone: "tool" });
  assert.equal(toolRow([openCode]).detail, "first line\nsecond line");
  // Any other tool keeps its provider detail as it came, untrimmed, whatever its data says.
  const patch = activity("tool.completed", { itemType: "file_change", toolUseId: "p", title: "Edit", status: "completed", detail: "3 lines\n", data: { rawOutput: { content: "x" } } }, { turnId: "t1", tone: "tool" });
  assert.equal(toolRow([patch]).detail, "3 lines\n");
});

/** A call's rows as every read serves them (§5.6 slimming, `truncated` stamped where it cut), folded into its one entry. */
const toolEntry = (items: ThreadItem[]): TranscriptEntry => {
  const read = items.map((item) => (item.kind === "activity" ? { ...item, payload: slimActivityPayload(item.payload) } : item));
  return transcriptEntries(snapshot({ items: read }), { turns: 5, include: ALL, maxChars: 100_000 }).entries.find((e) => e.kind === "tool")!;
};

test("outputItemId names the call's completion when the read cut it — the row the GUI's \"Load full output\" reads", () => {
  const lines = `${Array.from({ length: 200 }, (_, i) => `test ${i} passed`).join("\n")}\n`;
  const row = (activityKind: string, status: string, data?: unknown) => activity(activityKind, {
    itemType: "command_execution", toolUseId: "call-1", title: "pnpm test", status, ...(data === undefined ? {} : { data })
  }, { turnId: "t1", tone: "tool" });
  const started = row("tool.started", "inProgress");
  const completed = row("tool.completed", "completed", { item: { command: "pnpm test", aggregatedOutput: lines } });
  // The completion's output was cut to its first line on the way out: its id is where the whole of it is.
  const whole = toolEntry([started, completed]);
  assert.equal(whole.outputItemId, completed.id);
  assert.equal(whole.tool!.detail, "test 0 passed", "the detail is still the wire's preview");
  // Nothing cut, no field at all.
  const uncut = toolEntry([started, row("tool.completed", "completed")]);
  assert.equal("outputItemId" in uncut, false);
  assert.deepEqual(Object.keys(uncut), ["turn", "turnId", "kind", "createdAt", "tool"]);
});

test("without streamed output, outputItemId is never an update: ingestion stores it already cut, so its item holds nothing the row does not", () => {
  const row = (activityKind: string, status: string, data?: unknown) => activity(activityKind, {
    itemType: "command_execution", toolUseId: "call-1", title: "pnpm test", status, ...(data === undefined ? {} : { data })
  }, { turnId: "t1", tone: "tool" });
  const output = `${Array.from({ length: 50 }, (_, i) => `test ${i} passed`).join("\n")}\n`;
  // A running call's update, as ingestion persists it (§5.6: a `tool.updated` row is written already slimmed): what
  // `GET …/items/:itemId` would serve for it is the preview again, `truncated` and all.
  const live = row("tool.updated", "inProgress", { item: { command: "pnpm test", aggregatedOutput: output } });
  const stored = { ...live, payload: slimActivityPayload(live.payload) };
  assert.equal((stored.payload as { truncated?: unknown }).truncated, true);
  assert.equal(commandOutputText((stored.payload as { data: unknown }).data), "test 0 passed", "the stored update holds only the preview");
  // So a running call offers no id, and a completion the read did not cut leaves none behind an update either.
  assert.equal("outputItemId" in toolEntry([row("tool.started", "inProgress"), stored]), false);
  assert.equal("outputItemId" in toolEntry([row("tool.started", "inProgress"), stored, row("tool.completed", "completed")]), false);
  // Once the completion lands whole, its id is the one.
  const completed = row("tool.completed", "completed", { item: { command: "pnpm test", aggregatedOutput: output } });
  assert.equal(toolEntry([row("tool.started", "inProgress"), stored, completed]).outputItemId, completed.id);
});

test("without streamed output, outputItemId is never a call's start, which the GUI does not show; a denial the read cut is offered", () => {
  // Grok's first frame, as the normaliser writes it (fixture grok/03b): its data is cut to the allow-list on the wire.
  const started = activity("tool.started", {
    itemType: "command_execution", toolUseId: "call-1", title: "run_terminal_command", status: "inProgress", detail: "echo hi",
    data: { toolUseId: "call-1", command: "echo hi", vendorTool: "run_terminal_command", readOnly: false, rawInput: { command: "echo hi" } }
  }, { turnId: "t1", tone: "tool" });
  assert.equal((slimActivityPayload(started.payload) as { truncated?: unknown }).truncated, true, "the start's payload is cut");
  assert.equal("outputItemId" in toolEntry([started]), false, "a call that has only started offers nothing");
  const denied = activity("tool.denied", { itemType: "command_execution", toolUseId: "call-1", title: "rm -rf build", data: { reason: "x".repeat(20_000) } }, { turnId: "t1", tone: "tool" });
  assert.equal(toolEntry([started, denied]).outputItemId, denied.id);
});

test("a call that streamed output offers its latest row as outputItemId, where no completion was cut", () => {
  const row = (activityKind: string, status: string, data?: unknown) => activity(activityKind, {
    itemType: "command_execution", toolUseId: "call-1", title: "pnpm test", status, ...(data === undefined ? {} : { data })
  }, { turnId: "t1", tone: "tool" });
  const chunk = (delta: string) => activity("tool.output", { toolUseId: "call-1", streamKind: "command_output", delta }, { turnId: "t1", tone: "tool" });
  const started = row("tool.started", "inProgress", { item: { type: "commandExecution", command: "pnpm test", aggregatedOutput: null } });
  // A running call's output so far exists only as chunks: its latest row — the start, then the latest update — is offered.
  assert.equal(toolEntry([started, chunk("test 0 passed\n")]).outputItemId, started.id);
  const update = row("tool.updated", "inProgress", { item: { command: "pnpm test", aggregatedOutput: "test 0 passed\n" } });
  assert.equal(toolEntry([started, chunk("test 0 passed\n"), update, chunk("test 1 passed\n")]).outputItemId, update.id);
  // A completion the read did not cut is the latest row too.
  const done = row("tool.completed", "completed");
  assert.equal(toolEntry([started, chunk("test 0 passed\n"), done]).outputItemId, done.id);
  // One the read cut is offered by the first rule, streamed or not; a call that streamed nothing offers nothing new.
  const cut = row("tool.completed", "completed", { item: { command: "pnpm test", aggregatedOutput: "a\nb\n" } });
  assert.equal(toolEntry([started, chunk("a\n"), cut]).outputItemId, cut.id);
  assert.equal("outputItemId" in toolEntry([started, update]), false);
  // Another call's chunks are not this call's output.
  const other = activity("tool.output", { toolUseId: "call-2", streamKind: "command_output", delta: "x" }, { turnId: "t1", tone: "tool" });
  assert.equal("outputItemId" in toolEntry([started, other]), false);
  // The chunk rows themselves never become entries.
  const read = transcriptEntries(snapshot({ items: [started, chunk("a\n"), chunk("b\n")] }), { turns: 5, include: ALL, maxChars: 100_000 });
  assert.deepEqual(read.entries.map((e) => e.kind), ["tool"]);
});

test("a background shell's row, in its own drill-in, offers outputItemId — its chunks count wherever its turn range ends", () => {
  // The shell's rows as the Claude normaliser writes them: its own item, stamped with the task as the agent. It outlives
  // the turn that launched it, so its chunks carry whichever turn is live when they arrive.
  const shell = (activityKind: string, payload: Record<string, unknown>, turnId: string, createdAt: string) =>
    activity(activityKind, { toolUseId: "bgshell:task-1", ...payload }, { turnId, agentId: "task-1", tone: "tool", createdAt, updatedAt: createdAt });
  const data = { toolName: "Bash", input: { command: "make" }, background: true };
  const started = shell("tool.started", { itemType: "command_execution", title: "Background shell", status: "inProgress", data }, "t1", stamp(2));
  const early = shell("tool.output", { streamKind: "command_output", delta: "building\n" }, "t2", stamp(5));
  const turns = [turn({ turnId: "t1", requestedAt: stamp(1) }), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(4) })];
  const running = snapshot({ turns, items: [message("user", "build it", { turnId: "t1", id: "u1", createdAt: stamp(1) }), started, message("user", "meanwhile…", { turnId: "t2", id: "u2", createdAt: stamp(4) }), early] });
  // Turn 1 alone holds the shell's start; its only chunk arrived in turn 2 — the call still has streamed output.
  const drill = transcriptEntries(running, { turns: 1, beforeTurn: 2, agentId: "task-1", include: ALL, maxChars: 100_000 });
  const entry = drill.entries.find((e) => e.kind === "tool")!;
  assert.deepEqual([entry.tool!.status, entry.outputItemId], ["inProgress", started.id]);
  // The parent view leaves the shell's rows out, as the GUI's timeline does.
  assert.equal(transcriptEntries(running, { turns: 5, include: ALL, maxChars: 100_000 }).entries.some((e) => e.kind === "tool"), false);
  // Settled: the completion — cut on the wire, though its data holds no output — is the id.
  const completed = shell("tool.completed", { itemType: "command_execution", title: "Background shell", status: "completed", data: { ...data, exitCode: 0 } }, "t2", stamp(6));
  const settled = { ...running, items: [...running.items, completed].map((item) => (item.kind === "activity" ? { ...item, payload: slimActivityPayload(item.payload) } : item)) };
  assert.equal((settled.items.at(-1) as { payload: { truncated?: unknown } }).payload.truncated, true);
  const done = transcriptEntries(settled, { turns: 5, agentId: "task-1", include: ALL, maxChars: 100_000 }).entries.find((e) => e.kind === "tool")!;
  assert.deepEqual([done.tool!.status, done.outputItemId], ["completed", completed.id]);
});

test("hooks: a failed completion is an error row, a cancelled one a warning row; starts, progress and successes are no row", () => {
  const items = [
    message("user", "Format it.", { turnId: "t1" }),
    activity("hook.started", { hookId: "h1", hookName: "fmt", hookEvent: "PostToolUse" }, { turnId: "t1", summary: "Hook fmt started" }),
    activity("hook.progress", { hookId: "h1", stdout: "formatting…" }, { turnId: "t1", summary: "Hook progress" }),
    activity("hook.completed", { hookId: "h1", outcome: "success" }, { turnId: "t1", summary: "Hook completed" }),
    activity("hook.completed", { hookId: "h2", outcome: "error", stderr: "prettier: not found", exitCode: 127 }, { turnId: "t1", tone: "error", summary: "Hook failed" }),
    activity("hook.completed", { hookId: "h3", outcome: "cancelled" }, { turnId: "t1", summary: "Hook cancelled" }),
    message("assistant", "Formatted, but one hook failed.", { turnId: "t1" })
  ];
  const r = transcriptEntries(snapshot({ items }), { turns: 5, include: ALL, maxChars: 100_000 });
  assert.deepEqual(r.entries.map((e) => [e.kind, e.text]), [
    ["user", "Format it."], ["error", "Hook failed"], ["warning", "Hook cancelled"], ["assistant", "Formatted, but one hook failed."]
  ]);
  const lean = transcriptEntries(snapshot({ items }), { turns: 5, include: new Set(["tools"]), maxChars: 100_000 });
  assert.deepEqual(lean.entries.map((e) => e.kind), ["user", "assistant"], "hook rows are activity rows: include \"activity\"");
});

test("a commentary message is an assistant row marked commentary: true; the turn's answer carries no such field", () => {
  const items = [
    message("user", "Fix the parser.", { turnId: "t1" }),
    message("assistant", "I'll look at the failing test first.", { turnId: "t1", messageKind: "commentary" }),
    activity("tool.completed", { itemType: "command_execution", toolUseId: "t", title: "pnpm test", status: "completed", detail: "1 failed" }, { turnId: "t1", tone: "tool" }),
    message("assistant", "Fixed: the parser skipped empty lines.", { turnId: "t1", messageKind: "answer" }),
    message("assistant", "Anything else?", { turnId: "t1" })
  ];
  const r = transcriptEntries(snapshot({ items }), { turns: 5, include: ALL, maxChars: 100_000 });
  const assistant = r.entries.filter((e) => e.kind === "assistant");
  assert.deepEqual(assistant.map((e) => [e.text, e.commentary]), [
    ["I'll look at the failing test first.", true], ["Fixed: the parser skipped empty lines.", undefined], ["Anything else?", undefined]
  ]);
  assert.ok(!("commentary" in assistant[1]!) && !("commentary" in assistant[2]!), "no commentary field on an answer");
});

test("a commentary row is never the spared reply: a running turn's shed keeps its newest row instead", () => {
  // The turn is still at work: narration, then a call with a long command, and no answer yet.
  const items = [
    message("user", "Run the migration and report.", { turnId: "t1" }),
    message("assistant", `I'll run the migration now. ${"Checking the schema first. ".repeat(60)}`, { turnId: "t1", messageKind: "commentary" }),
    activity("tool.started", { itemType: "command_execution", toolUseId: "m", title: "Migrate", status: "inProgress", command: `pnpm migrate ${"--table t ".repeat(150)}` }, { turnId: "t1", tone: "tool" })
  ];
  const r = transcriptEntries(snapshot({ items }), { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(budgetSize(r) <= 2_000 - TRANSCRIPT_HINT_BYTES, `within the budget (${budgetSize(r)})`);
  assert.deepEqual(r.entries.map((e) => e.kind), ["tool"], "the newest row stays, cut to fit; the narration goes");
  // With an answer, the answer is the spared row as before.
  const answered = transcriptEntries(snapshot({ items: [...items, message("assistant", "Migrated 12 tables.", { turnId: "t1", messageKind: "answer" })] }), { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(answered.entries.some((e) => e.kind === "assistant" && e.text === "Migrated 12 tables."), "the answer stays");
});

test("compaction rows follow the shared rule: no state is settled, the legacy marker counts, a subagent's own stays out of the parent view", () => {
  const items = [
    message("user", "Keep going.", { turnId: "t1" }),
    // An old log's settled marker had no state at all.
    activity("context-compaction", { beforeTokens: 9_000, afterTokens: 900 }, { turnId: "t1", summary: "Context compacted" }),
    // An older log's spelling: thread.state.changed. Only "compacted" is a marker.
    activity("thread.state.changed", { state: "compacted", beforeTokens: 8_000, afterTokens: 800 }, { turnId: "t1", summary: "Context compacted" }),
    activity("thread.state.changed", { state: "running" }, { turnId: "t1", summary: "Running" }),
    activity("context-compaction", { state: "compacting" }, { turnId: "t1", summary: "Compacting context" }),
    activity("context-compaction", { state: "compaction-failed", error: "too large" }, { turnId: "t1", tone: "error", summary: "Context compaction failed" }),
    // A subagent compacting its own context: named on the payload only, or on the row.
    activity("context-compaction", { state: "compacted", agentId: "sub-1" }, { turnId: "t1", summary: "Context compacted" }),
    activity("context-compaction", { state: "compacted" }, { turnId: "t1", agentId: "sub-1", summary: "Context compacted" })
  ];
  const snap = snapshot({ items, roster: [{ id: "sub-1", kind: "subagent", agentKind: "agent", title: "Explore", status: "running" } as never] });
  const r = transcriptEntries(snap, { turns: 5, include: ALL, maxChars: 100_000 });
  assert.deepEqual(r.entries.filter((e) => e.kind === "compaction").map((e) => [e.state, e.beforeTokens, e.afterTokens]), [
    ["compacted", 9_000, 900], ["compacted", 8_000, 800], ["compacting", undefined, undefined], ["compaction-failed", undefined, undefined]
  ]);
  assert.deepEqual(r.entries.map((e) => e.kind), ["user", "compaction", "compaction", "compaction", "compaction"], "no other row: the running state is not a marker");
  // The drill-in keeps its own agent's rows as before: those stamped with its id on the row, as the GUI's drill-in reads them.
  const sub = transcriptEntries(snap, { turns: 5, agentId: "sub-1", include: ALL, maxChars: 100_000 });
  assert.deepEqual(sub.entries.map((e) => [e.kind, e.state, e.agentId]), [["compaction", "compacted", "sub-1"]]);
  const lean = transcriptEntries(snap, { turns: 5, include: new Set(["tools"]), maxChars: 100_000 });
  assert.ok(!lean.entries.some((e) => e.kind === "compaction"), "compaction rows are activity rows: include \"activity\"");
});
