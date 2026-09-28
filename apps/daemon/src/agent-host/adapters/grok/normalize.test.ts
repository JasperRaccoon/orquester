/**
 * Normaliser tests on synthetic frames: a late update of a finished call, and
 * the `spawn_subagent` tool's edge cases the captures do not reach.
 *
 * Every synthetic frame follows the shape EVERY captured tool call has
 * (`apps/daemon/test/fixtures/grok/`): a `tool_call` whose `title` and
 * `_meta["x.ai/tool"].name` are the tool's name and whose `rawInput` is the
 * model's own arguments, a status-less `tool_call_update` that rewrites the
 * title and the input (`{variant, …}`), and a terminal `tool_call_update`
 * carrying `content` (what the model reads) and a `rawOutput` tagged by
 * `type`. The subagent frames themselves — `spawn_subagent`'s launches and
 * answers (`SubagentCompleted`, `Text`), the poll and kill answers
 * (`TaskOutput`, `KillTask {outcome: "killed"}`), `subagent_*` and
 * `_x.ai/task_completed` — are the shapes fixtures 15–23 captured on
 * 2026-09-25 (`subagent-replay.test.ts` replays those files whole), and the
 * kill's `already_exited` outcome the shape fixture 27 captured on 2026-09-26
 * (`work-replay.test.ts`).
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { SessionNotification } from "./acp/_generated/schema.ts";
import { agentFrames, readCapture } from "./fixtures.ts";
import {
  GrokNormalizer
} from "./normalize.ts";

const SESSION = "01a0c1a7-1185-7171-9447-3aa38569088c";

/** The turn the normaliser reads as active; a test moves it between turns. */
interface TurnCursor {
  current: string | undefined;
}

function normalizer(turn: TurnCursor = { current: "turn-1" }): GrokNormalizer {
  let counter = 0;
  const created = new GrokNormalizer(
    {
      threadId: "thread-1",
      stamp: () => {
        counter += 1;
        const second = String(counter % 60).padStart(2, "0");
        return { eventId: `e${counter}`, createdAt: `2026-09-24T00:00:${second}.000Z` };
      },
      uuid: () => {
        counter += 1;
        return `u${counter}`;
      },
      activeTurnId: () => turn.current,
      planHost: { platform: "linux", env: { GROK_HOME: "~/home" } },
      launchNonce: "launch-1"
    },
    SESSION
  );
  created.beginTurn();
  return created;
}

function frame(update: Record<string, unknown>): SessionNotification {
  return { sessionId: SESSION, update, _meta: { promptId: "prompt-1" } } as unknown as SessionNotification;
}

function only<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

/** `[type, taskId-or-itemId, status]` of every row, for one-line assertions. */
function statuses(events: readonly RuntimeEvent[]): Array<[string, string | undefined, string | undefined]> {
  return events.map((event) => {
    const payload = event.payload as { taskId?: string; status?: string };
    return [event.type, payload.taskId ?? event.itemId, payload.status];
  });
}

/** The `session/update` frames of one captured call, verbatim. */
function capturedCall(file: string, toolCallId: string): SessionNotification[] {
  return agentFrames(readCapture(file))
    .filter((entry) => entry.method === "session/update")
    .map((entry) => entry.params as SessionNotification)
    .filter((params) => (params.update as { toolCallId?: string }).toolCallId === toolCallId);
}

// ---------------------------------------------------------------------------
// A late update of a finished call
// ---------------------------------------------------------------------------

const ECHO_CALL = "call-a7c3bfe8-967c-4ffe-916f-749b3b6da4c2-0";

/** Fixture 03b's `echo hi` call, folded to its end. */
function echoCompleted(): GrokNormalizer {
  const grok = normalizer();
  const events: RuntimeEvent[] = [];
  for (const params of capturedCall("03b-bash-output-accumulation.ndjson", ECHO_CALL)) {
    events.push(...grok.handleSessionUpdate(params));
  }
  assert.equal(only(events, "item.completed").length, 1, "the captured call completes once");
  return grok;
}

test("a restated end the CLI already sent emits nothing — the open bubble stays open", () => {
  const grok = echoCompleted();
  grok.handleSessionUpdate(
    frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: it printed hi." } })
  );
  const late = grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call_update", toolCallId: ECHO_CALL, status: "completed" })
  );
  assert.deepEqual(late, [], "a second tool.completed row, and a closed assistant segment, before this");
  const closing = grok.endTurn();
  assert.deepEqual(
    closing.map((event) => [event.type, (event.payload as { itemType?: string }).itemType]),
    [["item.completed", "assistant_message"]],
    "the bubble the restatement used to close is still the turn's to close"
  );
});

test("a CLI end after the adapter's own close still lands — once: it is the call's first real end", () => {
  const grok = normalizer();
  const start = { sessionUpdate: "tool_call", toolCallId: "call-x", title: "read_file", rawInput: {} };
  grok.handleSessionUpdate(frame(start));
  const closed = grok.failOpenTools("Stopped.");
  assert.deepEqual(statuses(closed), [["item.completed", "call-x", "failed"]], "the adapter's own close");
  const real = grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call_update", toolCallId: "call-x", status: "completed" })
  );
  assert.deepEqual(statuses(real), [["item.completed", "call-x", "completed"]], "the CLI's end lands");
  const again = grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call_update", toolCallId: "call-x", status: "completed" })
  );
  assert.deepEqual(again, [], "…and only once");
});

// ---------------------------------------------------------------------------
// spawn_subagent → the roster
// ---------------------------------------------------------------------------

/** `kind` is not captured for this tool; `other` is in the CLI's kind vocabulary and nothing reads it. */
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

/** Subagent ids are UUIDv7 ("Subagent id must be a UUIDv7", the CLI's own message). */
const SUB_A = "01a0c1a9-7b2e-7c3d-8e4f-0123456789ab";
const SUB_B = "01a0c1aa-1111-7222-8333-444455556666";
/** A background shell's id: the CLI's task ids are UUIDv7 too (fixture 11's starts `01a0c1a7`). */
const SHELL = "01a0c1a7-3335-7fc3-894b-56f0bb60a6db";

function spawnStart(callId: string, input: Record<string, unknown>): SessionNotification {
  return frame({
    sessionUpdate: "tool_call",
    toolCallId: callId,
    title: "spawn_subagent",
    rawInput: input,
    _meta: SPAWN_META
  });
}

function spawnEnd(
  callId: string,
  status: "completed" | "failed",
  text: string,
  rawOutput?: Record<string, unknown>
): SessionNotification {
  return frame({
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    status,
    content: [{ type: "content", content: { type: "text", text } }],
    ...(rawOutput === undefined ? {} : { rawOutput })
  });
}

type TaskEvent = Extract<RuntimeEvent, { type: "task.started" | "task.completed" }>;

function taskRows(events: readonly RuntimeEvent[]): TaskEvent[] {
  return events.filter(
    (event): event is TaskEvent => event.type === "task.started" || event.type === "task.completed"
  );
}

/** The one agent a launch starts (or reopens). */
function startedBy(grok: GrokNormalizer, callId: string, input: Record<string, unknown>) {
  const [started, ...more] = only(grok.handleSessionUpdate(spawnStart(callId, input)), "task.started");
  assert.ok(started, "the launch starts an agent");
  assert.equal(more.length, 0);
  return started;
}

/** The agent's end row, if the frame ended it. */
function endedBy(grok: GrokNormalizer, end: SessionNotification) {
  return only(grok.handleSessionUpdate(end), "task.completed");
}

/** The foreground completion tag: the child ran to its end (`SubagentCompletedOutput`). */
function completion(subagentId?: string): Record<string, unknown> {
  return { type: "SubagentCompleted", ...(subagentId === undefined ? {} : { subagent_id: subagentId }) };
}

/**
 * A spawn's text answer: a background launch's, or a foreground one the CLI
 * moved to the background ("Subagent took longer than the foreground budget
 * and was moved to the background…", the binary's own string). T3's tests name
 * the `Text` shape; not captured here.
 */
function textAnswer(subagentId: string, lead = "Subagent started."): Record<string, unknown> {
  const labels = `subagent_id: ${subagentId}\ntype: general-purpose\ndescription: run tests`;
  return { type: "Text", text: `${lead}\n${labels}` };
}

