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

import { HISTORICAL_RAW_SOURCE, type RuntimeEvent, type ThreadSnapshot } from "@orquester/api/agent-chat";

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
  // The shared marker is what a consumer keys on: a historical event never
  // raises attention, never fires a push and never moves a live turn.
  const snapshot = historyFromCapture("06-session-load-replay.ndjson");
  const events = projectGrokHistory(snapshot, { threadId: "t1", ...stamps() });
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.raw?.source, HISTORICAL_RAW_SOURCE);
    assert.equal(event.raw?.method, GROK_HISTORY_RAW_METHOD, "which channel it was rebuilt from");
    assert.deepEqual(event.raw?.payload, { turnId: "f8f85d1b-e6be-4e6c-9073-5ae82cd1b299" });
  }
});

test("a LIVE event never carries the historical marker", () => {
  // The two must stay distinguishable: everything the normaliser emits from a
  // real frame keeps its own ACP/vendor source.
  const snapshot = historyFromCapture("06-session-load-replay.ndjson");
  const historical = new Set(
    projectGrokHistory(snapshot, { threadId: "t1", ...stamps() }).map((event) => event.raw?.source)
  );
  assert.deepEqual([...historical], [HISTORICAL_RAW_SOURCE]);

  const normalizer = new GrokNormalizer(
    {
      threadId: "t1",
      stamp: stamps().stamp,
      uuid: () => "u",
      activeTurnId: () => "turn-1",
      planHost: { platform: "linux", env: {} }
    },
    "session-1"
  );
  normalizer.beginTurn();
  const live: RuntimeEvent[] = [];
  for (const frame of agentFrames(readCapture("02-prompt-plain-text.ndjson"))) {
    route2(normalizer, frame, live);
  }
  assert.ok(live.length > 0);
  assert.equal(
    live.some((event) => event.raw?.source === HISTORICAL_RAW_SOURCE),
    false
  );
});

function route2(normalizer: GrokNormalizer, frame: JsonRpcFrame, out: RuntimeEvent[]): void {
  if (frame.method === "session/update") {
    out.push(...normalizer.handleSessionUpdate(frame.params as SessionNotification));
    return;
  }
  if (frame.method === "_x.ai/session/update" || frame.method === "_x.ai/session_notification") {
    out.push(...normalizer.handleXaiNotification(frame.method, frame.params));
  }
}

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

test("a replayed prompt loses the `Attached files:` block the adapter appended, from the whole message", () => {
  // The replay echoes the text the adapter SENT, suffix included
  // (`attachment-lines.ts`). The chunk boundary sits inside the block's path
  // on purpose: stripped chunk by chunk, the first chunk alone reads as a
  // block and ".xlsx" is left behind.
  const collector = new GrokHistoryCollector();
  collector.observeAcpUpdate({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "hello\n\nAttached files:\n- q3.xlsx: /a/q3" }
  });
  collector.observeAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: ".xlsx" } });
  collector.observeAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
  collector.observeXaiUpdate({ sessionUpdate: "turn_completed", prompt_id: "p1" });
  // An attachment-only prompt: the block is all the user sent, and a replay
  // has no attachment chips to show instead, so it stays.
  collector.observeAcpUpdate({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "Attached files:\n- notes.txt: /a/notes.txt" }
  });
  collector.observeAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "read it" } });
  collector.observeXaiUpdate({ sessionUpdate: "turn_completed", prompt_id: "p2" });

  const events = projectGrokHistory(
    { threadId: "t1", turns: collector.snapshotTurns() },
    { threadId: "t1", ...stamps() }
  );
  const rows = events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "item.completed" }> => event.type === "item.completed"
    )
    .map((event) => [event.turnId, event.payload.itemType, event.payload.detail]);
  assert.deepEqual(rows, [
    ["p1", "user_message", "hello"],
    ["p1", "assistant_message", "ok"],
    ["p2", "user_message", "Attached files:\n- notes.txt: /a/notes.txt"],
    ["p2", "assistant_message", "read it"]
  ]);
});

