/**
 * The private updates of a Grok goal session — `subagent_spawned`,
 * `subagent_finished`, `retry_state`, `compaction_checkpoint`,
 * `task_completed` — each mapped to what it is, never a `runtime.warning`
 * (fixtures README observation 58).
 *
 * Every frame is shaped on the real rows of a goal session written by
 * `grok 1.0.3` (47 subagents, 25 retries, 2 compaction checkpoints, 2 finished
 * background shells) and of other local sessions; the `strings` of the 1.0.34
 * binary name every one of these kinds too. Ids and text are invented.
 * `retry_state` and `compaction_checkpoint` are known only from those rows.
 * The subagents and shells are the captured 1.0.34 vocabulary as well
 * (observations 37–51), and they follow its mapping: a model-launched agent is
 * keyed by its `spawn_subagent` CALL, which starts it at its first frame, and
 * `subagent_spawned` joins it; an agent the CLI spawns with no call (a goal's
 * planner, workers, skeptics, summarizer) starts under its own id; a
 * `resumed_from` relaunches its source's row (observation 43).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { foldSubagentActivities, type RuntimeEvent } from "@orquester/api/agent-chat";

import { runtimeEventToActivities } from "../../ingestion/activities.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";
import { GROK_AGENT_LIVENESS_TTL_MS, GrokNormalizer } from "./normalize.ts";

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
      launchNonce: "launch-1",
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
function spawnCall(r: Rig, toolCallId: string, description: string, prompt = "Audit the handlers."): RuntimeEvent[] {
  return [
    ...r.acp({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "spawn_subagent",
      rawInput: { description, prompt, subagent_type: "explore", capability_mode: "read-only" },
      _meta: SPAWN_TOOL_META
    }),
    ...r.acp({
      sessionUpdate: "tool_call_update",
      toolCallId,
      kind: "other",
      title: description,
      rawInput: {
        variant: "Task",
        prompt,
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
  // An agent the CLI spawns with no `spawn_subagent` call of this session's —
  // a goal's planner — starts under its own id, which is also its launch id
  // (the relaunch contract's first start), backgrounded: nothing waits on it.
  for (const method of ["_x.ai/session_notification", "x.ai/session_notification", "_x.ai/session/update"]) {
    const r = rig();
    const events = r.live(spawned("01a05789-0cc0-7563-9e4f-4b4b576928cc"), method);
    noWarnings(events);
    const [started, ...rest] = only(events, "task.started");
    assert.deepEqual(rest, [], method);
    assert.deepEqual(started.payload, {
      taskId: "01a05789-0cc0-7563-9e4f-4b4b576928cc",
      taskType: "subagent",
      agentId: "01a05789-0cc0-7563-9e4f-4b4b576928cc",
      title: "goal plan writer",
      description: "goal plan writer",
      role: "general-purpose",
      model: "grok-4.6",
      toolUseId: "01a05789-0cc0-7563-9e4f-4b4b576928cc",
      livenessTtlMs: GROK_AGENT_LIVENESS_TTL_MS,
      isBackgrounded: true
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
    taskType: "subagent",
    agentId: "01a0578f-573b-78b3-ba00-df910190c3c0",
    title: "Audit patients PHI IDOR",
    // 1.0.3 names an explore agent's `role` (fixtures README observation 58).
    role: "explore",
    model: "grok-4.6",
    toolUseId: "01a0578f-573b-78b3-ba00-df910190c3c0",
    livenessTtlMs: GROK_AGENT_LIVENESS_TTL_MS,
    status: "completed",
    summary: "Found two IDORs in the patients handlers; both fixed.",
    usage: { totalTokens: 126413, toolUses: 64, durationMs: 591179 }
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

test("an explore subagent is the spawn_subagent call that launched it: the call starts it, the spawn joins it, and it runs detached", () => {
  // The captured order (fixtures README observations 37 and 45): the call's
  // first frame starts the agent under the call's id — its launch — so the
  // timeline shows the agent row instead of both; `subagent_spawned` then
  // joins the child to it, by the id the call's answer reported, else the
  // open launch of the same description — held while two could be its, until
  // the child's prompt or a call's answer decides. The goal engine's own
  // agents have no call: each starts under its own id.
  const r = rig();
  const launched = [
    ...spawnCall(r, "call-26", "Audit patients PHI IDOR"),
    ...spawnCall(r, "call-27", "Audit agenda IDOR"),
    ...spawnCall(r, "call-28", "Audit agenda IDOR")
  ];
  assert.deepEqual(
    only(launched, "task.started").map((event) => [event.payload.taskId, event.payload.toolUseId]),
    [
      ["call-26", "call-26"],
      ["call-27", "call-27"],
      ["call-28", "call-28"]
    ]
  );
  const joined = [
    ...r.live(explore("01a0d910-6f3a-7c33-b417-671c083d4211", "Audit agenda IDOR")),
    ...r.live(explore("01a0d910-6f3a-7c33-b417-671c083d4212", "Audit patients PHI IDOR")),
    ...r.live(explore("01a0d910-6f3a-7c33-b417-671c083d4213", "Audit agenda IDOR")),
    ...r.live(spawned("01a0d910-6f3a-7c33-b417-671c083d4219", { description: "goal achievement skeptic" }))
  ];
  noWarnings(joined);
  assert.deepEqual(
    only(joined, "task.started").map((event) => [event.payload.taskId, event.payload.toolUseId, event.payload.isBackgrounded]),
    [["01a0d910-6f3a-7c33-b417-671c083d4219", "01a0d910-6f3a-7c33-b417-671c083d4219", true]],
    "the launched children join their calls' agents — only the engine's own agent starts"
  );
  // A child's end completes its call's agent: the patients audit is call-26's.
  const [done] = only(r.live(finished("01a0d910-6f3a-7c33-b417-671c083d4212")), "task.completed");
  assert.equal(done.payload.taskId, "call-26");
  assert.equal(done.payload.toolUseId, "call-26");
  // The call's answer ("Subagent started in background."): the run goes on
  // without its call, said once.
  const detached = only(
    spawnCallDone(r, "call-27", "01a0d910-6f3a-7c33-b417-671c083d4211", "Audit agenda IDOR"),
    "task.updated"
  );
  assert.deepEqual(
    detached.map((event) => [event.payload.taskId, event.payload.isBackgrounded]),
    [["call-27", true]]
  );
});

test("in the real order — the call's result first, the spawn after — a subagent joins by the id the result names", () => {
  // The real session, rows 2090–2118: nine of ten calls complete — their
  // answers naming their subagents — BEFORE those subagents' `subagent_spawned`,
  // in an order of their own. Two calls here even share a description, so
  // pairing by description could not tell them apart; the id in the answer can.
  const SUB_A = "01a0d910-6f3a-7c33-b417-671c083d42a1";
  const SUB_B = "01a0d910-6f3a-7c33-b417-671c083d42b2";
  const SUB_C = "01a0d910-6f3a-7c33-b417-671c083d42c3";
  const SUB_D = "01a0d910-6f3a-7c33-b417-671c083d42d4";
  const r = rig();
  spawnCall(r, "call-9", "Audit agenda doctors IDORs");
  spawnCall(r, "call-10", "Audit agenda doctors IDORs");
  spawnCall(r, "call-11", "Audit billing accounting IDORs");
  spawnCallDone(r, "call-10", SUB_B, "Audit agenda doctors IDORs");
  spawnCallDone(r, "call-9", SUB_A, "Audit agenda doctors IDORs");
  const joined = [
    // SUB_B first: its call is the one whose answer named it, not the
    // oldest launch of its description.
    ...r.live(explore(SUB_B, "Audit agenda doctors IDORs")),
    ...r.live(explore(SUB_A, "Audit agenda doctors IDORs")),
    // Still open when its subagent arrives: the description pairing.
    ...r.live(explore(SUB_C, "Audit billing accounting IDORs"))
  ];
  assert.deepEqual(only(joined, "task.started"), [], "each child joins its call's agent");
  const ends = [
    ...r.live(finished(SUB_A, { output: "A" })),
    ...r.live(finished(SUB_B, { output: "B" })),
    ...r.live(finished(SUB_C, { output: "C" }))
  ];
  assert.deepEqual(
    only(ends, "task.completed").map((event) => [event.payload.taskId, event.payload.summary]),
    [
      ["call-9", "A"],
      ["call-10", "B"],
      ["call-11", "C"]
    ]
  );
  // The call that answered AFTER its spawn — joined by description already —
  // leaves nothing behind for another subagent to take: a later spawn no
  // launch explains is an agent of its own.
  spawnCallDone(r, "call-11", SUB_C, "Audit billing accounting IDORs");
  const [unpaired] = only(r.live(explore(SUB_D, "Audit billing accounting IDORs")), "task.started");
  assert.equal(unpaired?.payload.taskId, SUB_D);
  assert.equal(unpaired?.payload.toolUseId, SUB_D);
});

/** A frame of a subagent's child session, on the ACP channel. */
function childAcp(r: Rig, child: string, update: Record<string, unknown>): RuntimeEvent[] {
  return r.normalizer.handleSessionUpdate({ sessionId: child, update, _meta: {} } as unknown as SessionNotification);
}

