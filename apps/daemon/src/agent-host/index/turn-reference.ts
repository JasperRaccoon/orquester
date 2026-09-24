/**
 * Agent host — the turn a log line says it belongs to (design 2026-09-23
 * "thread index and lazy boot", §C).
 *
 * One rule, read in two places: the indexer grows a turn's byte range over a
 * late line that names it (`extendReferenced` in `indexer.ts`), and history
 * planning folds such a line out of a revert's cut when the turn it names
 * survived the revert (`historyBlockEvents` in `orchestration/orchestrator.ts`).
 * Its own module, so the orchestrator reads it without loading the SQLite
 * driver.
 */

import type { DomainEvent } from "@orquester/api/agent-chat";

/**
 * The turn an event says it belongs to: an activity's or a message's
 * `turnId`, a checkpoint's `turnId`. Null for everything else — a session
 * change, a turn request, a revert — and for a line that names no turn.
 */
export function referencedTurnId(event: DomainEvent): string | null {
  switch (event.type) {
    case "thread.activity-appended":
      return stringOrNull(recordOrNull(event.payload?.activity)?.turnId);
    case "thread.turn-diff-completed":
    case "thread.message-sent":
      return stringOrNull(event.payload?.turnId);
    default:
      return null;
  }
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