test("a replayed goal <system-reminder> projects as the /goal that set it, and the goal rows project nothing", () => {
  // Goals §6.3 items 4–5, shaped on a real goal session (fixtures README
  // observation 36): the goal's `goal_updated` rows arrive BEFORE its user
  // message, and that message is a ~6 KB reminder block, never what the user
  // typed. Text invented.
  const objective = "Audit every request handler for cross-clinic data access and fix each hole.";
  const block =
    `<system-reminder>\nA goal has been set: ${objective}\n\nYou are working directly on this goal across multiple turns. Deliver\n` +
    "EVERYTHING the user asked for yourself — no follow-up questions, no manual\nsteps left for the user.\n\n" +
    "Plan: /home/sessions/goal/plan.md\n\nStart now.\n</system-reminder>\n\n";
  const goalRow = (fields: Record<string, unknown>): Record<string, unknown> => ({
    sessionUpdate: "goal_updated",
    goal_id: "3f6b2c1e-8a4d-4f0b-9c2e-7d5a1b9e0c44",
    objective,
    status: "active",
    phase: "executing",
    tokens_used: 0,
    elapsed_ms: 0,
    total_worker_rounds: 0,
    last_event: "goal_created",
    last_event_timestamp: "2026-09-24T09:00:00.622415836+00:00",
    ...fields
  });
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
  const replayed: RuntimeEvent[] = [];
  const replay = (method: string, update: Record<string, unknown>): void => {
    const params = { sessionId: "s", update, _meta: { eventId: "s-1", isReplay: true } };
    replayed.push(
      ...(method === "session/update"
        ? normalizer.handleSessionUpdate(params as unknown as SessionNotification)
        : normalizer.handleXaiNotification(method, params))
    );
  };
  replay("_x.ai/session/update", goalRow({}));
  replay("_x.ai/session/update", goalRow({ planning: true }));
  replay("session/update", { sessionUpdate: "user_message_chunk", content: { type: "text", text: block } });
  replay("session/update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } });
  replay(
    "_x.ai/session/update",
    goalRow({ status: "complete", phase: "idle", last_event: "goal_completed", total_worker_rounds: 2 })
  );
  replay("_x.ai/session/update", { sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: "end_turn" });
  assert.deepEqual(replayed, [], "replay emits nothing as it arrives");

  const events = projectGrokHistory(
    { threadId: "t1", turns: normalizer.historyTurns() },
    { threadId: "t1", ...stamps() }
  );
  assert.equal(
    events.some((event) => event.type === "thread.goal.updated"),
    false,
    "a replayed goal is the past: never a goal row"
  );
  const rows = events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "item.completed" }> => event.type === "item.completed"
    )
    .map((event) => [event.payload.itemType, event.payload.detail]);
  assert.deepEqual(rows, [
    ["user_message", `/goal ${objective}`],
    ["assistant_message", "On it."]
  ]);
  assert.equal(JSON.stringify(events).includes("You are working directly on this goal"), false, "the block is never rendered");
});

test("text after a replayed goal block survives beneath the /goal line, its attachment block stripped", () => {
  const collector = new GrokHistoryCollector();
  const text =
    "<system-reminder>\nA goal has been set: Fix the audit\n\nYou are working directly on this goal across multiple turns.\n</system-reminder>\n\n" +
    "Also keep the changelog current.\n\nAttached files:\n- notes.txt: /a/notes.txt";
  collector.observeAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  collector.observeXaiUpdate({ sessionUpdate: "turn_completed", prompt_id: "p1" });
  const user = projectGrokHistory(
    { threadId: "t1", turns: collector.snapshotTurns() },
    { threadId: "t1", ...stamps() }
  ).find((event): event is Extract<RuntimeEvent, { type: "item.completed" }> => event.type === "item.completed");
  assert.equal(user?.payload.detail, "/goal Fix the audit\n\nAlso keep the changelog current.");
});

test("a reminder that is not a goal block projects as it was replayed", () => {
  const collector = new GrokHistoryCollector();
  const text = "<system-reminder>\nThe user switched models.\n</system-reminder>";
  collector.observeAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  collector.observeXaiUpdate({ sessionUpdate: "turn_completed", prompt_id: "p1" });
  const events = projectGrokHistory(
    { threadId: "t1", turns: collector.snapshotTurns() },
    { threadId: "t1", ...stamps() }
  );
  const user = events.find(
    (event): event is Extract<RuntimeEvent, { type: "item.completed" }> => event.type === "item.completed"
  );
  assert.equal(user?.payload.detail, text);
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
