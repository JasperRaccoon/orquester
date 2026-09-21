/**
 * Agent host — the projection seam (spec §5.1, §6.3).
 *
 * There is exactly one definition of "what the thread looks like after these
 * events", and it lives in `@orquester/api/agent-chat` (package W2) so the host
 * and the client apply the same reducer. This module is only the *injection
 * point*: production wires {@link DEFAULT_FOLD_OPS}, and a test may pass a
 * scripted fold so orchestration behaviour can be asserted without the whole
 * projection.
 *
 * It is deliberately not a second fold — nothing here implements any rule.
 */

import {
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  toThreadSnapshot,
  type DomainEvent,
  type ThreadFoldState,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

export interface FoldOps {
  createEmpty(): ThreadFoldState;
  apply(state: ThreadFoldState, event: DomainEvent): ThreadFoldState;
  foldAll(events: Iterable<DomainEvent>): ThreadFoldState;
  snapshot(state: ThreadFoldState): ThreadSnapshotPayload;
}

export const DEFAULT_FOLD_OPS: FoldOps = {
  createEmpty: createEmptyThreadState,
  apply: applyDomainEvent,
  foldAll: foldThread,
  snapshot: toThreadSnapshot
};
