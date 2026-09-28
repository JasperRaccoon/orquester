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
import { FakeClock, RecordingSink, counterIdGen } from "../../ingestion/test-harness.ts";
import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import { createTestClock } from "../../orchestration/testing/fakes.ts";
import type { AppendableDomainEvent } from "../../services.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";
import { agentFrames, readCapture } from "./fixtures.ts";
import { GrokNormalizer } from "./normalize.ts";

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
  /** A later launch's normaliser — every launch builds its own — fed through this seam. */
  launch(launchNonce: string): GrokNormalizer;
}

/** `livenessClock` drives the registry's TTLs by hand (no sleeps). */
function seam(livenessClock?: ReturnType<typeof createTestClock>): Seam {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const liveness = createLivenessRegistry(livenessClock === undefined ? {} : { clock: livenessClock });
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness,
    clock,
    idGen: counterIdGen()
  });
  let turnId: string | undefined;
  let counter = 0;
  const normalizerFor = (launchNonce: string): GrokNormalizer =>
    new GrokNormalizer(
      {
        threadId: THREAD,
        stamp: () => {
          counter += 1;
          return { eventId: `g${counter}`, createdAt: new Date(T0 + counter).toISOString() };
        },
        uuid: () => `u${(counter += 1)}`,
        activeTurnId: () => turnId,
        planHost: { platform: "linux", env: { GROK_HOME: "~/home" } },
        launchNonce
      },
      SESSION
    );
  const grok = normalizerFor("launch-1");
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
    state: () => fold(sink.events()),
    launch: normalizerFor
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

test("a Grok subagent Stop closed counts live again when a poll answers running, for its hour", async () => {
  const clock = createTestClock(0);
  const s = seam(clock);
  await s.startTurn("turn-1");
  const input = { prompt: "Run the suite.", description: "run tests", background: true };
  await s.update(spawnStart("call-bg", input));
  await s.update(spawnEnd("call-bg", "completed", "Subagent started.", textAnswer(SUB_B)));
  // The session-scoped Stop: `session/cancel` probably leaves a background
  // child running (the CLI auto-backgrounds a child whose caller is gone).
  await s.feed(s.grok.stopBackgroundTasks());
  assert.equal(agent(s, "call-bg").status, "interrupted");
  assert.equal(s.liveness.liveness(THREAD), null);

  const command = "[subagent:general-purpose] run tests";
  await poll(s, { task_id: SUB_B, command, status: "running" });
  assert.equal(s.liveness.liveness(THREAD), "working", "the CLI still runs it: a deploy must wait");
  const kept = agent(s, "call-bg");
  assert.equal(kept.status, "interrupted", "the roster keeps the adapter's end");
  assert.equal(kept.activationCount, 1, "a late delivery, not a new run");

  clock.set(3_600_000 - 1);
  await poll(s, { task_id: SUB_B, command, status: "running" });
  clock.set(2 * 3_600_000 - 2);
  assert.equal(s.liveness.liveness(THREAD), "working", "re-armed by the next report");
  clock.set(2 * 3_600_000 - 1);
  assert.equal(s.liveness.liveness(THREAD), null, "its hour applies");
  assert.equal(agent(s, "call-bg").status, "interrupted");
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

  clock.set(3_600_000 - 1);
  assert.equal(s.liveness.liveness(THREAD), "working");
  const command = "[subagent:general-purpose] run tests";
  await poll(s, { task_id: SUB_B, command, status: "running" });
  clock.set(2 * 3_600_000 - 2);
  assert.equal(s.liveness.liveness(THREAD), "working", "the running poll re-armed the hour");
  clock.set(2 * 3_600_000 - 1);
  assert.equal(s.liveness.liveness(THREAD), null, "an hour with no row naming it: the drain may go");
  assert.equal(agent(s, "call-bg").status, "running", "liveness lapsed, the roster row did not");

  await poll(s, { task_id: SUB_B, command, status: "completed", output: "done at last" });
  assert.equal(agent(s, "call-bg").status, "completed", "a later end is recorded as any end is");
  assert.equal(agent(s, "call-bg").result, "done at last");
  assert.equal(s.liveness.liveness(THREAD), null);
});