/** The child's own `user_prompt_submit` hook — what precedes its prompt (fixtures 15–23, the 1.0.3 children). */
function childHook(r: Rig, child: string): RuntimeEvent[] {
  return r.normalizer.handleXaiNotification("_x.ai/session_notification", {
    sessionId: child,
    update: { sessionUpdate: "hook_execution", event_name: "user_prompt_submit", prompt_id: "p", runs: [] },
    _meta: {}
  });
}

/** The child's prompt, as its session echoes it: one `user_message_chunk` (fixtures 15–28). */
function childPrompt(r: Rig, child: string, text: string): RuntimeEvent[] {
  return childAcp(r, child, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
}

/** Who owns the child's words: the agent its session was joined to. */
function ownerOf(r: Rig, child: string): string | undefined {
  return childAcp(r, child, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "working" }
  }).find((event) => event.type === "content.delta")?.agentId;
}

test("a call the description pairing already gave away is never given to a second subagent", () => {
  // Two open calls of one description; the subagent that really belongs to
  // the NEWER call spawns first. Nothing the spawn says tells the two calls
  // apart, so its join waits; call-1's answer then names the OTHER subagent,
  // which leaves call-2 as the only launch it can be. Joined to the oldest
  // call at once (the rule before), the two children were swapped between
  // their calls' rows for good — and taking the id call-1's answer names
  // would have made ONE agent of both children.
  const SUB_X = "01a0d910-6f3a-7c33-b417-671c083d4201";
  const SUB_Y = "01a0d910-6f3a-7c33-b417-671c083d4202";
  const r = rig();
  spawnCall(r, "call-1", "Audit agenda IDOR");
  spawnCall(r, "call-2", "Audit agenda IDOR");
  r.live(explore(SUB_X, "Audit agenda IDOR"));
  spawnCallDone(r, "call-1", SUB_Y, "Audit agenda IDOR");
  spawnCallDone(r, "call-2", SUB_X, "Audit agenda IDOR");
  r.live(explore(SUB_Y, "Audit agenda IDOR"));
  assert.equal(ownerOf(r, SUB_X), "call-2", "the call whose answer named it");
  assert.equal(ownerOf(r, SUB_Y), "call-1", "the call whose answer named it");
  assert.deepEqual(
    only([...r.live(finished(SUB_X, { output: "x" })), ...r.live(finished(SUB_Y, { output: "y" }))], "task.completed").map(
      (event) => [event.payload.taskId, event.payload.summary]
    ),
    [
      ["call-2", "x"],
      ["call-1", "y"]
    ]
  );
});

