/**
 * Replay tests on the 2026-09-26 captures (fixtures 26–30), folded through
 * the REAL normaliser with turns opened the way the session opens them
 * (`testing/capture-driver.ts`): how a subagent ends when it does not
 * complete, a kill of work that had already finished, the scheduler's loops
 * (`/loop`) and an autonomous goal (`/goal`). What each pins is the fixtures
 * README's observation of the same range (49–53); the shapes are the CLI's
 * own.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import { createTestClock } from "../../orchestration/testing/fakes.ts";
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

function only<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

function warnings(run: DrivenCapture): string[] {
  return only(run.events, "runtime.warning").map(
    (event) => `${event.payload.message} ${JSON.stringify(event.payload.detail ?? null)}`
  );
}

/** `[status, summary]` of a task's end rows. */
function ends(events: readonly RuntimeEvent[], taskId: string): Array<[string, string | undefined]> {
  return only(taskRows(events, taskId), "task.completed").map((event) => [
    event.payload.status,
    event.payload.summary
  ]);
}

// ---------------------------------------------------------------------------
// 26 / 28 — a subagent that does not complete ends `cancelled`, with a reason
// ---------------------------------------------------------------------------

test("26 a subagent whose own write the user declined ends stopped, the CLI's reason its result", () => {
  const CALL = "call-9bf5de49-72b3-4c9b-af5e-876dceb4294b-0";
  const run = driveCapture("26-subagent-child-write-rejected.ndjson");
  assert.deepEqual(ends(run.events, CALL), [
    ["stopped", "Subagent turn was cancelled: user rejected permission — User rejected the execution for tool `write`"]
  ]);
  assert.deepEqual(warnings(run), []);
});

test("28 a subagent the runtime stopped at its turn cap ends stopped, naming the cap", () => {
  const CALL = "call-2f2e6f94-7534-4265-8ed4-b6864cd0b59d-0";
  const run = driveCapture("28-subagent-max-turns.ndjson");
  assert.deepEqual(
    ends(run.events, CALL),
    [["stopped", "max turns reached (limit: 1)"]],
    "subagent_finished {status: cancelled, error}: the CLI never said failed — the row says why it stopped"
  );
  const usage = only(taskRows(run.events, CALL), "task.completed")[0]?.payload.usage;
  assert.deepEqual(usage, { totalTokens: 11_370, toolUses: 1, durationMs: 1861 });
  assert.deepEqual(warnings(run), []);
});

// ---------------------------------------------------------------------------
// 27 — killing work that already finished
// ---------------------------------------------------------------------------

test("27 a kill of a shell and a subagent that had already finished adds no second end", () => {
  const SHELL = "01a0de98-e27e-7d10-ba40-425c1e657f73";
  const AGENT = "call-e62d89fa-6820-4987-8328-2b7a493da236-1";
  const run = driveCapture("27-kill-already-exited.ndjson");
  assert.deepEqual(ends(run.events, SHELL), [["completed", "quick-done"]], "ended by its own task_completed");
  assert.deepEqual(ends(run.events, AGENT), [["completed", "ok"]], "ended by subagent_finished");
  assert.deepEqual(warnings(run), []);
});

// ---------------------------------------------------------------------------
// 29 — `/loop`: the scheduler's own reports, and the fire the CLI spawns
// ---------------------------------------------------------------------------

const LOOP = "01a0de9b-e17c-7fa0-83dc-a436461e59b5";
const FIRE = "01a0de9b-e17d-7391-93f1-ba66a305252f";

test("29 a loop is a roster row of its own: started when created, re-noted per fire, ended when deleted", () => {
  const run = driveCapture("29-loop-scheduled-task.ndjson");
  assert.deepEqual(warnings(run), [], "the scheduler's reports are mapped, never warnings");
  const rows = taskRows(run.events, LOOP);
  assert.deepEqual(
    rows.map((row) => [row.type, (row.payload as { status?: string }).status]),
    [
      ["task.started", undefined],
      ["task.progress", undefined],
      ["task.completed", "stopped"]
    ]
  );
  const [started, fired, deleted] = rows;
  assert.equal(started?.payload.taskType, "scheduled");
  assert.equal(started?.payload.title, "Every 1 minute: Reply with exactly: tick", "its cadence, then what it does");
  assert.equal((started?.payload as { description?: string }).description, "Reply with exactly: tick");
  assert.equal(started?.turnId, "turn-1", "on the turn that created it");
  assert.equal((fired?.payload as { summary?: string }).summary, "Fired once", "a fire notes itself, status-less");
  assert.equal((deleted?.payload as { summary?: string }).summary, "Deleted");
  for (const row of rows) {
    assert.equal(row.turnId, "turn-1", "every row of the loop rides the turn it was created on");
    assert.equal((row.payload as { agentId?: string }).agentId, undefined, "nobody's work but the thread's");
  }
});

