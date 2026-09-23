/**
 * Agent host — the thread index's writer: domain events → rows (design
 * 2026-09-23 "thread index and lazy boot", §C "Maintenance").
 *
 * Per thread it keeps a tiny TURN fold (`applyTurnEvent`, the turn half of
 * the shared fold — so turn rows and their ordinals can never disagree with
 * what the host's own fold and `/revert` count) plus the byte range each
 * started turn owns in `events.ndjson`. Everything a batch changes is written
 * in ONE transaction together with the thread's cursor, so the rows are
 * always exactly "the log up to `threads.last_seq`" (invariant 4).
 *
 * **Byte ranges tile the log.** A started turn owns everything from its
 * opening prompt up to the first event of the next started turn; the latest
 * one grows with every event. Two rules make that true on real logs:
 * - a turn STARTS at the user message that opened it (`Turn.userMessageId`),
 *   which the orchestrator appends just BEFORE `thread.turn-start-requested`
 *   — and which a replayed history turn emits long before its row, since that
 *   row is only minted at the turn's end. Anchoring at the creating event
 *   instead cut every page's first prompt, and all of a replayed turn;
 * - a turn does NOT stop at its settling `thread.session-set`: the turn-end
 *   checkpoint, its capture outcome and the post-turn context reading are
 *   appended after it, and belong to it. A turn that never started (a send
 *   the provider refused) leaves its rows with the turn before it.
 * So a page of consecutive turns is one contiguous read, and consecutive
 * pages meet. One exception makes neighbours OVERLAP: an event that names an
 * earlier turn after the next one began — a slow turn-end capture, say —
 * still extends that turn's range, so its page holds its own diff card (the
 * reader dedupes by item id). A `thread.reverted` closes every range: the
 * surviving turns keep the bytes they had and are sealed — nothing, not even
 * a late event naming them, extends a range across a revert, because folding
 * a slice that holds the revert re-applies it against the slice's own,
 * shorter turn list. The reverted turns' bytes and the revert itself belong
 * to nobody, and nothing grows until the next turn starts.
 *
 * Messages are indexed when they finish (`streaming: false`), with the fold's
 * own text rule; activities on every write (last write wins, like
 * `readItem`), and a `context-compaction` activity also leaves a marker.
 *
 * **What survives losing the memory.** A thread's memory is dropped by a host
 * restart, by a driver error (the batch rolled back; the thread reloads from
 * its rows and a catch-up re-feeds the rest from the cursor) and by the LRU
 * ({@link MAX_RESIDENT_THREADS}; quiet threads only, `isQuiescent`). So
 * everything a LATER event can still need is persisted with the cursor, in
 * the same transaction — the reload then continues exactly where the rows
 * say the log was:
 * - started turns are their `turns` rows; the open turn and the revert seal
 *   are `threads.open_turn_id` and `threads.revert_seq`;
 * - a turn requested but not started yet has no provider id, so no `turns`
 *   row can hold it (`turn_id` is NOT NULL): it rides `threads.inflight` with
 *   its position among the started turns and the range anchored at its
 *   prompt, together with every prompt no turn has claimed yet. Without them
 *   the `thread.session-set {running}` that adopts it after a loss found no
 *   pending row, the fold minted a new turn AT the adoption — no prompt, its
 *   range opening at the session-set line — and the previous turn's range
 *   swallowed the prompt. A turn that settled without ever starting is not
 *   kept: the fold never adopts it, and ordinals and ranges count started
 *   turns only, so dropping it moves neither.
 *
 * Not persisted: a message's streamed text (`streams`). Its `message_docs`
 * row — its span — is written at its first chunk, so a message streaming
 * across a loss keeps its span; but the text accumulated before the loss is
 * missing from its search row — a known gap of a disposable cache, which a
 * rebuild from the log repairs. The LRU never drops a thread mid-stream; only
 * a restart or a failed write does. Nor a row's `lastReference` (see there).
 */

import type { DomainEvent, Turn } from "@orquester/api/agent-chat";
import { applyTurnEvent, startedTurns } from "@orquester/api/agent-chat";

import type { AdapterLogger, Clock } from "../adapter.ts";
import type { EventPosition } from "../services.ts";
import type { IndexedThreadMeta } from "./index.ts";
import type { IndexedMarkerKind } from "./schema.ts";
import { describeError, type SqliteDatabase } from "./sqlite.ts";

/** The longest text one FTS row indexes; a longer body is indexed by its head. */
export const MAX_INDEXED_TEXT_CHARS = 131_072;
/** Prompts remembered per thread until a turn claims them (a steer never is). */
const MAX_UNCLAIMED_PROMPTS = 64;
/** Messages streaming at once per thread; the oldest accumulation is dropped past it. */
const MAX_OPEN_STREAMS = 256;
/**
 * How far past the NEXT turn's first byte a late event naming an earlier turn
 * may still extend it. A turn-end capture lands within moments; a background
 * task naming its launching turn for an hour must not turn that turn's page
 * into a read of everything since.
 */
export const MAX_LATE_REFERENCE_BYTES = 2 * 1024 * 1024;
/**
 * Threads whose turn fold stays in memory. The index grows with the log ON
 * DISK (invariant 3): a quiet thread beyond this is dropped, least recently
 * used first, and reloaded from its rows on its next batch. A thread with
 * something in flight that exists nowhere else — a message mid-stream, a
 * turn not started yet — is never dropped by count (`isQuiescent`).
 */
export const MAX_RESIDENT_THREADS = 16;

interface Position {
  seq: number;
  byteOffset: number;
}

/** `[firstByte, endByte)` of `events.ndjson`, and the seqs of its first and last line. */
interface Span {
  firstSeq: number;
  firstByte: number;
  lastSeq: number;
  endByte: number;
}

/** Aligned by index with `ThreadMemory.turns`. */
interface RowState {
  span: Span;
  /** The ordinal the stored row carries; null while it was never written. */
  storedOrdinal: number | null;
  /** Something the stored row holds has moved. */
  dirty: boolean;
  /**
   * The latest event that NAMED this turn (`referencedTurnId`). When the next
   * turn starts, the range is cut back to that turn's prompt — but never
   * below this: a capture that landed between the next prompt and the next
   * turn's start is still this turn's. In memory only; a restart in that
   * window of seconds merely loses the overlap.
   */
  lastReference: { seq: number; end: number } | null;
}

