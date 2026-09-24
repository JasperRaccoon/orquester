/**
 * The private updates a Grok goal session sends that no capture has —
 * `subagent_spawned`, `subagent_finished`, `retry_state`,
 * `compaction_checkpoint`, `task_completed` — each mapped to what it is, never
 * a `runtime.warning` (fixtures README observation 37).
 *
 * Every frame is shaped on the real rows of a goal session written by
 * `grok 1.0.3` (47 subagents, 25 retries, 2 compaction checkpoints, 2 finished
 * background shells) and of other local sessions; the `strings` of the 1.0.34
 * binary name every one of these kinds too. Ids and text are invented.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { foldSubagentActivities, type RuntimeEvent } from "@orquester/api/agent-chat";

import { runtimeEventToActivities } from "../../ingestion/activities.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";
import { GrokNormalizer } from "./normalize.ts";

const SESSION = "01a05780-1220-7ee0-863c-3eed47284f9e";
const PROMPT = "8792d6d3-a044-49bf-8168-af4aa4ba4c4e";

let counter = 0;

interface Rig {
  normalizer: GrokNormalizer;
  debug: string[];
  /** The turn a frame arrives in; `undefined` between turns. */
  turn: string | undefined;
  live(update: Record<string, unknown>, method?: string): RuntimeEvent[];
  replay(update: Record<string, unknown>): RuntimeEvent[];
  acp(update: Record<string, unknown>): RuntimeEvent[];
}

function rig(): Rig {
  const debug: string[] = [];
  const built: Rig = {
    normalizer: undefined as unknown as GrokNormalizer,
    debug,
    turn: "turn-1",
    live: (update, method = "_x.ai/session_notification") =>
      built.normalizer.handleXaiNotification(method, envelope(update)),
    replay: (update) =>
      built.normalizer.handleXaiNotification("_x.ai/session/update", envelope(update, { isReplay: true })),
    acp: (update) =>
      built.normalizer.handleSessionUpdate(envelope(update, { promptId: PROMPT }) as unknown as SessionNotification)
  };
  built.normalizer = new GrokNormalizer(
    {
      threadId: "t1",
      stamp: () => {
        counter += 1;
        return { eventId: `e${counter}`, createdAt: `2026-09-24T09:${String(Math.floor(counter / 60) % 60).padStart(2, "0")}:${String(counter % 60).padStart(2, "0")}.000Z` };
      },
      uuid: () => {
        counter += 1;
        return `u${counter}`;
      },
      activeTurnId: () => built.turn,
      planHost: { platform: "linux", env: {} },
      debug: (message) => {
        debug.push(message);
      }
    },
    SESSION
  );
  built.normalizer.beginTurn();
  return built;
}

function envelope(update: Record<string, unknown>, meta: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  return {
    sessionId: SESSION,
    update,
    _meta: { eventId: `${SESSION}-${counter}`, agentTimestampMs: 1790240400000 + counter, ...meta }
  };
}

function only<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

function noWarnings(events: readonly RuntimeEvent[]): void {
  assert.deepEqual(
    only(events, "runtime.warning").map((event) => event.payload.message),
    [],
    "a known private update is never a warning"
  );
}

// -- real-shaped frames ------------------------------------------------------

function spawned(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionUpdate: "subagent_spawned",
    subagent_id: id,
    parent_session_id: SESSION,
    parent_prompt_id: PROMPT,
    child_session_id: id,
    subagent_type: "general-purpose",
    description: "goal plan writer",
    effective_context_source: "new",
    model: "grok-4.6",
    ...fields
  };
}

function finished(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionUpdate: "subagent_finished",
    subagent_id: id,
    child_session_id: id,
    status: "completed",
    tool_calls: 44,
    turns: 1,
    duration_ms: 222472,
    tokens_used: 66865,
    output: "Done",
    will_wake: false,
    ...fields
  };
}

function explore(id: string, description: string): Record<string, unknown> {
  return spawned(id, {
    subagent_type: "explore",
    description,
    capability_mode: "read-only",
    role: "explore"
  });
}

const SPAWN_TOOL_META = {
  "x.ai/tool": {
    version: 1,
    name: "spawn_subagent",
    kind: "task",
    namespace: "grok_build",
    label: "Subagent",
    read_only: false
  }
};

