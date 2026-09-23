/**
 * Agent host — the thread index's reads: turn lookups, history paging and
 * search (design 2026-09-23 "thread index and lazy boot", §C "History page",
 * "Search").
 *
 * Nothing here trusts a row's shape: the file is a cache another build may
 * have written, so every column is checked before it reaches a caller.
 */

import {
  THREAD_SEARCH_MAX_QUERY_CHARS,
  THREAD_SEARCH_MAX_RESULTS,
  type HistoryCursor,
  type ThreadSearchHit
} from "@orquester/api/agent-chat";

import type {
  IndexedItemPosition,
  IndexedMessageSpan,
  IndexedTurn,
  SpanningMessage
} from "./index.ts";
import type { SqliteDatabase } from "./sqlite.ts";

export interface ThreadIndexQueries {
  turnByOrdinal(threadId: string, ordinal: number): IndexedTurn | null;
  itemPosition(threadId: string, itemId: string): IndexedItemPosition | null;
  itemPositionBySeq(threadId: string, seq: number): IndexedItemPosition | null;
  hasItemsBefore(threadId: string, seq: number): boolean;
  activitySeqBefore(threadId: string, input: { beforeSeq: number; count: number }): number | null;
  turnsInSeqRange(threadId: string, input: { fromSeq: number; toSeq: number }): IndexedTurn[];
  turnOfSeq(threadId: string, seq: number): IndexedTurn | null;
  eventPositionBySeq(threadId: string, seq: number): IndexedItemPosition | null;
  messageSpan(threadId: string, messageId: string): IndexedMessageSpan | null;
  messagesSpanning(threadId: string, seq: number): SpanningMessage[];
  turnById(threadId: string, turnId: string): IndexedTurn | null;
  totalTurns(threadId: string): number;
  turnsBefore(
    threadId: string,
    input: { before: HistoryCursor | null; beforeTurn?: IndexedTurn | null; limit: number }
  ): IndexedTurn[];
  rewindable(threadId: string, turn: IndexedTurn): boolean;
  search(input: { q: string; limit: number; projectPath?: string }): ThreadSearchHit[];
}

const TURN_COLUMNS = `turn_id, ordinal, user_message_id, requested_at, started_at, completed_at,
  first_seq, last_seq, first_byte, end_byte`;

