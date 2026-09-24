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
 * README observation 36).
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { SessionNotification } from "./acp/_generated/schema.ts";
import { agentFrames, readCapture } from "./fixtures.ts";
import { FINISHED_CALLS_REMEMBERED, GrokNormalizer } from "./normalize.ts";

const SESSION = "01a0c1a7-1185-7171-9447-3aa38569088c";

function normalizer(): GrokNormalizer {
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
      activeTurnId: () => "turn-1",
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

test("a late frame with a terminal status still restates the end, never a start", () => {
  const grok = echoCompleted();
  const late = grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call_update", toolCallId: ECHO_CALL, status: "completed" })
  );
  assert.equal(only(late, "item.started").length, 0);
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

/** A background launch whose call already answered with the subagent's id — in its text only. */
function backgroundLaunched(grok: GrokNormalizer): void {
  const input = { prompt: "p", description: "run tests", background: true };
  grok.handleSessionUpdate(spawnStart("call-bg", input));
  grok.handleSessionUpdate(spawnEnd("call-bg", "completed", `Background subagent ${SUB_B} started.`));
}

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
    isBackgrounded: false
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
    spawnEnd("call-bg", "completed", `Background subagent ${SUB_B} started.`)
  );
  assert.deepEqual(returned.map((event) => event.type), ["item.completed"], "the call ended, not the agent");
  assert.deepEqual(taskRows(grok.endTurn()), [], "it outlives the parent's turn");

  const closing = taskRows(grok.stopBackgroundTasks());
  assert.deepEqual(statuses(closing), [["task.completed", "call-bg", "stopped"]]);
  assert.deepEqual(grok.stopBackgroundTasks(), [], "closed once");
});

test("a foreground spawn still open when its turn ends was cut with the turn, and reads stopped", () => {
  // `session/cancel` leaves an in-flight call with no terminal frame at all
  // (fixture 05's write), and the CLI cancels a foreground subagent with its
  // parent's turn.
  const grok = normalizer();
  startedBy(grok, "call-s1", { prompt: "p", description: "find callers" });
  assert.deepEqual(statuses(taskRows(grok.endTurn())), [["task.completed", "call-s1", "stopped"]]);
  assert.deepEqual(grok.stopBackgroundTasks(), [], "nothing left live");
});

test("resume_from reopens the settled agent: the same task, launched again by the new call", () => {
  const grok = normalizer();
  startedBy(grok, "call-s1", FIND_CALLERS);
  const output = { type: "SubagentCompleted", subagent_id: SUB_A };
  endedBy(grok, spawnEnd("call-s1", "completed", "main.js:3", output));

  const started = startedBy(grok, "call-s2", {
    prompt: "Now check the tests too.",
    subagent_type: "explore",
    resume_from: SUB_A
  });
  assert.equal(started.payload.taskId, "call-s1", "the resumed conversation is the same roster row");
  assert.equal(started.payload.toolUseId, "call-s2", "…launched by a new call, which is what reopens it");
  assert.equal(started.payload.title, "find callers", "a resume naming no description keeps the agent's");

  const end = endedBy(grok, spawnEnd("call-s2", "completed", "tests/add.test.js:4"));
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
  const end = endedBy(grok, spawnEnd("call-s2", "completed", "all green"));
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
  endedBy(grok, spawnEnd("call-s1", "completed", `Reviewed ${SUB_B}: fine.`));
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
    spawnEnd("call-s1", "completed", `Task ${SUB_B} in session ${SESSION} serves on :5173.`, {
      type: "SubagentCompleted",
      subagent_id: SUB_A
    })
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

test("a steer inside the turn keeps the turn's hasSubagents", () => {
  const grok = normalizer();
  backgroundLaunched(grok);
  grok.stopBackgroundTasks();
  grok.beginTurn(); // a steer re-opens the stream under the SAME turn id
  assert.equal(turnUsage(grok.turnCompleted("turn-1", { stopReason: "end_turn" }))?.hasSubagents, true);
  assert.equal(turnUsage(grok.turnCompleted("turn-2", { stopReason: "end_turn" }))?.hasSubagents, false);
});