test("29 a fire is the CLI's own subagent: an agent row under its id, whose end wakes the parent", () => {
  const run = driveCapture("29-loop-scheduled-task.ndjson");
  const rows = taskRows(run.events, FIRE);
  assert.equal(rows[0]?.type, "task.started");
  assert.equal(rows[0]?.payload.taskType, "subagent");
  assert.equal(rows[0]?.payload.title, "loop: Reply with exactly: tick (every 1 minute)");
  assert.deepEqual(ends(run.events, FIRE), [["completed", "tick"]]);
  assert.deepEqual(run.turns, ["turn-1", "wake-1", "turn-2"], "its end woke the parent for a turn of its own");
});

test("29 a loop never holds a deploy: only its fire's run is live work", () => {
  const run = driveCapture("29-loop-scheduled-task.ndjson");
  const clock = createTestClock(0);
  const registry = createLivenessRegistry({ clock });
  const readings: Array<[string, string]> = [];
  for (const event of run.events) {
    clock.set(Date.parse(event.createdAt));
    registry.observe(event);
    const task = (event.payload as { taskId?: string }).taskId;
    if (event.type.startsWith("task.") && (task === LOOP || task === FIRE)) {
      readings.push([`${event.type}:${task === LOOP ? "loop" : "fire"}`, String(registry.liveness("thread-1"))]);
    }
  }
  assert.deepEqual(readings, [
    ["task.started:loop", "null"],
    ["task.progress:loop", "null"],
    ["task.started:fire", "working"],
    ["task.completed:fire", "null"],
    ["task.completed:loop", "null"]
  ]);
});

// ---------------------------------------------------------------------------
// 30 — `/goal`: the thread's goal (goals §6.3), never a roster row
// ---------------------------------------------------------------------------

test("30 the goal is the thread's goal: set, stopped by its budget, cleared by /goal clear", () => {
  const run = driveCapture("30-goal.ndjson");
  assert.deepEqual(warnings(run), [], "goal_updated is mapped, never a warning — eleven of them in one short run");
  const goals = only(run.events, "thread.goal.updated");
  assert.deepEqual(
    goals.map((event) => [
      event.payload.change,
      event.turnId,
      event.payload.goal?.status ?? null,
      event.payload.goal?.phase ?? null
    ]),
    [
      ["set", "turn-1", "active", "executing"],
      // The planner runs under `executing` with `planning: true`: the goal's
      // `planning` phase, a hidden progress as it starts and as it ends 34 s
      // later — its frames in between, their counters moving, are none.
      ["progress", "turn-1", "active", "planning"],
      ["progress", "turn-1", "active", "executing"],
      ["limited", "turn-1", "budget-limited", "idle"],
      // 1.0.34's clear names no goal and no event: status `cleared`, every
      // id and text emptied (observation 53) — read as the level it is.
      ["cleared", "turn-2", null, null]
    ],
    "one row per change — a token tick alone is none"
  );
  const [set, , , limited, cleared] = goals;
  assert.equal(set?.payload.goal?.objective, "Create a file named goal.txt containing exactly: ok");
  assert.equal(set?.payload.goal?.tokenBudget, 20_000);
  assert.equal(limited?.payload.goal?.tokensUsed, 48_386);
  assert.equal(cleared?.payload.previous?.status, "budget-limited", "the goal as the thread showed it");
  assert.equal(
    run.events.some(
      (event) => event.type.startsWith("task.") && String((event.payload as { taskId?: string }).taskId).startsWith("goal:")
    ),
    false,
    "no roster row names the goal"
  );
});

test("30 the goal's planner is the CLI's own subagent; with it done, nothing of the goal holds a deploy", () => {
  const PLANNER = "01a0de9e-e2a1-7f31-a9be-c695a8111b2a";
  const run = driveCapture("30-goal.ndjson");
  assert.equal(taskRows(run.events, PLANNER)[0]?.payload.title, "goal plan writer");
  assert.deepEqual(ends(run.events, PLANNER), [["completed", "Done"]]);
  const clock = createTestClock(0);
  const registry = createLivenessRegistry({ clock });
  let liveWhileOnlyTheGoal = 0;
  for (const event of run.events) {
    clock.set(Date.parse(event.createdAt));
    registry.observe(event);
    if (event.type === "task.completed" && event.payload.taskId === PLANNER) {
      liveWhileOnlyTheGoal += registry.liveness("thread-1") === null ? 0 : 1;
    }
  }
  assert.equal(liveWhileOnlyTheGoal, 0, "with its planner done, nothing of the goal is live work");
});
