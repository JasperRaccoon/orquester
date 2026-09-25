/**
 * Replay tests on the 2026-09-25 captures (fixtures 15–23): real Grok
 * subagent, background-task and monitor traffic folded through the REAL
 * normaliser, with turns opened the way the session opens them
 * (`testing/capture-driver.ts`).
 *
 * What each capture pins is the fixtures README's observation of the same
 * number range (37–45); the shapes are the CLI's own, not T3's or the
 * binary's strings.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { agentFrames, readCapture } from "./fixtures.ts";
import { GROK_AGENT_LIVENESS_TTL_MS } from "./normalize.ts";
import { driveCapture, type DrivenCapture } from "./testing/capture-driver.ts";

type TaskRow = Extract<
  RuntimeEvent,
  { type: "task.started" | "task.progress" | "task.updated" | "task.completed" }
>;

function taskRows(events: readonly RuntimeEvent[], taskId: string): TaskRow[] {
  return events.filter(
    (event): event is TaskRow => event.type.startsWith("task.") && (event.payload as { taskId?: string }).taskId === taskId
  );
}

/** `[type, status]` of a task's rows — `status` absent on progress/update rows that carry none. */
function lifecycle(events: readonly RuntimeEvent[], taskId: string): Array<[string, string | undefined]> {
  return taskRows(events, taskId).map((event) => [event.type, (event.payload as { status?: string }).status]);
}

function only<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

