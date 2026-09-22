/**
 * Replay tests for the E6 history projection: a committed
 * `GET /session/:id/message` body, folded through the real `toThreadSnapshot`
 * + `projectOpenCodeHistory`, asserting the `RuntimeEvent` sequence a resumed
 * thread would render (spec §4.1, §9).
 *
 * Fixture 10 is the primary source because it captures the whole shape the
 * projection cares about in one file: a prompt, its answer, a trailing
 * unanswered prompt, the fork of that history under **new** ids, and an empty
 * fork. Fixtures 3 and 6 add the two part kinds fixture 10 has no example of —
 * a completed tool call (and a prompt answered by two assistant messages) and
 * an aborted one with reasoning.
 *
 * Nothing here is hand-written: every message body is read out of the capture.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { OPENCODE_HISTORY_SOURCE, projectOpenCodeHistory } from "./history.ts";
import type { OpenCodeMessageWithParts } from "./routes.ts";
import { toThreadSnapshot } from "./session.ts";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/opencode"
);

interface FixtureRecord {
  kind: "sse" | "http" | "stdout" | "note";
  data: unknown;
}

interface HttpRecord {
  method: string;
  path: string;
  status: number;
  responseBody?: unknown;
}

/**
 * Every `GET /session/<id>/message` body in a capture, keyed by session id —
 * the exact payload `readThread` would have received.
 */
function messageHistories(name: string): Map<string, OpenCodeMessageWithParts[]> {
  const records = readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureRecord);

  const histories = new Map<string, OpenCodeMessageWithParts[]>();
  for (const record of records) {
    if (record.kind !== "http") {
      continue;
    }
    const http = record.data as HttpRecord;
    const match = /^\/session\/([^/?]+)\/message(\?|$)/.exec(http.path);
    if (http.method !== "GET" || match === null || !Array.isArray(http.responseBody)) {
      continue;
    }
    histories.set(match[1]!, http.responseBody as OpenCodeMessageWithParts[]);
  }
  return histories;
}

function historyFor(fixture: string, sessionId: string): OpenCodeMessageWithParts[] {
  const found = messageHistories(fixture).get(sessionId);
  assert.ok(found !== undefined, `${fixture} has no GET /session/${sessionId}/message`);
  return found;
}

/** The projection with deterministic ids, so sequences can be compared exactly. */
function project(threadId: string, messages: OpenCodeMessageWithParts[]): RuntimeEvent[] {
  let counter = 0;
  return projectOpenCodeHistory(toThreadSnapshot(threadId, messages), {
    eventId: () => `evt-${(counter += 1)}`,
    nowIso: () => "2026-09-21T00:00:00.000Z"
  });
}

type ItemCompleted = Extract<RuntimeEvent, { type: "item.completed" }>;
type TurnCompleted = Extract<RuntimeEvent, { type: "turn.completed" }>;

function itemsOf(events: RuntimeEvent[]): ItemCompleted[] {
  return events.filter((event): event is ItemCompleted => event.type === "item.completed");
}

const FIXTURE_10 = "10-fork-rollback-and-messages.ndjson";
const ROOT_SESSION = "ses_f3e57df42ffeYDUh6RvaJqgKpe";
const WHOLE_FORK = "ses_f3e57c48affeHi4702SDbx9MLg";
const EMPTY_FORK = "ses_f3e57c504ffe3tko2eNnLjl5PB";

test("fixture 10: the captured history replays as turn markers around completed items", () => {
  const events = project("thread-1", historyFor(FIXTURE_10, ROOT_SESSION));

  // Two turns: the answered prompt, then the trailing prompt nothing answered.
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "turn.started",
      "item.completed",
      "item.completed",
      "turn.completed",
      "turn.started",
      "item.completed",
      "turn.completed"
    ]
  );

  const items = itemsOf(events);
  assert.deepEqual(
    items.map((item) => [item.payload.itemType, item.payload.detail]),
    [
      ["user_message", "Say the single word: alpha."],
      ["assistant_message", "alpha"],
      // The trailing prompt is a turn of its own, or resuming would silently
      // lose the last thing the user said.
      ["user_message", "Say the single word: bravo."]
    ]
  );
  assert.ok(items.every((item) => item.payload.status === "completed"));
});

test("fixture 10: `step-start` / `step-finish` are bookkeeping and project to nothing", () => {
  const messages = historyFor(FIXTURE_10, ROOT_SESSION);
  const partTypes = messages.flatMap((entry) => (entry.parts ?? []).map((part) => part.type));
  assert.ok(partTypes.includes("step-start") && partTypes.includes("step-finish"));

  // Three text parts in the capture, three items out — the step parts added none.
  assert.equal(
    itemsOf(project("thread-1", messages)).length,
    partTypes.filter((type) => type === "text").length
  );
});