/** A background launch whose call already answered with the subagent's id. */
function backgroundLaunched(grok: GrokNormalizer): void {
  const input = { prompt: "p", description: "run tests", background: true };
  grok.handleSessionUpdate(spawnStart("call-bg", input));
  grok.handleSessionUpdate(spawnEnd("call-bg", "completed", "Subagent started.", textAnswer(SUB_B)));
}

const POLL_META = {
  "x.ai/tool": {
    version: 1,
    name: "get_command_or_subagent_output",
    kind: "read",
    namespace: "grok_build",
    label: "Task Output",
    read_only: true
  }
};

let polls = 0;

/**
 * One `get_command_or_subagent_output` call, answered: its `TaskOutput` holds
 * a `Result`, or a `MultiResult` for several ids (T3's reader).
 */
function poll(
  grok: GrokNormalizer,
  results: ReadonlyArray<Record<string, unknown>>,
  type: "TaskOutput" | "KillTask" = "TaskOutput",
  callStatus: "completed" | "failed" = "completed"
): RuntimeEvent[] {
  polls += 1;
  const toolCallId = `call-poll-${polls}`;
  const input = { task_ids: results.map((result) => result["task_id"]) };
  const title = "get_command_or_subagent_output";
  grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call", toolCallId, title, rawInput: input, _meta: POLL_META })
  );
  const rawOutput = results.length === 1 ? { type, Result: results[0] } : { type, MultiResult: { results } };
  return grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call_update", toolCallId, status: callStatus, content: [], rawOutput })
  );
}

type AgentRow = Extract<
  RuntimeEvent,
  { type: "task.started" | "task.progress" | "task.updated" | "task.completed" }
>;

function agentRows(events: readonly RuntimeEvent[]): AgentRow[] {
  return events.filter((event): event is AgentRow => event.type.startsWith("task."));
}

const RUN_TESTS = "[subagent:general-purpose] run tests";

function turnUsage(event: RuntimeEvent) {
  return (event as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.tokenUsage;
}

function snapshot(taskId: string, kind: string, status: string): unknown {
  return {
    sessionId: SESSION,
    update: { sessionUpdate: "background_tasks", tasks: [{ task_id: taskId, command: "c", kind, status }] }
  };
}

function backgrounded(toolCallId: string, taskId: string): unknown {
  return {
    sessionId: SESSION,
    update: { sessionUpdate: "task_backgrounded", tool_call_id: toolCallId, task_id: taskId, command: "c" }
  };
}

/** `subagent_spawned`, the captured shape (fixture 15): the child's session id IS its subagent id. */
function spawned(subagentId: string, description: string, extra: Record<string, unknown> = {}): unknown {
  return {
    sessionId: SESSION,
    update: {
      sessionUpdate: "subagent_spawned",
      subagent_id: subagentId,
      parent_session_id: SESSION,
      child_session_id: subagentId,
      subagent_type: "general-purpose",
      description,
      effective_context_source: "new",
      model: "grok-4.7",
      ...extra
    }
  };
}

/** `subagent_finished`, the captured shape: `output` when completed, `error` when cancelled (fixtures 15, 18). */
function finished(subagentId: string, status: "completed" | "cancelled", output = "sub-ok"): unknown {
  return {
    sessionId: SESSION,
    update: {
      sessionUpdate: "subagent_finished",
      subagent_id: subagentId,
      child_session_id: subagentId,
      status,
      ...(status === "completed" ? { output } : { error: "Subagent was cancelled" }),
      tool_calls: 1,
      turns: 1,
      duration_ms: 3731,
      tokens_used: 12_011,
      will_wake: false
    }
  };
}

const TASK_COMPLETED = "_x.ai/task_completed";

/** `_x.ai/task_completed` for a killed shell, the captured shape (fixture 18). */
function killedSnapshot(taskId: string): unknown {
  return {
    sessionId: SESSION,
    update: {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: taskId,
        command: "c",
        output: "",
        exit_code: null,
        signal: "killed",
        completed: true,
        kind: "bash",
        explicitly_killed: true,
        kill_result_delivered: true,
        owner_session_id: SESSION,
        is_backgrounded: true
      },
      will_wake: false
    }
  };
}

const FIND_CALLERS = {
  prompt: "Find every caller of add() and report file:line.",
  description: "find callers",
  subagent_type: "explore"
};

test("a failed spawn whose child ran settles its agent failed, with the reason", () => {
  const grok = normalizer();
  startedBy(grok, "call-s1", { prompt: "p", description: "nested", subagent_type: "explore" });
  grok.handleXaiNotification("_x.ai/session_notification", spawned(SUB_A, "nested"));
  const failed = endedBy(grok, spawnEnd("call-s1", "failed", "tool_execution_failed: the child crashed"));
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.payload.status, "failed");
  assert.match(failed[0]!.payload.summary ?? "", /the child crashed/);
});

test("a Stop that cuts a spawn no subagent_spawned joined ends its agent stopped: it never started", () => {
  // Supervised, the CLI asks before it spawns (fixture 25): a Stop while that
  // card is pending cuts the call, and no child exists to be cancelled — no
  // `subagent_finished` can come. Left live, the roster read it running and
  // liveness held a deploy's drain for its hour.
  const grok = normalizer();
  startedBy(grok, "call-s1", { prompt: "p", description: "find callers" });
  const cut = grok.cutTurnCalls("Stopped.");
  assert.deepEqual(
    only(cut, "item.completed").map((event) => [event.itemId, (event.payload as { detail?: string }).detail]),
    [["call-s1", "Stopped."]],
    "the call is cut, as every cut call is"
  );
  const ends = only(cut, "task.completed");
  assert.deepEqual(statuses(ends), [["task.completed", "call-s1", "stopped"]]);
  assert.equal(ends[0]!.payload.summary, "Stopped before it started.");
  assert.deepEqual(grok.stopBackgroundTasks(), [], "nothing left live");
});

test("a spawn the CLI reports after the Stop cut it joins its launch: one agent, never a second", () => {
  // Unsupervised, the CLI spawns at once and `subagent_spawned` follows in
  // milliseconds: a Stop inside that window ends the launch "before it
  // started", and the late report must not start an agent of its own.
  const grok = normalizer();
  const rows: RuntimeEvent[] = [];
  rows.push(...grok.handleSessionUpdate(spawnStart("call-s1", { prompt: "p", description: "find callers" })));
  rows.push(...grok.cutTurnCalls("Stopped."));
  rows.push(...grok.handleXaiNotification("_x.ai/session_notification", spawned(SUB_A, "find callers")));
  rows.push(...grok.handleXaiNotification("_x.ai/session_notification", finished(SUB_A, "cancelled")));
  assert.deepEqual(statuses(taskRows(rows)), [
    ["task.started", "call-s1", undefined],
    ["task.completed", "call-s1", "stopped"]
  ]);
});

test("a foreground spawn its turn cut with no CLI end stays live until Stop", () => {
  // An older CLI without `subagent_finished`, or one that never sends it:
  // Stop, the session's stop or the exit ends the run.
  const grok = normalizer();
  startedBy(grok, "call-s1", { prompt: "p", description: "find callers" });
  grok.handleXaiNotification("_x.ai/session_notification", spawned(SUB_A, "find callers"));
  grok.endTurn();
  const late = grok.handleSessionUpdate(spawnEnd("call-s1", "failed", "cancelled"));
  assert.deepEqual(
    statuses(taskRows(late)),
    [["task.completed", "call-s1", "failed"]],
    "a call that fails with its run still open fails the run it opened"
  );
  assert.deepEqual(grok.stopBackgroundTasks(), [], "…once");
});

test("the id a launch reports anywhere in its result is enough to resume it", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  // Still live as far as anything observable says: the resume's success is
  // what proves the first run over, and its end settles the row.
  const started = startedBy(grok, "call-s2", { prompt: "Continue.", resume_from: SUB_B });
  assert.equal(started.payload.taskId, "call-bg");
  const end = endedBy(grok, spawnEnd("call-s2", "completed", "all green", completion()));
  assert.deepEqual(
    end.map((event) => [event.payload.taskId, event.payload.status, event.payload.summary]),
    [["call-bg", "completed", "all green"]]
  );
});

