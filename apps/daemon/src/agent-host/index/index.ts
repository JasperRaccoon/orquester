/**
 * Agent host — the thread index (design 2026-09-23 "thread index and lazy
 * boot", §C).
 *
 * One host-wide SQLite file of rows DERIVED from the per-thread logs: turn
 * boundaries with the byte range each turn owns, activity positions, markers
 * and full text. It serves paged history and cross-thread search. It is a
 * cache (invariant 1): deleted and rebuilt on any doubt, written strictly
 * after the log (invariant 4), and never on the readiness path (invariant 2).
 *
 * - `sqlite.ts` — driver resolution (once, at load) and the file lifecycle;
 * - `schema.ts` — the tables;
 * - `indexer.ts` — domain events → rows, one transaction per batch;
 * - `queries.ts` — turn lookups, paging, search, the thread's own prompts;
 * - `turn-reference.ts` — the turn a line says it belongs to, which history
 *   planning reads too.
 *
 * Writes are applied per thread, in order, on an internal queue: `observe`
 * returns at once, `catchUp` rides the same queue so a live append and a
 * catch-up read can never interleave out of order, and `drain` waits for both.
 * `stop` is the host's shutdown: it applies what is already queued but cuts a
 * catch-up short, so one big thread's catch-up cannot hold a deploy's stop.
 */

import type {
  DomainEvent,
  HistoryCursor,
  ThreadPromptEntry,
  ThreadSearchHit
} from "@orquester/api/agent-chat";

import type { AdapterLogger } from "../adapter.ts";
import { systemClock, type Clock } from "../orchestration/runtime-seams.ts";
import type { EventPosition, EventsFromResult } from "../services.ts";
import { createThreadIndexer, type ThreadIndexer } from "./indexer.ts";
import { createThreadIndexQueries, type ThreadIndexQueries } from "./queries.ts";
import {
  defaultSqliteDriver,
  defaultSqliteDriverError,
  describeError,
  openIndexFile,
  removeIndexFiles,
  type SqliteDatabase
} from "./sqlite.ts";

/** Events applied per transaction during a catch-up, with a loop yield between. */
const INDEX_CATCH_UP_CHUNK = 500;

export interface ThreadIndexOptions {
  /** `agentChatIndexPath(appdir)`. */
  filePath: string;
  logger: AdapterLogger;
  clock?: Clock;
}

export interface IndexedThreadMeta {
  threadId: string;
  projectPath: string;
  title: string;
}

/**
 * One started turn. `[firstByte, endByte)` is the part of `events.ndjson` it
 * owns — from its opening prompt to the next started turn's first line (the
 * latest turn's range grows with the log) — so the ranges of consecutive
 * turns meet exactly and a page of them is one read. `firstSeq`/`lastSeq`
 * are the seqs of that range's first and last line.
 */
export interface IndexedTurn {
  turnId: string;
  /** 1-based, by ORDER of started turns (`startedTurns`) — `/revert`'s count. */
  ordinal: number;
  userMessageId: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  firstSeq: number;
  lastSeq: number;
  firstByte: number;
  endByte: number;
}

/**
 * Where an activity's line sits in `events.ndjson` — its LATEST write: an
 * activity rewritten under the same id (last write wins, like `readItem`) is
 * found at its newest line, and its older lines no longer answer by seq.
 */
export interface IndexedItemPosition {
  seq: number;
  byteOffset: number;
  byteLength: number;
}

/**
 * One message's lines: the first that named it (`firstSeq`/`firstByte`) and
 * the latest (`lastSeq` — its final line once it finished streaming).
 */
export interface IndexedMessageSpan {
  firstSeq: number;
  firstByte: number;
  lastSeq: number;
}

export interface SpanningMessage extends IndexedMessageSpan {
  messageId: string;
}