/** The model's `spawn_subagent` call: its first frame, then the update naming it. */
function spawnCall(r: Rig, toolCallId: string, description: string): RuntimeEvent[] {
  return [
    ...r.acp({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "spawn_subagent",
      rawInput: { description, prompt: "Audit the handlers.", subagent_type: "explore", capability_mode: "read-only" },
      _meta: SPAWN_TOOL_META
    }),
    ...r.acp({
      sessionUpdate: "tool_call_update",
      toolCallId,
      kind: "other",
      title: description,
      rawInput: {
        variant: "Task",
        prompt: "Audit the handlers.",
        description,
        subagent_type: "explore",
        run_in_background: true,
        capability_mode: "read-only",
        task_id: null
      },
      _meta: SPAWN_TOOL_META
    })
  ];
}

/**
 * The `spawn_subagent` call's TERMINAL update: its result text names the
 * subagent it started — in the real session usually BEFORE that subagent's
 * `subagent_spawned` arrives (the call is closed, and gone, by then).
 */
function spawnCallDone(r: Rig, toolCallId: string, subagentId: string, description: string): RuntimeEvent[] {
  const text =
    `Subagent started in background.\nsubagent_id: ${subagentId}\ntype: explore\ndescription: ${description}\n\n` +
    "When you need its result, use get_command_or_subagent_output with the subagent id.";
  return r.acp({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    content: [{ type: "content", content: { type: "text", text } }],
    rawOutput: { type: "Text", text }
  });
}

function retry(attempt: number, reason = "reqwest error stream: Transport error: error decoding response body"): Record<string, unknown> {
  return { sessionUpdate: "retry_state", type: "retrying", attempt, max_retries: 15, reason };
}

const CHECKPOINT = {
  sessionUpdate: "compaction_checkpoint",
  checkpoint_id: "da9439f2-d6e4-4479-9507-e7909c769b6a",
  prompt_index_at_compaction: 3,
  checkpoint_file: "compaction_checkpoints/da9439f2-d6e4-4479-9507-e7909c769b6a.json",
  schema_version: 1,
  created_at: "2026-09-24T13:08:42.539454633+00:00"
};

const SHELL_TASK = "call-e65cbd8d-df03-40ce-93fa-8a3356c00850-432";

function backgrounded(r: Rig, taskId = SHELL_TASK): RuntimeEvent[] {
  return r.normalizer.handleXaiNotification("_x.ai/task_backgrounded", {
    sessionId: SESSION,
    update: {
      sessionUpdate: "task_backgrounded",
      tool_call_id: "call-e65cbd8d-df03-40ce-93fa-8a3356c00850-431",
      task_id: taskId,
      command: "./deploy.sh production",
      cwd: "/workspace",
      output_file: `/tmp/grok/terminal/${taskId}.log`,
      description: "Run the production deploy"
    },
    _meta: { eventId: `${SESSION}-bg`, agentTimestampMs: 1790240400000 }
  });
}