test("a resume the CLI refuses leaves the running agent running", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  startedBy(grok, "call-s2", { prompt: "Continue.", resume_from: SUB_B });
  const refused = endedBy(grok, spawnEnd("call-s2", "failed", "The source subagent is still running."));
  assert.deepEqual(refused, [], "the refusal ends the call, never the agent it named");
  assert.deepEqual(
    taskRows(grok.stopBackgroundTasks()).map((event) => event.payload.taskId),
    ["call-bg"],
    "still live, so still closed on Stop"
  );
});

test("a resume that opens no run carries no prompt: the agent was never given it", () => {
  const grok = normalizer();
  const [launched] = only(
    grok.handleSessionUpdate(spawnStart("call-bg", { prompt: "Run the test suite.", description: "run tests", background: true })),
    "task.started"
  );
  assert.equal(launched?.payload.prompt, "Run the test suite.", "the launch that opens the run carries its prompt");
  grok.handleSessionUpdate(spawnEnd("call-bg", "completed", "Subagent started.", textAnswer(SUB_B)));

  // Resumed while it still runs: the CLI refuses ("must be completed"), so no
  // run opens, and a prompt on this start would head the running run in the
  // drill-in with words its agent never received.
  const refusedStart = startedBy(grok, "call-s2", {
    prompt: "Continue, and also fix the flaky test.",
    resume_from: SUB_B
  });
  assert.equal(refusedStart.payload.taskId, "call-bg");
  assert.equal("prompt" in refusedStart.payload, false);
  endedBy(grok, spawnEnd("call-s2", "failed", "The source subagent is still running."));
});

test("a resume_from naming an id no launch reported starts a row of its own, under that id", () => {
  const grok = normalizer();
  const started = startedBy(grok, "call-s9", { prompt: "Continue.", resume_from: SUB_A });
  assert.equal(started.payload.taskId, SUB_A);
  assert.equal(started.payload.toolUseId, "call-s9");
});

test("an id the launch itself named is never taken for its subagent's", () => {
  const grok = normalizer();
  // The prompt hands the new agent another agent's id; the result echoes it.
  startedBy(grok, "call-s1", { prompt: `Review what subagent ${SUB_B} changed.`, description: "review" });
  endedBy(grok, spawnEnd("call-s1", "completed", `Reviewed ${SUB_B}: fine.`, completion()));
  const started = startedBy(grok, "call-s2", { prompt: "Continue.", resume_from: SUB_B });
  assert.equal(started.payload.taskId, SUB_B, "SUB_B was never call-s1's own id");
});

test("a background task the CLI registers for a spawn call is that subagent, never a shell", () => {
  // Whether the CLI backgrounds a subagent through these frames is not
  // captured; if it does, their observed shape joins on `tool_call_id`.
  const grok = normalizer();
  startedBy(grok, "call-bg", { prompt: "p", description: "run tests", background: true });
  const registered = grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-bg", SUB_B));
  assert.deepEqual(registered, [], "no shell row for the subagent");
  const channel = "_x.ai/session_notification";
  assert.deepEqual(grok.handleXaiNotification(channel, snapshot(SUB_B, "subagent", "running")), []);
  const ended = grok.handleXaiNotification(channel, snapshot(SUB_B, "subagent", "completed"));
  assert.deepEqual(statuses(taskRows(ended)), [["task.completed", "call-bg", "completed"]], "its end");
});

test("the CLI's own output names the subagent; a summary quoting other ids never steals them", () => {
  const grok = normalizer();
  // A live background shell of the parent's.
  grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-sh", SUB_B));
  startedBy(grok, "call-s1", { prompt: "Check the dev server.", description: "check server" });
  // The model's summary quotes the shell's id and the session's; the CLI's
  // output names the subagent.
  endedBy(
    grok,
    spawnEnd("call-s1", "completed", `Task ${SUB_B} in ${SESSION} serves :5173.`, completion(SUB_A))
  );
  assert.equal(startedBy(grok, "call-s2", { prompt: "More.", resume_from: SUB_A }).payload.taskId, "call-s1");
  // The shell stays a shell: its snapshot still ends IT.
  const channel = "_x.ai/session_notification";
  const ended = grok.handleXaiNotification(channel, snapshot(SUB_B, "bash", "completed"));
  assert.deepEqual(
    taskRows(ended).map((event) => [event.type, event.payload.taskId, event.payload.taskType]),
    [["task.completed", SUB_B, "shell"]]
  );
  const unknown = startedBy(grok, "call-s3", { prompt: "More.", resume_from: SESSION });
  assert.equal(unknown.payload.taskId, SESSION, "the session's own id was never taken for a subagent's");
});

test("hasSubagents: this turn launched one — a steer keeps it, a turn under a live one does not", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  grok.beginTurn(); // a steer re-opens the stream under the SAME turn id
  assert.equal(turnUsage(grok.turnCompleted("turn-1", { stopReason: "end_turn" }))?.hasSubagents, true);
  // The background agent is still live; turn 2 launched nothing (Codex's rule).
  assert.equal(turnUsage(grok.turnCompleted("turn-2", { stopReason: "end_turn" }))?.hasSubagents, false);
  // A background shell is not a subagent either.
  grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-sh", SUB_A));
  assert.equal(turnUsage(grok.turnCompleted("turn-3", { stopReason: "end_turn" }))?.hasSubagents, false);
});

// ---------------------------------------------------------------------------
// A background run's end: the poll and kill answers (T3's reader + the binary)
// ---------------------------------------------------------------------------

test("a poll answering running re-arms the agent; a finished one ends it with its output, once", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  const running = poll(grok, [{ task_id: SUB_B, command: RUN_TESTS, status: "running", output: "" }]);
  assert.deepEqual(
    statuses(agentRows(running)),
    [["task.progress", "call-bg", "running"]],
    "no end: the row that keeps it live"
  );
  assert.equal(agentRows(running)[0]!.payload.livenessTtlMs, 3_600_000);

  const output = "\n12 tests pass.\nNo failures.";
  const done = poll(grok, [{ task_id: SUB_B, command: RUN_TESTS, status: "completed", output }]);
  const ended = only(done, "task.completed");
  assert.deepEqual(
    ended.map(({ payload }) => [payload.taskId, payload.status, payload.summary, payload.toolUseId]),
    [["call-bg", "completed", "12 tests pass.\nNo failures.", "call-bg"]]
  );
  const again = poll(grok, [{ task_id: SUB_B, command: RUN_TESTS, status: "completed" }]);
  assert.deepEqual(agentRows(again), [], "a run already ended has no second end");
  assert.deepEqual(grok.stopBackgroundTasks(), [], "and nothing left live");
});

test("every status spelling and exit code T3's reader maps, in a MultiResult", () => {
  const cases: Array<[Record<string, unknown>, string | null]> = [
    [{ status: "success" }, "completed"],
    [{ status: "succeeded" }, "completed"],
    [{ status: "error" }, "failed"],
    [{ status: "failed", output: "boom" }, "failed"],
    [{ status: "killed" }, "stopped"],
    [{ status: "cancelled" }, "stopped"],
    [{ status: "stopped" }, "stopped"],
    [{ exit_code: 0 }, "completed"],
    [{ exit_code: 3 }, "failed"],
    [{ status: "pending" }, null],
    [{ status: "mystery" }, null]
  ];
  for (const [fields, expected] of cases) {
    const grok = normalizer();
    backgroundLaunched(grok);
    const events = poll(grok, [
      { task_id: SUB_B, command: RUN_TESTS, ...fields },
      { task_id: "not-ours", command: "sleep 9", status: "completed" }
    ]);
    const ended = only(events, "task.completed").map((event) => event.payload.status);
    assert.deepEqual(ended, expected === null ? [] : [expected], JSON.stringify(fields));
  }
});

