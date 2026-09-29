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
  type ThreadFoldState
} from "@orquester/api/agent-chat";

import { createIngestion } from "../../ingestion/index.ts";
import {
  FakeClock,
  RecordingLiveness,
  RecordingSink,
  counterIdGen
} from "../../ingestion/test-harness.ts";
import type { RuntimeEventDraft } from "./normalise.ts";

const FOLD_TESTING_THREAD_ID = "thread-1";

/**
 * Ingest `steps` in order, as the session emits them, and answer the log they
 * write: the host's `thread.created` first, then everything ingestion appended,
 * sequenced as the store sequences it. After each step ingestion drains buffered output, so a step that streams
 * output writes its own `tool.output` row.
 */
export async function ingestCodexDrafts(
  steps: readonly (readonly RuntimeEventDraft[])[]
): Promise<DomainEvent[]> {
  const clock = new FakeClock();

  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
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
    clock.advance(300);
    await ingestion.drain();
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
