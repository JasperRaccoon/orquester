/**
 * Normaliser tests on frames no capture holds: a late update of a finished
 * call, and the `spawn_subagent` tool.
 *
 * Every synthetic frame follows the shape EVERY captured tool call has
 * (`apps/daemon/test/fixtures/grok/`, all fourteen files): a `tool_call` whose
 * `title` and `_meta["x.ai/tool"].name` are the tool's name and whose
 * `rawInput` is the model's own arguments, a status-less `tool_call_update`
 * that rewrites the title and the input (`{variant, …}`), and a terminal
 * `tool_call_update` carrying `content` (what the model reads) and a
 * `rawOutput` tagged by `type`. What is specific to `spawn_subagent` — its
 * parameters, its `background` launch returning a subagent id at once,
 * `resume_from` — comes from the CLI's embedded docs, not a capture (fixtures
 * README observation 36). The poll and kill answers (`TaskOutput`,
 * `KillTask`) and a spawn's text answer (`Text`) take the shapes T3's own
 * reader and tests use (`XAiBackgroundTasks.ts`); the binary names the same
 * tags; none is captured here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { SessionNotification } from "./acp/_generated/schema.ts";
import { agentFrames, readCapture } from "./fixtures.ts";
import {
  ENDED_TASKS_REMEMBERED,
  FINISHED_CALLS_REMEMBERED,
  GROK_AGENT_LIVENESS_TTL_MS,
  GrokNormalizer,
  SUBAGENTS_REMEMBERED
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
      planHost: { platform: "linux", env: { GROK_HOME: "~/home" } }
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

/** A status-less resend after the terminal frame. Never captured: the defect is read off the code path. */
const lateResend = frame({
  sessionUpdate: "tool_call_update",
  toolCallId: ECHO_CALL,
  content: [{ type: "content", content: { type: "text", text: "hi\n" } }]
});

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

test("a late status-less update of a finished call never starts it again", () => {
  const grok = echoCompleted();
  const late = grok.handleSessionUpdate(lateResend);
  assert.deepEqual(
    late.filter((event) => event.itemId === ECHO_CALL).map((event) => event.type),
    [],
    "a finished call has no lifecycle left to report"
  );
});

test("…so the process exiting does not fail a call that completed", () => {
  const grok = echoCompleted();
  grok.handleSessionUpdate(lateResend);
  const closing = grok.failOpenTools("The agent process exited.");
  assert.deepEqual(
    statuses(closing.filter((event) => event.itemId === ECHO_CALL)),
    [],
    "the late frame re-registered the call as open, and the exit sweep then failed it"
  );
});