test("T3's kill answer ends the agent stopped — only a completed call whose outcome is killed", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  assert.deepEqual(agentRows(poll(grok, [{ task_id: SUB_B, outcome: "killed" }], "KillTask", "failed")), []);
  assert.deepEqual(agentRows(poll(grok, [{ task_id: SUB_B, outcome: "error" }], "KillTask")), []);
  const killed = poll(grok, [{ task_id: SUB_B, outcome: "killed" }], "KillTask");
  assert.deepEqual(statuses(taskRows(killed)), [["task.completed", "call-bg", "stopped"]]);
});

test("the captured kill answer ends a run — outcome killed; snapshot fields on it end nothing", () => {
  // Fixture 18: `{task_id, outcome: "killed", message}` for a subagent and a
  // shell alike. `explicitly_killed` / `kill_result_delivered` are
  // `TaskSnapshot` fields of `_x.ai/task_completed`, never a kill answer's.
  const grok = normalizer();
  backgroundLaunched(grok);
  grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-sh", SHELL));
  const snapshotFields = { explicitly_killed: true, kill_result_delivered: true };
  assert.deepEqual(agentRows(poll(grok, [{ task_id: SUB_B, ...snapshotFields }], "KillTask")), []);
  const refused = poll(grok, [{ task_id: SUB_B, outcome: "killed" }], "KillTask", "failed");
  assert.deepEqual(agentRows(refused), [], "a failed kill call ends nothing");
  const kills = [
    { task_id: SUB_B, outcome: "killed", message: "Subagent cancellation initiated" },
    { task_id: SHELL, outcome: "already_exited", message: "Task had already completed" }
  ];
  assert.deepEqual(statuses(taskRows(poll(grok, kills, "KillTask"))), [
    ["task.completed", "call-bg", "stopped"],
    ["task.completed", SHELL, "completed"]
  ]);
  assert.deepEqual(agentRows(poll(grok, kills, "KillTask")), [], "never a second end");
});

test("an already_exited kill outcome ends a run it finds live as completed, or by the answer's own status", () => {
  // Captured (fixture 27): `{task_id, outcome: "already_exited", message}` —
  // "Task had already completed", "Subagent already completed" — no status,
  // no exit code. Nobody stopped the task: the kill found it done. The CLI
  // had reported that end first in the capture; this is the reading for a
  // run whose end the adapter never saw.
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ outcome: "already_exited", message: "Subagent already completed" }, "completed"],
    [{ outcome: "already_exited", status: "running" }, "completed"],
    [{ outcome: "already_exited", status: "completed" }, "completed"],
    [{ outcome: "already_exited", status: "failed" }, "failed"],
    [{ outcome: "already_exited", exit_code: 0 }, "completed"],
    [{ outcome: "already_exited", exit_code: 1 }, "failed"],
    [{ outcome: "killed", status: "completed" }, "stopped"]
  ];
  for (const [fields, expected] of cases) {
    const grok = normalizer();
    backgroundLaunched(grok);
    const ended = only(poll(grok, [{ task_id: SUB_B, ...fields }], "KillTask"), "task.completed");
    assert.deepEqual(
      ended.map((event) => event.payload.status),
      [expected],
      JSON.stringify(fields)
    );
  }
});

test("an answer arriving between turns ends the agent on the turn it ran in", () => {
  const turn: TurnCursor = { current: "turn-1" };
  const grok = normalizer(turn);
  backgroundLaunched(grok);
  grok.endTurn();
  turn.current = undefined; // the CLI woke the parent on its own: no turn of ours
  const answered = poll(grok, [{ task_id: SUB_B, command: RUN_TESTS, status: "completed", output: "ok" }]);
  const ended = only(answered, "task.completed");
  assert.equal(ended.length, 1);
  assert.equal(ended[0]!.turnId, "turn-1");
});

test("a poll ends a known shell with its first output line; an id nobody reported starts nothing", () => {
  const grok = normalizer();
  grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-sh", SUB_A));
  const dev = { task_id: SUB_A, command: "npm run dev" };
  const running = poll(grok, [{ ...dev, status: "running", output: "ready on :5173" }]);
  assert.deepEqual(
    agentRows(running).map((event) => [event.type, event.payload.taskId, event.payload.agentKind]),
    [["task.progress", SUB_A, "background"]]
  );
  const oldAgent = "0000aaaa-0000-7000-8000-000000000001";
  const oldShell = "0000aaaa-0000-7000-8000-000000000002";
  const unknown = poll(grok, [
    { task_id: oldAgent, command: "[subagent:explore] old work", status: "completed" },
    { task_id: oldShell, command: "sleep 9", status: "completed" }
  ]);
  assert.deepEqual(agentRows(unknown), [], "no row for work this session never named");
  const done = poll(grok, [{ ...dev, exit_code: 1, output: "\nError: port in use\nat x" }]);
  const ended = only(done, "task.completed");
  assert.deepEqual(
    ended.map(({ payload }) => [payload.taskId, payload.status, payload.summary]),
    [[SUB_A, "failed", "Error: port in use"]]
  );
  assert.deepEqual(grok.stopBackgroundTasks(), [], "the shell is gone");
});

// ---------------------------------------------------------------------------
// A task whose end the CLI reported never starts again; one the adapter
// closed itself — shell or subagent — counts live again on any CLI report
// that it still runs (a listing, a start frame, a poll)
// ---------------------------------------------------------------------------

const SNAPSHOTS = "_x.ai/session_notification";
const EMPTY_SNAPSHOT = { sessionId: SESSION, update: { sessionUpdate: "background_tasks", tasks: [] } };

/** A snapshot listing SHELL alone, with this status. */
function listShell(grok: GrokNormalizer, status: string): RuntimeEvent[] {
  return grok.handleXaiNotification(SNAPSHOTS, snapshot(SHELL, "bash", status));
}

/** The late start frames: `_x.ai/task_backgrounded`, and the `BackgroundTaskStarted` discriminant. */
function lateStarts(grok: GrokNormalizer): RuntimeEvent[] {
  return [
    ...grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-late", SHELL)),
    ...grok.handleSessionUpdate(
      frame({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-late-2",
        status: "completed",
        rawOutput: { type: "BackgroundTaskStarted", task_id: SHELL, command: "c" }
      })
    )
  ];
}

test("a shell whose end the CLI reported never starts again — by a snapshot or a late frame", () => {
  const ends: Array<[string, string, (grok: GrokNormalizer) => RuntimeEvent[]]> = [
    ["its snapshot status", "completed", (grok) => listShell(grok, "completed")],
    ["a poll", "failed", (grok) => poll(grok, [{ task_id: SHELL, command: "c", exit_code: 1 }])],
    ["a kill", "stopped", (grok) => poll(grok, [{ task_id: SHELL, outcome: "killed" }], "KillTask")],
    ["task_completed", "stopped", (grok) => grok.handleXaiNotification(TASK_COMPLETED, killedSnapshot(SHELL))]
  ];
  for (const [how, status, end] of ends) {
    const grok = normalizer();
    listShell(grok, "running");
    assert.deepEqual(statuses(taskRows(end(grok))), [["task.completed", SHELL, status]], how);
    for (const listed of ["running", "completed"]) {
      assert.deepEqual(agentRows(listShell(grok, listed)), [], `${how}, then listed ${listed}`);
    }
    assert.deepEqual(agentRows(lateStarts(grok)), [], `${how}, then a late start frame`);
    assert.deepEqual(agentRows(grok.handleXaiNotification(SNAPSHOTS, EMPTY_SNAPSHOT)), [], how);
    assert.deepEqual(grok.stopBackgroundTasks(), [], `${how}: nothing is live`);
  }
});