/** One page of the thread's prompts; the host adds `threadId` and `indexed`. */
export interface IndexedPromptsPage {
  /** Newest first. */
  prompts: ThreadPromptEntry[];
  /**
   * The cursor of the next older page; null when the thread has no older
   * prompt. A page the scan budget cut short carries one while holding fewer
   * than `limit` prompts — even none (`queries.ts` `PROMPTS_SCAN_BUDGET`).
   */
  before: string | null;
}

/**
 * How much of one thread's log the index holds — whether its rows are the
 * WHOLE thread. The prompt list's gate: a page of a partly indexed thread
 * reads exactly like the complete list, and a client keeps it as such.
 * - `complete` — every line up to the log's own seq is indexed;
 * - `catching-up` — not yet, and a catch-up will close the gap: the file has
 *   not opened yet, the boot sweep has not reached the thread, or its
 *   catch-up is queued or running — ask again shortly;
 * - `behind` — not, and nothing will re-read the missing lines before the
 *   host restarts: its catch-up ended short (an unreadable log, a write that
 *   failed), a live write failed after it, or the sweep never listed it;
 * - `failed` — the index could not tell (a read failed);
 * - `unavailable` — there is no usable index at all.
 */
export type IndexCoverage = "complete" | "catching-up" | "behind" | "failed" | "unavailable";

/** `prompt()`'s answer. */
export type IndexedPromptLookup =
  | { status: "found"; prompt: IndexedPrompt }
  /** The index holds no such prompt of the thread. */
  | { status: "absent" }
  /** It could not read: a driver error, or no usable index. */
  | { status: "failed" };

/** The boot catch-up's walk over every log on disk, `beginCatchUpSweep` to `end`. */
export interface CatchUpSweep {
  /** Idempotent. */
  end(): void;
}

/**
 * One of the thread's own prompts by id, for `GET …/prompts/:messageId`: its
 * normalised text as the index holds it, and where its line sits, so the
 * host can read the whole prompt back from the log when the index's copy may
 * be cut.
 */
export interface IndexedPrompt {
  messageId: string;
  /** `recallablePromptText` of the index's copy. */
  text: string;
  /**
   * The index's copy may be cut: it is `MAX_INDEXED_TEXT_CHARS` long, or one
   * short of it (`capText`), so `text` may not be the whole prompt.
   */
  cut: boolean;
  /** The message's first line — its only one when `lastSeq === line.seq`. */
  line: IndexedItemPosition;
  /** The seq of the message's latest line. */
  lastSeq: number;
}

export interface ThreadIndex {
  /** False when the driver could not be loaded or the file could not be opened/rebuilt. */
  readonly available: boolean;
  /**
   * Feed appended events (with the positions the store returned). Never throws,
   * never blocks the caller: applied in order per thread on an internal queue.
   * Events with seq <= the thread's cursor are ignored (idempotent). A batch
   * that does not continue the cursor (the index is behind the log, e.g.
   * before its boot catch-up) is dropped: only `catchUp` can fill a hole.
   */
  observe(
    input: IndexedThreadMeta & {
      events: readonly DomainEvent[];
      positions: readonly EventPosition[];
    }
  ): void;
  /**
   * Wait for every queued observe AND every catch-up to finish — a whole
   * catch-up, however big its thread (tests; the host stops with `stop`).
   */
  drain(): Promise<void>;
  /**
   * Bring one thread's rows up to the log. `read` is the store's readEventsFrom bound to the
   * thread; on `mismatch` the thread is re-indexed from byte 0 (rows deleted first).
   * Chunked with setImmediate yields every 500 events. Never throws.
   */
  catchUp(
    input: IndexedThreadMeta & {
      logSeq: number;
      read: (cursor: { byteOffset: number; afterSeq: number }) => Promise<EventsFromResult>;
    }
  ): Promise<void>;
  deleteThread(threadId: string): void;
  cursor(threadId: string): { lastSeq: number; lastByte: number } | null;
  turnByOrdinal(threadId: string, ordinal: number): IndexedTurn | null;
  turnById(threadId: string, turnId: string): IndexedTurn | null;
  totalTurns(threadId: string): number;
  /**
   * The `limit` turns strictly older than the cursor (or than `beforeTurn` when the cursor is
   * null; the newest `limit` turns when both are null), oldest first.
   */
  turnsBefore(
    threadId: string,
    input: { before: HistoryCursor | null; beforeTurn?: IndexedTurn | null; limit: number }
  ): IndexedTurn[];
  /**
   * True when no SETTLED compaction of the conversation itself
   * (`isSettledConversationCompaction`) lies after the turn's opening prompt
   * (`firstSeq`): a rewind to it would not cross a compaction.
   */
  rewindable(threadId: string, turn: IndexedTurn): boolean;

