/**
 * `projectHistory` (E6), replayed from the real `session/load` capture.
 *
 * Fixture `06-session-load-replay.ndjson` is a fresh process loading the
 * session `02` created: the agent replays the transcript as `session/update`
 * frames with `_meta.isReplay: true` plus the xAI-private ones under
 * `_x.ai/session/update` — the method name T3 does not register, which is why
 * an adapter that knows only `_x.ai/session_notification` sees none of the
 * `turn_completed` rows that delimit the turns.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent, ThreadSnapshot } from "@orquester/api/agent-chat";

import { agentFrames, readCapture, type JsonRpcFrame } from "./fixtures.ts";
import {
  GROK_HISTORY_RAW_METHOD,
  GrokHistoryCollector,
  projectGrokHistory,
  type GrokHistoryItem
} from "./history.ts";
import { GrokNormalizer } from "./normalize.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";

function stamps(): { stamp: () => { eventId: string; createdAt: string } } {
  let n = 0;
  return {
    stamp: () => {
      n += 1;
      return { eventId: `h${n}`, createdAt: "2026-09-21T00:00:00.000Z" };
    }
  };
}

/** Fold the capture through a real normaliser, exactly as the session does. */
function historyFromCapture(file: string): ThreadSnapshot {
  const normalizer = new GrokNormalizer(
    {
      threadId: "t1",
      stamp: stamps().stamp,
      uuid: () => "u",
      activeTurnId: () => undefined,
      planHost: { platform: "linux", env: {} }
    },
    "session-1"
  );
  for (const frame of agentFrames(readCapture(file))) {
    route(normalizer, frame);
  }
  return { threadId: "t1", turns: normalizer.historyTurns() };
}

function route(normalizer: GrokNormalizer, frame: JsonRpcFrame): void {
  if (frame.method === "session/update") {
    normalizer.handleSessionUpdate(frame.params as SessionNotification);
    return;
  }
  if (frame.method === "_x.ai/session/update" || frame.method === "_x.ai/session_notification") {
    normalizer.handleXaiNotification(frame.method, frame.params);
  }
}

// ---------------------------------------------------------------------------

test("the replayed transcript really is in the capture", () => {
  const replayed = agentFrames(readCapture("06-session-load-replay.ndjson")).filter((frame) => {
    const params = frame.params as { _meta?: { isReplay?: boolean } } | undefined;
    return params?._meta?.isReplay === true;
  });
  assert.ok(replayed.length >= 3);
  assert.ok(
    replayed.some((frame) => frame.method === "_x.ai/session/update"),
    "the turn delimiter arrives on the underscore channel"
  );
});

test("the session/load replay is collected into turns", () => {
  const snapshot = historyFromCapture("06-session-load-replay.ndjson");
  assert.equal(snapshot.turns.length, 1, "the capture replays one finished turn");
  const turn = snapshot.turns[0];
  // The provider's OWN prompt id, from the replayed `turn_completed`.
  assert.equal(turn.id, "f8f85d1b-e6be-4e6c-9073-5ae82cd1b299");

  const items = turn.items as GrokHistoryItem[];
  assert.deepEqual(
    items.map((item) => item.kind),
    ["user_message", "assistant_message"]
  );
  assert.equal((items[0] as { text: string }).text, "Reply with exactly: OK");
  assert.equal((items[1] as { text: string }).text, "OK");
});

test("a live turn contributes nothing — its events are already in the host's log", () => {
  const snapshot: ThreadSnapshot = {
    threadId: "t1",
    turns: [
      { id: "grok-turn-1", items: [{ kind: "observed_turn", providerPromptId: "p1", stopReason: "end_turn" }] }
    ]
  };
  assert.deepEqual(projectGrokHistory(snapshot, { threadId: "t1", ...stamps() }), []);
});

test("each replayed turn projects started / items / completed, in order", () => {
  const snapshot = historyFromCapture("06-session-load-replay.ndjson");
  const events = projectGrokHistory(snapshot, { threadId: "t1", ...stamps() });

  assert.deepEqual(
    events.map((event) => event.type),
    ["turn.started", "item.completed", "item.completed", "turn.completed"]
  );
  assert.equal(
    events.every((event) => event.turnId === "f8f85d1b-e6be-4e6c-9073-5ae82cd1b299"),
    true
  );
  assert.equal(
    events.every((event) => event.threadId === "t1"),
    true
  );

  const items = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "item.completed" }> => event.type === "item.completed"
  );
  assert.equal(items[0].payload.itemType, "user_message");
  assert.equal(items[0].payload.detail, "Reply with exactly: OK");
  assert.equal(items[1].payload.itemType, "assistant_message");
  assert.equal(items[1].payload.detail, "OK");
  assert.equal(
    items.every((event) => event.payload.status === "completed"),
    true
  );
});

