/** Fold durable events without starving the host health probe (design invariant 7). */
import {
  applyDomainEvent,
  type DomainEvent,
  type ThreadFoldState
} from "@orquester/api/agent-chat";

const FOLD_CHUNK_SIZE = 500;

/** Apply the shared reducer in log order, yielding between bounded chunks. */
export async function applyEventsChunked(
  state: ThreadFoldState,
  events: readonly DomainEvent[]
): Promise<ThreadFoldState> {
  let next = state;
  for (let index = 0; index < events.length; index += 1) {
    if (index > 0 && index % FOLD_CHUNK_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    next = applyDomainEvent(next, events[index]!);
  }
  return next;
}
