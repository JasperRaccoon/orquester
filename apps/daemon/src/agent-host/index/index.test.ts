/**
 * The index as the host drives it (design 2026-09-23 §C "Catch-up",
 * "Unavailable index"): catch-up from nothing, from a cursor and after the log
 * was rewritten; chunking with loop yields; ordering against live observes;
 * deletion; a driver failure that must not poison later writes — nor lose a
 * turn not started yet; the host's stop; and the driver-less mode.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createDeferred } from "../orchestration/runtime-seams.ts";
import type { EventsFromResult } from "../services.ts";
import {
  createThreadIndex,
  createUnavailableThreadIndex,
  INDEX_CATCH_UP_CHUNK,
  type IndexedTurn,
  type ThreadIndex
} from "./index.ts";
import { defaultSqliteDriver, type SqliteDatabase, type SqliteDriver } from "./sqlite.ts";
import {
  checkpoint,
  created,
  done,
  liveTurn,
  recordingLogger,
  session,
  TestLog,
  turnStart,
  userMessage,
  type Draft,
  type RecordingLogger
} from "./testing.ts";

let dir: string;
let filePath: string;
let logger: RecordingLogger;
const opened: ThreadIndex[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orq-index-"));
  filePath = join(dir, "index.sqlite");
  logger = recordingLogger();
});

afterEach(async () => {
  for (const index of opened.splice(0)) {
    index.close();
  }
  await rm(dir, { recursive: true, force: true });
});

function open(options: { driver?: SqliteDriver | null; file?: string } = {}): ThreadIndex {
  const index = createThreadIndex({
    filePath: options.file ?? filePath,
    logger,
    ...(options.driver !== undefined ? { driver: options.driver } : {})
  });
  opened.push(index);
  return index;
}

const META = { projectPath: "/w/p", title: "T" };

function turns(log: TestLog, count: number, from = 1): Draft[] {
  const drafts: Draft[] = [];
  for (let n = from; n < from + count; n += 1) {
    drafts.push(...liveTurn({ n, prompt: `prompt ${n} words` }));
  }
  return drafts;
}

function catchUpInput(log: TestLog, read = log.readEventsFrom) {
  return { threadId: log.threadId, ...META, logSeq: log.lastSeq, read };
}

function allTurns(index: ThreadIndex, threadId: string): IndexedTurn[] {
  return index.turnsBefore(threadId, { before: null, limit: 10_000 });
}

/** The same log, observed in one batch into a fresh file. */
async function reference(log: TestLog): Promise<IndexedTurn[]> {
  const index = open({ file: join(dir, `reference-${opened.length}.sqlite`) });
  index.observe({ threadId: log.threadId, ...META, ...log.all() });
  await index.drain();
  return allTurns(index, log.threadId);
}

/**
 * Counts transactions; fails a statement's `run` on demand (from the start, or
 * armed later with `failNext`); and tells a test when a transaction commits.
 */
function instrumentedDriver(failOn?: { sql: RegExp; times: number }): {
  driver: SqliteDriver;
  transactions: () => number;
  /** Fail the next `times` runs of every statement whose SQL matches. */
  failNext: (sql: RegExp, times: number) => void;
  /**
   * Resolves once `count` more transactions have committed — from inside the
   * commit, so the writer is still wherever it was when the commit returned.
   */
  commits: (count: number) => Promise<void>;
} {
  const base = defaultSqliteDriver!;
  let transactions = 0;
  let committed = 0;
  let failure = failOn === undefined ? null : { sql: failOn.sql, left: failOn.times };
  const waiters: Array<{ at: number; resolve: () => void }> = [];
  const driver: SqliteDriver = {
    open(path) {
      const db = base.open(path);
      const wrapped: SqliteDatabase = {
        ...db,
        prepare(source) {
          const statement = db.prepare(source);
          return {
            run: (...params: unknown[]) => {
              if (failure !== null && failure.left > 0 && failure.sql.test(source)) {
                failure.left -= 1;
                throw new Error("disk I/O error");
              }
              return statement.run(...params);
            },
            get: (...params: unknown[]) => statement.get(...params),
            all: (...params: unknown[]) => statement.all(...params)
          };
        },
        transaction(fn) {
          transactions += 1;
          const run = db.transaction(fn);
          return () => {
            const result = run();
            committed += 1;
            for (const waiter of waiters.filter((entry) => entry.at <= committed)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve();
            }
            return result;
          };
        }
      };
      return wrapped;
    }
  };
  return {
    driver,
    transactions: () => transactions,
    failNext: (sql, times) => {
      failure = { sql, left: times };
    },
    commits: (count) => {
      const deferred = createDeferred();
      waiters.push({ at: committed + count, resolve: () => deferred.resolve() });
      return deferred.promise;
    }
  };
}