function taskCompleted(snapshot: Record<string, unknown> = {}, taskId = SHELL_TASK): Record<string, unknown> {
  return {
    sessionUpdate: "task_completed",
    task_snapshot: {
      task_id: taskId,
      command: "./deploy.sh production",
      cwd: "/workspace",
      start_time: { secs_since_epoch: 1790181284, nanos_since_epoch: 216373937 },
      end_time: { secs_since_epoch: 1790181376, nanos_since_epoch: 114288780 },
      output: "Deploying…\ndone\n",
      output_file: `/tmp/grok/terminal/${taskId}.log`,
      truncated: false,
      output_total_bytes: 17,
      exit_code: 0,
      signal: null,
      completed: true,
      kind: "bash",
      block_waited: true,
      explicitly_killed: false,
      owner_session_id: SESSION,
      description: "Run the production deploy",
      is_backgrounded: true,
      ...snapshot
    },
    will_wake: false
  };
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

test("subagent_spawned starts an agent task, on either private-channel method", () => {
  for (const method of ["_x.ai/session_notification", "x.ai/session_notification", "_x.ai/session/update"]) {
    const r = rig();
    const events = r.live(spawned("01a05789-0cc0-7563-9e4f-4b4b576928cc"), method);
    noWarnings(events);
    const [started, ...rest] = only(events, "task.started");
    assert.deepEqual(rest, [], method);
    assert.deepEqual(started.payload, {
      taskId: "01a05789-0cc0-7563-9e4f-4b4b576928cc",
      description: "goal plan writer",
      taskType: "subagent",
      agentKind: "agent",
      agentId: "01a05789-0cc0-7563-9e4f-4b4b576928cc",
      title: "goal plan writer",
      role: "general-purpose",
      model: "grok-4.6"
    });
    assert.equal(started.turnId, "turn-1");
    assert.equal(started.raw?.source, "acp.grok.extension");
  }
});

test("subagent_finished completes the task with its output, usage and linkage — in the turn that spawned it", () => {
  const r = rig();
  r.live(explore("01a0578f-573b-78b3-ba00-df910190c3c0", "Audit patients PHI IDOR"));
  r.turn = "turn-2";
  const events = r.live(
    finished("01a0578f-573b-78b3-ba00-df910190c3c0", {
      tool_calls: 64,
      duration_ms: 591179,
      tokens_used: 126413,
      output: "Found two IDORs in the patients handlers; both fixed."
    })
  );
  noWarnings(events);
  const [completed] = only(events, "task.completed");
  assert.deepEqual(completed.payload, {
    taskId: "01a0578f-573b-78b3-ba00-df910190c3c0",
    status: "completed",
    summary: "Found two IDORs in the patients handlers; both fixed.",
    usage: { totalTokens: 126413, toolUses: 64, durationMs: 591179 },
    taskType: "subagent",
    agentKind: "agent",
    agentId: "01a0578f-573b-78b3-ba00-df910190c3c0",
    title: "Audit patients PHI IDOR",
    role: "explore",
    model: "grok-4.6"
  });
  assert.equal(completed.turnId, "turn-1", "the row belongs with its start");
});

test("a cancelled subagent stops with the CLI's reason; a failed one fails", () => {
  const r = rig();
  r.live(spawned("s1", { description: "goal achievement skeptic" }));
  r.live(spawned("s2", { description: "goal achievement skeptic" }));
  const cancelled = only(
    r.live(finished("s1", { status: "cancelled", error: "Subagent was cancelled", output: undefined, tool_calls: 119 })),
    "task.completed"
  )[0];
  assert.equal(cancelled.payload.status, "stopped");
  assert.equal(cancelled.payload.summary, "Subagent was cancelled");
  const failed = only(r.live(finished("s2", { status: "failed", error: "model error", output: undefined })), "task.completed")[0];
  assert.equal(failed.payload.status, "failed");
  assert.equal(failed.payload.summary, "model error");
});

test("an explore subagent names the spawn_subagent call that launched it, and runs detached", () => {
  // The model's launch is a visible tool row; naming it on the task lets the
  // timeline show the agent row INSTEAD of both (entries.logic.ts,
  // `agentLaunchToolIds`). The frame itself names no call. While the calls are
  // still open — no result has named anyone yet — the join is the call's own
  // `description`, oldest open call first (the id-first order is the next test).
  const r = rig();
  spawnCall(r, "call-26", "Audit patients PHI IDOR");
  spawnCall(r, "call-27", "Audit agenda IDOR");
  spawnCall(r, "call-28", "Audit agenda IDOR");
  const started = [
    ...r.live(explore("a1", "Audit agenda IDOR")),
    ...r.live(explore("a2", "Audit patients PHI IDOR")),
    ...r.live(explore("a3", "Audit agenda IDOR")),
    ...r.live(spawned("g1", { description: "goal achievement skeptic" }))
  ].filter((event): event is Extract<RuntimeEvent, { type: "task.started" }> => event.type === "task.started");
  assert.deepEqual(
    started.map((event) => [event.payload.taskId, event.payload.toolUseId, event.payload.isBackgrounded]),
    [
      ["a1", "call-27", true],
      ["a2", "call-26", true],
      ["a3", "call-28", true],
      // The goal engine's own agents have no launching call.
      ["g1", undefined, undefined]
    ]
  );
  // The completion carries the same linkage.
  const [done] = only(r.live(finished("a2")), "task.completed");
  assert.equal(done.payload.toolUseId, "call-26");
});

test("in the real order — the call's result first, the spawn after — a subagent pairs by the id the result names", () => {
  // The real session, rows 2090–2118: nine of ten calls complete, and are
  // closed, BEFORE their subagents' `subagent_spawned`, in an order of their
  // own. The two calls here even share a description, so pairing by
  // description could not tell them apart; the id in the result can.
  const r = rig();
  spawnCall(r, "call-9", "Audit agenda doctors IDORs");
  spawnCall(r, "call-10", "Audit agenda doctors IDORs");
  spawnCall(r, "call-11", "Audit billing accounting IDORs");
  spawnCallDone(r, "call-10", "sub-b", "Audit agenda doctors IDORs");
  spawnCallDone(r, "call-9", "sub-a", "Audit agenda doctors IDORs");
  const started = [
    ...r.live(explore("sub-a", "Audit agenda doctors IDORs")),
    ...r.live(explore("sub-b", "Audit agenda doctors IDORs")),
    // Still open when its subagent arrives: the description pairing.
    ...r.live(explore("sub-c", "Audit billing accounting IDORs"))
  ].filter((event): event is Extract<RuntimeEvent, { type: "task.started" }> => event.type === "task.started");
  assert.deepEqual(
    started.map((event) => [event.payload.taskId, event.payload.toolUseId, event.payload.isBackgrounded]),
    [
      ["sub-a", "call-9", true],
      ["sub-b", "call-10", true],
      ["sub-c", "call-11", true]
    ]
  );
  // The call that finished AFTER its spawn — already paired by description —
  // leaves nothing behind for another subagent to take.
  spawnCallDone(r, "call-11", "sub-c", "Audit billing accounting IDORs");
  const [unpaired] = only(r.live(explore("sub-d", "Audit billing accounting IDORs")), "task.started");
  assert.equal(unpaired.payload.toolUseId, undefined);
});

test("a call the description pairing already gave away is never given to a second subagent", () => {
  // Two open calls with the same description; the subagent that really
  // belongs to the NEWER call spawns first, so the description pairing gives
  // it the older one. That call's result then names the other subagent —
  // remembering it would make two subagents share one launching call.
  const r = rig();
  spawnCall(r, "call-1", "Audit agenda IDOR");
  spawnCall(r, "call-2", "Audit agenda IDOR");
  const [x] = only(r.live(explore("sub-x", "Audit agenda IDOR")), "task.started");
  assert.equal(x.payload.toolUseId, "call-1", "the oldest open call, by description");
  spawnCallDone(r, "call-1", "sub-y", "Audit agenda IDOR");
  spawnCallDone(r, "call-2", "sub-x", "Audit agenda IDOR");
  const [y] = only(r.live(explore("sub-y", "Audit agenda IDOR")), "task.started");
  assert.equal(y.payload.toolUseId, undefined, "call-1 is sub-x's already: no call is shared");
});

test("a goal's planner, workers, skeptics and summarizer show on the roster as agents", () => {
  // Through the real ingestion and the real roster fold — the path the client
  // renders from.
  const r = rig();
  const events: RuntimeEvent[] = [
    ...r.live(spawned("plan", { description: "goal plan writer" })),
    ...r.live(finished("plan", { output: "Done" })),
    ...spawnCall(r, "call-26", "Audit patients PHI IDOR"),
    ...r.live(explore("w1", "Audit patients PHI IDOR")),
    ...r.live(finished("w1", { tokens_used: 126413, tool_calls: 64, duration_ms: 591179, output: "Two IDORs fixed." })),
    ...r.live(spawned("k1", { description: "goal achievement skeptic" })),
    ...r.live(spawned("k2", { description: "goal achievement skeptic" })),
    ...r.live(finished("k1", { output: "NOT ACHIEVED" })),
    ...r.live(finished("k2", { status: "cancelled", error: "Subagent was cancelled", output: undefined })),
    // A resumed skeptic is a NEW id naming the old one (`resumed_from`).
    ...r.live(spawned("k3", { description: "goal achievement skeptic", effective_context_source: "resumed", resumed_from: "k1" })),
    ...r.live(finished("k3", { turns: 3, output: "ACHIEVED" })),
    ...r.live(spawned("sum", { description: "goal summarizer", capability_mode: "read-only" }))
  ];
  noWarnings(events);
  const activities = events.flatMap((event) => runtimeEventToActivities(event));
  const roster = foldSubagentActivities(activities, { sessionLive: true });
  assert.deepEqual(
    roster.map((agent) => [agent.id, agent.agentKind, agent.title, agent.status]),
    [
      ["plan", "agent", "goal plan writer", "completed"],
      ["w1", "agent", "Audit patients PHI IDOR", "completed"],
      ["k1", "agent", "goal achievement skeptic", "completed"],
      ["k2", "agent", "goal achievement skeptic", "interrupted"],
      ["k3", "agent", "goal achievement skeptic", "completed"],
      ["sum", "agent", "goal summarizer", "running"]
    ]
  );
  const worker = roster.find((agent) => agent.id === "w1");
  assert.equal(worker?.role, "explore");
  assert.equal(worker?.model, "grok-4.6");
  assert.equal(worker?.result, "Two IDORs fixed.");
  assert.deepEqual(worker?.usage, { totalTokens: 126413, toolUses: 64, durationMs: 591179 });
});

test("a repeated spawn frame starts nothing twice; a finish with no spawn still completes the task", () => {
  const r = rig();
  assert.equal(only(r.live(spawned("s1")), "task.started").length, 1);
  assert.deepEqual(r.live({ ...spawned("s1"), model: "grok-4.6" }), []);
  // A subagent spawned before this session (a load, a restart) still gets its
  // result: the roster folds a completion without a start.
  const [late] = only(r.live(finished("s0", { output: "late result" })), "task.completed");
  assert.equal(late.payload.status, "completed");
  assert.equal(late.payload.taskType, "subagent");
  assert.equal(late.payload.agentId, "s0");
});

test("a live subagent never outlives the session: stopping closes it, once", () => {
  const r = rig();
  r.live(spawned("s1"));
  r.live(spawned("s2", { description: "goal summarizer" }));
  r.live(finished("s1"));
  const closing = r.normalizer.stopBackgroundTasks();
  assert.deepEqual(
    closing.map((event) =>
      event.type === "task.completed" ? [event.payload.taskId, event.payload.status, event.payload.title] : event.type
    ),
    [["s2", "stopped", "goal summarizer"]]
  );
  assert.deepEqual(r.normalizer.stopBackgroundTasks(), []);
});

test("a turn that ran a subagent says so on its usage", () => {
  const r = rig();
  r.live(spawned("s1"));
  r.live(finished("s1"));
  const settled = r.normalizer.turnCompleted("turn-1", { stopReason: "end_turn" });
  assert.equal(settled.type === "turn.completed" && settled.payload.tokenUsage?.hasSubagents, true);
  r.normalizer.beginTurn();
  const next = r.normalizer.turnCompleted("turn-2", { stopReason: "end_turn" });
  assert.equal(next.type === "turn.completed" && next.payload.tokenUsage?.hasSubagents, false, "per turn");
});

test("a subagent frame without an id is dropped with a debug line, never a warning", () => {
  const r = rig();
  const events = [
    ...r.live({ sessionUpdate: "subagent_spawned", description: "x" }),
    ...r.live({ sessionUpdate: "subagent_finished", status: "completed" })
  ];
  assert.deepEqual(events, []);
  assert.equal(r.debug.length, 2);
});

// ---------------------------------------------------------------------------
// retry_state
// ---------------------------------------------------------------------------

test("a retry episode keeps the running turn visibly alive, once per episode", () => {
  // Claude's `api_retry` precedent: a transport retry heartbeat is not a
  // timeline row. It is `session.state.changed {running}`, which ingestion
  // folds into the state the turn already has — nothing is written — while
  // the host's turn watchdog sees activity.
  const r = rig();
  const events = [
    ...r.live(retry(1)),
    ...r.live(retry(2)),
    ...r.live(retry(3)),
    // The same request retried after partial output: still one episode.
    ...r.acp({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } }),
    ...r.live(retry(4)),
    // A new failure starts over at 1: a second episode.
    ...r.live(retry(1, "API error (status 500 Internal Server Error)"))
  ];
  noWarnings(events);
  const heartbeats = only(events, "session.state.changed");
  assert.deepEqual(
    heartbeats.map((event) => [event.payload.state, event.payload.reason, event.turnId]),
    [
      ["running", "retry_state:1/15", "turn-1"],
      ["running", "retry_state:1/15", "turn-1"]
    ]
  );
  assert.deepEqual(heartbeats[1].payload.detail, { reason: "API error (status 500 Internal Server Error)" });
});

