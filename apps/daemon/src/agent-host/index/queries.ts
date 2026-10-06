/**
 * Agent host — the thread index's reads: turn lookups, history paging and
 * search (design 2026-09-23 "thread index and lazy boot", §C "History page",
 * "Search"), and the thread's own prompts (the right rail's History).
 *
 * Nothing here trusts a row's shape: the file is a cache another build may
 * have written, so every column is checked before it reaches a caller.
 */

import {
  THREAD_PROMPTS_DEFAULT_LIMIT,
  THREAD_PROMPTS_MAX_LIMIT,
  THREAD_PROMPT_TEXT_MAX_CHARS,
  THREAD_SEARCH_MAX_QUERY_CHARS,
  THREAD_SEARCH_MAX_RESULTS,
  recallablePromptText,
  type HistoryCursor,
  type ThreadPromptEntry,
  type ThreadSearchHit
} from "@orquester/api/agent-chat";

import type {
  IndexedItemPosition,
  IndexedPrompt,
  IndexedPromptsPage,
  IndexedTurn,
  SpanningMessage
} from "./index.ts";
import { MAX_INDEXED_TEXT_CHARS } from "./indexer.ts";
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
  messagesSpanning(threadId: string, seq: number): SpanningMessage[];
  firstBoundaryAfter(threadId: string, seq: number): IndexedItemPosition | null;
  latestRevertSeq(threadId: string): number;
  turnById(threadId: string, turnId: string): IndexedTurn | null;
  turnByPrompt(threadId: string, messageId: string): IndexedTurn | null;
  keepsUserMessage(threadId: string, messageId: string): boolean;
  totalTurns(threadId: string): number;
  turnsBefore(
    threadId: string,
    input: { before: HistoryCursor | null; beforeTurn?: IndexedTurn | null; limit: number }
  ): IndexedTurn[];
  rewindable(threadId: string, turn: IndexedTurn): boolean;
  search(input: { q: string; limit: number; projectPath?: string }): ThreadSearchHit[];
  prompts(threadId: string, input: { before?: string | null; limit: number }): IndexedPromptsPage;
  prompt(threadId: string, messageId: string): IndexedPrompt | null;
}

const TURN_COLUMNS = `turn_id, ordinal, user_message_id, requested_at, started_at, completed_at,
  first_seq, last_seq, first_byte, end_byte`;