test("a shell the adapter closed itself counts live again while the CLI still lists it running", () => {
  // Stop, the session's stop and the exit write the end themselves, and so
  // does a task dropping out of a snapshot unannounced: none is the CLI's
  // word that the shell stopped (whether `session/cancel` kills it is not
  // captured), and a deploy must never kill running work.
  const ends: Array<[string, string, (grok: GrokNormalizer) => RuntimeEvent[]]> = [
    ["Stop", "stopped", (grok) => grok.stopBackgroundTasks()],
    ["dropping out", "completed", (grok) => grok.handleXaiNotification(SNAPSHOTS, EMPTY_SNAPSHOT)]
  ];
  for (const [how, status, end] of ends) {
    const grok = normalizer();
    listShell(grok, "running");
    assert.deepEqual(statuses(taskRows(end(grok))), [["task.completed", SHELL, status]], how);
    const again = listShell(grok, "running");
    assert.deepEqual(statuses(agentRows(again)), [["task.started", SHELL, undefined]], `${how}, listed`);
    assert.deepEqual(
      statuses(grok.stopBackgroundTasks()),
      [["task.completed", SHELL, "stopped"]],
      `${how}: live again, so Stop closes it again`
    );
  }
  const grok = normalizer();
  listShell(grok, "running");
  grok.stopBackgroundTasks();
  const late = grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-late", SHELL));
  assert.deepEqual(statuses(agentRows(late)), [["task.started", SHELL, undefined]], "a late start frame");
});

test("a terminal listing of a shell the adapter closed is the CLI's end: no row, and final", () => {
  const grok = normalizer();
  listShell(grok, "running");
  grok.stopBackgroundTasks();
  assert.deepEqual(agentRows(listShell(grok, "completed")), [], "the end is already written");
  assert.deepEqual(agentRows(listShell(grok, "running")), [], "and now it is the CLI's word");
  assert.deepEqual(agentRows(lateStarts(grok)), []);
  assert.deepEqual(grok.stopBackgroundTasks(), [], "nothing is live");
});

test("a shell Stop closed counts live again when a poll answers running — its own start row", () => {
  const grok = normalizer();
  grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-sh", SHELL));
  assert.deepEqual(statuses(taskRows(grok.stopBackgroundTasks())), [["task.completed", SHELL, "stopped"]]);
  const dev = { task_id: SHELL, command: "c" };
  const revived = agentRows(poll(grok, [{ ...dev, status: "running" }]));
  assert.deepEqual(statuses(revived), [["task.started", SHELL, undefined]]);
  assert.equal(revived[0]!.payload.toolUseId, "call-sh", "its own start, re-emitted: a late delivery");
  const again = agentRows(poll(grok, [{ ...dev, status: "running" }]));
  assert.deepEqual(statuses(again), [["task.progress", SHELL, undefined]], "re-armed, with no status");
  assert.deepEqual(
    statuses(agentRows(listShell(grok, "pending"))),
    [["task.progress", SHELL, undefined]],
    "a status change says no status either: it would reopen the roster's row"
  );
  const done = poll(grok, [{ ...dev, status: "completed", output: "bye" }]);
  assert.deepEqual(statuses(taskRows(done)), [["task.completed", SHELL, "completed"]]);
  assert.deepEqual(agentRows(poll(grok, [{ ...dev, status: "running" }])), [], "the CLI's end is final");
  assert.deepEqual(agentRows(listShell(grok, "running")), []);
});

test("a subagent Stop closed counts live again on any CLI report that it still runs", () => {
  const running = { task_id: SUB_B, command: RUN_TESTS, status: "running" };
  const reports: Array<[string, (grok: GrokNormalizer) => RuntimeEvent[]]> = [
    ["a poll answering running", (grok) => poll(grok, [running])],
    [
      "a snapshot listing it",
      (grok) => grok.handleXaiNotification(SNAPSHOTS, snapshot(SUB_B, "subagent", "running"))
    ],
    [
      "a start frame naming its launch",
      (grok) => grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-bg", SUB_B))
    ]
  ];
  for (const [how, report] of reports) {
    const grok = normalizer();
    backgroundLaunched(grok);
    const stopped = grok.stopBackgroundTasks();
    assert.deepEqual(statuses(taskRows(stopped)), [["task.completed", "call-bg", "stopped"]], how);
    const revived = agentRows(report(grok));
    assert.deepEqual(statuses(revived), [["task.started", "call-bg", undefined]], how);
    assert.equal(revived[0]!.payload.toolUseId, "call-bg", `${how}: its own launch — a late delivery`);
    assert.equal(revived[0]!.payload.livenessTtlMs, 3_600_000, `${how}: its hour`);
    assert.deepEqual(
      statuses(agentRows(poll(grok, [running]))),
      [["task.progress", "call-bg", undefined]],
      `${how}: re-armed, with no status that would reopen the roster's row`
    );
    const done = poll(grok, [{ ...running, status: "completed", output: "ok" }]);
    assert.deepEqual(statuses(taskRows(done)), [["task.completed", "call-bg", "completed"]], how);
    assert.deepEqual(agentRows(poll(grok, [running])), [], `${how}: the CLI's end is final`);
  }
});

test("the CLI's end of a task Stop closed writes no second end, and is final", () => {
  const grok = normalizer();
  grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-sh", SHELL));
  backgroundLaunched(grok);
  grok.stopBackgroundTasks();
  const ends = poll(grok, [
    { task_id: SHELL, command: "c", status: "completed", output: "bye" },
    { task_id: SUB_B, command: RUN_TESTS, status: "completed", output: "ok" }
  ]);
  assert.deepEqual(agentRows(ends), [], "the adapter already wrote both ends");
  const running = poll(grok, [
    { task_id: SHELL, command: "c", status: "running" },
    { task_id: SUB_B, command: RUN_TESTS, status: "running" }
  ]);
  assert.deepEqual(agentRows(running), [], "and the CLI's word is final");
  assert.deepEqual(agentRows(listShell(grok, "running")), []);
});

test("a resting listing of a task Stop closed says nothing — neither a run nor an end", () => {
  const grok = normalizer();
  listShell(grok, "running");
  backgroundLaunched(grok);
  grok.stopBackgroundTasks();
  assert.deepEqual(agentRows(listShell(grok, "paused")), [], "a resting shell");
  const resting = grok.handleXaiNotification(SNAPSHOTS, snapshot(SUB_B, "subagent", "idle"));
  assert.deepEqual(agentRows(resting), [], "a resting subagent");
  assert.equal(only(listShell(grok, "running"), "task.started").length, 1, "a later run still counts");
});

test("an ended subagent's ids outlive its launch's memory: a snapshot listing one is no new shell", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  const done = poll(grok, [{ task_id: SUB_B, command: RUN_TESTS, status: "completed", output: "ok" }]);
  assert.equal(only(done, "task.completed").length, 1);
  // As many later launches push SUB_B's id out of the launch memory.
  for (let index = 0; index < 2_000; index += 1) {
    const callId = `call-many-${index}`;
    const id = `01a0c1ab-0000-7000-8000-${String(index).padStart(12, "0")}`;
    grok.handleSessionUpdate(spawnStart(callId, { prompt: "p", background: true }));
    grok.handleSessionUpdate(spawnEnd(callId, "completed", "Subagent started.", textAnswer(id)));
  }
  const listed = grok.handleXaiNotification(SNAPSHOTS, snapshot(SUB_B, "subagent", "completed"));
  assert.deepEqual(agentRows(listed), []);
});

test("an ended shell's id quoted in a subagent's answer is never taken for the agent's", () => {
  const grok = normalizer();
  grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-sh", SHELL));
  poll(grok, [{ task_id: SHELL, command: "npm run dev", status: "completed", output: "bye" }]);
  const input = { prompt: "p", description: "run tests", background: true };
  grok.handleSessionUpdate(spawnStart("call-bg", input));
  const lead = `Subagent started; it reads the log ${SHELL} left.`;
  grok.handleSessionUpdate(spawnEnd("call-bg", "completed", lead, textAnswer(SUB_B, lead)));
  const listed = listShell(grok, "completed");
  assert.deepEqual(agentRows(listed), [], "the shell's listing is not the agent's end");
  assert.deepEqual(
    statuses(taskRows(grok.stopBackgroundTasks())),
    [["task.completed", "call-bg", "stopped"]],
    "the agent was still running"
  );
});

test("a resume clears `listed`: a snapshot without the resumed agent does not end it mid-resume", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  const channel = "_x.ai/session_notification";
  grok.handleXaiNotification(channel, snapshot(SUB_B, "subagent", "running"));
  startedBy(grok, "call-s2", { prompt: "Continue.", resume_from: SUB_B });
  const empty = { sessionId: SESSION, update: { sessionUpdate: "background_tasks", tasks: [] } };
  const without = grok.handleXaiNotification(channel, empty);
  assert.deepEqual(agentRows(without), [], "the resumed run is not the listed one");
  const end = endedBy(grok, spawnEnd("call-s2", "completed", "resumed and done", completion()));
  assert.deepEqual(
    end.map((event) => [event.payload.taskId, event.payload.status, event.payload.summary]),
    [["call-bg", "completed", "resumed and done"]],
    "the resume's own end lands"
  );
});

