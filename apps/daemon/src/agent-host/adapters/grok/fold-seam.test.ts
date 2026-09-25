/**
 * The Grok normaliser's output through REAL ingestion, the REAL fold and the
 * REAL liveness registry — the seam where what the adapter emits becomes the
 * timeline, the roster and the tab's live state.
 *
 * Captured frames where a capture holds them; elsewhere synthetic frames of
 * the captured tool-call shape (see `normalize.test.ts`).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDomainEvent,
  createEmptyThreadState,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadActivityItem
} from "@orquester/api/agent-chat";

import { createIngestion } from "../../ingestion/index.ts";
import { FakeClock, FakeTimers, RecordingSink, counterIdGen } from "../../ingestion/test-harness.ts";
import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import { createTestClock } from "../../orchestration/testing/fakes.ts";
import type { AppendableDomainEvent } from "../../services.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";
import { agentFrames, readCapture } from "./fixtures.ts";
import { GROK_AGENT_LIVENESS_TTL_MS, GrokNormalizer } from "./normalize.ts";

const THREAD = "thread-1";
const SESSION = "01a0c1a7-1185-7171-9447-3aa38569088c";
const T0 = Date.parse("2026-09-24T10:00:00.000Z");

interface Seam {
  grok: GrokNormalizer;
  liveness: ReturnType<typeof createLivenessRegistry>;
  /** Ingest every event, in order, and wait for the sink. */
  feed(events: readonly RuntimeEvent[]): Promise<void>;
  /** Normalise one `session/update`, then feed what it produced. */
  update(update: Record<string, unknown>): Promise<void>;
  /** A turn the session starts: `turn.started`, and the normaliser's own reset. */
  startTurn(turnId: string): Promise<void>;
  state(): ReturnType<typeof fold>;
}

/** `livenessClock` drives the registry's TTLs by hand (no sleeps). */
function seam(livenessClock?: ReturnType<typeof createTestClock>): Seam {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const liveness = createLivenessRegistry(livenessClock === undefined ? {} : { clock: livenessClock });
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness,
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  let turnId: string | undefined;
  let counter = 0;
  const grok = new GrokNormalizer(
    {
      threadId: THREAD,
      stamp: () => {
        counter += 1;
        return { eventId: `g${counter}`, createdAt: new Date(T0 + counter).toISOString() };
      },
      uuid: () => `u${(counter += 1)}`,
      activeTurnId: () => turnId,
      planHost: { platform: "linux", env: { GROK_HOME: "~/home" } }
    },
    SESSION
  );
  const feed = async (events: readonly RuntimeEvent[]): Promise<void> => {
    for (const event of events) {
      await ingestion.ingest(event);
    }
    await ingestion.drain();
  };
  return {
    grok,
    liveness,
    feed,
    update: async (update) =>
      await feed(
        grok.handleSessionUpdate({ sessionId: SESSION, update, _meta: { promptId: "p1" } } as never)
      ),
    startTurn: async (id) => {
      turnId = id;
      grok.beginTurn();
      await feed([grok.event("turn.started", {}, id)]);
    },
    state: () => fold(sink.events())
  };
}

/** Stamp sequences as the store does and fold; `thread.created` is the host's. */
function fold(events: AppendableDomainEvent[]) {
  const created: DomainEvent = {
    seq: 1,
    eventId: "created",
    threadId: THREAD,
    occurredAt: "2026-09-24T09:59:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {},
    type: "thread.created",
    payload: {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "New thread",
      adapter: "grok",
      refId: "grok",
      accountId: "acc1",
      home: "system",
      modelSelection: { model: "grok-4.6" },
      runtimeMode: "approval-required"
    }
  };
  let state = applyDomainEvent(createEmptyThreadState(), created);
  let seq = 1;
  for (const event of events) {
    seq += 1;
    state = applyDomainEvent(state, { ...event, seq } as DomainEvent);
  }
  return state;
}

function rowsOfCall(activities: readonly ThreadActivityItem[], callId: string): ThreadActivityItem[] {
  return activities.filter(
    (row) =>
      row.activityKind.startsWith("tool.") && (row.payload as { toolUseId?: string }).toolUseId === callId
  );
}

// ---------------------------------------------------------------------------

const ECHO_CALL = "call-a7c3bfe8-967c-4ffe-916f-749b3b6da4c2-0";