export function createThreadIndexQueries(db: SqliteDatabase): ThreadIndexQueries {
  const sql = {
    turnByOrdinal: db.prepare(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE thread_id = ? AND ordinal = ? LIMIT 1`
    ),
    turnById: db.prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE thread_id = ? AND turn_id = ?`),
    turnByPrompt: db.prepare(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE thread_id = ? AND user_message_id = ?
       ORDER BY ordinal LIMIT 1`
    ),
    revertSeq: db.prepare("SELECT revert_seq FROM threads WHERE thread_id = ?"),
    // A user message's row outlives every revert that keeps it, and no other
    // (`dropRevertedUserMessages` in `indexer.ts`).
    keepsUserMessage: db.prepare(
      "SELECT 1 AS hit FROM message_docs WHERE thread_id = ? AND message_id = ? AND role = 'user' LIMIT 1"
    ),
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
    messagesSpanning: db.prepare(
      `SELECT message_id, first_seq, first_byte, seq FROM message_docs
       WHERE thread_id = ? AND first_seq < ? AND seq >= ?
       ORDER BY first_seq, message_id`
    ),
    itemAfter: db.prepare(
      `SELECT seq, byte_offset, byte_length FROM items
       WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT 1`
    ),
    messageAfter: db.prepare(
      `SELECT first_seq AS seq, first_byte AS byte_offset, first_length AS byte_length
       FROM message_docs WHERE thread_id = ? AND first_seq > ? ORDER BY first_seq LIMIT 1`
    ),
    compactedAfter: db.prepare(
      "SELECT 1 AS hit FROM markers WHERE thread_id = ? AND kind = 'compacted' AND seq > ? LIMIT 1"
    ),
    // The thread's own prompts, newest first: its parent `user` rows walked
    // down the partial index `message_docs_prompts` — no other message's row
    // is touched — each joined to its text by rowid. A LEFT join: a message
    // with no FTS row never had any text, and is walked past like any row the
    // recall rule refuses, so a page's read counts every row it scanned.
    promptsBefore: db.prepare(
      `SELECT d.message_id AS message_id, d.first_seq AS first_seq,
              d.turn_id AS turn_id, d.created_at AS created_at, f.text AS text
       FROM message_docs AS d
       LEFT JOIN messages_fts AS f ON f.rowid = d.rowid
       WHERE d.thread_id = ? AND d.role = 'user' AND d.agent_id IS NULL AND d.first_seq < ?
       ORDER BY d.first_seq DESC
       LIMIT ?`
    ),
    prompt: db.prepare(
      `SELECT d.first_seq AS first_seq, d.first_byte AS first_byte,
              d.first_length AS first_length, d.seq AS seq, f.text AS text
       FROM message_docs AS d
       CROSS JOIN messages_fts AS f ON f.rowid = d.rowid
       WHERE d.thread_id = ? AND d.message_id = ? AND d.role = 'user' AND d.agent_id IS NULL`
    ),
    // The started turns naming a prompt as theirs (one, but for a log that
    // says otherwise). No ORDER BY: sorting by ordinal here makes SQLite walk
    // `turns_by_ordinal` over the whole thread instead of `turns_by_prompt`.
    turnsOpenedBy: db.prepare(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE thread_id = ? AND user_message_id = ?`
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
   * A rewind to `turn` cuts the conversation just before its opening prompt
   * (`targetTurnCount = ordinal - 1`), so any SETTLED compaction after that
   * prompt lies between the cut and now — the provider no longer holds what
   * it would roll back to, and refuses (§5.5). The window's rule, exactly:
   * "no compacted marker after the message"; an in-flight or failed
   * compaction dropped nothing and withholds nothing. `markers` holds only
   * the conversation's own markers (`schema.ts` `IndexedMarkerKind`), so a
   * `compacted` row here is what `isSettledConversationCompaction` accepts.
   * The history page's turns and the prompt list's entries both ask here.
   */
  function rewindable(threadId: string, turn: IndexedTurn): boolean {
    return sql.compactedAfter.get(threadId, turn.firstSeq) === undefined;
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

    /**
     * The first line past `seq` a page boundary may sit on — the lowest
     * activity line (an activity's latest) or message first line above it —
     * or null when the index positions none.
     */
    firstBoundaryAfter(threadId, seq) {
      if (typeof seq !== "number" || Number.isNaN(seq)) {
        return null;
      }
      const bound = boundOf(seq);
      const item = toItemPosition(sql.itemAfter.get(threadId, bound));
      const message = toItemPosition(sql.messageAfter.get(threadId, bound));
      if (item === null || message === null) {
        return item ?? message;
      }
      return message.seq < item.seq ? message : item;
    },

    /** The seq of the thread's latest `thread.reverted`; 0 for one never rewound (or not indexed). */
    latestRevertSeq(threadId) {
      const seq = asRecord(sql.revertSeq.get(threadId))?.revert_seq;
      return isCount(seq) ? seq : 0;
    },

    turnByOrdinal(threadId, ordinal) {
      if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
        return null;
      }
      return toIndexedTurn(sql.turnByOrdinal.get(threadId, ordinal));
    },

    turnById,

    /** The turn that names `messageId` as its opening prompt (its `userMessageId`), or null. */
    turnByPrompt(threadId, messageId) {
      if (typeof messageId !== "string" || messageId.length === 0) {
        return null;
      }
      return toIndexedTurn(sql.turnByPrompt.get(threadId, messageId));
    },

    /**
     * Whether the thread still holds `messageId` as a user message: the index
     * wrote its row at its first line, and only a revert that drops it by the
     * fold's own rule deletes it (`dropRevertedUserMessages` in `indexer.ts`).
     */
    keepsUserMessage(threadId, messageId) {
      if (typeof messageId !== "string" || messageId.length === 0) {
        return false;
      }
      return sql.keepsUserMessage.get(threadId, messageId) !== undefined;
    },

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

    rewindable,

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
    },

    prompts(threadId, input) {
      return readPromptsPage(threadId, input, {
        olderThan: (beforeSeq, count) => {
          const rows = sql.promptsBefore.all(threadId, boundOf(beforeSeq), count);
          return {
            candidates: rows
              .map(toPromptCandidate)
              .filter((candidate): candidate is PromptCandidate => candidate !== null),
            scanned: rows.length
          };
        },
        // The first, as search reveals it.
        turnOpenedBy: (messageId) =>
          sql.turnsOpenedBy
            .all(threadId, messageId)
            .map(toIndexedTurn)
            .reduce<IndexedTurn | null>(
              (first, turn) =>
                turn !== null && (first === null || turn.ordinal < first.ordinal) ? turn : first,
              null
            ),
        rewindable: (turn) => rewindable(threadId, turn)
      });
    },

    /**
     * The prompt's text as the index holds it, judged by the list's own rule:
     * only an id `prompts` could have listed answers — never an assistant or
     * a subagent's message, a reverted turn's prompt (its row is gone) or a
     * row the recall rule refuses.
     */
    prompt(threadId, messageId) {
      if (typeof messageId !== "string" || messageId.length === 0) {
        return null;
      }
      const row = asRecord(sql.prompt.get(threadId, messageId));
      if (row === null || typeof row.text !== "string") {
        return null;
      }
      const {
        first_seq: firstSeq,
        first_byte: byteOffset,
        first_length: byteLength,
        seq: lastSeq
      } = row;
      if (!isCount(firstSeq) || !isCount(byteOffset) || !isCount(byteLength) || !isCount(lastSeq)) {
        return null;
      }
      const text = recallablePromptText(row.text);
      if (text === null || byteLength === 0) {
        return null;
      }
      return {
        messageId,
        text,
        // `capText` keeps MAX_INDEXED_TEXT_CHARS units, or one fewer rather
        // than split a surrogate pair: a copy that long may be a head.
        cut: row.text.length >= MAX_INDEXED_TEXT_CHARS - 1,
        line: { seq: firstSeq, byteOffset, byteLength },
        lastSeq
      };
    }
  };
}