test("only grok_build's spawn_subagent launches a subagent; `background` is its background flag", () => {
  const SPAWN = "spawn_subagent";
  const grok = normalizer();
  const elsewhere = grok.handleSessionUpdate(
    frame({
      sessionUpdate: "tool_call",
      toolCallId: "call-mcp",
      title: "spawn_subagent",
      rawInput: { prompt: "p" },
      _meta: { "x.ai/tool": { ...SPAWN_META["x.ai/tool"], namespace: "mcp" } }
    })
  );
  assert.deepEqual(agentRows(elsewhere), [], "another namespace's tool of that name is not the CLI's");
  assert.equal(only(elsewhere, "item.started")[0]!.payload.itemType, "dynamic_tool_call");
  const bare = grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call", toolCallId: "call-b", title: SPAWN, rawInput: { prompt: "p" } })
  );
  assert.deepEqual(agentRows(bare), [], "no vendor block: no namespace to trust");
  const started = startedBy(grok, "call-s1", { prompt: "p", description: "d", is_background: true });
  assert.equal(started.payload.isBackgrounded, false, "`is_background` is run_terminal_command's spelling");
});

// ---------------------------------------------------------------------------
// One bubble per prompt: a steer's reply, and a CLI prompt's held frames that
// join our open turn (AGENTS.md, "Grok: shells are live work", point (5))
// ---------------------------------------------------------------------------

/** One `agent_message_chunk`, naming the prompt that produced it when `promptId` is given. */
function chunkOf(grok: GrokNormalizer, text: string, promptId?: string): RuntimeEvent[] {
  return grok.handleSessionUpdate({
    sessionId: SESSION,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    _meta: promptId === undefined ? {} : { promptId }
  } as unknown as SessionNotification);
}

/** Each assistant bubble's text, in the order the bubbles opened. */
function bubbleTexts(events: readonly RuntimeEvent[]): string[] {
  const bubbles = new Map<string, string>();
  for (const event of only(events, "content.delta")) {
    if (event.payload.streamKind !== "assistant_text") continue;
    bubbles.set(event.itemId ?? "", (bubbles.get(event.itemId ?? "") ?? "") + event.payload.delta);
  }
  return [...bubbles.values()];
}

/** `item.started` / `item.completed` of the assistant bubbles, in order. */
function bubbleEdges(events: readonly RuntimeEvent[]): string[] {
  return events
    .filter(
      (event) =>
        (event.type === "item.started" || event.type === "item.completed") &&
        (event.payload as { itemType?: string }).itemType === "assistant_message"
    )
    .map((event) => `${event.type}:${event.itemId}`);
}

test("one bubble per prompt: a chunk naming another prompt closes the open bubble and opens its own", () => {
  // Our prompt P streams; the CLI's own prompt W's held frames join our open
  // turn (past the hold, or a card on our turn — `prompt-queue.ts`); P goes
  // on. ACP's chunks name no message, but every one names its prompt
  // (`_meta.promptId`, fixtures README 19): three bubbles, never one.
  const grok = normalizer();
  const events = [
    ...chunkOf(grok, "p1 ", "P"),
    ...chunkOf(grok, "p2 ", "P"),
    ...chunkOf(grok, "w1 ", "W"),
    ...chunkOf(grok, "w2 ", "W"),
    ...chunkOf(grok, "p3", "P")
  ];
  assert.deepEqual(bubbleTexts(events), ["p1 p2 ", "w1 w2 ", "p3"]);
  const edges = bubbleEdges(events);
  assert.equal(edges.length, 5, "three opened, the first two closed as the next prompt's first chunk arrives");
  assert.deepEqual(
    edges.map((edge) => edge.split(":")[0]),
    ["item.started", "item.completed", "item.started", "item.completed", "item.started"]
  );
  assert.equal(edges[1]!.slice("item.completed:".length), edges[0]!.slice("item.started:".length), "each closes before the next opens");
  assert.ok(events.every((event) => event.turnId === "turn-1"), "all on the one open turn");
  // Whitespace never opens a bubble, even under a prompt of its own.
  assert.deepEqual(bubbleTexts(chunkOf(grok, "  ", "W")), [], "a blank chunk of another prompt opens nothing");
});

test("a prompt's dispatch keeps a prompt-named bubble open for its late chunks, and closes one no chunk named", () => {
  // A steer: the cancelled prompt's bubble stays open at the steered prompt's
  // dispatch, so a chunk it flushes after the cancel still joins it; the
  // steered prompt's first chunk closes it.
  const named = normalizer();
  const opened = chunkOf(named, "one;", "P1");
  assert.deepEqual(named.beginTurn(), [], "a named bubble stays open at the dispatch");
  const late = chunkOf(named, " two", "P1");
  const steered = chunkOf(named, "stop", "P2");
  assert.deepEqual(bubbleTexts([...opened, ...late, ...steered]), ["one; two", "stop"]);
  // With no prompt id to compare, the bubble closes at the dispatch (T3's
  // rule, `AcpSessionRuntime.ts:1033-1034`), so the next prompt's text is a
  // bubble of its own.
  const unnamed = normalizer();
  const first = chunkOf(unnamed, "one;");
  const closed = unnamed.beginTurn();
  assert.deepEqual(
    bubbleEdges(closed),
    bubbleEdges(first).map((edge) => edge.replace("item.started", "item.completed")),
    "the dispatch closes the unnamed bubble"
  );
  const next = chunkOf(unnamed, "two");
  assert.deepEqual(bubbleTexts([...first, ...next]), ["one;", "two"]);
});

// ---------------------------------------------------------------------------
// A subagent's child session (fixture 15: its frames arrive under its own id)
// ---------------------------------------------------------------------------

/** A frame of the child session `childId`, in the captured `session/update` shape. */
function childFrame(childId: string, update: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  return { sessionId: childId, update, _meta: { promptId: "child-prompt", ...meta } } as unknown as SessionNotification;
}

function childXai(childId: string, update: Record<string, unknown>): unknown {
  return { sessionId: childId, update };
}

/** A foreground launch whose `subagent_spawned` has named its child session SUB_A. */
function withChild(turn: TurnCursor = { current: "turn-1" }): GrokNormalizer {
  const grok = normalizer(turn);
  startedBy(grok, "call-s1", FIND_CALLERS);
  grok.handleXaiNotification("_x.ai/session_notification", spawned(SUB_A, "find callers"));
  return grok;
}

test("a child's turn_completed is never the parent turn's usage", () => {
  const grok = withChild();
  const usage = { inputTokens: 23_451, outputTokens: 95, totalTokens: 23_546, costUsdTicks: 146_390_400 };
  grok.handleXaiNotification(
    "_x.ai/session_notification",
    childXai(SUB_A, { sessionUpdate: "turn_completed", prompt_id: "child-prompt", stop_reason: "end_turn", usage })
  );
  grok.handleXaiNotification(
    "_x.ai/session_notification",
    childXai(SUB_A, { sessionUpdate: "response_completed", usage: { input_tokens: 10_078, output_tokens: 58 } })
  );
  assert.equal(grok.turnUsage(), undefined, "the parent's turn has reported no usage of its own");
});