test("two launches of one description: each child joins the call whose prompt it received, whichever spawns first", () => {
  // The real session spawned its children out of call order (rows 2101–2119:
  // the fourth call's child first, the ninth and tenth swapped), and a
  // child's first frames are its hooks, then its prompt — the call's
  // `prompt` argument verbatim, in one `user_message_chunk` (fixtures 15–28;
  // all 27 model launches of the 1.0.3 goal session). The prompt tells two
  // launches of one description apart before any row of the child is routed.
  const SUB_A = "01a0d910-6f3a-7c33-b417-671c083d42a5";
  const SUB_B = "01a0d910-6f3a-7c33-b417-671c083d42b5";
  const r = rig();
  spawnCall(r, "call-1", "Audit agenda IDOR", "Audit the agenda handlers.");
  spawnCall(r, "call-2", "Audit agenda IDOR", "Audit the doctors handlers.");
  const held = [
    ...r.live(explore(SUB_B, "Audit agenda IDOR")),
    ...r.live(explore(SUB_A, "Audit agenda IDOR")),
    ...childHook(r, SUB_B),
    ...childHook(r, SUB_A),
    ...childPrompt(r, SUB_B, "Audit the doctors handlers."),
    ...childPrompt(r, SUB_A, "Audit the agenda handlers.")
  ];
  assert.deepEqual(held, [], "a join waiting for its evidence writes nothing");
  assert.equal(ownerOf(r, SUB_B), "call-2");
  assert.equal(ownerOf(r, SUB_A), "call-1");
  const progress = only(r.live({ sessionUpdate: "subagent_progress", subagent_id: SUB_B, tokens_used: 10 }), "task.progress");
  assert.deepEqual(
    progress.map((event) => event.payload.taskId),
    ["call-2"]
  );
  assert.deepEqual(
    only([...r.live(finished(SUB_A, { output: "a" })), ...r.live(finished(SUB_B, { output: "b" }))], "task.completed").map(
      (event) => [event.payload.taskId, event.payload.summary]
    ),
    [
      ["call-1", "a"],
      ["call-2", "b"]
    ]
  );
});