// ---------------------------------------------------------------------------
// The thread's prompts
// ---------------------------------------------------------------------------

/** A parent `user` message as the index holds it, before the recall rule judges it. */
interface PromptCandidate {
  messageId: string;
  /** The seq of its first line: where it sits in the conversation. */
  seq: number;
  /** The index's copy of its text. */
  text: string;
  /** The turn the message itself names — a steer's is the turn it steered. */
  turnId: string | null;
  createdAt: string;
}

/**
 * The SQL reads used by {@link readPromptsPage}.
 */
interface PromptSource {
  /**
   * Up to `count` of the thread's parent `user` rows whose `seq` is below
   * `beforeSeq`, newest first: `candidates` are the ones that could be
   * placed, and `scanned` how many rows the read returned, placed or not — a
   * read shorter than `count` is what says the thread has no more.
   */
  olderThan(beforeSeq: number, count: number): { candidates: PromptCandidate[]; scanned: number };
  /** The started turn the message opened (the first, if several name it), or null. */
  turnOpenedBy(messageId: string): IndexedTurn | null;
  /** The history page's rule, for a turn a prompt opened. */
  rewindable(turn: IndexedTurn): boolean;
}

/**
 * Rows one page may walk before it stops and hands back a cursor instead —
 * the bound on a page's synchronous work: a Claude thread resumed from its
 * transcript can hold thousands of `<task-notification>` rows between two
 * prompts, and every row walked is one FTS row read.
 */
const PROMPTS_SCAN_BUDGET = 2_000;

/** Rows one read takes at the least, whatever the page's `limit`. */
const PROMPTS_MIN_BATCH = 256;

/**
 * One page of the thread's own prompts, newest first: `limit` of the
 * candidates `recallablePromptText` accepts, strictly older than the
 * `before` cursor. Rows the rule refuses — a provider-internal row, the
 * verbatim `/compact`, an Implement, an image-only message — never cost the
 * page a slot: the walk goes on down the thread, `max(limit + 1,
 * PROMPTS_MIN_BATCH)` rows a read, until the page is full plus ONE prompt,
 * whose existence is what `before` says — or until the thread is exhausted
 * (`before` null), or until {@link PROMPTS_SCAN_BUDGET} rows have been walked:
 * then the page stops where it is, however few prompts it holds (none,
 * even), with `before` at the last row it walked, and the next page goes on
 * from there. A malformed or foreign cursor reads as none — a first page, as
 * the history cursor does.
 *
 * `turnOrdinal` and `rewindable` belong to the turn a prompt OPENED (the
 * started turn naming it as its prompt — `/revert`'s count, and the history
 * page's rule); a steer, or a prompt no started turn claims yet, has neither.
 * Its `turnId` is then the turn the message itself names: the one a steer
 * steered, null for a prompt still waiting for its turn.
 */
