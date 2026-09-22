/**
 * The head arms of the fold, kept as a standalone projection (spec §5.1).
 *
 * `meta.json` exists so boot never replays from zero, which means the store
 * has to be able to advance the head on its own, once every 50 events, WITHOUT
 * carrying the whole timeline in memory beside W1's fold.
 *
 * **These are the same arms as `applyDomainEvent` in `@orquester/api`, and they
 * are kept in step by hand.** `head.test.ts` is the guard: it folds a
 * representative log both ways and asserts the two heads are identical. The
 * fold stays authoritative — `ThreadStore.saveHead` overwrites whatever this
 * tracked, which is also how `continueAfterRestart` (§3.3) survives: it has no
 * domain event, so it only ever reaches disk through an explicit `saveHead`,
 * and this projection carries the field forward untouched.
 */

import type { DomainEvent, ThreadHead } from "@orquester/api/agent-chat";

/**
 * Advance the head by one event. Returns `head` unchanged (same reference)
 * when the event is one of the arms that projects nothing onto it, apart from
 * the `seq`/`updatedAt` stamp every event carries.
 */
export function applyEventToHead(head: ThreadHead | null, event: DomainEvent): ThreadHead | null {
  const next = projectHead(head, event);
  if (next === null) {
    return null;
  }
  return { ...next, seq: event.seq, updatedAt: event.occurredAt };
}

function projectHead(head: ThreadHead | null, event: DomainEvent): ThreadHead | null {
  switch (event.type) {
    case "thread.created": {
      const payload = event.payload;
      return {
        id: event.threadId,
        projectPath: payload.projectPath,
        cwd: payload.cwd,
        title: payload.title,
        adapter: payload.adapter,
        refId: payload.refId,
        accountId: payload.accountId,
        home: payload.home,
        modelSelection: payload.modelSelection,
        runtimeMode: payload.runtimeMode,
        session: { status: "idle", activeTurnId: null },
        turnCount: 0,
        seq: event.seq,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt
      };
    }
    case "thread.meta-updated": {
      if (head === null) return null;
      const { title, modelSelection } = event.payload;
      return {
        ...head,
        ...(title !== undefined ? { title } : {}),
        ...(modelSelection !== undefined ? { modelSelection } : {})
      };
    }
    case "thread.runtime-mode-set":
      return head === null ? null : { ...head, runtimeMode: event.payload.runtimeMode };
    case "thread.session-set": {
      if (head === null) return null;
      // Mirror of the shared fold (`packages/api/src/agent-chat/fold.ts`): the
      // resume cursor and provider thread id carry forward unless the event
      // names new ones, so a settle never strips what the start recorded.
      const incoming = event.payload.session;
      const previous = head.session;
      return {
        ...head,
        session: {
          ...incoming,
          ...(incoming.resumeCursor === undefined && previous.resumeCursor !== undefined
            ? { resumeCursor: previous.resumeCursor }
            : {}),
          ...(incoming.providerThreadId === undefined && previous.providerThreadId !== undefined
            ? { providerThreadId: previous.providerThreadId }
            : {})
        }
      };
    }
    case "thread.turn-diff-completed":
      return head === null || head.turnCount >= event.payload.turnCount
        ? head
        : { ...head, turnCount: event.payload.turnCount };
    case "thread.reverted":
      return head === null ? null : { ...head, turnCount: event.payload.turnCount };
    default:
      return head;
  }
}