test("fixture 10: every replayed turn reports usage as unavailable, never a guess", () => {
  const events = project("thread-1", historyFor(FIXTURE_10, ROOT_SESSION));
  const completions = events.filter(
    (event): event is TurnCompleted => event.type === "turn.completed"
  );

  assert.equal(completions.length, 2);
  for (const completed of completions) {
    // History is over: `interrupted` would colour a settled row red for nothing.
    assert.equal(completed.payload.state, "completed");
    assert.equal(completed.payload.tokenUsage?.usageStatus, "unavailable");
  }

  // The `step-finish` parts DO carry token counts — attributing them to a turn
  // needs the live ownership bookkeeping, so they are deliberately not used.
  const stepTokens = historyFor(FIXTURE_10, ROOT_SESSION)
    .flatMap((entry) => entry.parts ?? [])
    .filter((part) => part.type === "step-finish");
  assert.ok(stepTokens.length > 0);
});

test("fixture 10: every projected event is stamped historical and carries the turn id", () => {
  const messages = historyFor(FIXTURE_10, ROOT_SESSION);
  const events = project("thread-7", messages);
  const assistantId = messages.find((entry) => entry.info.role === "assistant")?.info.id;

  assert.ok(events.length > 0);
  for (const event of events) {
    // W1's `isHistoricalRuntimeEvent` tests exactly this literal.
    assert.equal(event.raw?.source, OPENCODE_HISTORY_SOURCE);
    assert.equal(event.raw?.source, "host.history");
    assert.equal(event.threadId, "thread-7");
    assert.equal(typeof event.turnId, "string");
    assert.equal(event.providerRefs?.providerTurnId, event.turnId);
    assert.equal(typeof event.createdAt, "string");
  }
  // The turn is keyed on the ASSISTANT message — the unit `rollbackThread` counts.
  assert.equal(events[0]!.turnId, assistantId);
});

test("fixture 10: history replays identically after a whole-history fork, under the new ids", () => {
  const original = project("thread-1", historyFor(FIXTURE_10, ROOT_SESSION));
  const forked = project("thread-1", historyFor(FIXTURE_10, WHOLE_FORK));

  const shape = (events: RuntimeEvent[]): unknown[] =>
    events.map((event) => [
      event.type,
      event.type === "item.completed" ? event.payload.itemType : null,
      event.type === "item.completed" ? event.payload.detail : null
    ]);

  assert.deepEqual(shape(forked), shape(original));
  // A fork rewrites every id, so the projection must key off the fork's own.
  const originalTurns = new Set(original.map((event) => event.turnId));
  for (const event of forked) {
    assert.equal(originalTurns.has(event.turnId), false);
  }
});

test("fixture 10: an empty fork projects to no events at all", () => {
  assert.deepEqual(project("thread-1", historyFor(FIXTURE_10, EMPTY_FORK)), []);
});

test("fixture 3: a completed tool call replays under its lifecycle type with its callID", () => {
  const fixture = "03-permission-ask-reply-once.ndjson";
  const messages = historyFor(fixture, "ses_f3e621707ffej6ZWX9gnB3hIjM");
  const events = project("thread-1", messages);

  const tool = itemsOf(events).find((item) => item.payload.itemType === "command_execution");
  assert.ok(tool !== undefined, "the bash call should replay as a command_execution item");
  assert.equal(tool.payload.status, "completed");
  assert.equal(tool.payload.title, "echo hi");
  assert.equal(tool.payload.detail, "hi\n");
  // §5.1: the stable handle across a call's lifecycle.
  const data = tool.payload.data as Record<string, unknown> | undefined;
  assert.equal(data?.toolUseId, "tool_bash_hUFbWmc0v5dvHJZ6lgfR");
  assert.equal(tool.itemId, "tool_bash_hUFbWmc0v5dvHJZ6lgfR");
  assert.equal(data?.command, "echo hi");

  // Two assistant messages answer ONE prompt here, so the prompt must be
  // attached to the first of them only — never replayed twice.
  const prompts = itemsOf(events).filter((item) => item.payload.itemType === "user_message");
  assert.equal(prompts.length, 1);
});

test("fixture 6: reasoning replays as its own item and an aborted tool call is failed", () => {
  const fixture = "06-abort-with-permission-pending.ndjson";
  const messages = historyFor(fixture, "ses_f3e59fb7affeW8iTraEqOrrRL6");
  const items = itemsOf(project("thread-1", messages));

  const reasoning = items.find((item) => item.payload.itemType === "reasoning");
  assert.ok(reasoning !== undefined);
  assert.match(String(reasoning.payload.detail), /Executing Bash Command/);

  const tool = items.find((item) => item.payload.itemType === "command_execution");
  assert.ok(tool !== undefined);
  assert.equal(tool.payload.status, "failed");
  assert.equal(tool.payload.detail, "Tool execution aborted");

  // No approval is replayed: an answered-or-abandoned request is not actionable.
  const types = new Set(project("thread-1", messages).map((event) => event.type));
  assert.equal(types.has("request.opened"), false);
  assert.equal(types.has("content.delta"), false);
});
