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

function normalizer(turnId: { current: string | undefined } = { current: "turn-1" }): GrokNormalizer {
  let counter = 0;
  const created = new GrokNormalizer(
    {
      threadId: "thread-1",
      stamp: () => {
        counter += 1;
        return { eventId: `e${counter}`, createdAt: `2026-09-24T00:00:${String(counter % 60).padStart(2, "0")}.000Z` };
      },
      uuid: () => {
        counter += 1;
        return `u${counter}`;
      },
      activeTurnId: () => turnId.current,
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

test("a late status-less update of a finished call never starts it again", () => {
  const grok = normalizer();
  const events: RuntimeEvent[] = [];
  for (const params of capturedCall("03b-bash-output-accumulation.ndjson", ECHO_CALL)) {
    events.push(...grok.handleSessionUpdate(params));
  }
  assert.equal(only(events, "item.completed").length, 1, "the captured call completes once");

  const late = grok.handleSessionUpdate(lateResend);
  assert.deepEqual(
    late.filter((event) => event.itemId === ECHO_CALL).map((event) => event.type),
    [],
    "a finished call has no lifecycle left to report"
  );
});

test("…so the process exiting does not fail a call that completed", () => {
  const grok = normalizer();
  for (const params of capturedCall("03b-bash-output-accumulation.ndjson", ECHO_CALL)) {
    grok.handleSessionUpdate(params);
  }
  grok.handleSessionUpdate(lateResend);
  const closing = grok.failOpenTools("The agent process exited.");
  assert.deepEqual(
    closing.filter((event) => event.itemId === ECHO_CALL).map((event) => [event.type, (event.payload as { status?: string }).status]),
    [],
    "the late frame re-registered the call as open, and the exit sweep then failed it"
  );
});

test("the finished-call memory is bounded: the oldest id is forgotten first", () => {
  const grok = normalizer();
  const finish = (id: string): RuntimeEvent[] => [
    ...grok.handleSessionUpdate(frame({ sessionUpdate: "tool_call", toolCallId: id, title: "read_file", rawInput: {} })),
    ...grok.handleSessionUpdate(frame({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" }))
  ];
  for (let index = 0; index <= FINISHED_CALLS_REMEMBERED; index += 1) {
    finish(`call-${index}`);
  }
  const resend = (id: string): RuntimeEvent[] =>
    grok.handleSessionUpdate(frame({ sessionUpdate: "tool_call_update", toolCallId: id, title: "again" }));
  assert.equal(only(resend("call-0"), "item.started").length, 1, "past the bound, call-0 reads as a new call");
  assert.equal(resend("call-1").length, 0, "still remembered");
  assert.equal(resend(`call-${FINISHED_CALLS_REMEMBERED}`).length, 0, "the newest is remembered");
});

test("a late frame with a terminal status still restates the end, never a start", () => {
  const grok = normalizer();
  for (const params of capturedCall("03b-bash-output-accumulation.ndjson", ECHO_CALL)) {
    grok.handleSessionUpdate(params);
  }
  const late = grok.handleSessionUpdate(
    frame({ sessionUpdate: "tool_call_update", toolCallId: ECHO_CALL, status: "completed" })
  );
  assert.equal(only(late, "item.started").length, 0);
});