test("a child's catalog, title, mode, model and context size never become the parent's", () => {
  const grok = withChild();
  grok.handleSessionUpdate(
    frame({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "c" }] })
  );
  grok.handleXaiNotification("_x.ai/session_notification", {
    sessionId: SESSION,
    update: { sessionUpdate: "model_changed", model_id: "grok-4.7" }
  });
  const events = [
    ...grok.handleSessionUpdate(
      childFrame(SUB_A, {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "only-the-childs", description: "x" }]
      })
    ),
    ...grok.handleSessionUpdate(childFrame(SUB_A, { sessionUpdate: "session_info_update", title: "Child's title" })),
    ...grok.handleSessionUpdate(childFrame(SUB_A, { sessionUpdate: "current_mode_update", currentModeId: "plan" })),
    ...grok.handleXaiNotification(
      "_x.ai/session_notification",
      childXai(SUB_A, { sessionUpdate: "model_changed", model_id: "grok-4.5" })
    ),
    ...grok.handleSessionUpdate(
      childFrame(SUB_A, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }, { totalTokens: 11_549 })
    )
  ];
  assert.deepEqual(grok.slashCommands.map((command) => command.name), ["compact"]);
  assert.deepEqual(only(events, "thread.metadata.updated"), [], "the child's title is not the thread's");
  assert.equal(grok.isPlanModeActive, false);
  assert.equal(grok.modelId, "grok-4.7");
  assert.equal(grok.contextSize, undefined, "the child's context size is not the thread's");
  assert.deepEqual(only(events, "thread.token-usage.updated"), []);
});

test("a child's hooks, permission_denied and self-resolved interactions are not the parent's", () => {
  const grok = withChild();
  const events = [
    ...grok.handleXaiNotification(
      "_x.ai/session_notification",
      childXai(SUB_A, { sessionUpdate: "hook_run_started", event_name: "permission_denied", tool_name: "write", count: 1 })
    ),
    ...grok.handleXaiNotification(
      "_x.ai/session_notification",
      childXai(SUB_A, { sessionUpdate: "pending_interaction", tool_call_id: "call-c", kind: "permission" })
    ),
    ...grok.handleXaiNotification(
      "_x.ai/session_notification",
      childXai(SUB_A, { sessionUpdate: "interaction_resolved", tool_call_id: "call-c" })
    )
  ];
  assert.deepEqual(events, [], "a hook row names no owner: a child's would land in the parent timeline");
  assert.equal(grok.sawPermissionDenied, false);
  assert.equal(grok.approvalsWereSelfResolved, false);
});

test("a child's words open its agent's own segment; its turn end closes it and leaves the parent's open", () => {
  const grok = withChild();
  const parent = grok.handleSessionUpdate(
    frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting." } })
  );
  const childWords = grok.handleSessionUpdate(
    childFrame(SUB_A, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sub-ok" } })
  );
  const [opened, delta] = childWords;
  assert.equal(opened?.type, "item.started");
  assert.equal(opened?.agentId, "call-s1");
  assert.equal(delta?.type, "content.delta");
  assert.equal(delta?.agentId, "call-s1");
  assert.equal(delta?.turnId, "turn-1");
  assert.notEqual(delta?.itemId, only(parent, "content.delta")[0]?.itemId, "never the parent's bubble");
  const ended = grok.handleXaiNotification(
    "_x.ai/session_notification",
    childXai(SUB_A, { sessionUpdate: "turn_completed", prompt_id: "child-prompt", stop_reason: "end_turn" })
  );
  assert.deepEqual(
    ended.map((event) => [event.type, event.itemId, event.agentId]),
    [["item.completed", delta?.itemId, "call-s1"]]
  );
  const more = grok.handleSessionUpdate(
    frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Done." } })
  );
  assert.equal(only(more, "item.started").length, 0, "the parent's bubble is still the open one");
});

test("a background agent's words after the parent's turn ended are turnless, closed by their own completion", () => {
  const turn: TurnCursor = { current: "turn-1" };
  const grok = normalizer(turn);
  startedBy(grok, "call-bg", { prompt: "p", description: "run tests", background: true });
  grok.handleXaiNotification("_x.ai/session_notification", spawned(SUB_B, "run tests"));
  grok.endTurn();
  turn.current = undefined;
  const words = grok.handleSessionUpdate(
    childFrame(SUB_B, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "bg-done" } })
  );
  const thought = grok.handleSessionUpdate(
    childFrame(SUB_B, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "ok" } })
  );
  for (const event of [...words, ...thought]) {
    assert.equal(event.turnId, undefined, `${event.type} rides no turn`);
    assert.equal(event.agentId, "call-bg");
    assert.ok(event.itemId !== undefined, `${event.type} names its item`);
  }
  const finishedRows = grok.handleXaiNotification("_x.ai/session_notification", finished(SUB_B, "completed", "bg-done"));
  assert.deepEqual(
    finishedRows.map((event) => [event.type, event.itemId ?? (event.payload as { taskId?: string }).taskId]),
    [
      ["item.completed", only(thought, "content.delta")[0]?.itemId],
      ["item.completed", only(words, "content.delta")[0]?.itemId],
      ["task.completed", "call-bg"]
    ],
    "the run's end closes its open thinking and words before its task row"
  );
});

test("a run's end closes its child's open calls BEFORE its task row", () => {
  const grok = withChild();
  const opened = grok.handleSessionUpdate(
    childFrame(SUB_A, { sessionUpdate: "tool_call", toolCallId: "call-child-1", title: "run_terminal_command", rawInput: { command: "sleep 302" } })
  );
  assert.equal(only(opened, "item.started")[0]?.agentId, "call-s1");
  const ended = grok.handleXaiNotification("_x.ai/session_notification", finished(SUB_A, "cancelled"));
  assert.deepEqual(
    ended.map((event) => [event.type, event.itemId ?? (event.payload as { taskId?: string }).taskId]),
    [
      ["item.completed", "call-child-1"],
      ["task.completed", "call-s1"]
    ]
  );
  const failed = only(ended, "item.completed")[0]!;
  assert.equal(failed.payload.status, "failed");
  assert.equal(failed.agentId, "call-s1");
  assert.equal(failed.turnId, "turn-1", "on the turn the call started in");
});

test("subagent_spawned joins a resume to its source's task, and a spawn no launch explains starts its own", () => {
  const grok = normalizer();
  startedBy(grok, "call-s1", FIND_CALLERS);
  grok.handleXaiNotification("_x.ai/session_notification", spawned(SUB_A, "find callers"));
  grok.handleXaiNotification("_x.ai/session_notification", finished(SUB_A, "completed", "main.js:3"));
  const resumed = startedBy(grok, "call-s2", { prompt: "More.", resume_from: SUB_A });
  assert.equal(resumed.payload.taskId, "call-s1");
  const NEW_ID = "01a0c1ab-2222-7333-8444-555566667777";
  grok.handleXaiNotification(
    "_x.ai/session_notification",
    spawned(NEW_ID, "find callers", { resumed_from: SUB_A, effective_context_source: "resumed" })
  );
  const end = grok.handleXaiNotification("_x.ai/session_notification", finished(NEW_ID, "completed", "tests:4"));
  assert.deepEqual(
    only(end, "task.completed").map((event) => [event.payload.taskId, event.payload.toolUseId, event.payload.summary]),
    [["call-s1", "call-s2", "tests:4"]]
  );
  // The CLI's own spawn (a /loop fire; not captured): an agent under its id.
  const LOOP = "01a0c1ac-3333-7444-8555-666677778888";
  const loop = grok.handleXaiNotification("_x.ai/session_notification", spawned(LOOP, "hourly check"));
  assert.deepEqual(
    taskRows(loop).map((event) => [event.type, event.payload.taskId, event.payload.toolUseId]),
    [["task.started", LOOP, LOOP]]
  );
});

// ---------------------------------------------------------------------------
// Monitors (fixture 20; T3's reader)
// ---------------------------------------------------------------------------

test("a Monitor answer with no task_backgrounded before it starts the monitor itself — T3's reader order", () => {
  const grok = normalizer();
  const MONITOR = "01a0d913-6204-7391-8dbb-5ea888f73f03";
  grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call", toolCallId: "call-m", title: "monitor", rawInput: { command: "tail -f x", description: "watch x" } })
  );
  const started = grok.handleSessionUpdate(
    frame({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-m",
      status: "completed",
      rawOutput: { type: "Monitor", taskId: MONITOR, timeoutMs: 36_000_000, persistent: false }
    })
  );
  assert.deepEqual(
    taskRows(started).map((event) => [event.payload.taskId, event.payload.taskType, event.payload.title, event.payload.toolUseId]),
    [[MONITOR, "monitor", "watch x", "call-m"]]
  );
  const event = grok.handleXaiNotification("_x.ai/monitor_event", {
    sessionId: SESSION,
    update: { sessionUpdate: "monitor_event", task_id: MONITOR, description: "watch x", event_text: "ERROR boom" }
  });
  assert.deepEqual(
    agentRows(event).map((row) => [row.type, (row.payload as { summary?: string }).summary]),
    [["task.progress", "ERROR boom"]]
  );
  const unknown = grok.handleXaiNotification("_x.ai/monitor_event", {
    sessionId: SESSION,
    update: { sessionUpdate: "monitor_event", task_id: "01a0d913-0000-7000-8000-000000000000", event_text: "x" }
  });
  assert.deepEqual(unknown, [], "a monitor nobody started starts nothing");
});