interface StreamState {
  /** The message's `message_docs` rowid — its FTS row's rowid too. */
  doc: number;
  text: string;
  role: string;
  at: string;
}

interface ThreadMemory {
  threadId: string;
  turns: Turn[];
  rows: RowState[];
  /** The started turn whose range grows with every event; null after a revert. */
  openTurnId: string | null;
  /** Seq of the latest `thread.reverted`; a range that began before it is sealed. */
  revertSeq: number;
  lastSeq: number;
  lastByte: number;
  /** User messages not yet claimed by a turn, by message id. */
  prompts: Map<string, Position>;
  /** Streamed text per message id, until its `streaming: false`. */
  streams: Map<string, StreamState>;
  gapLogged: boolean;
  /** `threads.inflight` for the pending turns and prompts above (`serializeInflight`). */
  inflight: string;
  /** A pending turn or a prompt moved since `inflight` was serialized. */
  inflightStale: boolean;
}

/**
 * A turn requested but not started — `turnId: null`, state `pending` — as
 * `threads.inflight` keeps it (see the module header).
 */
interface InflightTurn {
  /**
   * How many started turns precede it in the turn fold, i.e. where it goes
   * back. Usually all of them — but a resumed thread's first prompt can be
   * requested BEFORE the provider's history is replayed, so its row precedes
   * every replayed turn, and after the adoption the fold numbers it FIRST.
   * Appending it after them instead would renumber every turn of the thread.
   */
  startedBefore: number;
  requestedAt: string;
  userMessageId?: string;
  /** Its row's range: from its prompt (or its own line) to its own line. */
  span: Span;
}

/** A prompt no turn has claimed yet, as `threads.inflight` keeps it. */
interface InflightPrompt {
  messageId: string;
  seq: number;
  byteOffset: number;
}

interface InflightState {
  pending: InflightTurn[];
  prompts: InflightPrompt[];
}

interface BatchState {
  /** The turn list changed shape or content: every started row is re-checked. */
  structural: boolean;
}

/**
 * - `applied` — at least one event was applied;
 * - `noop` — every event was already indexed;
 * - `gap` — the batch does not continue the cursor (the index is behind the
 *   log): nothing was applied, and only a catch-up from the log can fix it;
 * - `deleted` — a `thread.deleted` removed the thread's rows.
 */
export type ApplyOutcome = "applied" | "noop" | "gap" | "deleted";

export interface ThreadIndexer {
  /**
   * Apply one batch in one transaction. Throws on a driver error, after which
   * nothing of the batch is stored and the thread is reloaded from its rows.
   */
  applyBatch(
    meta: IndexedThreadMeta,
    events: readonly DomainEvent[],
    positions: readonly EventPosition[]
  ): ApplyOutcome;
  cursor(threadId: string): { lastSeq: number; lastByte: number } | null;
  /** Delete every row of the thread and forget its memory. */
  resetThread(threadId: string): void;
  /**
   * Test seam: the threads whose memory is resident, least recently used
   * first — the order {@link MAX_RESIDENT_THREADS} evicts in.
   */
  residentThreadIds(): readonly string[];
}