test("a prompt streamed in pieces still tells the launches apart", () => {
  const SUB_A = "01a0d910-6f3a-7c33-b417-671c083d42a6";
  const SUB_B = "01a0d910-6f3a-7c33-b417-671c083d42b6";
  const r = rig();
  spawnCall(r, "call-1", "Audit agenda IDOR", "Audit the handlers of the agenda.");
  spawnCall(r, "call-2", "Audit agenda IDOR", "Audit the handlers of the doctors.");
  r.live(explore(SUB_B, "Audit agenda IDOR"));
  r.live(explore(SUB_A, "Audit agenda IDOR"));
  childPrompt(r, SUB_B, "Audit the handlers");
  childPrompt(r, SUB_B, " of the doctors.");
  assert.equal(ownerOf(r, SUB_B), "call-2");
  // The other child is decided by elimination: call-1 is the only launch left.
  assert.equal(ownerOf(r, SUB_A), "call-1");
});

test("launches identical in every argument are told apart by nothing before an answer: the oldest, at the child's first row", () => {
  // Two launches of one description, one prompt, one type: every row either
  // agent shows reads the same, so the child takes the oldest open call when
  // its first row must be routed — the rule before the wait — and an answer
  // naming it before that decides it instead.
  const SUB_X = "01a0d910-6f3a-7c33-b417-671c083d4207";
  const SUB_Y = "01a0d910-6f3a-7c33-b417-671c083d4208";
  const r = rig();
  spawnCall(r, "call-1", "Audit agenda IDOR");
  spawnCall(r, "call-2", "Audit agenda IDOR");
  r.live(explore(SUB_Y, "Audit agenda IDOR"));
  r.live(explore(SUB_X, "Audit agenda IDOR"));
  childPrompt(r, SUB_Y, "Audit the handlers.");
  assert.equal(ownerOf(r, SUB_Y), "call-1", "nothing told them apart: the oldest open call");
  assert.equal(ownerOf(r, SUB_X), "call-2");
});

test("a launch the user declined is no candidate for a child of its description", () => {
  // Supervised, the CLI asks before it spawns (observation 49): of two calls
  // of one description, one approved and one declined, only the approved one
  // has a child — even when its spawn arrives before the other's refusal.
  const SUB_X = "01a0d910-6f3a-7c33-b417-671c083d4209";
  const r = rig();
  spawnCall(r, "call-1", "Audit agenda IDOR");
  spawnCall(r, "call-2", "Audit agenda IDOR");
  r.live(explore(SUB_X, "Audit agenda IDOR"));
  const declined = r.acp({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: "User rejected the execution for tool `spawn_subagent`" } }]
  });
  assert.deepEqual(
    only(declined, "task.completed").map((event) => [event.payload.taskId, event.payload.status]),
    [["call-1", "stopped"]],
    "a spawn that never ran is stopped, never failed"
  );
  assert.equal(ownerOf(r, SUB_X), "call-2");
  assert.deepEqual(
    only(r.live(finished(SUB_X, { output: "x" })), "task.completed").map((event) => [event.payload.taskId, event.payload.status]),
    [["call-2", "completed"]]
  );
});