test("a loop a later launch reports again reopens its row: each launch numbers its own runs", async () => {
  // PLAUSIBLE, not captured: a CLI restoring a durable loop on `session/load`
  // reports it to a new launch, whose normaliser numbers its runs from 1
  // again. Without the launch in its launch ids those were the ids of the
  // runs a deploy had ended, and the roster read each new start as a late
  // delivery of an ended run: the row stayed ended. A goal is no roster row:
  // the goal a later launch reports is the thread's goal.
  const LOOP = "01a0de9b-e17c-7fa0-83dc-a436461e59b5";
  const GOAL = "18745eb4-3b61-4f0c-9a5e-4dc7dd2087ed";
  const loopReport = (grok: GrokNormalizer, sessionUpdate: string): RuntimeEvent[] =>
    grok.handleXaiNotification(`_x.ai/${sessionUpdate}`, {
      sessionId: SESSION,
      update: { sessionUpdate, task_id: LOOP, prompt: "Reply with exactly: tick", human_schedule: "every 1 minute" }
    });
  const goalReport = (grok: GrokNormalizer): RuntimeEvent[] =>
    grok.handleXaiNotification("_x.ai/session_notification", {
      sessionId: SESSION,
      update: {
        sessionUpdate: "goal_updated",
        goal_id: GOAL,
        objective: "Create goal.txt",
        status: "active",
        phase: "executing",
        token_budget: 20000,
        tokens_used: 0
      }
    });
  // A live session, as the adapter says: a dead one reads every running row interrupted.
  const live = (grok: GrokNormalizer): RuntimeEvent[] => [
    grok.event("session.started", {}),
    grok.event("session.state.changed", { state: "ready" })
  ];
  const s = seam();
  await s.feed(live(s.grok));
  await s.feed(loopReport(s.grok, "scheduled_task_created"));
  // A deploy: the session's end closes it.
  await s.feed(s.grok.stopBackgroundTasks());
  const ended = s.state().roster;
  assert.notEqual(ended.find((entry) => entry.id === LOOP)?.status, "running");
  // The next launch hears the loop fire.
  const next = s.launch("launch-2");
  await s.feed(live(next));
  await s.feed(loopReport(next, "scheduled_task_fired"));
  const roster = s.state().roster;
  assert.equal(roster.find((entry) => entry.id === LOOP)?.status, "running", "the loop is live again");
  // The goal the next launch reports is the thread's goal, never a roster row.
  await s.feed(goalReport(next));
  assert.equal(s.state().goal?.status, "active");
  assert.equal(s.state().goal?.objective, "Create goal.txt");
  assert.equal(s.state().roster.some((entry) => entry.id === `goal:${GOAL}`), false);
});

// ---------------------------------------------------------------------------
// A resumed run's words are its own; a monitor through its wakes; more captures through the fold
// ---------------------------------------------------------------------------

function agentMessages(state: ReturnType<typeof fold>, agentId: string, role: "assistant" | "reasoning") {
  return state.items.filter(
    (item): item is Extract<(typeof state.items)[number], { kind: "message" }> =>
      item.kind === "message" && item.agentId === agentId && item.role === role
  );
}