test("a retry between turns flips nothing: an idle session must not read as running", () => {
  const r = rig();
  r.turn = undefined;
  assert.deepEqual(r.live(retry(1)), []);
});

test("a new turn opens a new episode", () => {
  const r = rig();
  assert.equal(r.live(retry(1)).length, 1);
  r.normalizer.endTurn();
  r.normalizer.beginTurn();
  r.turn = "turn-2";
  assert.equal(r.live(retry(2)).length, 1, "the counter is per request, the episode per turn");
});

// ---------------------------------------------------------------------------
// compaction_checkpoint, task_completed
// ---------------------------------------------------------------------------

test("compaction_checkpoint is known and silent: auto_compact_completed carries the boundary", () => {
  const r = rig();
  assert.deepEqual(r.live(CHECKPOINT), []);
  const compacted = r.live({ sessionUpdate: "auto_compact_completed", tokens_before: 350067, tokens_after: 20312, summary_preview: null });
  assert.deepEqual(
    only(compacted, "thread.state.changed").map((event) => event.payload.state),
    ["compacted"],
    "one marker, from the update that is the boundary"
  );
});

test("task_completed closes the background shell it names, with its exit code", () => {
  const cases: Array<[Record<string, unknown>, string, number | undefined]> = [
    [{}, "completed", 0],
    [{ exit_code: 2 }, "failed", 2],
    [{ exit_code: null, signal: "killed", explicitly_killed: true }, "stopped", undefined],
    [{ exit_code: null, signal: "segfault" }, "failed", undefined]
  ];
  for (const [snapshot, status, exitCode] of cases) {
    const r = rig();
    assert.equal(only(backgrounded(r), "task.started").length, 1);
    r.turn = "turn-2";
    const events = r.live(taskCompleted(snapshot));
    noWarnings(events);
    const [completed, ...rest] = only(events, "task.completed");
    assert.deepEqual(rest, []);
    assert.equal(completed.payload.status, status, JSON.stringify(snapshot));
    assert.equal(completed.payload.exitCode, exitCode, JSON.stringify(snapshot));
    assert.equal(completed.payload.taskId, SHELL_TASK);
    assert.equal(completed.payload.agentKind, "background");
    assert.equal(completed.payload.toolUseId, "call-e65cbd8d-df03-40ce-93fa-8a3356c00850-431");
    assert.equal(completed.turnId, "turn-1", "with the turn that started it");
    assert.deepEqual(r.normalizer.stopBackgroundTasks(), [], "closed: nothing left to stop");
  }
});