export function createThreadIndexQueries(db: SqliteDatabase): ThreadIndexQueries {
  const sql = {
    turnByOrdinal: db.prepare(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE thread_id = ? AND ordinal = ? LIMIT 1`
    ),
    turnById: db.prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE thread_id = ? AND turn_id = ?`),
    totalTurns: db.prepare("SELECT COUNT(*) AS total FROM turns WHERE thread_id = ?"),
    newestTurns: db.prepare(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE thread_id = ? ORDER BY ordinal DESC LIMIT ?`
    ),
    turnsBelowOrdinal: db.prepare(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE thread_id = ? AND ordinal < ?
       ORDER BY ordinal DESC LIMIT ?`
    ),
    // A cursor whose own turn is gone (reverted since the page was served):
    // the first turn at or after its anchor, in content order.
    firstOrdinalFromAnchor: db.prepare(
      `SELECT MIN(ordinal) AS ordinal FROM turns
       WHERE thread_id = ? AND (requested_at > ? OR (requested_at = ? AND turn_id >= ?))`
    ),
    itemPosition: db.prepare(
      "SELECT seq, byte_offset, byte_length FROM items WHERE thread_id = ? AND item_id = ?"
    ),
    itemPositionBySeq: db.prepare(
      "SELECT seq, byte_offset, byte_length FROM items WHERE thread_id = ? AND seq = ? LIMIT 1"
    ),
    hasItemsBefore: db.prepare("SELECT 1 AS hit FROM items WHERE thread_id = ? AND seq < ? LIMIT 1"),
    itemSeqBack: db.prepare(
      "SELECT seq FROM items WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?"
    ),
    oldestItemSeqBefore: db.prepare(
      "SELECT MIN(seq) AS seq FROM items WHERE thread_id = ? AND seq < ?"
    ),
    turnsInSeqRange: db.prepare(
      `SELECT ${TURN_COLUMNS} FROM turns
       WHERE thread_id = ? AND first_seq < ? AND last_seq >= ?
       ORDER BY ordinal`
    ),
    // Containing turns first, the newest start among them; else the nearest
    // turn that started before `seq` (only a revert leaves such a gap).
    turnOfSeq: db.prepare(
      `SELECT ${TURN_COLUMNS} FROM turns
       WHERE thread_id = ? AND first_seq <= ?
       ORDER BY (last_seq >= ?) DESC, first_seq DESC, ordinal DESC
       LIMIT 1`
    ),
    messageFirstLine: db.prepare(
      `SELECT first_seq AS seq, first_byte AS byte_offset, first_length AS byte_length
       FROM message_docs WHERE thread_id = ? AND first_seq = ? LIMIT 1`
    ),
    messageSpan: db.prepare(
      `SELECT message_id, first_seq, first_byte, seq FROM message_docs
       WHERE thread_id = ? AND message_id = ?`
    ),
    messagesSpanning: db.prepare(
      `SELECT message_id, first_seq, first_byte, seq FROM message_docs
       WHERE thread_id = ? AND first_seq < ? AND seq >= ?
       ORDER BY first_seq, message_id`
    ),
    compactedAfter: db.prepare(
      "SELECT 1 AS hit FROM markers WHERE thread_id = ? AND kind = 'compacted' AND seq > ? LIMIT 1"
    ),
    // A prompt is persisted before the provider mints its turn id, so its
    // own `turn_id` is null; the turn that names it as `user_message_id` is
    // the turn a hit on it must reveal.
    searchMessages: db.prepare(
      `SELECT 'message' AS kind, f.thread_id AS thread_id, f.message_id AS id,
              COALESCE(f.turn_id,
                (SELECT p.turn_id FROM turns AS p
                 WHERE p.thread_id = f.thread_id AND p.user_message_id = f.message_id
                 ORDER BY p.ordinal LIMIT 1)) AS turn_id,
              COALESCE(
                (SELECT u.ordinal FROM turns AS u
                 WHERE u.thread_id = f.thread_id AND u.turn_id = f.turn_id),
                (SELECT p.ordinal FROM turns AS p
                 WHERE p.thread_id = f.thread_id AND p.user_message_id = f.message_id
                 ORDER BY p.ordinal LIMIT 1)) AS ordinal,
              f.role AS role, NULL AS activity_kind, f.seq AS seq, f.at AS at,
              snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
              bm25(messages_fts) AS score,
              t.project_path AS project_path, t.title AS title
       FROM messages_fts AS f
       JOIN threads AS t ON t.thread_id = f.thread_id
       WHERE messages_fts MATCH ? AND (? IS NULL OR t.project_path = ?)
       ORDER BY score, f.seq DESC
       LIMIT ?`
    ),
    searchActivities: db.prepare(
      `SELECT 'activity' AS kind, f.thread_id AS thread_id, f.activity_id AS id,
              f.turn_id AS turn_id,
              (SELECT u.ordinal FROM turns AS u
               WHERE u.thread_id = f.thread_id AND u.turn_id = f.turn_id) AS ordinal,
              NULL AS role, f.kind AS activity_kind, f.seq AS seq, f.at AS at,
              snippet(activities_fts, 0, '«', '»', '…', 12) AS snippet,
              bm25(activities_fts) AS score,
              t.project_path AS project_path, t.title AS title
       FROM activities_fts AS f
       JOIN threads AS t ON t.thread_id = f.thread_id
       WHERE activities_fts MATCH ? AND (? IS NULL OR t.project_path = ?)
       ORDER BY score, f.seq DESC
       LIMIT ?`
    )
  };

  function turnById(threadId: string, turnId: string): IndexedTurn | null {
    return toIndexedTurn(sql.turnById.get(threadId, turnId));
  }

  /**
   * The exclusive upper ordinal of the page below `turnId`: its own ordinal
   * while the turn is indexed, else the first turn at or after the content
   * anchor — so a cursor still means "older than this" after a revert or a
   * rebuild, which is why it names content and not a row (T3's rule).
   */
  function upperOrdinal(threadId: string, anchorAt: string, turnId: string): number {
    const own = turnById(threadId, turnId);
    if (own !== null) {
      return own.ordinal;
    }
    const row = asRecord(sql.firstOrdinalFromAnchor.get(threadId, anchorAt, anchorAt, turnId));
    const ordinal = row?.ordinal;
    return typeof ordinal === "number" ? ordinal : Number.MAX_SAFE_INTEGER;
  }

  return {
    itemPosition(threadId, itemId) {
      if (typeof itemId !== "string") {
        return null;
      }
      return toItemPosition(sql.itemPosition.get(threadId, itemId));
    },

    itemPositionBySeq(threadId, seq) {
      if (!isCount(seq)) {
        return null;
      }
      return toItemPosition(sql.itemPositionBySeq.get(threadId, seq));
    },

    hasItemsBefore(threadId, seq) {
      if (typeof seq !== "number" || Number.isNaN(seq)) {
        return false;
      }
      return sql.hasItemsBefore.get(threadId, boundOf(seq)) !== undefined;
    },

    /**
     * The seq of the activity `count` activities back from `beforeSeq`
     * (exclusive), walking down — so a page `[result, beforeSeq)` holds
     * `count` of them. The oldest indexed activity when fewer remain; null
     * when none precedes `beforeSeq`. A `count` below 1 reads as 1.
     */
    activitySeqBefore(threadId, input) {
      if (typeof input.beforeSeq !== "number" || Number.isNaN(input.beforeSeq)) {
        return null;
      }
      const before = boundOf(input.beforeSeq);
      const requested = Math.floor(input.count);
      const count = Number.isFinite(requested) && requested > 1 ? requested : 1;
      const back = asRecord(sql.itemSeqBack.get(threadId, before, count - 1))?.seq;
      if (typeof back === "number") {
        return back;
      }
      const oldest = asRecord(sql.oldestItemSeqBefore.get(threadId, before))?.seq;
      return typeof oldest === "number" ? oldest : null;
    },

    /** Turns whose `[firstSeq, lastSeq]` meets `[fromSeq, toSeq)`, in ordinal order. */
    turnsInSeqRange(threadId, input) {
      const { fromSeq, toSeq } = input;
      if (
        typeof fromSeq !== "number" ||
        typeof toSeq !== "number" ||
        Number.isNaN(fromSeq) ||
        Number.isNaN(toSeq) ||
        toSeq <= fromSeq
      ) {
        return [];
      }
      return sql.turnsInSeqRange
        .all(threadId, boundOf(toSeq), boundOf(fromSeq))
        .map(toIndexedTurn)
        .filter((turn): turn is IndexedTurn => turn !== null);
    },

    /**
     * The turn `seq` belongs to: the one whose range contains it — the newest
     * start among overlapping ones. Ranges tile the log, so only the rows a
     * revert left between its survivors and the next turn are in none; they
     * get the nearest turn that started before them. Null when no turn starts
     * at or before `seq` (rows that precede the first prompt).
     */
    turnOfSeq(threadId, seq) {
      if (typeof seq !== "number" || Number.isNaN(seq)) {
        return null;
      }
      const bound = boundOf(seq);
      return toIndexedTurn(sql.turnOfSeq.get(threadId, bound, bound));
    },

    /**
     * A line a page boundary can sit on: an activity's (latest) line first,
     * else the line that began a message.
     */
    eventPositionBySeq(threadId, seq) {
      if (!isCount(seq)) {
        return null;
      }
      return (
        toItemPosition(sql.itemPositionBySeq.get(threadId, seq)) ??
        toItemPosition(sql.messageFirstLine.get(threadId, seq))
      );
    },

    messageSpan(threadId, messageId) {
      if (typeof messageId !== "string") {
        return null;
      }
      const span = toSpanningMessage(sql.messageSpan.get(threadId, messageId));
      return span === null
        ? null
        : { firstSeq: span.firstSeq, firstByte: span.firstByte, lastSeq: span.lastSeq };
    },

    /**
     * Every message a boundary at `seq` would cut: begun strictly before it,
     * still written at or after it. Oldest first.
     */
    messagesSpanning(threadId, seq) {
      if (typeof seq !== "number" || Number.isNaN(seq)) {
        return [];
      }
      const bound = boundOf(seq);
      return sql.messagesSpanning
        .all(threadId, bound, bound)
        .map(toSpanningMessage)
        .filter((span): span is SpanningMessage => span !== null);
    },

    turnByOrdinal(threadId, ordinal) {
      if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
        return null;
      }
      return toIndexedTurn(sql.turnByOrdinal.get(threadId, ordinal));
    },

    turnById,

    totalTurns(threadId) {
      const total = asRecord(sql.totalTurns.get(threadId))?.total;
      return typeof total === "number" ? total : 0;
    },

    /**
     * Pages walk the ORDINAL order — the log's own order, which is what makes
     * a page's turns one contiguous byte range. The cursor's
     * `(requested_at, turn_id)` locates the boundary; it orders nothing
     * itself, because two turns replayed in the same millisecond, or a clock
     * stepped backwards, would otherwise interleave pages.
     */
    turnsBefore(threadId, input) {
      const limit = Math.floor(input.limit);
      if (!Number.isFinite(limit) || limit < 1) {
        return [];
      }
      const before =
        input.before !== null && input.before.threadId === threadId ? input.before : null;
      let upper: number | null = null;
      if (before !== null) {
        upper = upperOrdinal(threadId, before.beforeAnchorAt, before.beforeTurnId);
      } else if (input.beforeTurn !== undefined && input.beforeTurn !== null) {
        upper = upperOrdinal(threadId, input.beforeTurn.requestedAt, input.beforeTurn.turnId);
      }
      const rows =
        upper === null
          ? sql.newestTurns.all(threadId, limit)
          : sql.turnsBelowOrdinal.all(threadId, upper, limit);
      return rows
        .map(toIndexedTurn)
        .filter((turn): turn is IndexedTurn => turn !== null)
        .reverse();
    },

    /**
     * A rewind to `turn` cuts the conversation just before its opening prompt
     * (`targetTurnCount = ordinal - 1`), so any SETTLED compaction after that
     * prompt lies between the cut and now — the provider no longer holds what
     * it would roll back to, and refuses (§5.5). The window's rule, exactly:
     * "no compacted marker after the message"; an in-flight or failed
     * compaction dropped nothing and withholds nothing.
     */
    rewindable(threadId, turn) {
      return sql.compactedAfter.get(threadId, turn.firstSeq) === undefined;
    },

    search(input) {
      const match = toFtsQuery(typeof input.q === "string" ? input.q : "");
      if (match === null) {
        return [];
      }
      const requested = Math.floor(input.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 1), THREAD_SEARCH_MAX_RESULTS)
        : THREAD_SEARCH_MAX_RESULTS;
      const project =
        typeof input.projectPath === "string" && input.projectPath.length > 0
          ? input.projectPath
          : null;
      const rows = [
        ...sql.searchMessages.all(match, project, project, limit),
        ...sql.searchActivities.all(match, project, project, limit)
      ]
        .map(toScoredHit)
        .filter((hit): hit is ScoredHit => hit !== null);
      // bm25 is "lower is better"; the two tables' scores are close enough to
      // interleave — one ranked list, the best `limit` of both.
      rows.sort((left, right) => left.score - right.score || right.hit.seq - left.hit.seq);
      return rows.slice(0, limit).map((row) => row.hit);
    }
  };
}