describe("thread index: catchUp", () => {
  it("indexes a thread from nothing in chunks of 500, yielding to the loop between them", async () => {
    const { driver, transactions } = instrumentedDriver();
    const index = open({ driver });
    const log = new TestLog();
    log.append(created(), ...turns(log, 150)); // 1 201 events
    assert.equal(log.lastSeq, 1_201);

    const before = transactions();
    let loopTurned = false;
    setImmediate(() => {
      loopTurned = true;
    });
    await index.catchUp(catchUpInput(log));

    assert.equal(loopTurned, true, "a setImmediate queued before the catch-up ran during it");
    assert.equal(transactions() - before, Math.ceil(1_201 / INDEX_CATCH_UP_CHUNK));
    assert.deepEqual(log.reads, [{ byteOffset: 0, afterSeq: 0 }]);
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 1_201, lastByte: log.size });
    assert.equal(index.totalTurns(log.threadId), 150);
    assert.deepEqual(allTurns(index, log.threadId), await reference(log));
  });

  it("reads only the tail after the cursor", async () => {
    const index = open();
    const log = new TestLog();
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(log, 2)) });
    await index.drain();
    const cursor = index.cursor(log.threadId)!;
    log.append(...turns(log, 3, 3));

    await index.catchUp(catchUpInput(log));

    assert.deepEqual(log.reads, [{ byteOffset: cursor.lastByte, afterSeq: cursor.lastSeq }]);
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId), await reference(log));
  });

  it("does not read a thread that is up to date", async () => {
    const index = open();
    const log = new TestLog();
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(log, 1)) });
    await index.drain();
    await index.catchUp(catchUpInput(log));
    assert.deepEqual(log.reads, []);
  });

  it("re-indexes from byte 0 when the log no longer matches the cursor", async () => {
    const index = open();
    const original = new TestLog("thread-x");
    index.observe({
      threadId: original.threadId,
      ...META,
      ...original.append(created(), ...turns(original, 3))
    });
    await index.drain();

    // Same thread, rewritten: different text, so no line starts at the cursor.
    const rewritten = new TestLog("thread-x");
    rewritten.append(
      created(),
      ...liveTurn({ n: 7, prompt: "entirely different prompt" }),
      ...turns(rewritten, 30, 8)
    );

    await index.catchUp(catchUpInput(rewritten));

    const cursor = { byteOffset: original.size, afterSeq: original.lastSeq };
    assert.deepEqual(rewritten.reads, [cursor, { byteOffset: 0, afterSeq: 0 }]);
    assert.deepEqual(index.search({ q: "prompt 2 words", limit: 5 }), []);
    assert.equal(index.search({ q: "entirely different", limit: 5 }).length, 1);
    assert.deepEqual(allTurns(index, "thread-x"), await reference(rewritten));
    assert.ok(
      logger.entries.some((entry) => /re-indexing/.test(entry.message)),
      "the re-index is logged"
    );
  });

  it("re-indexes a log that got SHORTER than the index (cursor ahead of logSeq)", async () => {
    const index = open();
    const original = new TestLog("thread-y");
    index.observe({
      threadId: original.threadId,
      ...META,
      ...original.append(created(), ...turns(original, 4))
    });
    await index.drain();
    const shorter = new TestLog("thread-y");
    shorter.append(created(), ...turns(shorter, 1, 9));

    await index.catchUp(catchUpInput(shorter));

    assert.equal(index.totalTurns("thread-y"), 1);
    assert.deepEqual(index.cursor("thread-y"), { lastSeq: shorter.lastSeq, lastByte: shorter.size });
  });

  it("gives up, once, on a log it cannot read from its start", async () => {
    const index = open();
    const reads: Array<{ byteOffset: number; afterSeq: number }> = [];
    const unreadable = async (cursor: { byteOffset: number; afterSeq: number }) => {
      reads.push(cursor);
      const result: EventsFromResult = {
        events: [],
        positions: [],
        truncated: false,
        seq: 0,
        logBytes: 0,
        mismatch: true
      };
      return result;
    };
    await index.catchUp({ threadId: "t-bad", ...META, logSeq: 5, read: unreadable });
    assert.equal(reads.length, 1);
    assert.equal(index.cursor("t-bad"), null);
    assert.ok(
      logger.entries.some((entry) => /cannot read/.test(entry.message)),
      "the give-up is logged"
    );
  });

  it("fills the hole a live batch found before the boot catch-up reached its thread", async () => {
    const index = open();
    const log = new TestLog();
    log.append(created(), ...turns(log, 2));
    // The host appends and observes before the catch-up loop gets here.
    const live = log.append(...turns(log, 1, 3));
    index.observe({ threadId: log.threadId, ...META, ...live });
    await index.drain();
    assert.equal(index.cursor(log.threadId), null, "a batch past a hole is not applied");

    await index.catchUp(catchUpInput(log));
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId), await reference(log));
  });

  it("a live observe queued during a catch-up applies after it, in order", async () => {
    const index = open();
    const log = new TestLog();
    log.append(created(), ...turns(log, 2));
    const gate = createDeferred();
    // The read sees the log as it was when the catch-up asked…
    const slowRead = async (cursor: { byteOffset: number; afterSeq: number }) => {
      const result = await log.readEventsFrom(cursor);
      await gate.promise;
      return result;
    };
    const running = index.catchUp(catchUpInput(log, slowRead));
    await new Promise((resolve) => setImmediate(resolve));
    // …and the host appends meanwhile.
    index.observe({ threadId: log.threadId, ...META, ...log.append(...turns(log, 1, 3)) });
    gate.resolve();
    await running;
    await index.drain();

    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId), await reference(log));
  });
});