test("a projected turn never claims token usage it cannot account for", () => {
  // The replayed `turn_completed` DOES carry a full usage block, but it covers
  // the whole original turn while replay returned a handful of rows (README
  // 10: 39 events produced, 5 replayed).
  const snapshot = historyFromCapture("06-session-load-replay.ndjson");
  const completed = projectGrokHistory(snapshot, { threadId: "t1", ...stamps() }).find(
    (event): event is Extract<RuntimeEvent, { type: "turn.completed" }> => event.type === "turn.completed"
  );
  assert.equal(completed?.payload.state, "completed");
  assert.equal(completed?.payload.stopReason, null);
  assert.equal(completed?.payload.tokenUsage?.usageStatus, "unavailable");
  assert.equal(completed?.payload.totalCostUsd, undefined);
});

test("every projected event is stamped as replayed history, not live traffic", () => {
  const snapshot = historyFromCapture("06-session-load-replay.ndjson");
  for (const event of projectGrokHistory(snapshot, { threadId: "t1", ...stamps() })) {
    assert.equal(event.raw?.method, GROK_HISTORY_RAW_METHOD);
    assert.equal(event.raw?.source, "acp.grok.extension");
    assert.deepEqual(event.raw?.payload, {
      turnId: "f8f85d1b-e6be-4e6c-9073-5ae82cd1b299",
      historical: true
    });
  }
});

test("event ids are unique across the whole projection", () => {
  const snapshot = historyFromCapture("06-session-load-replay.ndjson");
  const events = projectGrokHistory(snapshot, { threadId: "t1", ...stamps() });
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
});

test("a thread with nothing replayed projects nothing", () => {
  // Every other capture is a fresh `session/new`, so none of them replays.
  const snapshot = historyFromCapture("02-prompt-plain-text.ndjson");
  assert.deepEqual(snapshot.turns, []);
  assert.deepEqual(projectGrokHistory(snapshot, { threadId: "t1", ...stamps() }), []);
});

// ---------------------------------------------------------------------------
// The collector's own rules
// ---------------------------------------------------------------------------

test("chunks accumulate and a turn_completed closes the turn under its prompt id", () => {
  const collector = new GrokHistoryCollector();
  collector.observeAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "he" } });
  collector.observeAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "llo" } });
  collector.observeAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
  collector.observeXaiUpdate({ sessionUpdate: "turn_completed", prompt_id: "p1" });

  const turns = collector.snapshotTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, "p1");
  assert.deepEqual(turns[0].items, [
    { kind: "user_message", text: "hello" },
    { kind: "assistant_message", text: "hi" }
  ]);
});

test("a tool call is kept, and it flushes the text before it", () => {
  const collector = new GrokHistoryCollector();
  collector.observeAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "writing" } });
  collector.observeAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "write",
    status: "completed"
  });
  collector.observeXaiUpdate({ sessionUpdate: "turn_completed", prompt_id: "p1" });

  const items = collector.snapshotTurns()[0].items as GrokHistoryItem[];
  assert.deepEqual(items.map((item) => item.kind), ["assistant_message", "tool_call"]);
  assert.equal((items[1] as { toolCallId: string }).toolCallId, "call-1");
});

test("an unterminated tail is kept under a synthetic id rather than lost", () => {
  const collector = new GrokHistoryCollector();
  collector.observeAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "q" } });
  const turns = collector.snapshotTurns();
  assert.equal(turns.length, 1);
  assert.match(turns[0].id, /^grok-history-/);
});

test("non-text content and an id-less tool call are ignored, never thrown on", () => {
  const collector = new GrokHistoryCollector();
  collector.observeAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "image", data: "…" } });
  collector.observeAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "" });
  collector.observeAcpUpdate({ sessionUpdate: "session_info_update", title: "ignored" });
  collector.observeXaiUpdate({ sessionUpdate: "hook_execution" });
  assert.deepEqual(collector.snapshotTurns(), []);
});