test("a resume in a later turn keeps each run's words and thinking apart, each on its own turn", async () => {
  const s = seam();
  const RUN_1 = "01a0d910-6f3a-7c33-b417-671c083d422c";
  const RUN_2 = "01a0d910-856d-77c2-8e1f-8f1ebe0ce5a9";
  const child = async (sessionId: string, update: Record<string, unknown>) =>
    await s.feed(s.grok.handleSessionUpdate({ sessionId, update, _meta: { promptId: "child" } } as never));
  const notify = async (update: Record<string, unknown>) =>
    await s.feed(s.grok.handleXaiNotification("_x.ai/session_notification", { sessionId: SESSION, update }));
  const spawned = (subagentId: string, extra: Record<string, unknown> = {}) => ({
    sessionUpdate: "subagent_spawned",
    subagent_id: subagentId,
    child_session_id: subagentId,
    description: "first run",
    subagent_type: "general-purpose",
    ...extra
  });
  const finished = (subagentId: string, output: string) => ({
    sessionUpdate: "subagent_finished",
    subagent_id: subagentId,
    child_session_id: subagentId,
    status: "completed",
    output
  });
  const turnEnd = { sessionUpdate: "turn_completed", prompt_id: "child", stop_reason: "end_turn" };

  await s.startTurn("turn-1");
  await s.update(spawnStart("call-s1", { prompt: "p", description: "first run" }));
  await notify(spawned(RUN_1));
  await child(RUN_1, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think-1" } });
  await child(RUN_1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first-run" } });
  await s.feed(s.grok.handleXaiNotification("_x.ai/session_notification", { sessionId: RUN_1, update: turnEnd }));
  await notify(finished(RUN_1, "first-run"));
  await s.update(spawnEnd("call-s1", "completed", "first-run", completion(RUN_1)));
  await s.feed(s.grok.endTurn());
  await s.feed([s.grok.turnCompleted("turn-1", { stopReason: "end_turn" })]);

  await s.startTurn("turn-2");
  await s.update(spawnStart("call-s2", { prompt: "again", resume_from: RUN_1 }));
  await notify(spawned(RUN_2, { resumed_from: RUN_1, effective_context_source: "resumed" }));
  await child(RUN_2, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think-2" } });
  await child(RUN_2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second-run" } });
  await s.feed(s.grok.handleXaiNotification("_x.ai/session_notification", { sessionId: RUN_2, update: turnEnd }));
  await notify(finished(RUN_2, "second-run"));

  const state = s.state();
  assert.deepEqual(
    agentMessages(state, "call-s1", "assistant").map((item) => [item.text, item.turnId]),
    [
      ["first-run", "turn-1"],
      ["second-run", "turn-2"]
    ]
  );
  assert.deepEqual(
    agentMessages(state, "call-s1", "reasoning").map((item) => [item.text, item.turnId]),
    [
      ["think-1", "turn-1"],
      ["think-2", "turn-2"]
    ]
  );
});

test("a subagent's own shell counts on its own once the subagent's run ends, until its own end", async () => {
  const s = seam();
  await s.startTurn("turn-1");
  await s.update(spawnStart("call-s1", { prompt: "p", description: "find callers", background: true }));
  const spawnedUpdate = {
    sessionUpdate: "subagent_spawned",
    subagent_id: SUB_A,
    child_session_id: SUB_A,
    description: "find callers",
    subagent_type: "general-purpose"
  };
  await s.feed(s.grok.handleXaiNotification("_x.ai/session_notification", { sessionId: SESSION, update: spawnedUpdate }));
  const SHELL = "call-88e87ad3-152e-4eab-b522-89fc544e8db5-0";
  const backgrounded = {
    sessionUpdate: "task_backgrounded",
    tool_call_id: SHELL,
    task_id: SHELL,
    command: "npm run dev",
    description: "dev server"
  };
  await s.feed(s.grok.handleXaiNotification("_x.ai/task_backgrounded", { sessionId: SUB_A, update: backgrounded }));
  assert.equal(s.liveness.liveness(THREAD), "working", "the agent covers its own shell");
  const finished = {
    sessionUpdate: "subagent_finished",
    subagent_id: SUB_A,
    child_session_id: SUB_A,
    status: "completed",
    output: "started the server",
    will_wake: true
  };
  await s.feed(s.grok.handleXaiNotification("_x.ai/session_notification", { sessionId: SESSION, update: finished }));
  assert.equal(agent(s, "call-s1").status, "completed");
  assert.equal(
    s.liveness.liveness(THREAD),
    "monitoring",
    "the shell outlives its agent — whether the CLI kills it is not captured, and a deploy must not"
  );
  const completed = {
    sessionUpdate: "task_completed",
    task_snapshot: { task_id: SHELL, command: "npm run dev", exit_code: 0, completed: true, kind: "bash" },
    will_wake: false
  };
  await s.feed(s.grok.handleXaiNotification("_x.ai/task_completed", { sessionId: SUB_A, update: completed }));
  assert.equal(s.liveness.liveness(THREAD), null, "its own end ends it");
  assert.equal(agent(s, SHELL).status, "completed");
});

/** An agent spawned in the background, and a shell its child session started: the orphan tests' start. */
async function agentWithOwnShell(
  s: Seam
): Promise<{ shell: string; notify(update: Record<string, unknown>, sessionId?: string): Promise<void> }> {
  const notify = async (update: Record<string, unknown>, sessionId = SESSION): Promise<void> =>
    await s.feed(s.grok.handleXaiNotification("_x.ai/session_notification", { sessionId, update }));
  await s.startTurn("turn-1");
  await s.update(spawnStart("call-s1", { prompt: "p", description: "find callers", background: true }));
  await notify({
    sessionUpdate: "subagent_spawned",
    subagent_id: SUB_A,
    child_session_id: SUB_A,
    description: "find callers",
    subagent_type: "general-purpose"
  });
  const shell = "call-88e87ad3-152e-4eab-b522-89fc544e8db5-0";
  await s.feed(
    s.grok.handleXaiNotification("_x.ai/task_backgrounded", {
      sessionId: SUB_A,
      update: { sessionUpdate: "task_backgrounded", tool_call_id: shell, task_id: shell, command: "npm run dev", description: "dev server" }
    })
  );
  return { shell, notify };
}

const SUB_A_FINISHED = {
  sessionUpdate: "subagent_finished",
  subagent_id: SUB_A,
  child_session_id: SUB_A,
  status: "completed",
  output: "started the server",
  will_wake: true
};

test("a subagent's own shell RESTING when the subagent ends does not count live: its row keeps its status", async () => {
  const s = seam();
  const { shell, notify } = await agentWithOwnShell(s);
  const listing = (status: string) => ({
    sessionUpdate: "background_tasks",
    tasks: [{ task_id: shell, command: "npm run dev", description: "dev server", kind: "bash", status }]
  });
  await notify(listing("paused"), SUB_A);
  await notify(SUB_A_FINISHED);
  assert.equal(s.liveness.liveness(THREAD), null, "a resting task is not live work, with or without its agent");
  const restamp = s
    .state()
    .activities.filter(
      (row) => row.activityKind === "task.progress" && (row.payload as { taskId?: string }).taskId === shell
    )
    .at(-1);
  assert.equal((restamp?.payload as { agentId?: string } | undefined)?.agentId, shell, "it names itself from now on");
  assert.equal((restamp?.payload as { status?: string } | undefined)?.status, "idle", "its own status, never `running`");
});

test("a subagent's own shell the CLI revived counts on its own once the subagent ends", async () => {
  const s = seam();
  const { shell, notify } = await agentWithOwnShell(s);
  // A Stop closes both (the adapter's own end); the CLI then reports both
  // still running — the agent's heartbeat, the child's listing.
  await s.feed(s.grok.stopBackgroundTasks());
  await notify({
    sessionUpdate: "subagent_progress",
    subagent_id: SUB_A,
    child_session_id: SUB_A,
    duration_ms: 2096,
    turn_count: 1,
    tool_call_count: 1,
    tokens_used: 1704
  });
  await notify(
    {
      sessionUpdate: "background_tasks",
      tasks: [{ task_id: shell, command: "npm run dev", description: "dev server", kind: "bash", status: "running" }]
    },
    SUB_A
  );
  assert.equal(s.liveness.liveness(THREAD), "working", "the revived agent covers its revived shell");
  await notify(SUB_A_FINISHED);
  assert.equal(
    s.liveness.liveness(THREAD),
    "monitoring",
    "the revived shell outlives its agent: its own start row again, never a status the roster would reopen on"
  );
  assert.equal(agent(s, shell).status, "interrupted", "the roster keeps the end the adapter wrote, never reopened");
});

// ---------------------------------------------------------------------------
// 2026-09-26: a loop and a goal through ingestion and the fold (fixtures 29, 30)
// ---------------------------------------------------------------------------