  // Activity paging (spec "History page": blocks walked back by activity count).
  /** The activity's latest line, or null when the index does not know it. */
  itemPosition(threadId: string, itemId: string): IndexedItemPosition | null;
  /** The activity whose latest line has exactly this seq, or null. */
  itemPositionBySeq(threadId: string, seq: number): IndexedItemPosition | null;
  /** True when any indexed activity has a seq below `seq`. */
  hasItemsBefore(threadId: string, seq: number): boolean;
  /**
   * The seq of the activity `count` activities back from `beforeSeq`
   * (exclusive, walking down), or the OLDEST indexed activity's seq when
   * fewer than `count` precede it; null when none does. A `count` below 1
   * reads as 1.
   */
  activitySeqBefore(threadId: string, input: { beforeSeq: number; count: number }): number | null;
  /** Turns whose `[firstSeq, lastSeq]` intersects `[fromSeq, toSeq)`, in ordinal order. */
  turnsInSeqRange(threadId: string, input: { fromSeq: number; toSeq: number }): IndexedTurn[];
  /**
   * The turn whose range contains `seq` — the one with the greatest
   * `firstSeq <= seq` when ranges overlap. Ranges tile the log, so only rows
   * a revert left between its survivors and the next turn fall in none; they
   * get the nearest turn that started before them. Null when no turn starts
   * at or before `seq`.
   */
  turnOfSeq(threadId: string, seq: number): IndexedTurn | null;
  /**
   * The line at `seq` a page boundary may sit on: an activity's (latest)
   * line, else the first line of a message. Null for any other line.
   */
  eventPositionBySeq(threadId: string, seq: number): IndexedItemPosition | null;
  /** Where a message began and where it was last written; null when unknown. */
  messageSpan(threadId: string, messageId: string): IndexedMessageSpan | null;
  /**
   * Every message a page boundary at `seq` would cut in two: `firstSeq < seq
   * && seq <= lastSeq`, oldest first — the host moves the boundary back to
   * the oldest one's `firstSeq`.
   */
  messagesSpanning(threadId: string, seq: number): SpanningMessage[];
  /**
   * The first line past `seq` a page boundary may sit on — the lowest
   * activity line or message first line above it — or null when there is none.
   */
  firstBoundaryAfter(threadId: string, seq: number): IndexedItemPosition | null;
  /** The seq of the thread's latest `thread.reverted`, 0 for a thread never rewound. */
  latestRevertSeq(threadId: string): number;
  /** The turn that names `messageId` as its opening prompt (`userMessageId`), or null. */
  turnByPrompt(threadId: string, messageId: string): IndexedTurn | null;
  /**
   * Whether the thread still holds `messageId` as a user message — every one
   * the index has taken, less those a revert dropped by the fold's own rule
   * (`indexer.ts` `dropRevertedUserMessages`: with the turn that names or
   * claims it, else by the fallback pass). What a history page folds of a
   * turn-less prompt written before the latest revert (`historyBlockEvents`
   * in `orchestrator.ts`). False when the index cannot read.
   */
  keepsUserMessage(threadId: string, messageId: string): boolean;
  search(input: { q: string; limit: number; projectPath?: string }): ThreadSearchHit[];
  /**
   * Whether the index holds every line of the thread's log up to `logSeq` —
   * the log's own last seq, as the host's fold has it. Waits for the observes
   * already queued for the thread, so a live append trailing by a moment never
   * reads as a gap — but never for a catch-up, which reads `catching-up`
   * whatever its progress. Never rejects.
   */
  coverage(threadId: string, logSeq: number): Promise<IndexCoverage>;
  /**
   * The boot catch-up starts walking every log on disk: until `end()`, a
   * thread the index is behind on reads `catching-up`, not `behind` — unless
   * its own catch-up has already finished, which is what settled it.
   */
  beginCatchUpSweep(): CatchUpSweep;
  /**
   * The thread's own prompts, newest first — the right rail's History: the
   * parent conversation's `user` messages that `recallablePromptText`
   * accepts, each with the turn it opened. At most `limit` of them (clamped
   * to `[1, THREAD_PROMPTS_MAX_LIMIT]`), strictly older than a previous
   * page's `before` cursor — a malformed or foreign one reads as none; a
   * page that walked its scan budget past refused rows stops short with a
   * cursor. Only as whole as the index is: ask `coverage` first.
   *
   * A revert takes its user messages by the fold's own rule
   * (`indexer.ts` `dropRevertedUserMessages`): a steer with its turn, a prompt
   * with the turn that claimed it, a turn-less one no retained turn claims
   * (an idle `/goal`, a refused send) unless the fold's fallback restores it.
   * Parity is with a fold of the whole log: the live fold counts that
   * fallback over its retained window, and a log with no started turn at all
   * (numbered by checkpoints) keeps none of its user messages here.
   *
   * Null when the index could not read (a driver error, or none is usable).
   */
  prompts(
    threadId: string,
    input: { before?: string | null; limit: number }
  ): IndexedPromptsPage | null;
  /** One of those prompts by message id — or `absent`, or `failed`. */
  prompt(threadId: string, messageId: string): IndexedPromptLookup;
  /**
   * The host's shutdown. At once: `available` turns false, every read answers
   * its empty fallback, and new work is refused (`observe`, `catchUp`) — but a
   * `deleteThread` still deletes until the file closes, because no catch-up
   * ever visits a thread whose directory is gone. Then: every observe queued
   * before the call is still APPLIED — the orchestrator's last commits feed
   * it — while a catch-up in flight returns at its next check (after its
   * read, or at its next chunk boundary), its cursor left behind the log for
   * the next boot's catch-up to finish. Once every lane has settled, the file
   * is closed. Never rejects; idempotent.
   */
  stop(): Promise<void>;
  /** Close the file now: whatever is queued or in flight is dropped. */
  close(): void;
}

