/**
 * Codex adapter — test support: normaliser drafts through the host's REAL
 * ingestion and fold, the seams every reader of a thread sits behind (the
 * GUI's snapshot, the host's `GET …/items/:itemId` and its streamed-output
 * join, the MCP's transcript).
 *
 * Not a `*.test.ts`, so `pnpm test` does not execute it; it is typechecked
 * with the rest of the package.
 */

import {
  applyDomainEvent,
  createEmptyThreadState,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadActivityItem,
  type ThreadFoldState
} from "@orquester/api/agent-chat";

import { createIngestion } from "../../ingestion/index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen
} from "../../ingestion/test-harness.ts";
import type { RuntimeEventDraft } from "./normalise.ts";

export const FOLD_TESTING_THREAD_ID = "thread-1";

/**
 * Ingest `steps` in order, as the session emits them, and answer the log they
 * write: the host's `thread.created` first, then everything ingestion appended,
 * sequenced as the store sequences it. After each step the ingestion clock
 * moves past the §5.6 buffer's 250 ms flush, so a step that streams output
 * writes its own `tool.output` row.
 */
export async function ingestCodexDrafts(
  steps: readonly (readonly RuntimeEventDraft[])[]
): Promise<DomainEvent[]> {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  let seq = 0;
  for (const step of steps) {
    for (const draft of step) {
      await ingestion.ingest({
        ...draft,
        eventId: `re-${(seq += 1)}`,
        threadId: FOLD_TESTING_THREAD_ID,
        createdAt: clock.nowIso()
      } as RuntimeEvent);
    }
    timers.advance(300);
  }
  await ingestion.drain();

  const created: DomainEvent = {
    seq: 1,
    eventId: "created",
    threadId: FOLD_TESTING_THREAD_ID,
    occurredAt: "2026-09-21T09:59:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {},
    type: "thread.created",
    payload: {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "New thread",
      adapter: "codex",
      refId: "codex",
      accountId: "acc1",
      home: "system",
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required"
    }
  };
  return [created, ...sink.events().map((event, index) => ({ ...event, seq: index + 2 }) as DomainEvent)];
}

/** The thread the log folds to, by the real fold. */
export function foldCodexLog(events: readonly DomainEvent[]): ThreadFoldState {
  return events.reduce(applyDomainEvent, createEmptyThreadState());
}

/**
 * The newest write of every activity in the log, in log order — what the
 * host's `readItem` answers for an id (§5.6: the row as ingestion wrote it,
 * never slimmed, but for a `tool.updated`, which it stores slimmed).
 */
export function loggedActivities(events: readonly DomainEvent[]): ThreadActivityItem[] {
  const newest = new Map<string, ThreadActivityItem>();
  for (const event of events) {
    if (event.type === "thread.activity-appended") {
      newest.delete(event.payload.activity.id);
      newest.set(event.payload.activity.id, event.payload.activity);
    }
  }
  return [...newest.values()];
}