export function createThreadIndexer(input: {
  db: SqliteDatabase;
  logger: AdapterLogger;
  clock: Clock;
}): ThreadIndexer {
  const { db, logger, clock } = input;

  const sql = {
    selectThread: db.prepare(
      `SELECT last_seq, last_byte, open_turn_id, revert_seq, inflight
       FROM threads WHERE thread_id = ?`
    ),
    upsertThread: db.prepare(
      `INSERT INTO threads (thread_id, project_path, title, last_seq, last_byte, updated_at,
                            open_turn_id, revert_seq, inflight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET
         project_path = excluded.project_path,
         title = excluded.title,
         last_seq = excluded.last_seq,
         last_byte = excluded.last_byte,
         updated_at = excluded.updated_at,
         open_turn_id = excluded.open_turn_id,
         revert_seq = excluded.revert_seq,
         inflight = excluded.inflight`
    ),
    selectTurns: db.prepare(
      `SELECT turn_id, ordinal, user_message_id, requested_at, started_at, completed_at,
              first_seq, last_seq, first_byte, end_byte
       FROM turns WHERE thread_id = ? ORDER BY ordinal`
    ),
    upsertTurn: db.prepare(
      `INSERT INTO turns (thread_id, turn_id, ordinal, user_message_id, requested_at, started_at,
                          completed_at, first_seq, last_seq, first_byte, end_byte)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, turn_id) DO UPDATE SET
         ordinal = excluded.ordinal,
         user_message_id = excluded.user_message_id,
         requested_at = excluded.requested_at,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         first_seq = excluded.first_seq,
         last_seq = excluded.last_seq,
         first_byte = excluded.first_byte,
         end_byte = excluded.end_byte`
    ),
    deleteTurn: db.prepare("DELETE FROM turns WHERE thread_id = ? AND turn_id = ?"),

    selectMessageDoc: db.prepare(
      "SELECT rowid AS doc FROM message_docs WHERE thread_id = ? AND message_id = ?"
    ),
    selectMessageText: db.prepare("SELECT text, role, at FROM messages_fts WHERE rowid = ?"),
    insertMessageDoc: db.prepare(
      `INSERT INTO message_docs (thread_id, message_id, seq, first_seq, first_byte, first_length)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    updateMessageDoc: db.prepare("UPDATE message_docs SET seq = ? WHERE rowid = ?"),
    deleteMessageFts: db.prepare("DELETE FROM messages_fts WHERE rowid = ?"),
    insertMessageFts: db.prepare(
      `INSERT INTO messages_fts (rowid, text, thread_id, message_id, turn_id, role, seq, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),

    selectItem: db.prepare(
      "SELECT rowid AS doc, seq FROM items WHERE thread_id = ? AND item_id = ?"
    ),
    insertItem: db.prepare(
      "INSERT INTO items (thread_id, item_id, seq, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?)"
    ),
    updateItem: db.prepare(
      "UPDATE items SET seq = ?, byte_offset = ?, byte_length = ? WHERE rowid = ?"
    ),
    deleteActivityFts: db.prepare("DELETE FROM activities_fts WHERE rowid = ?"),
    insertActivityFts: db.prepare(
      `INSERT INTO activities_fts (rowid, text, thread_id, activity_id, turn_id, kind, seq, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insertMarker: db.prepare(
      "INSERT OR REPLACE INTO markers (thread_id, seq, kind) VALUES (?, ?, ?)"
    ),
    deleteMarkerAt: db.prepare("DELETE FROM markers WHERE thread_id = ? AND seq = ?"),

    // A revert: everything at or after the first removed turn's first line.
    truncateMessageFts: db.prepare(
      `DELETE FROM messages_fts WHERE rowid IN
         (SELECT rowid FROM message_docs WHERE thread_id = ? AND seq >= ?)`
    ),
    truncateMessageDocs: db.prepare("DELETE FROM message_docs WHERE thread_id = ? AND seq >= ?"),
    truncateActivityFts: db.prepare(
      `DELETE FROM activities_fts WHERE rowid IN
         (SELECT rowid FROM items WHERE thread_id = ? AND seq >= ?)`
    ),
    truncateItems: db.prepare("DELETE FROM items WHERE thread_id = ? AND seq >= ?"),
    truncateMarkers: db.prepare("DELETE FROM markers WHERE thread_id = ? AND seq >= ?"),

    // The whole thread.
    dropMessageFts: db.prepare(
      "DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM message_docs WHERE thread_id = ?)"
    ),
    dropMessageDocs: db.prepare("DELETE FROM message_docs WHERE thread_id = ?"),
    dropActivityFts: db.prepare(
      "DELETE FROM activities_fts WHERE rowid IN (SELECT rowid FROM items WHERE thread_id = ?)"
    ),
    dropItems: db.prepare("DELETE FROM items WHERE thread_id = ?"),
    dropMarkers: db.prepare("DELETE FROM markers WHERE thread_id = ?"),
    dropTurns: db.prepare("DELETE FROM turns WHERE thread_id = ?"),
    dropThread: db.prepare("DELETE FROM threads WHERE thread_id = ?")
  };

  /** Most recently used last (Map insertion order). */
  const resident = new Map<string, ThreadMemory>();

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  function load(threadId: string): ThreadMemory {
    const existing = resident.get(threadId);
    if (existing !== undefined) {
      resident.delete(threadId);
      resident.set(threadId, existing);
      return existing;
    }
    const memory: ThreadMemory = {
      threadId,
      turns: [],
      rows: [],
      openTurnId: null,
      revertSeq: 0,
      lastSeq: 0,
      lastByte: 0,
      prompts: new Map(),
      streams: new Map(),
      gapLogged: false,
      inflight: "",
      inflightStale: false
    };
    const thread = asRecord(sql.selectThread.get(threadId));
    if (thread !== null) {
      memory.lastSeq = toCount(thread.last_seq);
      memory.lastByte = toCount(thread.last_byte);
      memory.openTurnId = toStringOrNull(thread.open_turn_id);
      memory.revertSeq = toCount(thread.revert_seq);
      // Rebuilt in `Turn` shape for the turn fold. What the rows cannot carry
      // (the exact settled state, the assistant anchor, the checkpoint count)
      // does not change any turn id, ordinal or range the fold derives.
      for (const raw of sql.selectTurns.all(threadId)) {
        const row = asRecord(raw);
        const turnId = toStringOrNull(row?.turn_id);
        if (row === null || turnId === null) {
          continue;
        }
        const startedAt = toStringOrNull(row.started_at);
        const completedAt = toStringOrNull(row.completed_at);
        const userMessageId = toStringOrNull(row.user_message_id);
        memory.turns.push({
          turnId,
          state: completedAt !== null ? "completed" : startedAt !== null ? "running" : "pending",
          turnCount: null,
          requestedAt: toStringOrNull(row.requested_at) ?? "",
          startedAt,
          completedAt,
          assistantMessageId: null,
          ...(userMessageId !== null ? { userMessageId } : {})
        });
        memory.rows.push({
          span: {
            firstSeq: toCount(row.first_seq),
            firstByte: toCount(row.first_byte),
            lastSeq: toCount(row.last_seq),
            endByte: toCount(row.end_byte)
          },
          storedOrdinal: toCount(row.ordinal),
          dirty: false,
          lastReference: null
        });
      }
      if (
        memory.openTurnId !== null &&
        !memory.turns.some((turn) => turn.turnId === memory.openTurnId)
      ) {
        memory.openTurnId = null;
      }
      restoreInflight(memory, thread.inflight);
    }
    resident.set(threadId, memory);
    return memory;
  }

  /**
   * Put back what `threads.inflight` kept: each pending turn at its place
   * among the started turns just rebuilt, with its row as it was, and the
   * unclaimed prompts in the order they arrived. A blob that does not read
   * back whole is dropped whole — an empty in-flight state, which is what
   * this index had before the column existed — rather than half-restored:
   * one lost pending turn out of two would let the adoption take the other.
   */
  function restoreInflight(memory: ThreadMemory, raw: unknown): void {
    const parsed = parseInflight(raw, { lastSeq: memory.lastSeq, lastByte: memory.lastByte });
    if ("error" in parsed) {
      logger.debug("agent-host: thread index ignored an unreadable in-flight state", {
        threadId: memory.threadId,
        reason: parsed.error
      });
      return;
    }
    const { pending, prompts } = parsed.state;
    if (pending.length > 0) {
      const started = memory.turns;
      const startedRows = memory.rows;
      const turns: Turn[] = [];
      const rows: RowState[] = [];
      let next = 0;
      for (let index = 0; index <= started.length; index += 1) {
        // `startedBefore` never decreases (`parseInflight`), and one past the
        // rebuilt list means "after all of them".
        while (
          next < pending.length &&
          Math.min(pending[next]!.startedBefore, started.length) === index
        ) {
          const entry = pending[next]!;
          turns.push({
            turnId: null,
            state: "pending",
            turnCount: null,
            requestedAt: entry.requestedAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
            ...(entry.userMessageId !== undefined ? { userMessageId: entry.userMessageId } : {})
          });
          rows.push({
            span: { ...entry.span },
            storedOrdinal: null,
            dirty: false,
            lastReference: null
          });
          next += 1;
        }
        if (index < started.length) {
          turns.push(started[index]!);
          rows.push(startedRows[index]!);
        }
      }
      memory.turns = turns;
      memory.rows = rows;
    }
    for (const prompt of prompts) {
      if (!memory.prompts.has(prompt.messageId)) {
        memory.prompts.set(prompt.messageId, { seq: prompt.seq, byteOffset: prompt.byteOffset });
      }
    }
    trimPrompts(memory);
    // Re-serialized by the next batch, so a blob this build would not have
    // written is replaced by one it would.
    memory.inflightStale = true;
  }

  /** The in-flight state `restoreInflight` reads back, as of this batch. */
  function serializeInflight(memory: ThreadMemory): string {
    const pending: InflightTurn[] = [];
    const started = new Set<string>();
    memory.turns.forEach((turn, index) => {
      if (turn.turnId !== null) {
        started.add(turn.turnId);
        return;
      }
      // A row that settled without ever starting is never adopted — the fold
      // adopts only a `pending` one — and holds no ordinal and no range any
      // other row reads, so it is not kept.
      const row = memory.rows[index];
      if (turn.state !== "pending" || row === undefined) {
        return;
      }
      pending.push({
        startedBefore: started.size,
        requestedAt: typeof turn.requestedAt === "string" ? turn.requestedAt : "",
        ...(typeof turn.userMessageId === "string" && turn.userMessageId.length > 0
          ? { userMessageId: turn.userMessageId }
          : {}),
        span: { ...row.span }
      });
    });
    const prompts: InflightPrompt[] = [];
    for (const [messageId, position] of memory.prompts) {
      prompts.push({ messageId, seq: position.seq, byteOffset: position.byteOffset });
    }
    if (pending.length === 0 && prompts.length === 0) {
      return "";
    }
    const state: InflightState = { pending, prompts };
    return JSON.stringify(state);
  }

  /** In-flight state that exists nowhere but here: dropping it would lose it. */
  function isQuiescent(memory: ThreadMemory): boolean {
    return (
      memory.streams.size === 0 &&
      !memory.turns.some((turn) => turn.turnId === null && turn.state === "pending")
    );
  }

  function evictIdle(keep: string): void {
    if (resident.size <= MAX_RESIDENT_THREADS) {
      return;
    }
    for (const [threadId, memory] of resident) {
      if (resident.size <= MAX_RESIDENT_THREADS) {
        break;
      }
      if (threadId !== keep && isQuiescent(memory)) {
        resident.delete(threadId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Turns and their ranges
  // -------------------------------------------------------------------------

  /** Index of the open turn's (first) row, or -1. */
  function openIndex(memory: ThreadMemory): number {
    if (memory.openTurnId === null) {
      return -1;
    }
    return memory.turns.findIndex((turn) => turn.turnId === memory.openTurnId);
  }

  function extendOpen(memory: ThreadMemory, seq: number, end: number): void {
    const index = openIndex(memory);
    if (index === -1) {
      memory.openTurnId = null;
      return;
    }
    const row = memory.rows[index]!;
    if (row.span.lastSeq < seq) {
      row.span.lastSeq = seq;
      row.span.endByte = end;
      row.dirty = true;
    }
  }

  /**
   * An event naming a turn belongs to that turn. For the open turn that only
   * needs remembering (see `RowState.lastReference`); a turn that is no
   * longer open — the turn-end capture of turn N landing after turn N+1
   * began — has its range grown over the event, overlapping the next turn's.
   * Never for a turn sealed by a revert, and never further than
   * {@link MAX_LATE_REFERENCE_BYTES} past the next turn's start. Returns
   * whether a closed row moved.
   */
  function extendReferenced(
    memory: ThreadMemory,
    event: DomainEvent,
    end: number
  ): boolean {
    const turnId = referencedTurnId(event);
    if (turnId === null) {
      return false;
    }
    if (turnId === memory.openTurnId) {
      const open = memory.rows[openIndex(memory)];
      if (open !== undefined) {
        open.lastReference = { seq: event.seq, end };
      }
      return false;
    }
    const index = memory.turns.findIndex((turn) => turn.turnId === turnId);
    const row = index === -1 ? undefined : memory.rows[index];
    if (row === undefined || row.span.firstSeq < memory.revertSeq || row.span.lastSeq >= event.seq) {
      return false;
    }
    const nextIndex = memory.turns.findIndex(
      (turn, position) => position > index && turn.turnId !== null
    );
    const next = nextIndex === -1 ? undefined : memory.rows[nextIndex];
    if (next !== undefined && end - next.span.firstByte > MAX_LATE_REFERENCE_BYTES) {
      return false;
    }
    row.span.lastSeq = event.seq;
    row.span.endByte = end;
    row.dirty = true;
    row.lastReference = { seq: event.seq, end };
    return true;
  }

  /** A user message remembered for the turn that will name it as its prompt. */
  function claimPrompt(memory: ThreadMemory, messageId: string | undefined): Position | null {
    if (messageId === undefined) {
      return null;
    }
    const prompt = memory.prompts.get(messageId);
    if (prompt === undefined) {
      return null;
    }
    memory.prompts.delete(messageId);
    memory.inflightStale = true;
    return prompt;
  }

  function freshRow(anchor: Position, here: Position, end: number): RowState {
    return {
      span: {
        firstSeq: anchor.seq,
        firstByte: anchor.byteOffset,
        lastSeq: here.seq,
        endByte: end
      },
      storedOrdinal: null,
      dirty: true,
      lastReference: null
    };
  }

  /**
   * Row states for `next`, carried from `prev`. Every turn reducer but the
   * revert appends or replaces in place, so rows keep their index; anything
   * else (a revert, or a list that no longer lines up) is matched by identity,
   * then by turn id. A row with no predecessor is new: it starts at its
   * prompt when one is remembered, at this event otherwise.
   */
  function carryRows(
    memory: ThreadMemory,
    prev: readonly Turn[],
    next: readonly Turn[],
    here: Position,
    end: number
  ): RowState[] {
    const aligned =
      next.length >= prev.length &&
      prev.every((turn, index) => {
        const successor = next[index]!;
        return (
          successor === turn ||
          turn.turnId === null ||
          successor.turnId === turn.turnId
        );
      });
    if (aligned) {
      const rows = memory.rows.slice(0, prev.length);
      for (let index = 0; index < prev.length; index += 1) {
        if (next[index] !== prev[index]) {
          rows[index]!.dirty = true;
        }
      }
      for (let index = prev.length; index < next.length; index += 1) {
        const anchor = claimPrompt(memory, next[index]!.userMessageId) ?? here;
        rows.push(freshRow(anchor, here, end));
      }
      return rows;
    }

    const byTurn = new Map<Turn, RowState>();
    const byId = new Map<string, RowState>();
    prev.forEach((turn, index) => {
      const row = memory.rows[index]!;
      byTurn.set(turn, row);
      if (turn.turnId !== null && !byId.has(turn.turnId)) {
        byId.set(turn.turnId, row);
      }
    });
    const used = new Set<RowState>();
    return next.map((turn) => {
      const same = byTurn.get(turn);
      const found = same ?? (turn.turnId !== null ? byId.get(turn.turnId) : undefined);
      if (found !== undefined && !used.has(found)) {
        used.add(found);
        if (same === undefined) {
          found.dirty = true;
        }
        return found;
      }
      const anchor = claimPrompt(memory, turn.userMessageId) ?? here;
      return freshRow(anchor, here, end);
    });
  }

  /**
   * `row` just got its provider turn id: it becomes the open turn. The turn
   * that was open ends where this one begins — or at the last event that
   * named it, if that came later (the two ranges then overlap). A start that
   * would precede the open turn's own (it cannot, on a log this host wrote)
   * begins at this event instead.
   */
  function openTurn(
    memory: ThreadMemory,
    index: number,
    here: Position,
    end: number
  ): void {
    const row = memory.rows[index]!;
    const openAt = openIndex(memory);
    if (openAt !== -1 && openAt !== index) {
      const open = memory.rows[openAt]!;
      if (row.span.firstByte <= open.span.firstByte) {
        row.span.firstSeq = here.seq;
        row.span.firstByte = here.byteOffset;
      }
      if (open.span.endByte > row.span.firstByte) {
        const reference = open.lastReference;
        if (
          reference !== null &&
          reference.end > row.span.firstByte &&
          reference.end - row.span.firstByte <= MAX_LATE_REFERENCE_BYTES
        ) {
          open.span.endByte = reference.end;
          open.span.lastSeq = reference.seq;
        } else {
          open.span.endByte = row.span.firstByte;
          open.span.lastSeq = Math.max(open.span.firstSeq, row.span.firstSeq - 1);
        }
        open.dirty = true;
      }
    }
    row.span.lastSeq = here.seq;
    row.span.endByte = end;
    row.dirty = true;
    memory.openTurnId = memory.turns[index]!.turnId;
  }

  function foldTurns(memory: ThreadMemory, event: DomainEvent): Turn[] {
    try {
      return applyTurnEvent(memory.turns, event);
    } catch (error) {
      // The shared reducer and this build disagree about the event's shape;
      // the host's own fold has the same problem, so the row simply stays.
      logger.debug("agent-host: thread index could not fold a turn event", {
        threadId: memory.threadId,
        seq: event.seq,
        error: describeError(error)
      });
      return memory.turns;
    }
  }

  function advanceTurns(
    memory: ThreadMemory,
    event: DomainEvent,
    here: Position,
    end: number,
    batch: BatchState
  ): void {
    const prev = memory.turns;
    const next = foldTurns(memory, event);

    if (event.type === "thread.reverted") {
      applyRevert(memory, prev, next, here, end);
      batch.structural = true;
      return;
    }

    if (next === prev || sameTurns(prev, next)) {
      extendOpen(memory, event.seq, end);
      return;
    }

    batch.structural = true;
    const before = new Set(startedTurns(prev).map((turn) => turn.turnId));
    memory.rows = carryRows(memory, prev, next, here, end);
    memory.turns = next;
    memory.inflightStale = true;
    for (const turn of startedTurns(next)) {
      if (!before.has(turn.turnId)) {
        openTurn(memory, next.indexOf(turn), here, end);
      }
    }
    extendOpen(memory, event.seq, end);
  }

  /**
   * §5.5 by turn ORDER: the turn fold keeps the first `turnCount` started
   * turns, and every row from the first removed turn's first line on goes —
   * its turn rows, its text, its item positions, its markers.
   */
  function applyRevert(
    memory: ThreadMemory,
    prev: Turn[],
    next: Turn[],
    here: Position,
    end: number
  ): void {
    const kept = new Set(startedTurns(next).map((turn) => turn.turnId));
    const seen = new Set<string>();
    const removed: string[] = [];
    let cut: number | null = null;
    prev.forEach((turn, index) => {
      if (turn.turnId === null || seen.has(turn.turnId)) {
        return;
      }
      seen.add(turn.turnId);
      if (kept.has(turn.turnId)) {
        return;
      }
      removed.push(turn.turnId);
      const firstSeq = memory.rows[index]!.span.firstSeq;
      cut = cut === null ? firstSeq : Math.min(cut, firstSeq);
    });

    memory.rows = carryRows(memory, prev, next, here, end);
    memory.turns = next;
    memory.inflightStale = true;
    // Nothing grows past a revert: the surviving turns keep the bytes they
    // had, and folding a range that holds this event would re-apply the
    // revert against a slice's own, shorter turn list.
    memory.openTurnId = null;
    memory.revertSeq = here.seq;

    const threadId = memory.threadId;
    for (const turnId of removed) {
      sql.deleteTurn.run(threadId, turnId);
    }
    if (cut !== null) {
      // A stream's doc row may be among the deleted; none runs across an
      // idle-only revert anyway.
      memory.streams.clear();
      sql.truncateMessageFts.run(threadId, cut);
      sql.truncateMessageDocs.run(threadId, cut);
      sql.truncateActivityFts.run(threadId, cut);
      sql.truncateItems.run(threadId, cut);
      sql.truncateMarkers.run(threadId, cut);
    }
  }

  /** Write every started turn whose stored row is stale. */
  function flushTurnRows(memory: ThreadMemory, batch: BatchState): void {
    const threadId = memory.threadId;
    const write = (turn: Turn, row: RowState, ordinal: number): void => {
      sql.upsertTurn.run(
        threadId,
        turn.turnId,
        ordinal,
        turn.userMessageId ?? null,
        typeof turn.requestedAt === "string" ? turn.requestedAt : "",
        toStringOrNull(turn.startedAt),
        toStringOrNull(turn.completedAt),
        row.span.firstSeq,
        row.span.lastSeq,
        row.span.firstByte,
        row.span.endByte
      );
      row.dirty = false;
      row.storedOrdinal = ordinal;
    };

    if (!batch.structural) {
      // Only the open turn's range can have moved.
      const index = openIndex(memory);
      const row = index === -1 ? undefined : memory.rows[index];
      if (row === undefined || !row.dirty) {
        return;
      }
      if (row.storedOrdinal !== null) {
        write(memory.turns[index]!, row, row.storedOrdinal);
        return;
      }
    }

    const firstIndex = new Map<string, number>();
    memory.turns.forEach((turn, index) => {
      if (turn.turnId !== null && !firstIndex.has(turn.turnId)) {
        firstIndex.set(turn.turnId, index);
      }
    });
    startedTurns(memory.turns).forEach((turn, position) => {
      const index = firstIndex.get(turn.turnId)!;
      const row = memory.rows[index]!;
      const ordinal = position + 1;
      if (row.dirty || row.storedOrdinal !== ordinal) {
        write(turn, row, ordinal);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  function rememberPrompt(
    memory: ThreadMemory,
    event: Extract<DomainEvent, { type: "thread.message-sent" }>,
    here: Position
  ): void {
    const { role, messageId } = event.payload;
    if (role !== "user" || typeof messageId !== "string" || messageId.length === 0) {
      return;
    }
    if (memory.prompts.has(messageId)) {
      return;
    }
    memory.prompts.set(messageId, here);
    trimPrompts(memory);
    memory.inflightStale = true;
  }

  /** Oldest first: a steer is never claimed, so the map would only grow. */
  function trimPrompts(memory: ThreadMemory): void {
    for (const oldest of memory.prompts.keys()) {
      if (memory.prompts.size <= MAX_UNCLAIMED_PROMPTS) {
        break;
      }
      memory.prompts.delete(oldest);
    }
  }

  /**
   * Every `thread.message-sent` moves the message's span: the first line that
   * names it creates its `message_docs` row, every later one advances `seq`.
   * Text follows the fold's rule (§5.1): a `streaming: true` row appends; a
   * `streaming: false` row with text replaces the body, with empty text keeps
   * it. A message streaming again after it finished continues from the text
   * already indexed for it, as the fold continues from the item.
   */
  function indexMessage(
    memory: ThreadMemory,
    event: Extract<DomainEvent, { type: "thread.message-sent" }>,
    position: EventPosition
  ): void {
    const payload = event.payload;
    const messageId = payload.messageId;
    if (typeof messageId !== "string" || messageId.length === 0) {
      return;
    }
    const chunk = typeof payload.text === "string" ? payload.text : "";
    const threadId = memory.threadId;

    let stream = memory.streams.get(messageId);
    let rowid: number;
    let fresh = false;
    if (stream !== undefined) {
      rowid = stream.doc;
      sql.updateMessageDoc.run(event.seq, rowid);
    } else {
      const doc = asRecord(sql.selectMessageDoc.get(threadId, messageId))?.doc;
      if (doc !== undefined) {
        rowid = Number(doc);
        sql.updateMessageDoc.run(event.seq, rowid);
      } else {
        fresh = true;
        rowid = Number(
          sql.insertMessageDoc.run(
            threadId,
            messageId,
            event.seq,
            event.seq,
            position.byteOffset,
            position.byteLength
          ).lastInsertRowid
        );
      }
    }

    if (payload.streaming === true) {
      if (stream === undefined) {
        const indexed = fresh ? null : indexedText(rowid);
        stream = {
          doc: rowid,
          text: indexed?.text ?? "",
          role: indexed?.role ?? String(payload.role),
          at: indexed?.at ?? event.occurredAt
        };
        memory.streams.set(messageId, stream);
        for (const stale of memory.streams.keys()) {
          if (memory.streams.size <= MAX_OPEN_STREAMS) {
            break;
          }
          memory.streams.delete(stale);
        }
      }
      // Kept to ONE unit past the cap, and no further: the final cut
      // (`capText`) must see the unit after the cap to know whether the cap
      // splits a surrogate pair. Kept at exactly the cap, a pair a chunk
      // boundary split there left its high half as the indexed body's last
      // unit, with the low half never appended.
      if (stream.text.length <= MAX_INDEXED_TEXT_CHARS) {
        const joined = stream.text + chunk;
        stream.text =
          joined.length > MAX_INDEXED_TEXT_CHARS + 1
            ? joined.slice(0, MAX_INDEXED_TEXT_CHARS + 1)
            : joined;
      }
      return;
    }

    memory.streams.delete(messageId);
    const text = chunk.length > 0 ? chunk : (stream?.text ?? "");
    if (text.trim().length === 0) {
      return;
    }
    // A message finished again without streaming keeps where and when it began.
    const previous = stream ?? (fresh ? null : indexedText(rowid));
    sql.deleteMessageFts.run(rowid);
    sql.insertMessageFts.run(
      rowid,
      capText(text),
      threadId,
      messageId,
      toStringOrNull(payload.turnId),
      previous?.role ?? String(payload.role),
      event.seq,
      previous?.at || event.occurredAt
    );
  }

  /** The text, role and first stamp already indexed under a message's rowid. */
  function indexedText(rowid: number): Omit<StreamState, "doc"> | null {
    const row = asRecord(sql.selectMessageText.get(rowid));
    if (row === null || typeof row.text !== "string") {
      return null;
    }
    return {
      text: row.text,
      role: typeof row.role === "string" ? row.role : "assistant",
      at: typeof row.at === "string" ? row.at : ""
    };
  }

  function indexActivity(
    memory: ThreadMemory,
    event: Extract<DomainEvent, { type: "thread.activity-appended" }>,
    position: EventPosition
  ): void {
    const activity = asRecord(event.payload?.activity);
    const activityId = toStringOrNull(activity?.id);
    if (activity === null || activityId === null || activityId.length === 0) {
      return;
    }
    const threadId = memory.threadId;
    const existing = asRecord(sql.selectItem.get(threadId, activityId));
    let rowid: number;
    if (existing !== null) {
      rowid = Number(existing.doc);
      sql.deleteActivityFts.run(rowid);
      sql.deleteMarkerAt.run(threadId, toCount(existing.seq));
      sql.updateItem.run(event.seq, position.byteOffset, position.byteLength, rowid);
    } else {
      rowid = Number(
        sql.insertItem.run(
          threadId,
          activityId,
          event.seq,
          position.byteOffset,
          position.byteLength
        ).lastInsertRowid
      );
    }

    const kind = toStringOrNull(activity.activityKind) ?? "";
    const text = activityText(activity);
    if (text.length > 0) {
      sql.insertActivityFts.run(
        rowid,
        text,
        threadId,
        activityId,
        toStringOrNull(activity.turnId),
        kind,
        event.seq,
        toStringOrNull(activity.createdAt) ?? event.occurredAt
      );
    }
    if (kind === "context-compaction") {
      sql.insertMarker.run(threadId, event.seq, markerKind(activity.payload));
    }
  }

  // -------------------------------------------------------------------------
  // The batch
  // -------------------------------------------------------------------------

  function applyEvent(
    memory: ThreadMemory,
    event: DomainEvent,
    position: EventPosition,
    batch: BatchState
  ): boolean {
    const here: Position = { seq: event.seq, byteOffset: position.byteOffset };
    const end = position.byteOffset + position.byteLength;

    // A line of another thread's log is not this thread's (the fold agrees);
    // it still occupies its bytes, so the cursor moves past it.
    if (event.threadId === memory.threadId) {
      if (event.type === "thread.deleted") {
        deleteThreadRows(memory.threadId);
        resident.delete(memory.threadId);
        return false;
      }
      // Remembered before the turn fold: the turn that claims this prompt is
      // created by a LATER event of the same append.
      if (event.type === "thread.message-sent") {
        rememberPrompt(memory, event, here);
      }
      advanceTurns(memory, event, here, end, batch);
      if (extendReferenced(memory, event, end)) {
        // A closed row moved: the flush re-checks every started row.
        batch.structural = true;
      }
      if (event.type === "thread.message-sent") {
        indexMessage(memory, event, position);
      } else if (event.type === "thread.activity-appended") {
        indexActivity(memory, event, position);
      }
    }

    memory.lastSeq = event.seq;
    memory.lastByte = end;
    return true;
  }

  function deleteThreadRows(threadId: string): void {
    sql.dropMessageFts.run(threadId);
    sql.dropMessageDocs.run(threadId);
    sql.dropActivityFts.run(threadId);
    sql.dropItems.run(threadId);
    sql.dropMarkers.run(threadId);
    sql.dropTurns.run(threadId);
    sql.dropThread.run(threadId);
  }

  /**
   * Applying past a hole would leave it unindexed for good — the cursor would
   * already be beyond it when the catch-up comes — so the batch stops there.
   * Said once per hole: the index stays behind until a catch-up.
   */
  function noteGap(memory: ThreadMemory, nextSeq: number): void {
    if (memory.gapLogged) {
      return;
    }
    memory.gapLogged = true;
    logger.info("agent-host: thread index is behind this thread's log; waiting for catch-up", {
      threadId: memory.threadId,
      indexedSeq: memory.lastSeq,
      nextSeq
    });
  }

  const resetThreadRows = (threadId: string): void =>
    db.transaction(() => deleteThreadRows(threadId))();

  /** `applyBatch` on the thread's loaded memory. */
  function applyLoaded(
    memory: ThreadMemory,
    meta: IndexedThreadMeta,
    events: readonly DomainEvent[],
    positions: readonly EventPosition[]
  ): ApplyOutcome {
    const threadId = memory.threadId;
    let start = 0;
    while (start < events.length && events[start]!.seq <= memory.lastSeq) {
      start += 1;
    }
    if (start === events.length) {
      return "noop";
    }
    if (events[start]!.seq !== memory.lastSeq + 1) {
      noteGap(memory, events[start]!.seq);
      return "gap";
    }

    let outcome: ApplyOutcome = "applied";
    let stoppedAtGap = false;
    try {
      db.transaction(() => {
        const batch: BatchState = { structural: false };
        for (let index = start; index < events.length; index += 1) {
          const event = events[index]!;
          const position = positions[index]!;
          if (event.seq !== memory.lastSeq + 1) {
            // A hole INSIDE the batch — observes coalesced around one that
            // never came: the prefix before it is still good.
            noteGap(memory, event.seq);
            stoppedAtGap = true;
            break;
          }
          if (!isUsablePosition(position, event.seq)) {
            logger.warn("agent-host: thread index stopped at an unusable position", {
              threadId,
              seq: event.seq,
              indexedSeq: memory.lastSeq
            });
            break;
          }
          if (!applyEvent(memory, event, position, batch)) {
            outcome = "deleted";
            return;
          }
        }
        flushTurnRows(memory, batch);
        if (memory.inflightStale) {
          memory.inflight = serializeInflight(memory);
          memory.inflightStale = false;
        }
        sql.upsertThread.run(
          threadId,
          typeof meta.projectPath === "string" ? meta.projectPath : "",
          typeof meta.title === "string" ? meta.title : "",
          memory.lastSeq,
          memory.lastByte,
          clock.nowIso(),
          memory.openTurnId,
          memory.revertSeq,
          memory.inflight
        );
      })();
    } catch (error) {
      // The rows rolled back; the memory did not. Reload it from the rows —
      // and from `threads.inflight`, which rolled back with them.
      resident.delete(threadId);
      throw error;
    }
    if (!stoppedAtGap) {
      memory.gapLogged = false;
    }
    return outcome;
  }

  return {
    applyBatch(meta, events, positions) {
      if (events.length !== positions.length) {
        throw new Error(
          `thread index: ${events.length} events but ${positions.length} positions`
        );
      }
      const threadId = meta.threadId;
      // A throw has already dropped the thread's memory: nothing to evict.
      const outcome = applyLoaded(load(threadId), meta, events, positions);
      // Every other outcome loaded the thread — a noop or a gap as well — so
      // every one of them keeps the bound.
      evictIdle(threadId);
      return outcome;
    },

    cursor(threadId) {
      const memory = resident.get(threadId);
      if (memory !== undefined) {
        return memory.lastSeq > 0 || memory.lastByte > 0
          ? { lastSeq: memory.lastSeq, lastByte: memory.lastByte }
          : null;
      }
      const row = asRecord(sql.selectThread.get(threadId));
      return row === null
        ? null
        : { lastSeq: toCount(row.last_seq), lastByte: toCount(row.last_byte) };
    },

    resetThread(threadId) {
      resident.delete(threadId);
      resetThreadRows(threadId);
    },

    residentThreadIds() {
      return [...resident.keys()];
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The turn an event says it belongs to: an activity's or a message's
 * `turnId`, a checkpoint's `turnId`. Null for everything else.
 */
function referencedTurnId(event: DomainEvent): string | null {
  switch (event.type) {
    case "thread.activity-appended":
      return toStringOrNull(asRecord(event.payload?.activity)?.turnId);
    case "thread.turn-diff-completed":
    case "thread.message-sent":
      return toStringOrNull(event.payload?.turnId);
    default:
      return null;
  }
}

/** Same rows, same order — the reducer merely returned a fresh array. */
function sameTurns(prev: readonly Turn[], next: readonly Turn[]): boolean {
  return prev.length === next.length && prev.every((turn, index) => next[index] === turn);
}

function isUsablePosition(position: EventPosition | undefined, seq: number): boolean {
  return (
    position !== undefined &&
    Number.isSafeInteger(position.byteOffset) &&
    position.byteOffset >= 0 &&
    Number.isSafeInteger(position.byteLength) &&
    position.byteLength > 0 &&
    (position.seq === undefined || position.seq === seq)
  );
}

/** What a search can find an activity by: its label plus the payload's title and detail. */
function activityText(activity: Record<string, unknown>): string {
  const payload = asRecord(activity.payload);
  const parts: string[] = [];
  for (const candidate of [activity.summary, payload?.title, payload?.detail]) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !parts.includes(trimmed)) {
      parts.push(trimmed);
    }
  }
  return capText(parts.join("\n"));
}

/** `compactionMarkerState`'s classification, on the persisted payload. */
function markerKind(payload: unknown): IndexedMarkerKind {
  const state = asRecord(payload)?.state;
  return state === "compacting" || state === "compaction-failed" ? state : "compacted";
}

/**
 * The head of `text` an FTS row indexes: {@link MAX_INDEXED_TEXT_CHARS} UTF-16
 * code units — one fewer when the cut would leave the high half of a
 * surrogate pair as the last unit. A lone surrogate is not text: SQLite's
 * UTF-8 stores it as replacement characters, which a snippet then shows. Only
 * the unit at the cut is looked at, never the whole body (no `Array.from`
 * over 128 K code units to find a boundary one comparison finds).
 */
export function capText(text: string): string {
  if (text.length <= MAX_INDEXED_TEXT_CHARS) {
    return text;
  }
  const last = text.charCodeAt(MAX_INDEXED_TEXT_CHARS - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? MAX_INDEXED_TEXT_CHARS - 1 : MAX_INDEXED_TEXT_CHARS);
}

// ---------------------------------------------------------------------------
// `threads.inflight`
// ---------------------------------------------------------------------------

interface Cursor {
  lastSeq: number;
  lastByte: number;
}

type InflightParse = { state: InflightState } | { error: string };

/**
 * `threads.inflight` read back field by field: the file is a cache another
 * build may have written, so nothing `JSON.parse` returns is trusted. `''` is
 * the writer's own "nothing in flight"; anything else must be exactly what
 * `serializeInflight` writes, inside the cursor it was written with — or it
 * is an error, and the caller drops it whole.
 */
function parseInflight(raw: unknown, cursor: Cursor): InflightParse {
  if (raw === "") {
    return { state: { pending: [], prompts: [] } };
  }
  if (typeof raw !== "string") {
    return { error: "not text" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: "not JSON" };
  }
  const record = asRecord(value);
  if (record === null || !Array.isArray(record.pending) || !Array.isArray(record.prompts)) {
    return { error: "not an in-flight state" };
  }
  const pending: InflightTurn[] = [];
  for (const entry of record.pending as unknown[]) {
    const turn = toInflightTurn(entry, cursor);
    if (turn === null) {
      return { error: "a pending turn does not read back" };
    }
    const previous = pending[pending.length - 1];
    if (previous !== undefined && turn.startedBefore < previous.startedBefore) {
      return { error: "pending turns out of order" };
    }
    pending.push(turn);
  }
  const prompts: InflightPrompt[] = [];
  for (const entry of record.prompts as unknown[]) {
    const prompt = toInflightPrompt(entry, cursor);
    if (prompt === null) {
      return { error: "a prompt does not read back" };
    }
    prompts.push(prompt);
  }
  return { state: { pending, prompts } };
}

function toInflightTurn(value: unknown, cursor: Cursor): InflightTurn | null {
  const entry = asRecord(value);
  if (entry === null) {
    return null;
  }
  const { startedBefore, requestedAt, userMessageId } = entry;
  const span = toSpan(entry.span, cursor);
  if (!isCount(startedBefore) || typeof requestedAt !== "string" || span === null) {
    return null;
  }
  if (userMessageId === undefined) {
    return { startedBefore, requestedAt, span };
  }
  // The fold never records an empty prompt id (`requestedTurn`).
  if (typeof userMessageId !== "string" || userMessageId.length === 0) {
    return null;
  }
  return { startedBefore, requestedAt, userMessageId, span };
}

/** A range this index wrote: whole lines, first to last, inside what it had indexed. */
function toSpan(value: unknown, cursor: Cursor): Span | null {
  const span = asRecord(value);
  if (span === null) {
    return null;
  }
  const { firstSeq, firstByte, lastSeq, endByte } = span;
  if (!isCount(firstSeq) || !isCount(firstByte) || !isCount(lastSeq) || !isCount(endByte)) {
    return null;
  }
  if (
    firstSeq < 1 ||
    firstSeq > lastSeq ||
    lastSeq > cursor.lastSeq ||
    firstByte >= endByte ||
    endByte > cursor.lastByte
  ) {
    return null;
  }
  return { firstSeq, firstByte, lastSeq, endByte };
}

function toInflightPrompt(value: unknown, cursor: Cursor): InflightPrompt | null {
  const entry = asRecord(value);
  if (entry === null) {
    return null;
  }
  const { messageId, seq, byteOffset } = entry;
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    !isCount(seq) ||
    seq < 1 ||
    seq > cursor.lastSeq ||
    !isCount(byteOffset) ||
    byteOffset >= cursor.lastByte
  ) {
    return null;
  }
  return { messageId, seq, byteOffset };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toCount(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : 0;
}