export function createThreadIndex(options: ThreadIndexOptions): ThreadIndex {
  const { logger } = options;
  const clock = options.clock ?? systemClock;
  const driver = defaultSqliteDriver;
  if (driver === null) {
    logger.warn("agent-host: thread index disabled — the SQLite driver is unavailable", {
      error: defaultSqliteDriverError
    });
    return createUnavailableThreadIndex();
  }

  // A file can pass every open-time check and still not fit this build's
  // statements (a column this build added under the same version): that is a
  // schema mismatch too, so it is deleted and rebuilt — once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const opened = openIndexFile({ filePath: options.filePath, driver, logger });
    if (opened === null) {
      return createUnavailableThreadIndex();
    }
    const { db } = opened;
    let indexer: ThreadIndexer;
    let queries: ThreadIndexQueries;
    try {
      indexer = createThreadIndexer({ db, logger, clock });
      queries = createThreadIndexQueries(db);
    } catch (error) {
      closeQuietly(db);
      if (attempt === 0) {
        logger.warn("agent-host: thread index does not fit this build; deleting and rebuilding it", {
          filePath: options.filePath,
          error: describeError(error)
        });
        try {
          removeIndexFiles(options.filePath);
        } catch (removeError) {
          logger.warn("agent-host: thread index could not be deleted; running without it", {
            error: describeError(removeError)
          });
          return createUnavailableThreadIndex();
        }
        continue;
      }
      logger.warn("agent-host: thread index could not prepare its statements; running without it", {
        error: describeError(error)
      });
      return createUnavailableThreadIndex();
    }
    if (opened.rebuilt || attempt > 0) {
      logger.info("agent-host: thread index recreated empty; threads are re-indexed by catch-up", {
        filePath: options.filePath
      });
    }
    return createOpenThreadIndex({ db, indexer, queries, logger });
  }
  return createUnavailableThreadIndex();
}