test("a late status-less update of a finished call leaves the timeline one completed call", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  for (const entry of agentFrames(readCapture("03b-bash-output-accumulation.ndjson"))) {
    const params = entry.params as SessionNotification | undefined;
    const callId = (params?.update as { toolCallId?: string } | undefined)?.toolCallId;
    if (entry.method === "session/update" && callId === ECHO_CALL) {
      await s.feed(s.grok.handleSessionUpdate(params!));
    }
  }
  // Never captured — the defect is read off the code path: a resend after the end.
  await s.update({
    sessionUpdate: "tool_call_update",
    toolCallId: ECHO_CALL,
    content: [{ type: "content", content: { type: "text", text: "hi\n" } }]
  });
  // The exit sweep, as a dying process runs it.
  await s.feed(s.grok.failOpenTools("The agent process exited."));

  const rows = rowsOfCall(s.state().activities, ECHO_CALL);
  assert.equal(rows.filter((row) => row.activityKind === "tool.started").length, 1, "one start, one call");
  const last = rows.at(-1);
  assert.equal(last?.activityKind, "tool.completed");
  assert.equal((last?.payload as { status?: string }).status, "completed", "a completed command never fails");
});

// ---------------------------------------------------------------------------
// spawn_subagent through ingestion, the fold and the liveness registry
// ---------------------------------------------------------------------------

/** The captured tool-call shape; `spawn_subagent` itself is not captured (see normalize.test.ts). */
const SPAWN_META = {
  "x.ai/tool": {
    version: 1,
    name: "spawn_subagent",
    kind: "other",
    namespace: "grok_build",
    label: "Spawn Subagent",
    read_only: false
  }
};
const SUB_A = "01a0c1a9-7b2e-7c3d-8e4f-0123456789ab";
const SUB_B = "01a0c1aa-1111-7222-8333-444455556666";

const spawnStart = (callId: string, input: Record<string, unknown>) => ({
  sessionUpdate: "tool_call",
  toolCallId: callId,
  title: "spawn_subagent",
  rawInput: input,
  _meta: SPAWN_META
});

const spawnEnd = (
  callId: string,
  status: "completed" | "failed",
  text: string,
  rawOutput?: Record<string, unknown>
) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: callId,
  status,
  content: [{ type: "content", content: { type: "text", text } }],
  ...(rawOutput === undefined ? {} : { rawOutput })
});

const FIND_CALLERS = {
  prompt: "Find every caller of add().",
  description: "find callers",
  subagent_type: "explore"
};

/** The foreground completion tag, and a spawn's text answer (see normalize.test.ts). */
const completion = (subagentId?: string) => ({
  type: "SubagentCompleted",
  ...(subagentId === undefined ? {} : { subagent_id: subagentId })
});
const textAnswer = (subagentId: string) => ({
  type: "Text",
  text: `Subagent started.\nsubagent_id: ${subagentId}\ntype: general-purpose\ndescription: run tests`
});

let polls = 0;

/** A `get_command_or_subagent_output` call answered with one `TaskOutput` Result (T3's reader). */
async function poll(s: Seam, result: Record<string, unknown>): Promise<void> {
  polls += 1;
  const toolCallId = `call-poll-${polls}`;
  const title = "get_command_or_subagent_output";
  await s.update({ sessionUpdate: "tool_call", toolCallId, title, rawInput: {} });
  await s.update({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    content: [],
    rawOutput: { type: "TaskOutput", Result: result }
  });
}

function agent(s: Seam, taskId: string) {
  const roster = s.state().roster;
  const row = roster.find((entry) => entry.id === taskId);
  assert.ok(row, `roster had ${JSON.stringify(roster.map((entry) => entry.id))}`);
  return row;
}

test("a foreground Grok subagent runs, ends with its result, and its launch row is the agent's", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  await s.update(spawnStart("call-s1", FIND_CALLERS));

  const running = agent(s, "call-s1");
  assert.equal(running.status, "running");
  assert.equal(running.title, "find callers");
  assert.equal(s.liveness.liveness(THREAD), "working", "a running subagent is live work");

  const result = "add() is called from main.js:3.";
  await s.update(spawnEnd("call-s1", "completed", result, completion(SUB_A)));
  const done = agent(s, "call-s1");
  assert.equal(done.status, "completed");
  assert.equal(done.result, result);
  assert.equal(done.activationCount, 1);
  assert.equal(s.liveness.liveness(THREAD), null);

  // The GUI hides a call's rows behind an AGENT task row naming it
  // (`deriveWorkLogEntries`, packages/ui entries.logic.ts, pinned by "hides a
  // launch tool row once its task row replaces it") unless the call failed.
  const activities = s.state().activities;
  const anchors = activities.filter((row) => row.activityKind.startsWith("task."));
  assert.ok(anchors.length >= 2);
  for (const row of anchors) {
    const payload = row.payload as { agentKind?: string; toolUseId?: string };
    assert.equal(payload.agentKind, "agent", "ingestion stamps it an agent");
    assert.equal(payload.toolUseId, "call-s1", "…launched by the spawn call");
  }
  const launchRows = rowsOfCall(activities, "call-s1");
  assert.ok(launchRows.length >= 2);
  for (const row of launchRows) {
    const payload = row.payload as { itemType?: string; status?: string };
    assert.equal(payload.itemType, "collab_agent_tool_call");
    assert.notEqual(payload.status, "failed");
  }
});

