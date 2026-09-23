import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanImplementationPrompt, type ThreadItem } from "@orquester/api/agent-chat";
import { activity, message, snapshot, stamp, turn } from "./fixtures.ts";
import { transcriptEntries } from "./transcript.ts";

const ALL = new Set(["reasoning", "tools", "activity"] as const);

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
  assert.deepEqual(last.coveredTurns, [2, 2]); assert.ok(last.entries.every((e) => e.turn === 2));
  const big = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(10), startedAt: stamp(10), completedAt: stamp(20) })],
    items: [message("user", "a".repeat(3000), { turnId: "t1" }), message("reasoning", "r".repeat(3000), { turnId: "t1" }), message("assistant", "b".repeat(3000), { turnId: "t1" }),
      activity("tool.completed", { itemType: "command_execution", toolUseId: "x", title: "t", status: "completed", detail: "d".repeat(3000) }, { turnId: "t2", tone: "tool" }), message("assistant", "c".repeat(3000), { turnId: "t2" })] });
  const shed1 = transcriptEntries(big, { turns: 5, include: ALL, maxChars: 12_000 });
  assert.equal(shed1.truncated, true); assert.ok(!shed1.entries.some((e) => e.kind === "reasoning"));
  assert.ok(shed1.entries.find((e) => e.kind === "tool")!.tool!.detail!.length <= 200);
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
  assert.ok(JSON.stringify(r.entries).length <= 40_000); assert.equal(r.truncated, true);
  assert.deepEqual([r.entries.at(-1)!.kind, r.entries.at(-1)!.text], ["assistant", "all 300 steps done"]);
  assert.equal(r.entries.at(-2)!.tool!.title, "Run step 299", "the newest rows are kept");
  assert.ok(!r.entries.some((e) => e.kind === "user"), "the oldest rows go first");
  // A final reply that alone is over the budget keeps its head.
  const report = snapshot({ items: [message("user", "report", { turnId: "t1" }), message("assistant", "z".repeat(10_000), { turnId: "t1" })] });
  const capped = transcriptEntries(report, { turns: 5, include: ALL, maxChars: 2_000 });
  assert.ok(JSON.stringify(capped.entries).length <= 2_000); assert.equal(capped.truncated, true);
  assert.deepEqual(capped.entries.map((e) => e.kind), ["assistant"]);
  assert.match(capped.entries[0]!.text!, /^z{1000,}…$/u);
});