// ---------------------------------------------------------------------------
// The open index
// ---------------------------------------------------------------------------

interface ObserveBatch {
  meta: IndexedThreadMeta;
  events: readonly DomainEvent[];
  positions: readonly EventPosition[];
}

/** One thread's writes, in order. */
interface Lane {
  tail: Promise<void>;
  /** Observed batches not applied yet; one queued flush applies them all. */
  pending: ObserveBatch[];
  flushQueued: boolean;
  /** Bumped by `deleteThread`: a catch-up in flight for an older one stops. */
  generation: number;
}

function createOpenThreadIndex(input: {
  db: SqliteDatabase;
  indexer: ThreadIndexer;
  queries: ThreadIndexQueries;
  logger: AdapterLogger;
}): ThreadIndex {
  const { db, indexer, queries, logger } = input;
  /** The file is open: queued work may still be applied. */
  let open = true;
  /** `stop` was called: nothing new is accepted, nothing is read. */
  let stopping = false;
  let stopped: Promise<void> | null = null;
  /** New work and reads: only while open and not stopping. */
  const serving = (): boolean => open && !stopping;
  const lanes = new Map<string, Lane>();
  /** Threads whose last write failed: logged once until one succeeds. */
  const failing = new Set<string>();
  /** Catch-ups queued or running, per thread: from `catchUp` until it settles. */
  const catchUpsInFlight = new Map<string, number>();
  /** Threads whose catch-up has settled, whatever it reached. */
  const caughtUp = new Set<string>();
  /** Boot catch-up sweeps under way (`beginCatchUpSweep`). */
  let sweeps = 0;

  const laneOf = (threadId: string): Lane => {
    let lane = lanes.get(threadId);
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), pending: [], flushQueued: false, generation: 0 };
      lanes.set(threadId, lane);
    }
    return lane;
  };

  const enqueue = (lane: Lane, task: () => void | Promise<void>): Promise<void> => {
    const run = lane.tail.then(task).catch((error: unknown) => {
      logger.warn("agent-host: thread index task failed", { error: describeError(error) });
    });
    lane.tail = run;
    return run;
  };

  /** Apply one batch; a failure is logged, never thrown, and never sticks. */
  const apply = (
    meta: IndexedThreadMeta,
    events: readonly DomainEvent[],
    positions: readonly EventPosition[]
  ): void => {
    try {
      indexer.applyBatch(meta, events, positions);
      failing.delete(meta.threadId);
    } catch (error) {
      // The transaction rolled back and the thread reloads from its rows, so
      // the next batch starts clean — it finds a hole only catch-up fills.
      if (!failing.has(meta.threadId)) {
        failing.add(meta.threadId);
        logger.warn("agent-host: thread index write failed", {
          threadId: meta.threadId,
          error: describeError(error)
        });
      }
    }
  };

  const flush = (lane: Lane): void => {
    lane.flushQueued = false;
    const batches = lane.pending.splice(0);
    if (!open || batches.length === 0) {
      return;
    }
    // Consecutive observes become ONE transaction; the newest meta wins.
    const meta = batches[batches.length - 1]!.meta;
    const events = batches.flatMap((batch) => batch.events);
    const positions = batches.flatMap((batch) => batch.positions);
    apply(meta, events, positions);
  };

  const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const runCatchUp = async (
    lane: Lane,
    generation: number,
    request: Parameters<ThreadIndex["catchUp"]>[0]
  ): Promise<void> => {
    const meta: IndexedThreadMeta = {
      threadId: request.threadId,
      projectPath: request.projectPath,
      title: request.title
    };
    // A stop ends the catch-up here too: the rest of the log waits for the
    // next boot's catch-up, which starts from the cursor this one leaves.
    const current = (): boolean => serving() && lane.generation === generation;
    let reindexed = false;
    // Bounded: every round either advances the cursor or returns.
    for (let round = 0; round < 1_000 && current(); round += 1) {
      const cursor = indexer.cursor(meta.threadId) ?? { lastSeq: 0, lastByte: 0 };
      if (cursor.lastSeq === request.logSeq) {
        return;
      }
      // Behind: read the missing tail. Ahead: `logSeq` may simply predate a
      // live append — or the log was rewritten; the read tells which.
      const tail = await request.read({ byteOffset: cursor.lastByte, afterSeq: cursor.lastSeq });
      if (!current()) {
        return;
      }
      if (tail.mismatch) {
        if (reindexed || (cursor.lastSeq === 0 && cursor.lastByte === 0)) {
          logger.warn("agent-host: thread index cannot read this thread's log from its start", {
            threadId: meta.threadId
          });
          return;
        }
        logger.info("agent-host: thread log no longer matches its index; re-indexing it", {
          threadId: meta.threadId,
          indexedSeq: cursor.lastSeq
        });
        indexer.resetThread(meta.threadId);
        reindexed = true;
        continue;
      }
      if (tail.events.length === 0) {
        return;
      }
      for (let start = 0; start < tail.events.length; start += INDEX_CATCH_UP_CHUNK) {
        if (start > 0) {
          await yieldToLoop();
          if (!current()) {
            return;
          }
        }
        const end = start + INDEX_CATCH_UP_CHUNK;
        apply(meta, tail.events.slice(start, end), tail.positions.slice(start, end));
      }
      const after = indexer.cursor(meta.threadId);
      if (after === null || after.lastSeq <= cursor.lastSeq || tail.truncated) {
        // No progress (a write failed, a malformed line): the next boot retries.
        return;
      }
      if (after.lastSeq >= request.logSeq) {
        return;
      }
    }
  };

  /** Until no lane's tail moves: tasks queued by tasks are waited for too. */
  const settleLanes = async (): Promise<void> => {
    for (;;) {
      const tails = [...lanes.values()].map((lane) => lane.tail);
      await Promise.all(tails);
      const now = [...lanes.values()].map((lane) => lane.tail);
      if (now.length === tails.length && now.every((tail, index) => tail === tails[index])) {
        return;
      }
    }
  };

  const close = (): void => {
    if (!open) {
      return;
    }
    open = false;
    for (const lane of lanes.values()) {
      lane.pending.length = 0;
    }
    closeQuietly(db);
  };

  return {
    get available() {
      return serving();
    },

    observe(request) {
      if (!serving()) {
        return;
      }
      try {
        const lane = laneOf(request.threadId);
        lane.pending.push({
          meta: {
            threadId: request.threadId,
            projectPath: request.projectPath,
            title: request.title
          },
          events: request.events,
          positions: request.positions
        });
        if (!lane.flushQueued) {
          lane.flushQueued = true;
          void enqueue(lane, () => flush(lane));
        }
      } catch (error) {
        logger.warn("agent-host: thread index could not queue a batch", {
          error: describeError(error)
        });
      }
    },

    async drain() {
      await settleLanes();
    },

    async catchUp(request) {
      if (!serving()) {
        return;
      }
      const { threadId } = request;
      const lane = laneOf(threadId);
      const generation = lane.generation;
      // Catching up from the moment it is queued: a read that waited for it
      // would wait out a whole thread's log.
      catchUpsInFlight.set(threadId, (catchUpsInFlight.get(threadId) ?? 0) + 1);
      try {
        await enqueue(lane, () => runCatchUp(lane, generation, request));
      } finally {
        const left = (catchUpsInFlight.get(threadId) ?? 1) - 1;
        if (left > 0) {
          catchUpsInFlight.set(threadId, left);
        } else {
          catchUpsInFlight.delete(threadId);
        }
        caughtUp.add(threadId);
      }
    },

    async coverage(threadId, logSeq) {
      const settled = (): IndexCoverage | null => {
        if (!serving()) return "unavailable";
        return (catchUpsInFlight.get(threadId) ?? 0) > 0 ? "catching-up" : null;
      };
      const early = settled();
      if (early !== null) {
        return early;
      }
      // Only flushes of live observes are queued on the lane (no catch-up is):
      // wait for them, so an append that trails the log by a moment counts.
      await lanes.get(threadId)?.tail;
      const late = settled();
      if (late !== null) {
        return late;
      }
      let cursor: { lastSeq: number; lastByte: number } | null;
      try {
        cursor = indexer.cursor(threadId);
      } catch (error) {
        logger.warn("agent-host: thread index read failed", { error: describeError(error) });
        return "failed";
      }
      if ((cursor?.lastSeq ?? 0) >= logSeq) {
        return "complete";
      }
      return sweeps > 0 && !caughtUp.has(threadId) ? "catching-up" : "behind";
    },

    beginCatchUpSweep() {
      sweeps += 1;
      let ended = false;
      return {
        end: () => {
          if (!ended) {
            ended = true;
            sweeps -= 1;
          }
        }
      };
    },

    deleteThread(threadId) {
      if (!open) {
        return;
      }
      const lane = lanes.get(threadId);
      if (lane !== undefined) {
        lane.generation += 1;
        lane.pending.length = 0;
      }
      try {
        indexer.resetThread(threadId);
      } catch (error) {
        logger.warn("agent-host: thread index could not delete a thread", {
          threadId,
          error: describeError(error)
        });
      }
    },

    cursor(threadId) {
      return serving() ? read(() => indexer.cursor(threadId), null) : null;
    },

    turnByOrdinal(threadId, ordinal) {
      return serving() ? read(() => queries.turnByOrdinal(threadId, ordinal), null) : null;
    },

    turnById(threadId, turnId) {
      return serving() ? read(() => queries.turnById(threadId, turnId), null) : null;
    },

    totalTurns(threadId) {
      return serving() ? read(() => queries.totalTurns(threadId), 0) : 0;
    },

    turnsBefore(threadId, request) {
      return serving() ? read(() => queries.turnsBefore(threadId, request), []) : [];
    },

    rewindable(threadId, turn) {
      return serving() ? read(() => queries.rewindable(threadId, turn), false) : false;
    },

    itemPosition(threadId, itemId) {
      return serving() ? read(() => queries.itemPosition(threadId, itemId), null) : null;
    },

    itemPositionBySeq(threadId, seq) {
      return serving() ? read(() => queries.itemPositionBySeq(threadId, seq), null) : null;
    },

    hasItemsBefore(threadId, seq) {
      return serving() ? read(() => queries.hasItemsBefore(threadId, seq), false) : false;
    },

    activitySeqBefore(threadId, request) {
      return serving() ? read(() => queries.activitySeqBefore(threadId, request), null) : null;
    },

    turnsInSeqRange(threadId, request) {
      return serving() ? read(() => queries.turnsInSeqRange(threadId, request), []) : [];
    },

    turnOfSeq(threadId, seq) {
      return serving() ? read(() => queries.turnOfSeq(threadId, seq), null) : null;
    },

    eventPositionBySeq(threadId, seq) {
      return serving() ? read(() => queries.eventPositionBySeq(threadId, seq), null) : null;
    },

    messageSpan(threadId, messageId) {
      return serving() ? read(() => queries.messageSpan(threadId, messageId), null) : null;
    },

    messagesSpanning(threadId, seq) {
      return serving() ? read(() => queries.messagesSpanning(threadId, seq), []) : [];
    },

    firstBoundaryAfter(threadId, seq) {
      return serving() ? read(() => queries.firstBoundaryAfter(threadId, seq), null) : null;
    },

    latestRevertSeq(threadId) {
      return serving() ? read(() => queries.latestRevertSeq(threadId), 0) : 0;
    },

    turnByPrompt(threadId, messageId) {
      return serving() ? read(() => queries.turnByPrompt(threadId, messageId), null) : null;
    },

    keepsUserMessage(threadId, messageId) {
      return serving() ? read(() => queries.keepsUserMessage(threadId, messageId), false) : false;
    },

    search(request) {
      return serving() ? read(() => queries.search(request), []) : [];
    },

    // Null on a failed read, never an empty page: the client takes an empty
    // page for "this thread has no prompts".
    prompts(threadId, request) {
      return serving() ? read(() => queries.prompts(threadId, request), null) : null;
    },

    prompt(threadId, messageId) {
      if (!serving()) {
        return { status: "failed" };
      }
      return read<IndexedPromptLookup>(() => {
        const prompt = queries.prompt(threadId, messageId);
        return prompt === null ? { status: "absent" } : { status: "found", prompt };
      }, { status: "failed" });
    },

    stop() {
      if (stopped === null) {
        stopping = true;
        stopped = (async () => {
          try {
            // Observes queued before the stop apply (`flush` needs only an
            // open file); a catch-up returns at its next `current()`.
            await settleLanes();
          } catch (error) {
            // `enqueue` catches every task, so nothing should get here.
            logger.warn("agent-host: thread index lanes did not settle", {
              error: describeError(error)
            });
          } finally {
            close();
          }
        })();
      }
      return stopped;
    },

    close
  };

  function read<T>(query: () => T, fallback: T): T {
    try {
      return query();
    } catch (error) {
      logger.warn("agent-host: thread index read failed", { error: describeError(error) });
      return fallback;
    }
  }
}