/** Every item-lifecycle row of one call. */
function callRows(events: readonly RuntimeEvent[], callId: string): RuntimeEvent[] {
  return events.filter(
    (event) =>
      (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") &&
      event.itemId === callId
  );
}

/** The assistant text an author streamed: `undefined` = the parent, else an agent's id. */
function textOf(events: readonly RuntimeEvent[], agentId: string | undefined, turnId?: string): string {
  return only(events, "content.delta")
    .filter((event) => event.payload.streamKind === "assistant_text")
    .filter((event) => event.agentId === agentId)
    .filter((event) => turnId === undefined || event.turnId === turnId)
    .map((event) => event.payload.delta)
    .join("");
}

function unmapped(run: DrivenCapture): string[] {
  return only(run.events, "runtime.warning")
    .filter((event) => /unmapped/.test(event.payload.message))
    .map((event) => `${event.payload.message} ${JSON.stringify(event.payload.detail)}`);
}

// ---------------------------------------------------------------------------
// 15 — a foreground subagent, run to its end
// ---------------------------------------------------------------------------

const FG_CALL = "call-178a2a0c-2c5e-49a6-8fb8-e0fee73d6c1e-0";
const FG_CHILD_CALL = "call-bc7ab91e-2c90-4a0b-b578-8ba7dc84ce7e-0";

test("15 foreground: the call starts the agent, subagent_finished ends it once with its clean output", () => {
  const run = driveCapture("15-subagent-foreground.ndjson");
  assert.deepEqual(unmapped(run), []);
  const rows = taskRows(run.events, FG_CALL);
  const [started] = rows;
  assert.equal(started?.type, "task.started");
  assert.equal(started?.payload.taskType, "subagent");
  assert.equal(started?.payload.toolUseId, FG_CALL);
  assert.equal(started?.payload.title, "echo check");
  assert.equal(started?.payload.role, "general-purpose");
  assert.equal(started?.turnId, "turn-1");

  const ends = only(rows, "task.completed");
  assert.equal(ends.length, 1, "subagent_finished ends it; the SubagentCompleted answer after it adds nothing");
  assert.equal(ends[0]!.payload.status, "completed");
  assert.equal(ends[0]!.payload.summary, "sub-ok", "the run's own output, never the call's <subagent_meta> blocks");
  assert.deepEqual(ends[0]!.payload.usage, { totalTokens: 12_011, toolUses: 1, durationMs: 3731 });
  assert.equal(ends[0]!.payload.livenessTtlMs, GROK_AGENT_LIVENESS_TTL_MS);
  assert.deepEqual(
    rows.filter((row) => row.type === "task.updated"),
    [],
    "a run that finished in the foreground was never sent to the background"
  );

  const progress = only(rows, "task.progress");
  assert.ok(progress.length >= 1, "subagent_progress is the agent's heartbeat");
  assert.deepEqual(progress[0]!.payload.usage, { totalTokens: 11_925, toolUses: 1, durationMs: 2102 });
  assert.equal(
    (progress[0]!.payload as { status?: string }).status,
    undefined,
    "a heartbeat names no status: a late one can never reopen an ended run"
  );
  assert.equal(progress[0]!.payload.livenessTtlMs, GROK_AGENT_LIVENESS_TTL_MS, "…and re-arms its hour");
});

test("15 foreground: the child session's frames are the agent's own rows, on the parent turn", () => {
  const run = driveCapture("15-subagent-foreground.ndjson");
  const child = callRows(run.events, FG_CHILD_CALL);
  assert.ok(child.length >= 2, "the child's run_terminal_command is surfaced");
  for (const row of child) {
    assert.equal(row.agentId, FG_CALL, "owned by the agent, on the envelope…");
    assert.equal((row.payload as { agentId?: string }).agentId, FG_CALL, "…and on the payload");
    assert.equal(row.turnId, "turn-1", "riding the parent turn live when it started");
  }
  assert.equal(child.at(-1)?.type, "item.completed");

  assert.equal(textOf(run.events, FG_CALL), "sub-ok", "the child's words are the agent's");
  const parentText = textOf(run.events, undefined);
  assert.match(parentText, /DONE$/, "the parent's own answer");
  assert.equal(parentText.includes("sub-ok"), false, "…and never the child's words in the parent's bubble");
  const childReasoning = only(run.events, "content.delta").filter(
    (event) => event.payload.streamKind === "reasoning_text" && event.agentId === FG_CALL
  );
  assert.ok(childReasoning.length > 0, "the child's thinking is the agent's reasoning");
  assert.ok(
    childReasoning.every((event) => event.itemId !== undefined),
    "every owned block names its item, so a turnless one can be closed"
  );
  const childSegments = only(run.events, "item.completed").filter(
    (event) => event.agentId === FG_CALL && event.payload.itemType !== "command_execution"
  );
  assert.ok(childSegments.length > 0, "the child's own turn end closes its segments");
});

/** The `_meta.totalTokens` a capture's frames carry, split by session. */
function contextSizes(file: string, parentSessionId: string): { parent: Set<number>; childOnly: Set<number> } {
  const parent = new Set<number>();
  const child = new Set<number>();
  for (const frame of agentFrames(readCapture(file))) {
    const params = frame.params as { sessionId?: string; _meta?: { totalTokens?: unknown } } | undefined;
    const size = params?._meta?.totalTokens;
    if (frame.method !== "session/update" || typeof size !== "number" || size <= 0) {
      continue;
    }
    (params?.sessionId === parentSessionId ? parent : child).add(size);
  }
  return { parent, childOnly: new Set([...child].filter((size) => !parent.has(size))) };
}

test("15 foreground: the child's context size never moves the parent's meter", () => {
  const run = driveCapture("15-subagent-foreground.ndjson", { contextWindow: 500_000 });
  const sizes = only(run.events, "thread.token-usage.updated").map((event) => event.payload.usage.usedTokens);
  const { parent, childOnly } = contextSizes("15-subagent-foreground.ndjson", run.sessionId);
  assert.ok(childOnly.size > 0, "the child streams context sizes of its own");
  assert.deepEqual(
    sizes.filter((size) => childOnly.has(size)),
    [],
    `a child's _meta.totalTokens reached the meter: ${JSON.stringify(sizes)}`
  );
  assert.ok(sizes.length > 0 && sizes.every((size) => parent.has(size)), "the meter reads the parent alone");
});

// ---------------------------------------------------------------------------
// 16 — a background subagent, polled while it ran and after its end
// ---------------------------------------------------------------------------

const BG_CALL = "call-a00d2553-adc5-48f4-9181-4a66616fc94f-0";
const BG_CHILD_SHELL = "call-88e87ad3-152e-4eab-b522-89fc544e8db5-0";

test("16 background: a running poll re-arms, subagent_finished ends it, the late poll adds nothing", () => {
  const run = driveCapture("16-subagent-background-poll.ndjson");
  assert.deepEqual(unmapped(run), []);
  const rows = taskRows(run.events, BG_CALL);
  assert.equal(rows[0]?.type, "task.started");
  assert.equal(rows[0]?.payload.isBackgrounded, true);
  const ends = only(rows, "task.completed");
  assert.equal(ends.length, 1, "once: the poll after the end is no second end");
  assert.equal(ends[0]!.payload.status, "completed");
  assert.equal(ends[0]!.payload.summary, "bg-done");
  assert.equal(ends[0]!.turnId, "turn-1", "an end after its turn names the turn it ran in");
  assert.ok(
    only(rows, "task.progress").some((row) => (row.payload as { status?: string }).status === "running"),
    "the running poll answer re-arms it"
  );
});

test("16 background: the child's own auto-backgrounded shell is the agent's, and ends by task_completed", () => {
  const run = driveCapture("16-subagent-background-poll.ndjson");
  const shell = taskRows(run.events, BG_CHILD_SHELL);
  assert.deepEqual(
    shell.map((row) => row.type),
    ["task.started", "task.completed"],
    "one start, one end — the completed listing after task_completed adds nothing"
  );
  for (const row of shell) {
    assert.equal(row.payload.agentId, BG_CALL, "owned by the subagent whose session started it");
    assert.equal(row.payload.taskType, "shell");
  }
  const end = shell[1] as Extract<RuntimeEvent, { type: "task.completed" }>;
  assert.equal(end.payload.status, "completed");
  assert.equal(end.payload.summary, "bg-done");
  assert.equal(end.payload.exitCode, 0);
});

test("16 background: the CLI's wake is a turn of its own, holding the parent's reply", () => {
  const run = driveCapture("16-subagent-background-poll.ndjson");
  assert.deepEqual(run.turns, ["turn-1", "wake-1", "turn-2"]);
  assert.match(textOf(run.events, undefined, "wake-1"), /finished successfully/);
});

// ---------------------------------------------------------------------------
// 17 — resume_from relaunches a finished subagent
// ---------------------------------------------------------------------------

const FIRST_CALL = "call-22f4fca9-389a-4943-a3bc-f130066bc4ce-0";
const RESUME_CALL = "call-51239e69-2c1c-4685-bcea-efcad1d1ad5b-1";
const RESUMED_CHILD_CALL = "call-173a5fa4-9b39-4c56-afe0-1cccd99c86b7-1";

test("17 resume_from: the same roster task runs again under the new call and the new subagent id", () => {
  const run = driveCapture("17-subagent-resume-from.ndjson");
  assert.deepEqual(unmapped(run), []);
  const rows = taskRows(run.events, FIRST_CALL);
  const starts = only(rows, "task.started");
  assert.deepEqual(
    starts.map((row) => row.payload.toolUseId),
    [FIRST_CALL, RESUME_CALL],
    "the relaunch contract: a NEW launch id reopens the row"
  );
  const ends = only(rows, "task.completed");
  assert.deepEqual(
    ends.map((row) => [row.payload.status, row.payload.summary, row.payload.toolUseId]),
    [
      ["completed", "first-run", FIRST_CALL],
      ["completed", "resumed-ok", RESUME_CALL]
    ],
    "the resumed run's own end, found through the new id's resumed_from"
  );
  assert.deepEqual(taskRows(run.events, RESUME_CALL), [], "the resume call is never an agent of its own");
  for (const row of callRows(run.events, RESUMED_CHILD_CALL)) {
    assert.equal(row.agentId, FIRST_CALL, "the resumed child session's rows are the same agent's");
  }
});

// ---------------------------------------------------------------------------
// 18 — kill_command_or_subagent, of a subagent and of a shell
// ---------------------------------------------------------------------------

const KILLED_AGENT = "call-e64257f2-037e-4f00-95c4-f512daeb136b-1";
const KILLED_SHELL = "01a0d911-4089-7b73-a6b2-4490a4cfe87a";

test("18 kill: the captured KillTask answer ends the agent stopped, once — subagent_finished adds nothing", () => {
  const run = driveCapture("18-subagent-kill.ndjson");
  assert.deepEqual(unmapped(run), []);
  assert.deepEqual(lifecycle(run.events, KILLED_AGENT).filter(([type]) => type !== "task.progress"), [
    ["task.started", undefined],
    ["task.completed", "stopped"]
  ]);
});

test("18 kill: a killed shell ends once, by task_completed — the kill answer and the failed listing add nothing", () => {
  const run = driveCapture("18-subagent-kill.ndjson");
  assert.deepEqual(lifecycle(run.events, KILLED_SHELL).filter(([type]) => type !== "task.progress"), [
    ["task.started", undefined],
    ["task.completed", "stopped"]
  ]);
});

// ---------------------------------------------------------------------------
// 19 — a background subagent nobody polls
// ---------------------------------------------------------------------------

const UNPOLLED = "call-b929f166-b896-45fa-bdb5-4b7129d05044-0";

test("19 unpolled: subagent_finished alone ends the run, and the CLI wakes the parent", () => {
  const run = driveCapture("19-subagent-background-unpolled.ndjson");
  assert.deepEqual(unmapped(run), []);
  const ends = only(taskRows(run.events, UNPOLLED), "task.completed");
  assert.deepEqual(
    ends.map((row) => [row.payload.status, row.payload.summary]),
    [["completed", "e-done"]]
  );
  assert.deepEqual(run.turns, ["turn-1", "wake-1"]);
  assert.match(textOf(run.events, undefined, "wake-1"), /e-done/);
});

// ---------------------------------------------------------------------------
// 20 — a monitor
// ---------------------------------------------------------------------------

const MONITOR_CALL = "call-a10c31e1-4cd0-406b-baff-e31166971d6d-0";
const MONITOR = "01a0d913-6204-7391-8dbb-5ea888f73f03";

test("20 monitor: one monitor task, its events as progress, its end by task_completed", () => {
  const run = driveCapture("20-monitor.ndjson");
  assert.deepEqual(unmapped(run), []);
  const rows = taskRows(run.events, MONITOR);
  const started = only(rows, "task.started");
  assert.equal(started.length, 1, "task_backgrounded, the snapshot and the Monitor answer are one start");
  assert.equal(started[0]!.payload.taskType, "monitor");
  assert.equal(started[0]!.payload.title, "tick watch");
  assert.equal(started[0]!.payload.toolUseId, MONITOR_CALL);
  assert.deepEqual(
    only(rows, "task.progress").map((row) => row.payload.summary),
    ["tick 1", "tick 2"],
    "each monitor_event is the monitor's latest line"
  );
  const ends = only(rows, "task.completed");
  assert.deepEqual(
    ends.map((row) => [row.payload.status, row.payload.exitCode]),
    [["completed", 0]],
    "the completed listing after task_completed adds nothing"
  );
  assert.deepEqual(run.turns, ["turn-1", "wake-1", "wake-2", "wake-3"], "two events and the end woke it");
});

// ---------------------------------------------------------------------------
// 21 — a session-scoped Stop while a background subagent and shell run
// ---------------------------------------------------------------------------

const STOP_SHELL = "01a0d915-61b7-7132-b432-a6c95b3f7778";
const STOP_AGENT = "call-7b249d13-32d3-4f24-a3ad-b582665c9c5a-1";

test("21 Stop: the CLI cancels the subagent but keeps the shell; a poll saying so counts the shell live again", () => {
  const run = driveCapture("21-stop-with-background-work.ndjson", {
    atNote: (note, { grok }) =>
      /sending session\/cancel with no prompt in flight/.test(note)
        ? [...grok.failOpenTools("Stopped."), ...grok.stopBackgroundTasks()]
        : []
  });
  assert.deepEqual(unmapped(run), []);
  assert.deepEqual(
    lifecycle(run.events, STOP_AGENT).filter(([type]) => type !== "task.progress"),
    [
      ["task.started", undefined],
      ["task.completed", "stopped"]
    ],
    "the adapter's own end; the CLI's `cancelled` after it adds nothing"
  );
  assert.deepEqual(
    lifecycle(run.events, STOP_SHELL).map(([type]) => type),
    ["task.started", "task.completed", "task.started"],
    "the poll answering `running` re-emits the shell's own start: live again"
  );
});

// ---------------------------------------------------------------------------
// 22 — a foreground subagent past its await budget
// ---------------------------------------------------------------------------

const BUDGET_CALL = "call-058f81b9-857c-4320-84f2-eefa4e2b3d6c-0";

test("22 await budget: the Text answer sends the run to the background, once; subagent_finished ends it", () => {
  const run = driveCapture("22-subagent-await-budget.ndjson");
  assert.deepEqual(unmapped(run), []);
  const rows = taskRows(run.events, BUDGET_CALL).filter((row) => row.type !== "task.progress");
  assert.deepEqual(
    rows.map((row) => [row.type, (row.payload as { isBackgrounded?: boolean }).isBackgrounded]),
    [
      ["task.started", false],
      ["task.updated", true],
      ["task.completed", undefined]
    ]
  );
  const end = rows[2] as Extract<RuntimeEvent, { type: "task.completed" }>;
  assert.equal(end.payload.summary, "late-ok");
});

// ---------------------------------------------------------------------------
// 23 — a turn-scoped Stop that cuts a foreground subagent
// ---------------------------------------------------------------------------

const CUT_CALL = "call-051e75a0-fd17-4ac0-b9cd-a9d831db32a0-0";

test("23 cut: session/cancel cancels the foreground child — never sent to the background, ended stopped", () => {
  const run = driveCapture("23-stop-cuts-foreground-subagent.ndjson", {
    atNote: (note, control) => (/sending session\/cancel mid-turn/.test(note) ? control.interrupt() : [])
  });
  assert.deepEqual(unmapped(run), []);
  const rows = taskRows(run.events, CUT_CALL).filter((row) => row.type !== "task.progress");
  assert.deepEqual(
    rows.map((row) => [row.type, (row.payload as { status?: string }).status]),
    [
      ["task.started", undefined],
      ["task.completed", "stopped"]
    ],
    "no task.updated {isBackgrounded}: the CLI cancels a cut foreground child (subagent_finished cancelled)"
  );
});
