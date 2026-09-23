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
 * - `queries.ts` — turn lookups, paging, search.
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
  type SqliteDatabase,
  type SqliteDriver
} from "./sqlite.ts";

export type {
  SqliteDatabase,
  SqliteDriver,
  SqliteRunResult,
  SqliteStatement
} from "./sqlite.ts";
export { defaultSqliteDriver } from "./sqlite.ts";
export { INDEX_SCHEMA_VERSION } from "./schema.ts";

/** Events applied per transaction during a catch-up, with a loop yield between. */
export const INDEX_CATCH_UP_CHUNK = 500;

export interface ThreadIndexOptions {
  /** `agentChatIndexPath(appdir)`. */
  filePath: string;
  logger: AdapterLogger;
  clock?: Clock;
  /**
   * Test seam: inject the driver; `null` simulates a host without the native
   * binding. Default: better-sqlite3, resolved once when `sqlite.ts` loads.
   */
  driver?: SqliteDriver | null;
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
  search(input: { q: string; limit: number; projectPath?: string }): ThreadSearchHit[];
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
  const driver = options.driver === undefined ? defaultSqliteDriver : options.driver;
  if (driver === null) {
    logger.warn("agent-host: thread index disabled — the SQLite driver is unavailable", {
      error: options.driver === null ? "disabled by the caller" : defaultSqliteDriverError
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
  ): boolean => {
    try {
      const outcome = indexer.applyBatch(meta, events, positions);
      failing.delete(meta.threadId);
      return outcome === "applied" || outcome === "deleted";
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
      return false;
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
      const lane = laneOf(request.threadId);
      const generation = lane.generation;
      await enqueue(lane, () => runCatchUp(lane, generation, request));
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

    search(request) {
      return serving() ? read(() => queries.search(request), []) : [];
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
 * `INDEX_UNAVAILABLE` (history) and `indexed: false` (search).
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
    search: () => [],
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