// ---------------------------------------------------------------------------
// The query language
// ---------------------------------------------------------------------------

/**
 * `q` as an FTS5 query that can never be a syntax error: clamped to
 * {@link THREAD_SEARCH_MAX_QUERY_CHARS} code points, split on whitespace,
 * every token quoted as a phrase (an inner `"` doubled), joined by spaces —
 * an implicit AND. So `NEAR`, `OR`, `*`, `-` and `:` are matched as text,
 * never parsed. Null when nothing searchable is left.
 */
export function toFtsQuery(q: string): string | null {
  const clamped = Array.from(q).slice(0, THREAD_SEARCH_MAX_QUERY_CHARS).join("");
  const tokens = clamped.split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface ScoredHit {
  score: number;
  hit: ThreadSearchHit;
}

function toScoredHit(value: unknown): ScoredHit | null {
  const row = asRecord(value);
  if (row === null) {
    return null;
  }
  const threadId = row.thread_id;
  const id = row.id;
  const seq = row.seq;
  const score = row.score;
  if (typeof threadId !== "string" || typeof id !== "string" || typeof seq !== "number") {
    return null;
  }
  const kind = row.kind === "activity" ? "activity" : "message";
  const role = row.role;
  return {
    score: typeof score === "number" ? score : 0,
    hit: {
      threadId,
      projectPath: typeof row.project_path === "string" ? row.project_path : "",
      title: typeof row.title === "string" ? row.title : "",
      turnId: typeof row.turn_id === "string" ? row.turn_id : null,
      ordinal: typeof row.ordinal === "number" ? row.ordinal : null,
      kind,
      id,
      role:
        kind === "message" && (role === "user" || role === "assistant" || role === "reasoning")
          ? role
          : null,
      activityKind:
        kind === "activity" && typeof row.activity_kind === "string" ? row.activity_kind : null,
      snippet: typeof row.snippet === "string" ? row.snippet : "",
      at: typeof row.at === "string" ? row.at : "",
      seq
    }
  };
}

function toSpanningMessage(value: unknown): SpanningMessage | null {
  const row = asRecord(value);
  if (row === null) {
    return null;
  }
  const { message_id: messageId, first_seq: firstSeq, first_byte: firstByte, seq: lastSeq } = row;
  if (
    typeof messageId !== "string" ||
    !isCount(firstSeq) ||
    !isCount(firstByte) ||
    !isCount(lastSeq)
  ) {
    return null;
  }
  return { messageId, firstSeq, firstByte, lastSeq };
}

function toItemPosition(value: unknown): IndexedItemPosition | null {
  const row = asRecord(value);
  if (row === null) {
    return null;
  }
  const { seq, byte_offset: byteOffset, byte_length: byteLength } = row;
  if (!isCount(seq) || !isCount(byteOffset) || !isCount(byteLength) || byteLength === 0) {
    return null;
  }
  return { seq, byteOffset, byteLength };
}

/**
 * A seq bound SQLite compares as a number: an infinity (a caller's "no
 * bound") becomes the largest or smallest safe integer rather than NULL.
 */
function boundOf(seq: number): number {
  if (seq === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (seq === Number.NEGATIVE_INFINITY) {
    return Number.MIN_SAFE_INTEGER;
  }
  return seq;
}

function toIndexedTurn(value: unknown): IndexedTurn | null {
  const row = asRecord(value);
  if (row === null) {
    return null;
  }
  const {
    turn_id: turnId,
    ordinal,
    requested_at: requestedAt,
    first_seq: firstSeq,
    last_seq: lastSeq,
    first_byte: firstByte,
    end_byte: endByte
  } = row;
  if (
    typeof turnId !== "string" ||
    typeof requestedAt !== "string" ||
    !isCount(ordinal) ||
    !isCount(firstSeq) ||
    !isCount(lastSeq) ||
    !isCount(firstByte) ||
    !isCount(endByte)
  ) {
    return null;
  }
  return {
    turnId,
    ordinal,
    userMessageId: typeof row.user_message_id === "string" ? row.user_message_id : null,
    requestedAt,
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    firstSeq,
    lastSeq,
    firstByte,
    endByte
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