// ---------------------------------------------------------------------------
// background_tasks: a row only when something the roster reads changed
// ---------------------------------------------------------------------------

function listing(tasks: Array<Record<string, unknown>>, sessionId = SESSION): unknown {
  return { sessionId, update: { sessionUpdate: "background_tasks", tasks } };
}

const DEV = { task_id: SHELL, command: "npm run dev", description: "dev server", kind: "bash", output_file: "~/out.log" };

test("an unchanged background_tasks listing emits nothing, however often it is restated", () => {
  const grok = normalizer();
  const OTHER = "01a0c1a7-4444-7fc3-894b-56f0bb60a6db";
  const first = grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }]));
  assert.deepEqual(agentRows(first).map((row) => row.type), ["task.started"]);
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }])), []);
  }
  // Another task starting restates this one: still nothing for it.
  const second = grok.handleXaiNotification(
    SNAPSHOTS,
    listing([
      { ...DEV, status: "running" },
      { task_id: OTHER, command: "sleep 9", kind: "bash", status: "running" }
    ])
  );
  assert.deepEqual(agentRows(second).map((row) => [row.type, row.payload.taskId]), [["task.started", OTHER]]);
});

test("a changed listing emits exactly one row, carrying every change", () => {
  const grok = normalizer();
  grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }]));
  const renamed = agentRows(grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, description: "vite", status: "running" }])));
  assert.deepEqual(
    renamed.map((row) => [row.type, row.payload.title, (row.payload as { status?: string }).status]),
    [["task.updated", "vite", undefined]],
    "a new title is one status-less update"
  );
  const both = agentRows(
    grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, description: "vite 2", status: "waiting", output_file: "~/b.log" }]))
  );
  assert.equal(both.length, 1, "status, title and output file: one row");
  assert.deepEqual(
    [both[0]!.type, both[0]!.payload.title, (both[0]!.payload as { status?: string }).status, both[0]!.payload.outputFile],
    ["task.updated", "vite 2", "waiting", "~/b.log"]
  );
  assert.deepEqual(grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, description: "vite 2", status: "waiting", output_file: "~/b.log" }])), []);
});

test("a listing's cancelled status ends the task once — Stop then writes no second end", () => {
  const grok = normalizer();
  grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }]));
  const ended = agentRows(grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "cancelled" }])));
  assert.deepEqual(statuses(ended), [["task.completed", SHELL, "stopped"]]);
  assert.deepEqual(grok.stopBackgroundTasks(), []);
});

test("a revived shell's changes ride a status-less row; an unchanged listing still says nothing", () => {
  const grok = normalizer();
  grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }]));
  grok.stopBackgroundTasks();
  const revived = agentRows(grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }])));
  assert.deepEqual(revived.map((row) => row.type), ["task.started"]);
  assert.deepEqual(grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }])), []);
  const waiting = agentRows(grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "waiting" }])));
  assert.deepEqual(
    waiting.map((row) => [row.type, (row.payload as { status?: string }).status]),
    [["task.progress", undefined]],
    "never a status that would reopen the roster's row"
  );
});

test("a child session's listing never ends the parent's tasks", () => {
  const grok = withChild();
  grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }]));
  const CHILD_SHELL = "call-88e87ad3-152e-4eab-b522-89fc544e8db5-0";
  const childListing = grok.handleXaiNotification(
    SNAPSHOTS,
    listing([{ task_id: CHILD_SHELL, command: "sleep 20", kind: "bash", status: "running" }], SUB_A)
  );
  assert.deepEqual(
    agentRows(childListing).map((row) => [row.type, row.payload.taskId, row.payload.agentId]),
    [["task.started", CHILD_SHELL, "call-s1"]],
    "the child's shell is its agent's; the parent's dev server did not drop out"
  );
  const parentAgain = grok.handleXaiNotification(SNAPSHOTS, listing([{ ...DEV, status: "running" }]));
  assert.deepEqual(parentAgain, [], "…and the parent's listing never ends the child's shell");
});

// ---------------------------------------------------------------------------
// Loops (fixture 29): the teardown and a second run. A goal (fixture 30) is
// the thread's goal, not a roster row: `goal.test.ts`.
// ---------------------------------------------------------------------------

const LOOP_ID = "01a0de9b-e17c-7fa0-83dc-a436461e59b5";

/** One scheduler report, shaped as fixture 29 records it. */
function scheduler(grok: GrokNormalizer, sessionUpdate: string, extra: Record<string, unknown> = {}): RuntimeEvent[] {
  return grok.handleXaiNotification(`_x.ai/${sessionUpdate}`, {
    sessionId: SESSION,
    update: {
      sessionUpdate,
      task_id: LOOP_ID,
      prompt: "Reply with exactly: tick\n\nOne fire does only this.",
      human_schedule: "every 1 minute",
      next_fire_at: "2026-09-26T16:45:52.892176827+00:00",
      ...extra
    }
  });
}

test("the session's end closes a live loop; a later fire notes itself, the CLI re-creating it is a new run", () => {
  const grok = normalizer();
  assert.deepEqual(statuses(scheduler(grok, "scheduled_task_created")), [["task.started", LOOP_ID, undefined]]);

  const closed = only(grok.stopBackgroundTasks(), "task.completed");
  assert.deepEqual(
    closed.map((event) => [event.payload.taskId, event.payload.status]),
    [[LOOP_ID, "stopped"]]
  );

  // The process lived on (a Stop): the CLI's later reports note themselves on
  // the ended row — no start, which would reopen a row the user just stopped
  // — and its end ends nothing twice.
  assert.deepEqual(statuses(scheduler(grok, "scheduled_task_fired", { subagent_id: "sub-1" })), [
    ["task.progress", LOOP_ID, undefined]
  ]);
  assert.deepEqual(scheduler(grok, "scheduled_task_deleted", { reason: "deleted" }), []);

  // Re-created by the CLI: a new run.
  const again = only(scheduler(grok, "scheduled_task_created"), "task.started");
  assert.equal(again[0]?.payload.toolUseId, `loop-run:${LOOP_ID}:launch-1:2`);
});

test("an end the user did not choose says why on a live loop's closing row; the user's end and a Stop say nothing", () => {
  // A deploy, a restart or the CLI's exit ends a `/loop` — it lives in the
  // CLI — and a bare "Stopped" read as if the user had pressed it.
  for (const note of ["Ended when the agent host stopped.", "Ended when the session restarted.", undefined]) {
    const grok = normalizer();
    scheduler(grok, "scheduled_task_created");
    const closed = only(grok.stopBackgroundTasks(note === undefined ? {} : { ended: note }), "task.completed");
    assert.deepEqual(
      closed.map((event) => [event.payload.taskId, event.payload.status, event.payload.summary]),
      [[LOOP_ID, "stopped", note]]
    );
  }
});

test("a loop's deletion by expiry completes it; a report of a loop never seen created starts its row first", () => {
  const grok = normalizer();
  assert.deepEqual(statuses(scheduler(grok, "scheduled_task_fired", { subagent_id: "sub-1" })), [
    ["task.started", LOOP_ID, undefined],
    ["task.progress", LOOP_ID, undefined]
  ]);
  const expired = only(scheduler(grok, "scheduled_task_deleted", { reason: "expired" }), "task.completed");
  assert.deepEqual(expired.map((event) => [event.payload.status, event.payload.summary]), [["completed", "Expired"]]);
});