test("task_completed for a shell the thread never showed is silent, and a finished shell is not reopened", () => {
  const r = rig();
  assert.deepEqual(r.live(taskCompleted({}, "call-unknown-1")), []);
  backgrounded(r);
  r.live(taskCompleted());
  // A later roster snapshot that still lists it must not start it again.
  const snapshot = r.live({
    sessionUpdate: "background_tasks",
    tasks: [{ task_id: SHELL_TASK, command: "./deploy.sh production", kind: "bash", status: "completed" }]
  });
  assert.deepEqual(only(snapshot, "task.started"), []);
});

// ---------------------------------------------------------------------------
// Replay, and the fallback
// ---------------------------------------------------------------------------

test("replayed frames of all five kinds emit nothing and leave nothing live", () => {
  const r = rig();
  const replayed = [
    ...r.replay(spawned("s1")),
    ...r.replay(retry(1)),
    ...r.replay(CHECKPOINT),
    ...r.replay(taskCompleted()),
    ...r.replay(finished("s0"))
  ];
  assert.deepEqual(replayed, []);
  assert.deepEqual(r.normalizer.stopBackgroundTasks(), [], "a replayed spawn is the past, not a live agent");
});

test("an unknown private update still warns", () => {
  const r = rig();
  const events = r.live({ sessionUpdate: "definitely_new_update", payload: 1 });
  assert.deepEqual(
    only(events, "runtime.warning").map((event) => event.payload.message),
    ["grok: unmapped _x.ai/session_notification update"]
  );
});
