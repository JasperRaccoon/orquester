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
import { FakeClock, FakeTimers, RecordingSink, counterIdGen } from "../../ingestion/test-harness.ts";
import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import type { AppendableDomainEvent } from "../../services.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";
import { agentFrames, readCapture } from "./fixtures.ts";
import { GrokNormalizer } from "./normalize.ts";

const THREAD = "thread-1";
const SESSION = "01a0c1a7-1185-7171-9447-3aa38569088c";

interface Seam {
  grok: GrokNormalizer;
  turn: { current: string | undefined };
  liveness: ReturnType<typeof createLivenessRegistry>;
  /** Normalise, then ingest every event the normaliser returned, in order. */
  feed(events: readonly RuntimeEvent[]): Promise<void>;
  update(update: Record<string, unknown>): Promise<void>;
  activities(): ThreadActivityItem[];
  state(): ReturnType<typeof fold>;
}

function seam(): Seam {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const liveness = createLivenessRegistry();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness,
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  const turn = { current: "turn-1" as string | undefined };
  let counter = 0;
  const grok = new GrokNormalizer(
    {
      threadId: THREAD,
      stamp: () => {
        counter += 1;
        return { eventId: `g${counter}`, createdAt: new Date(Date.parse("2026-09-24T10:00:00.000Z") + counter).toISOString() };
      },
      uuid: () => `u${(counter += 1)}`,
      activeTurnId: () => turn.current,
      planHost: { platform: "linux", env: { GROK_HOME: "~/home" } }
    },
    SESSION
  );
  const feed = async (events: readonly RuntimeEvent[]): Promise<void> => {
    for (const event of events) {
      await ingestion.ingest(event);
    }
    await ingestion.drain();
  };
  return {
    grok,
    turn,
    liveness,
    feed,
    update: async (update) =>
      await feed(
        grok.handleSessionUpdate({ sessionId: SESSION, update, _meta: { promptId: "p1" } } as unknown as SessionNotification)
      ),
    activities: () => fold(sink.events()).activities,
    state: () => fold(sink.events())
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
    (row) => row.activityKind.startsWith("tool.") && (row.payload as { toolUseId?: string }).toolUseId === callId
  );
}

// ---------------------------------------------------------------------------

const ECHO_CALL = "call-a7c3bfe8-967c-4ffe-916f-749b3b6da4c2-0";

test("a late status-less update of a finished call leaves the timeline one completed call", async () => {
  const s = seam();
  await s.feed([{ eventId: "ts", threadId: THREAD, createdAt: "2026-09-24T10:00:00.000Z", turnId: "turn-1", type: "turn.started", payload: {} } as RuntimeEvent]);
  for (const entry of agentFrames(readCapture("03b-bash-output-accumulation.ndjson"))) {
    const params = entry.params as SessionNotification | undefined;
    if (entry.method === "session/update" && (params?.update as { toolCallId?: string }).toolCallId === ECHO_CALL) {
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

  const rows = rowsOfCall(s.activities(), ECHO_CALL);
  assert.equal(rows.filter((row) => row.activityKind === "tool.started").length, 1, "one start: one call");
  const last = rows.at(-1);
  assert.equal(last?.activityKind, "tool.completed");
  assert.equal((last?.payload as { status?: string }).status, "completed", "a completed command never reads failed");
});