describe("thread index: deleteThread", () => {
  it("deletes the rows at once and drops what was queued or in flight for the thread", async () => {
    const index = open();
    const log = new TestLog();
    const other = new TestLog("other");
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(log, 2)) });
    index.observe({ threadId: other.threadId, ...META, ...other.append(created(), ...turns(other, 1)) });
    await index.drain();

    index.observe({ threadId: log.threadId, ...META, ...log.append(...turns(log, 1, 3)) });
    index.deleteThread(log.threadId);
    assert.equal(index.cursor(log.threadId), null);
    await index.drain();
    assert.equal(index.cursor(log.threadId), null, "the queued batch was dropped");
    assert.equal(index.totalTurns(log.threadId), 0);
    assert.deepEqual(
      index.search({ q: "words", limit: 10 }).map((hit) => hit.threadId),
      ["other"]
    );

    const gate = createDeferred();
    const fresh = new TestLog("in-flight");
    fresh.append(created(), ...turns(fresh, 2));
    const running = index.catchUp(
      catchUpInput(fresh, async (cursor) => {
        await gate.promise;
        return fresh.readEventsFrom(cursor);
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    index.deleteThread(fresh.threadId);
    gate.resolve();
    await running;
    assert.equal(index.cursor(fresh.threadId), null, "a catch-up in flight stops");
  });
});

