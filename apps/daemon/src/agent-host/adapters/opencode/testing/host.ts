/**
 * OpenCode adapter — test support: runtime events through the host's REAL
 * ingestion and fold, the seams every reader of a thread sits behind (the
 * GUI's snapshot, the host's `GET …/items/:itemId` and its streamed-output
 * join, the MCP's transcript and `read_tool_output`).
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

import { createIngestion } from "../../../ingestion/index.ts";
import {
  FakeClock,
  RecordingLiveness,
  RecordingSink,
  counterIdGen
} from "../../../ingestion/test-harness.ts";

/** The thread every helper here writes, as the adapter tests name it. */
export const HOST_THREAD_ID = "thread-1";

/** The host's own first line of an OpenCode thread: ingestion never writes it. */
const CREATED: DomainEvent = {
  seq: 1,
  eventId: "created",
  threadId: HOST_THREAD_ID,
  occurredAt: "2026-09-21T09:59:00.000Z",
  commandId: null,
  causationEventId: null,
  metadata: {},
  type: "thread.created",
  payload: {
    projectPath: "/repo",
    cwd: "/repo",
    title: "New thread",
    adapter: "opencode",
    refId: "opencode",
    accountId: "",
    home: "system",
    modelSelection: { model: "openrouter/google/gemini-3.1-flash-lite" },
    runtimeMode: "approval-required"
  }
};

interface HostIngestion {
  /**
   * Ingest `events` in order, as the session emits them, then move the
   * ingestion clock past the §5.6 buffer's 250 ms flush and wait for what it
   * writes — so a step that streamed text or output has written its rows.
   */
  ingest(events: readonly RuntimeEvent[]): Promise<void>;
  /** The log so far: the host's `thread.created`, then every line ingestion appended, sequenced. */
  log(): DomainEvent[];
  /** The thread that log folds to, by the real fold. */
  fold(): ThreadFoldState;
}

/**
 * One thread's ingestion, driven step by step, and the log it writes.
 */
export function createHostIngestion(): HostIngestion {
  const clock = new FakeClock();

  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
  });
  const log = (): DomainEvent[] => [
    CREATED,
    ...sink.events().map((event, index) => ({ ...event, seq: index + 2 }) as DomainEvent)
  ];
  return {
    async ingest(events) {
      for (const event of events) {
        await ingestion.ingest(event);
      }
      clock.advance(300);
      await ingestion.drain();
    },
    log,
    fold: () => log().reduce(applyDomainEvent, createEmptyThreadState())
  };
}