test("a resumed Grok subagent reopens as run 2 and settles with its new result", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  await s.update(spawnStart("call-s1", FIND_CALLERS));
  await s.update(spawnEnd("call-s1", "completed", "main.js:3", completion(SUB_A)));
  assert.equal(agent(s, "call-s1").status, "completed");

  await s.startTurn("turn-2");
  await s.update(spawnStart("call-s2", { prompt: "Now check the tests.", resume_from: SUB_A }));
  const reopened = agent(s, "call-s1");
  assert.equal(reopened.status, "running");
  assert.equal(reopened.activationCount, 2);
  assert.equal(reopened.result, null, "the previous run's result is cleared");
  assert.equal(s.liveness.liveness(THREAD), "working");

  await s.update(spawnEnd("call-s2", "completed", "tests/add.test.js:4", completion()));
  const settled = agent(s, "call-s1");
  assert.equal(settled.status, "completed");
  assert.equal(settled.result, "tests/add.test.js:4");
  assert.equal(settled.activationCount, 2);
  assert.equal(s.state().roster.length, 1, "one agent, two runs");
  assert.equal(s.liveness.liveness(THREAD), null);
});

test("a background Grok subagent outlives its call and turn; a poll between turns ends it", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  const input = { prompt: "Run the suite.", description: "run tests", background: true };
  await s.update(spawnStart("call-bg", input));
  await s.update(spawnEnd("call-bg", "completed", "Subagent started.", textAnswer(SUB_B)));
  await s.feed(s.grok.endTurn());
  await s.feed([s.grok.turnCompleted("turn-1", { stopReason: "end_turn" })]);

  assert.equal(agent(s, "call-bg").status, "running", "its call answered; the agent works on");
  assert.equal(s.liveness.liveness(THREAD), "working", "live work outlives the parent's turn");

  // The CLI woke the parent (no turn of ours) and the model polled the id.
  const command = "[subagent:general-purpose] run tests";
  await poll(s, { task_id: SUB_B, command, status: "completed", output: "12 tests pass." });
  const done = agent(s, "call-bg");
  assert.equal(done.status, "completed");
  assert.equal(done.result, "12 tests pass.");
  assert.equal(s.liveness.liveness(THREAD), null);
});

test("a background Grok subagent still running when Stop comes is closed by it", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  const input = { prompt: "Run the suite.", description: "run tests", background: true };
  await s.update(spawnStart("call-bg", input));
  await s.update(spawnEnd("call-bg", "completed", "Subagent started.", textAnswer(SUB_B)));
  await s.feed(s.grok.stopBackgroundTasks());
  assert.equal(agent(s, "call-bg").status, "interrupted");
  assert.equal(s.liveness.liveness(THREAD), null);
});

test("a foreground Grok subagent its turn cut keeps running in the background", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  await s.update(spawnStart("call-s1", { prompt: "p", description: "find callers" }));
  // `session/cancel`: the call gets no terminal frame (fixture 05), the turn
  // settles, and the child keeps running ("caller gone; auto-backgrounding").
  await s.feed(s.grok.endTurn());
  const cancelled = { stopReason: "cancelled", cancellationCategory: "MidTurnAbort" };
  await s.feed([s.grok.turnCompleted("turn-1", cancelled)]);
  // The session settles `ready` after the interrupted turn (`settleTurn`).
  await s.feed([s.grok.event("session.state.changed", { state: "ready" })]);
  const cut = agent(s, "call-s1");
  assert.equal(cut.status, "running");
  assert.equal(cut.isBackgrounded, true);
  assert.equal(s.liveness.liveness(THREAD), "working", "it still holds a deploy's drain");
  await s.feed(s.grok.stopBackgroundTasks());
  assert.equal(agent(s, "call-s1").status, "interrupted");
  assert.equal(s.liveness.liveness(THREAD), null);
});