test("a Stop while a join waits decides it as before: no child is left without its agent", () => {
  const SUB_X = "01a0d910-6f3a-7c33-b417-671c083d420a";
  const r = rig();
  spawnCall(r, "call-1", "Audit agenda IDOR", "Audit the agenda handlers.");
  spawnCall(r, "call-2", "Audit agenda IDOR", "Audit the doctors handlers.");
  r.live(explore(SUB_X, "Audit agenda IDOR"));
  const cut = r.normalizer.cutTurnCalls("Stopped.");
  assert.deepEqual(
    only(cut, "task.completed").map((event) => [event.payload.taskId, event.payload.summary]),
    [["call-2", "Stopped before it started."]],
    "the child took the oldest call; only the other one never started"
  );
  assert.deepEqual(only(cut, "task.started"), []);
  assert.equal(ownerOf(r, SUB_X), "call-1");
});

test("a call that answered with its child's id is never taken by another child of its description", () => {
  // The same pair, answered in between: call-1's answer names SUB_Y before
  // SUB_X spawns, so SUB_X is not call-1's child, whatever its description.
  const SUB_X = "01a0d910-6f3a-7c33-b417-671c083d4203";
  const SUB_Y = "01a0d910-6f3a-7c33-b417-671c083d4204";
  const r = rig();
  spawnCall(r, "call-1", "Audit agenda IDOR");
  spawnCall(r, "call-2", "Audit agenda IDOR");
  spawnCallDone(r, "call-1", SUB_Y, "Audit agenda IDOR");
  r.live(explore(SUB_X, "Audit agenda IDOR"));
  spawnCallDone(r, "call-2", SUB_X, "Audit agenda IDOR");
  r.live(explore(SUB_Y, "Audit agenda IDOR"));
  assert.deepEqual(
    only([...r.live(finished(SUB_X, { output: "x" })), ...r.live(finished(SUB_Y, { output: "y" }))], "task.completed").map(
      (event) => [event.payload.taskId, event.payload.summary]
    ),
    [
      ["call-2", "x"],
      ["call-1", "y"]
    ]
  );
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
    // A resumed skeptic is a NEW id naming the old one (`resumed_from`), with
    // no call behind it: a new run of the SAME agent (the relaunch contract,
    // observation 43), whose answer is that agent's result.
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
      // The model's worker is its spawn call — the launch the timeline shows.
      ["call-26", "agent", "Audit patients PHI IDOR", "completed"],
      ["k1", "agent", "goal achievement skeptic", "completed"],
      ["k2", "agent", "goal achievement skeptic", "interrupted"],
      ["sum", "agent", "goal summarizer", "running"]
    ]
  );
  assert.equal(roster.find((agent) => agent.id === "k1")?.result, "ACHIEVED", "the resumed run's answer");
  const worker = roster.find((agent) => agent.id === "call-26");
  assert.equal(worker?.role, "explore");
  assert.equal(worker?.model, "grok-4.6");
  assert.equal(worker?.result, "Two IDORs fixed.");
  assert.deepEqual(worker?.usage, { totalTokens: 126413, toolUses: 64, durationMs: 591179 });
});

test("a repeated spawn frame starts nothing twice; a finish naming no agent this session knows writes nothing", () => {
  const r = rig();
  assert.equal(only(r.live(spawned("s1")), "task.started").length, 1);
  assert.deepEqual(r.live({ ...spawned("s1"), model: "grok-4.6" }), []);
  // A subagent of another process (a host restart since) is no agent of this
  // session's: its end names nothing here, and the host's first load closes
  // what a dead process left running (`leftoverWorkClosings`).
  assert.deepEqual(r.live(finished("s0", { output: "late result" })), []);
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

test("a subagent_spawned without an id is one visible warning; a finish without one writes nothing", () => {
  // A known kind of frame missing the id every row keys on is a protocol
  // change worth seeing (§10: never a silent drop); a finish without an id
  // names no agent to end.
  const r = rig();
  const events = [
    ...r.live({ sessionUpdate: "subagent_spawned", description: "x" }),
    ...r.live({ sessionUpdate: "subagent_finished", status: "completed" })
  ];
  assert.deepEqual(
    events.map((event) => [event.type, event.type === "runtime.warning" ? event.payload.message : undefined]),
    [["runtime.warning", "grok: subagent_spawned without a subagent_id"]]
  );
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