test("the finished-call memory is bounded: the oldest id is forgotten first", () => {
  const grok = normalizer();
  for (let index = 0; index <= FINISHED_CALLS_REMEMBERED; index += 1) {
    const toolCallId = `call-${index}`;
    const start = { sessionUpdate: "tool_call", toolCallId, title: "read_file", rawInput: {} };
    grok.handleSessionUpdate(frame(start));
    grok.handleSessionUpdate(frame({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" }));
  }
  const resend = (toolCallId: string): RuntimeEvent[] =>
    grok.handleSessionUpdate(frame({ sessionUpdate: "tool_call_update", toolCallId, title: "again" }));
  assert.equal(only(resend("call-0"), "item.started").length, 1, "past the bound, call-0 is a new call");
  assert.equal(resend("call-1").length, 0, "still remembered");
  assert.equal(resend(`call-${FINISHED_CALLS_REMEMBERED}`).length, 0, "the newest is remembered");
});

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

/** The status-less rewrite every captured call gets second; its `variant` name is not captured. */
function spawnRewrite(callId: string): SessionNotification {
  return frame({
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    title: "Subagent: find callers",
    rawInput: { variant: "SpawnSubagent" },
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

/** `[type, taskId, isBackgrounded]` of every task row. */
function backgroundings(events: readonly RuntimeEvent[]): Array<[string, string, boolean | undefined]> {
  return agentRows(events).map((event) => [
    event.type,
    event.payload.taskId,
    (event.payload as { isBackgrounded?: boolean }).isBackgrounded
  ]);
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

const FIND_CALLERS = {
  prompt: "Find every caller of add() and report file:line.",
  description: "find callers",
  subagent_type: "explore"
};

test("a foreground spawn_subagent is a roster agent, started with its call, settled with its result", () => {
  const grok = normalizer();
  const start = grok.handleSessionUpdate(spawnStart("call-s1", FIND_CALLERS));
  const launch = only(start, "item.started");
  assert.equal(launch.length, 1);
  assert.equal(launch[0]!.itemId, "call-s1");
  assert.equal(launch[0]!.payload.itemType, "collab_agent_tool_call", "an agent launch, as Claude's is");
  const [started, ...restOfStart] = only(start, "task.started");
  assert.equal(restOfStart.length, 0);
  assert.equal(started!.turnId, "turn-1");
  assert.deepEqual(started!.payload, {
    taskId: "call-s1",
    taskType: "subagent",
    agentId: "call-s1",
    title: "find callers",
    role: "explore",
    toolUseId: "call-s1",
    description: "find callers",
    isBackgrounded: false,
    livenessTtlMs: GROK_AGENT_LIVENESS_TTL_MS
  });

  const rewrite = grok.handleSessionUpdate(spawnRewrite("call-s1"));
  assert.deepEqual(taskRows(rewrite), [], "the rewrite is the call's, not the agent's");

  const end = grok.handleSessionUpdate(
    spawnEnd("call-s1", "completed", "add() is called from main.js:3 and test.js:7.", {
      type: "SubagentCompleted",
      subagent_id: SUB_A,
      subagent_type: "explore",
      tool_calls: 4,
      turns: 2,
      duration_ms: 5100
    })
  );
  assert.deepEqual(end.map((event) => event.type), ["item.completed", "task.completed"]);
  const completed = only(end, "task.completed")[0]!;
  assert.equal(completed.payload.taskId, "call-s1");
  assert.equal(completed.payload.status, "completed");
  assert.equal(completed.payload.summary, "add() is called from main.js:3 and test.js:7.");
  assert.equal(completed.payload.toolUseId, "call-s1");
  assert.equal(completed.payload.agentId, "call-s1");
  assert.equal(completed.payload.livenessTtlMs, GROK_AGENT_LIVENESS_TTL_MS);

  const settled = grok.turnCompleted("turn-1", { stopReason: "end_turn" });
  assert.equal(turnUsage(settled)?.hasSubagents, true, "the turn ran a subagent");
});

test("a failed spawn settles its agent failed, with the reason", () => {
  const grok = normalizer();
  startedBy(grok, "call-s1", { prompt: "p", description: "nested", subagent_type: "explore" });
  const failed = endedBy(
    grok,
    spawnEnd("call-s1", "failed", "max_depth_exceeded: a subagent cannot spawn subagents")
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.payload.status, "failed");
  assert.match(failed[0]!.payload.summary ?? "", /max_depth_exceeded/);
});

test("a background spawn outlives its call and its turn; Stop or exit closes it", () => {
  const grok = normalizer();
  const started = startedBy(grok, "call-bg", {
    prompt: "Run the whole test suite.",
    description: "run tests",
    background: true
  });
  assert.equal(started.payload.isBackgrounded, true);
  // The call answers at once with the subagent's id; the agent works on.
  const returned = grok.handleSessionUpdate(
    spawnEnd("call-bg", "completed", "Subagent started.", textAnswer(SUB_B))
  );
  assert.deepEqual(returned.map((event) => event.type), ["item.completed"], "the call ended, not the agent");
  assert.deepEqual(taskRows(grok.endTurn()), [], "it outlives the parent's turn");

  const closing = taskRows(grok.stopBackgroundTasks());
  assert.deepEqual(statuses(closing), [["task.completed", "call-bg", "stopped"]]);
  assert.deepEqual(grok.stopBackgroundTasks(), [], "closed once");
});

test("a foreground spawn answered without the completion tag went to the background: it stays live", () => {
  // "foreground subagent exceeded await budget; auto-backgrounding (child
  // keeps running)" — the binary's own log line.
  const grok = normalizer();
  startedBy(grok, "call-s1", FIND_CALLERS);
  const lead = "Subagent took longer than the foreground budget and was moved to the background.";
  const answered = grok.handleSessionUpdate(spawnEnd("call-s1", "completed", lead, textAnswer(SUB_A, lead)));
  assert.deepEqual(
    backgroundings(answered),
    [["task.updated", "call-s1", true]],
    "no end: the run goes on in the background, and says so"
  );
  assert.equal(startedBy(grok, "call-s2", { prompt: "p", resume_from: SUB_A }).payload.taskId, "call-s1");
});

test("a foreground spawn its turn ended under was cut, not ended: its child runs on, backgrounded", () => {
  // `session/cancel` leaves an in-flight call with no terminal frame (fixture
  // 05's write), and "foreground subagent caller gone; auto-backgrounding
  // (child keeps running)". A steer re-opens the turn and changes nothing.
  const grok = normalizer();
  startedBy(grok, "call-s1", { prompt: "p", description: "find callers" });
  grok.beginTurn();
  const cut = grok.endTurn();
  assert.deepEqual(backgroundings(cut), [["task.updated", "call-s1", true]]);
  assert.deepEqual(agentRows(grok.endTurn()), [], "said once");
  const late = grok.handleSessionUpdate(spawnEnd("call-s1", "failed", "cancelled"));
  assert.deepEqual(agentRows(late), [], "a cut call's failure is not the child's end");
  const stopped = taskRows(grok.stopBackgroundTasks());
  assert.deepEqual(statuses(stopped), [["task.completed", "call-s1", "stopped"]]);
});

test("resume_from reopens the settled agent: the same task, launched again by the new call", () => {
  const grok = normalizer();
  startedBy(grok, "call-s1", FIND_CALLERS);
  endedBy(grok, spawnEnd("call-s1", "completed", "main.js:3", completion(SUB_A)));

  const started = startedBy(grok, "call-s2", {
    prompt: "Now check the tests too.",
    subagent_type: "explore",
    resume_from: SUB_A
  });
  assert.equal(started.payload.taskId, "call-s1", "the resumed conversation is the same roster row");
  assert.equal(started.payload.toolUseId, "call-s2", "…launched by a new call, which is what reopens it");
  assert.equal(started.payload.title, "find callers", "a resume naming no description keeps the agent's");

  const end = endedBy(grok, spawnEnd("call-s2", "completed", "tests/add.test.js:4", completion()));
  assert.equal(end.length, 1);
  assert.equal(end[0]!.payload.taskId, "call-s1");
  assert.equal(end[0]!.payload.toolUseId, "call-s2");
  assert.equal(end[0]!.payload.summary, "tests/add.test.js:4");
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
  assert.equal(agentRows(running)[0]!.payload.livenessTtlMs, GROK_AGENT_LIVENESS_TTL_MS);

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

test("a kill ends the agent stopped — only when the call completed and the outcome is killed", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  assert.deepEqual(agentRows(poll(grok, [{ task_id: SUB_B, outcome: "killed" }], "KillTask", "failed")), []);
  assert.deepEqual(agentRows(poll(grok, [{ task_id: SUB_B, outcome: "already_exited" }], "KillTask")), []);
  const killed = poll(grok, [{ task_id: SUB_B, outcome: "killed" }], "KillTask");
  assert.deepEqual(statuses(taskRows(killed)), [["task.completed", "call-bg", "stopped"]]);
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
// An ended task never starts again
// ---------------------------------------------------------------------------

const SNAPSHOTS = "_x.ai/session_notification";
const EMPTY_SNAPSHOT = { sessionId: SESSION, update: { sessionUpdate: "background_tasks", tasks: [] } };

test("a snapshot still listing a shell a poll ended starts nothing, and ends nothing twice", () => {
  const grok = normalizer();
  grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-sh", SHELL));
  const bye = { task_id: SHELL, command: "npm run dev", status: "completed", output: "bye" };
  assert.deepEqual(statuses(taskRows(poll(grok, [bye]))), [["task.completed", SHELL, "completed"]]);
  const listed = grok.handleXaiNotification(SNAPSHOTS, snapshot(SHELL, "bash", "completed"));
  assert.deepEqual(agentRows(listed), [], "the CLI still lists the finished shell: no new start");
  const dropped = grok.handleXaiNotification(SNAPSHOTS, EMPTY_SNAPSHOT);
  assert.deepEqual(agentRows(dropped), [], "…and no second end when it drops out");
  assert.deepEqual(grok.stopBackgroundTasks(), [], "nothing is live");
});

test("a shell ended any other way never starts again either — by a snapshot or a late frame", () => {
  const list = (grok: GrokNormalizer, status: string) =>
    grok.handleXaiNotification(SNAPSHOTS, snapshot(SHELL, "bash", status));
  const ends: Array<[string, string, (grok: GrokNormalizer) => RuntimeEvent[]]> = [
    ["its snapshot status", "completed", (grok) => list(grok, "completed")],
    ["dropping out", "completed", (grok) => grok.handleXaiNotification(SNAPSHOTS, EMPTY_SNAPSHOT)],
    ["Stop", "stopped", (grok) => grok.stopBackgroundTasks()]
  ];
  for (const [how, status, end] of ends) {
    const grok = normalizer();
    list(grok, "running");
    assert.deepEqual(statuses(taskRows(end(grok))), [["task.completed", SHELL, status]], how);
    for (const listed of ["running", "completed"]) {
      assert.deepEqual(agentRows(list(grok, listed)), [], `${how}, then listed ${listed}`);
    }
    const late = grok.handleXaiNotification("_x.ai/task_backgrounded", backgrounded("call-late", SHELL));
    assert.deepEqual(agentRows(late), [], `${how}, then a late task_backgrounded`);
    const restated = grok.handleSessionUpdate(
      frame({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-late-2",
        status: "completed",
        rawOutput: { type: "BackgroundTaskStarted", task_id: SHELL, command: "c" }
      })
    );
    assert.deepEqual(agentRows(restated), [], `${how}, then a late BackgroundTaskStarted`);
    assert.deepEqual(agentRows(grok.handleXaiNotification(SNAPSHOTS, EMPTY_SNAPSHOT)), [], how);
    assert.deepEqual(grok.stopBackgroundTasks(), [], `${how}: nothing is live`);
  }
});

test("the ended-task memory is bounded: the oldest id is forgotten first", () => {
  const grok = normalizer();
  const ids = Array.from(
    { length: ENDED_TASKS_REMEMBERED + 1 },
    (_, index) => `01a0c1ac-0000-7000-8000-${String(index).padStart(12, "0")}`
  );
  const tasks = ids.map((task_id) => ({ task_id, command: "c", kind: "bash", status: "running" }));
  grok.handleXaiNotification(SNAPSHOTS, {
    sessionId: SESSION,
    update: { sessionUpdate: "background_tasks", tasks }
  });
  const ended = grok.handleXaiNotification(SNAPSHOTS, EMPTY_SNAPSHOT);
  assert.equal(only(ended, "task.completed").length, ids.length, "every one dropped out");
  const newest = grok.handleXaiNotification(SNAPSHOTS, snapshot(ids.at(-1)!, "bash", "completed"));
  assert.deepEqual(agentRows(newest), [], "the newest end is remembered");
  const oldest = grok.handleXaiNotification(SNAPSHOTS, snapshot(ids[0]!, "bash", "completed"));
  assert.deepEqual(
    agentRows(oldest).map((event) => event.type),
    ["task.started"],
    "the oldest was forgotten: memory only, as the finished-call bound is"
  );
});

test("an ended subagent's ids outlive its launch's memory: a snapshot listing one is no new shell", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  const done = poll(grok, [{ task_id: SUB_B, command: RUN_TESTS, status: "completed", output: "ok" }]);
  assert.equal(only(done, "task.completed").length, 1);
  // As many later launches push SUB_B's id out of the launch memory.
  for (let index = 0; index < SUBAGENTS_REMEMBERED; index += 1) {
    const callId = `call-many-${index}`;
    const id = `01a0c1ab-0000-7000-8000-${String(index).padStart(12, "0")}`;
    grok.handleSessionUpdate(spawnStart(callId, { prompt: "p", background: true }));
    grok.handleSessionUpdate(spawnEnd(callId, "completed", "Subagent started.", textAnswer(id)));
  }
  const listed = grok.handleXaiNotification(SNAPSHOTS, snapshot(SUB_B, "subagent", "completed"));
  assert.deepEqual(agentRows(listed), []);
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

test("every row naming a subagent carries the hour-long liveness TTL", () => {
  const grok = normalizer();
  const rows: RuntimeEvent[] = [];
  rows.push(...grok.handleSessionUpdate(spawnStart("call-s1", FIND_CALLERS)));
  rows.push(...grok.endTurn());
  rows.push(...poll(grok, [{ task_id: SUB_A, command: "[subagent:explore] x", status: "running" }]));
  grok.beginTurn();
  rows.push(...grok.handleSessionUpdate(spawnStart("call-s2", FIND_CALLERS)));
  rows.push(...grok.handleSessionUpdate(spawnEnd("call-s2", "completed", "done", completion())));
  rows.push(...grok.stopBackgroundTasks());
  const tasks = agentRows(rows);
  assert.deepEqual(
    tasks.map((event) => event.type),
    ["task.started", "task.updated", "task.started", "task.completed", "task.completed"]
  );
  for (const row of tasks) {
    assert.equal(row.payload.livenessTtlMs, GROK_AGENT_LIVENESS_TTL_MS, row.type);
  }
});