function readPromptsPage(
  threadId: string,
  input: { before?: string | null; limit: number },
  source: PromptSource
): IndexedPromptsPage {
  const limit = clampPromptsLimit(input.limit);
  const cursor =
    typeof input.before === "string" && input.before.length > 0
      ? decodePromptsCursor(input.before, threadId)
      : null;
  let bound = cursor ?? Number.MAX_SAFE_INTEGER;
  const accepted: Array<{ candidate: PromptCandidate; text: string }> = [];
  const batch = Math.max(limit + 1, PROMPTS_MIN_BATCH);
  const budget = Math.max(PROMPTS_SCAN_BUDGET, batch);
  let scanned = 0;
  // Why the walk stopped short of a full page plus one: the thread ran out
  // (nothing older), or the budget did (more may be older).
  let exhausted = false;
  while (accepted.length <= limit) {
    if (scanned >= budget) {
      break;
    }
    const count = Math.min(batch, budget - scanned);
    const read = source.olderThan(bound, count);
    scanned += read.scanned;
    let moved = false;
    for (const row of read.candidates) {
      // Newest first and below the bound, by the source's contract; a row
      // that would not move the bound down could only walk in a circle.
      if (!(row.seq < bound)) {
        continue;
      }
      bound = row.seq;
      moved = true;
      const text = recallablePromptText(row.text);
      if (text === null) {
        continue;
      }
      accepted.push({ candidate: row, text });
      if (accepted.length > limit) {
        break;
      }
    }
    // Counted in rows READ, placed or not: a short read is the end.
    if (read.scanned < count || !moved) {
      exhausted = true;
      break;
    }
  }
  const page = accepted.slice(0, limit);
  const oldest = page[page.length - 1];
  let before: string | null = null;
  if (accepted.length > limit && oldest !== undefined) {
    before = encodePromptsCursor(threadId, oldest.candidate.seq);
  } else if (!exhausted && bound < Number.MAX_SAFE_INTEGER) {
    // Out of budget: the next page starts below the last row walked.
    before = encodePromptsCursor(threadId, bound);
  }
  return {
    prompts: page.map(({ candidate, text }) => promptEntry(candidate, text, source)),
    before
  };
}

function promptEntry(
  candidate: PromptCandidate,
  text: string,
  source: PromptSource
): ThreadPromptEntry {
  const opened = source.turnOpenedBy(candidate.messageId);
  const shown = headOf(text, THREAD_PROMPT_TEXT_MAX_CHARS);
  return {
    messageId: candidate.messageId,
    turnId: opened?.turnId ?? candidate.turnId,
    turnOrdinal: opened?.ordinal ?? null,
    rewindable: opened === null ? null : source.rewindable(opened),
    text: shown,
    truncated: shown.length < text.length,
    createdAt: candidate.createdAt,
    seq: candidate.seq
  };
}

/** `limit` clamped to `[1, THREAD_PROMPTS_MAX_LIMIT]`; anything not a finite number is the default. */
function clampPromptsLimit(limit: number): number {
  const requested = Math.floor(limit);
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), THREAD_PROMPTS_MAX_LIMIT)
    : THREAD_PROMPTS_DEFAULT_LIMIT;
}

/**
 * The first `max` UTF-16 units of `text` — one fewer when the cut would
 * leave the high half of a surrogate pair as the last unit (`capText`'s
 * rule).
 */
function headOf(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The prompt list's cursor, opaque on the wire: `base64url(JSON {t, s})`,
 * unpadded — the thread, and the seq of the oldest prompt the previous page
 * held; the next page is what lies strictly below it. A log seq never moves
 * (the log is append-only; a rebuilt index derives the same seq from it), so
 * the cursor survives an index rebuild and a revert, as the history cursor
 * does.
 */
function encodePromptsCursor(threadId: string, beforeSeq: number): string {
  return Buffer.from(JSON.stringify({ t: threadId, s: beforeSeq }), "utf8").toString("base64url");
}

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

/**
 * The seq a cursor pages below, or null when it is not one of ours for
 * `threadId` — the caller then serves a first page. Never throws: the input
 * is a query parameter. Fields beyond `{t, s}` are ignored, so a later build
 * can add one.
 */
function decodePromptsCursor(encoded: string, threadId: string): number | null {
  // `Buffer` skips characters outside the alphabet rather than refusing them,
  // and a length of `4n + 1` is never a whole byte count.
  if (typeof encoded !== "string" || !BASE64URL_ALPHABET.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url"))
    );
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (record === null || record.t !== threadId) {
    return null;
  }
  const seq = record.s;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function toPromptCandidate(value: unknown): PromptCandidate | null {
  const row = asRecord(value);
  if (row === null || !isCount(row.first_seq)) {
    return null;
  }
  return {
    messageId: typeof row.message_id === "string" ? row.message_id : "",
    seq: row.first_seq,
    // A row whose text or id does not read back — a message that never had
    // text has no FTS row at all — is still walked past, its seq moving the
    // page on, but the recall rule refuses the empty text.
    text: typeof row.text === "string" && typeof row.message_id === "string" ? row.text : "",
    turnId: typeof row.turn_id === "string" ? row.turn_id : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : ""
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
function toFtsQuery(q: string): string | null {
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