// ---------------------------------------------------------------------------
// The unavailable index
// ---------------------------------------------------------------------------

/**
 * What a host without a usable index runs with: every write a no-op, every
 * read empty. The routes turn `available === false` into 503
 * `INDEX_UNAVAILABLE` (history, a prompt's text) and `indexed: false`
 * (search, the prompt list).
 */
export function createUnavailableThreadIndex(): ThreadIndex {
  return {
    available: false,
    observe: () => undefined,
    drain: async () => undefined,
    catchUp: async () => undefined,
    deleteThread: () => undefined,
    cursor: () => null,
    turnByOrdinal: () => null,
    turnById: () => null,
    totalTurns: () => 0,
    turnsBefore: () => [],
    rewindable: () => false,
    itemPosition: () => null,
    itemPositionBySeq: () => null,
    hasItemsBefore: () => false,
    activitySeqBefore: () => null,
    turnsInSeqRange: () => [],
    turnOfSeq: () => null,
    eventPositionBySeq: () => null,
    messageSpan: () => null,
    messagesSpanning: () => [],
    firstBoundaryAfter: () => null,
    latestRevertSeq: () => 0,
    turnByPrompt: () => null,
    keepsUserMessage: () => false,
    search: () => [],
    coverage: async () => "unavailable",
    beginCatchUpSweep: () => ({ end: () => undefined }),
    prompts: () => null,
    prompt: () => ({ status: "failed" }),
    stop: async () => undefined,
    close: () => undefined
  };
}

function closeQuietly(db: SqliteDatabase): void {
  try {
    db.close();
  } catch {
    // Nothing left to do with it.
  }
}