describe("thread index: failures", () => {
  it("a driver error rolls its batch back without poisoning later ones; catch-up repairs the hole", async () => {
    const { driver } = instrumentedDriver({ sql: /INSERT INTO messages_fts/, times: 1 });
    const index = open({ driver });
    const log = new TestLog();
    index.observe({ threadId: log.threadId, ...META, ...log.append(created()) });
    await index.drain();

    index.observe({ threadId: log.threadId, ...META, ...log.append(...turns(log, 1)) });
    await index.drain();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 1, lastByte: log.at(2).byteOffset });
    assert.ok(
      logger.entries.some((entry) => entry.level === "warn" && /write failed/.test(entry.message)),
      "the failed write is logged"
    );

    // The next live batch finds the hole the failed one left…
    index.observe({ threadId: log.threadId, ...META, ...log.append(...turns(log, 1, 2)) });
    await index.drain();
    assert.equal(index.cursor(log.threadId)!.lastSeq, 1);

    // …and the catch-up fills it: the writer is healthy again.
    await index.catchUp(catchUpInput(log));
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId), await reference(log));
    assert.equal(index.search({ q: "prompt 1", limit: 5 }).length, 1);
  });

  it("a turn not started yet survives a failed write: the catch-up adopts it at its prompt", async () => {
    const { driver, failNext } = instrumentedDriver();
    const index = open({ driver });
    const log = new TestLog();
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(log, 1)) });
    const request = log.append(userMessage("u2", "prompt 2 words"), turnStart("u2"));
    const promptSeq = request.events[0]!.seq;
    index.observe({ threadId: log.threadId, ...META, ...request });
    await index.drain();

    // The adoption's batch fails and rolls back, and the thread's memory —
    // the only place the pending turn lived — is dropped with it.
    failNext(/INSERT INTO messages_fts/, 1);
    index.observe({
      threadId: log.threadId,
      ...META,
      ...log.append(session("running", "t2"), done("a2", "t2", "answer 2 words"))
    });
    await index.drain();
    assert.equal(index.cursor(log.threadId)!.lastSeq, promptSeq + 1, "rolled back");

    // The next batch finds the hole; the catch-up re-feeds from the cursor,
    // on memory rebuilt from the rows.
    index.observe({
      threadId: log.threadId,
      ...META,
      ...log.append(session("ready", null, "t2"), checkpoint("t2", 2))
    });
    await index.drain();
    await index.catchUp(catchUpInput(log));

    const first = index.turnByOrdinal(log.threadId, 1)!;
    const second = index.turnByOrdinal(log.threadId, 2)!;
    assert.equal(second.turnId, "t2");
    assert.equal(second.userMessageId, "u2", "adopted, not minted at the session-set");
    assert.deepEqual([second.firstSeq, second.firstByte], [promptSeq, log.at(promptSeq).byteOffset]);
    assert.equal(first.endByte, log.at(promptSeq).byteOffset, "turn 1 stops at turn 2's prompt");
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId), await reference(log));
  });

  it("never throws out of observe, even for a malformed batch", async () => {
    const index = open();
    const log = new TestLog();
    const batch = log.append(created(), done("m1", null, "hello"));
    assert.doesNotThrow(() =>
      index.observe({ threadId: log.threadId, ...META, events: batch.events, positions: [] })
    );
    await index.drain();
    assert.equal(index.cursor(log.threadId), null);
    index.observe({ threadId: log.threadId, ...META, ...batch });
    await index.drain();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 2, lastByte: log.size });
  });
});

describe("thread index: stop", () => {
  it("ends a catch-up at its next chunk boundary, applies what was queued before, then closes", async () => {
    const { driver, transactions, commits } = instrumentedDriver();
    const index = open({ driver });
    const log = new TestLog();
    log.append(created(), ...turns(log, 150)); // 1 201 events: three chunks
    const queued = new TestLog("queued");
    const late = new TestLog("late");

    const firstChunk = commits(1);
    const before = transactions();
    const running = index.catchUp(catchUpInput(log));
    // Chunk one is committed and the catch-up is parked on its loop yield.
    await firstChunk;
    index.observe({ threadId: queued.threadId, ...META, ...queued.append(created(), ...turns(queued, 1)) });
    const stopped = index.stop();
    assert.equal(index.available, false, "unavailable at once");
    index.observe({ threadId: late.threadId, ...META, ...late.append(created()) });
    await stopped;
    await running;

    assert.equal(transactions() - before, 2, "chunk one, and the observe queued before the stop");
    assert.equal(index.available, false);
    assert.equal(index.cursor(log.threadId), null);
    assert.equal(index.totalTurns(log.threadId), 0);
    assert.deepEqual(index.search({ q: "words", limit: 5 }), []);
    await index.stop();
    await index.drain();

    // The next boot finds the catch-up's cursor behind the log, and finishes it.
    const next = open();
    assert.deepEqual(next.cursor(log.threadId), {
      lastSeq: INDEX_CATCH_UP_CHUNK,
      lastByte: log.at(INDEX_CATCH_UP_CHUNK + 1).byteOffset
    });
    assert.deepEqual(next.cursor(queued.threadId), { lastSeq: queued.lastSeq, lastByte: queued.size });
    assert.equal(next.cursor(late.threadId), null, "an observe after the stop was refused");
    await next.catchUp(catchUpInput(log));
    assert.deepEqual(log.reads, [
      { byteOffset: 0, afterSeq: 0 },
      { byteOffset: log.at(INDEX_CATCH_UP_CHUNK + 1).byteOffset, afterSeq: INDEX_CATCH_UP_CHUNK }
    ]);
    assert.deepEqual(next.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(next, log.threadId), await reference(log));
  });

  it("a catch-up still reading when the stop lands applies nothing of what it read", async () => {
    const index = open();
    const log = new TestLog();
    log.append(created(), ...turns(log, 2));
    const reading = createDeferred();
    const gate = createDeferred();
    const running = index.catchUp(
      catchUpInput(log, async (cursor) => {
        reading.resolve();
        await gate.promise;
        return log.readEventsFrom(cursor);
      })
    );
    await reading.promise;
    const stopped = index.stop();
    gate.resolve();
    await stopped;
    await running;

    assert.equal(open().cursor(log.threadId), null);
  });

  it("still deletes a thread's rows while it stops", async () => {
    const index = open();
    const log = new TestLog();
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(log, 1)) });
    await index.drain();
    const reading = createDeferred();
    const gate = createDeferred();
    const other = new TestLog("other");
    other.append(created());
    // A catch-up in flight holds the stop open.
    void index.catchUp(
      catchUpInput(other, async (cursor) => {
        reading.resolve();
        await gate.promise;
        return other.readEventsFrom(cursor);
      })
    );
    await reading.promise;
    const stopped = index.stop();
    index.deleteThread(log.threadId);
    gate.resolve();
    await stopped;

    const next = open();
    assert.equal(next.cursor(log.threadId), null, "no catch-up ever visits a deleted thread");
    assert.equal(next.totalTurns(log.threadId), 0);
  });
});