test("a Grok shell a poll ended stays ended while a snapshot lists it: one start, one end", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  const shell = "01a0c1a7-3335-7fc3-894b-56f0bb60a6db";
  const command = "npm run dev";
  const update = { sessionUpdate: "task_backgrounded", tool_call_id: "call-sh", task_id: shell, command };
  await s.feed(s.grok.handleXaiNotification("_x.ai/task_backgrounded", { sessionId: SESSION, update }));
  assert.equal(s.liveness.liveness(THREAD), "monitoring");
  await poll(s, { task_id: shell, command, status: "completed", output: "bye" });
  assert.equal(s.liveness.liveness(THREAD), null);

  const listing = (tasks: unknown[]) =>
    s.grok.handleXaiNotification("_x.ai/session_notification", {
      sessionId: SESSION,
      update: { sessionUpdate: "background_tasks", tasks }
    });
  await s.feed(listing([{ task_id: shell, command, kind: "bash", status: "completed" }]));
  assert.equal(s.liveness.liveness(THREAD), null, "a finished shell the CLI still lists holds no drain");
  await s.feed(listing([]));
  const rows = s
    .state()
    .activities.filter(
      (row) => row.activityKind.startsWith("task.") && (row.payload as { taskId?: string }).taskId === shell
    );
  assert.deepEqual(
    rows.map((row) => row.activityKind),
    ["task.started", "task.completed"]
  );
  assert.equal(agent(s, shell).status, "completed");
});

test("a Grok shell Stop closed counts live again while a snapshot lists it running", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  const shell = "01a0c1a7-3335-7fc3-894b-56f0bb60a6db";
  const command = "npm run dev";
  const update = { sessionUpdate: "task_backgrounded", tool_call_id: "call-sh", task_id: shell, command };
  await s.feed(s.grok.handleXaiNotification("_x.ai/task_backgrounded", { sessionId: SESSION, update }));
  // The session-scoped Stop writes the end itself; whether `session/cancel`
  // kills the CLI's background shell is not captured.
  await s.feed(s.grok.stopBackgroundTasks());
  const closed = agent(s, shell).status;
  assert.notEqual(closed, "running");
  assert.equal(s.liveness.liveness(THREAD), null);

  const task = { task_id: shell, command, kind: "bash", status: "running" };
  const snapshot = { sessionId: SESSION, update: { sessionUpdate: "background_tasks", tasks: [task] } };
  await s.feed(s.grok.handleXaiNotification("_x.ai/session_notification", snapshot));
  assert.equal(s.liveness.liveness(THREAD), "monitoring", "the CLI still runs it: a deploy must wait");
  assert.equal(agent(s, shell).status, closed, "the roster reads the start as a late delivery");
});

test("a Grok agent nobody polls holds working for an hour, re-armed by a running poll", async () => {
  const clock = createTestClock(0);
  const s = seam(clock);
  await s.startTurn("turn-1");
  const input = { prompt: "Run the suite.", description: "run tests", background: true };
  await s.update(spawnStart("call-bg", input));
  await s.update(spawnEnd("call-bg", "completed", "Subagent started.", textAnswer(SUB_B)));
  await s.feed(s.grok.endTurn());
  await s.feed([s.grok.turnCompleted("turn-1", { stopReason: "end_turn" })]);

  clock.set(GROK_AGENT_LIVENESS_TTL_MS - 1);
  assert.equal(s.liveness.liveness(THREAD), "working");
  const command = "[subagent:general-purpose] run tests";
  await poll(s, { task_id: SUB_B, command, status: "running" });
  clock.set(2 * GROK_AGENT_LIVENESS_TTL_MS - 2);
  assert.equal(s.liveness.liveness(THREAD), "working", "the running poll re-armed the hour");
  clock.set(2 * GROK_AGENT_LIVENESS_TTL_MS - 1);
  assert.equal(s.liveness.liveness(THREAD), null, "an hour with no row naming it: the drain may go");
  assert.equal(agent(s, "call-bg").status, "running", "liveness lapsed, the roster row did not");

  await poll(s, { task_id: SUB_B, command, status: "completed", output: "done at last" });
  assert.equal(agent(s, "call-bg").status, "completed", "a later end is recorded as any end is");
  assert.equal(agent(s, "call-bg").result, "done at last");
  assert.equal(s.liveness.liveness(THREAD), null);
});