describe("thread index: unavailable", () => {
  for (const [name, make] of [
    ["driver: null", () => open({ driver: null })],
    ["createUnavailableThreadIndex()", () => createUnavailableThreadIndex()],
    [
      "after close()",
      () => {
        const index = open();
        index.close();
        return index;
      }
    ],
    [
      "after stop()",
      async () => {
        const index = open();
        await index.stop();
        return index;
      }
    ]
  ] as const) {
    it(`is inert: ${name}`, async () => {
      const index = await make();
      const log = new TestLog();
      log.append(created(), ...turns(log, 2));
      assert.equal(index.available, false);

      index.observe({ threadId: log.threadId, ...META, ...log.all() });
      await index.drain();
      await index.catchUp(catchUpInput(log));
      assert.deepEqual(log.reads, [], "a catch-up reads nothing");
      index.deleteThread(log.threadId);

      assert.equal(index.cursor(log.threadId), null);
      assert.equal(index.totalTurns(log.threadId), 0);
      assert.equal(index.turnByOrdinal(log.threadId, 1), null);
      assert.equal(index.turnById(log.threadId, "t1"), null);
      assert.deepEqual(index.turnsBefore(log.threadId, { before: null, limit: 5 }), []);
      assert.deepEqual(index.search({ q: "prompt", limit: 5 }), []);
      const probe: IndexedTurn = {
        turnId: "t1",
        ordinal: 1,
        userMessageId: null,
        requestedAt: "",
        startedAt: null,
        completedAt: null,
        firstSeq: 1,
        lastSeq: 1,
        firstByte: 0,
        endByte: 1
      };
      assert.equal(index.rewindable(log.threadId, probe), false);
      assert.equal(index.itemPosition(log.threadId, "x"), null);
      assert.equal(index.itemPositionBySeq(log.threadId, 3), null);
      assert.equal(index.hasItemsBefore(log.threadId, 100), false);
      assert.equal(index.activitySeqBefore(log.threadId, { beforeSeq: 100, count: 400 }), null);
      assert.deepEqual(index.turnsInSeqRange(log.threadId, { fromSeq: 0, toSeq: 100 }), []);
      assert.equal(index.turnOfSeq(log.threadId, 5), null);
      assert.equal(index.eventPositionBySeq(log.threadId, 2), null);
      assert.equal(index.messageSpan(log.threadId, "u1"), null);
      assert.deepEqual(index.messagesSpanning(log.threadId, 5), []);
      await index.stop();
      index.close();
    });
  }

  it("says why it is disabled", () => {
    open({ driver: null });
    assert.ok(
      logger.entries.some((entry) => entry.level === "warn" && /disabled/.test(entry.message)),
      "the reason is logged"
    );
  });
});
