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

import Database from "better-sqlite3";

import { createDeferred } from "../orchestration/runtime-seams.ts";
import type { EventsFromResult } from "../services.ts";
import {
  createThreadIndex,
  type IndexedTurn,
  type ThreadIndex
} from "./index.ts";
import {
  checkpoint,
  created,
  done,
  liveTurn,
  testLogger,
  session,
  TestLog,
  turnStart,
  userMessage,
  type Draft,
} from "./testing.ts";

let dir: string;
let filePath: string;
let logger: ReturnType<typeof testLogger>;
const opened: ThreadIndex[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orq-index-"));
  filePath = join(dir, "index.sqlite");
  logger = testLogger();
});

afterEach(async () => {
  for (const index of opened.splice(0)) {
    index.close();
  }
  await rm(dir, { recursive: true, force: true });
});

function open(): ThreadIndex {
  const index = createThreadIndex({
    filePath,
    logger
  });
  opened.push(index);
  return index;
}

const META = { projectPath: "/w/p", title: "T" };

function turns(count: number, from = 1): Draft[] {
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

describe("thread index: catchUp", () => {
  it("recovers every turn from a large log while yielding to the event loop", async () => {
    const index = open();
    const log = new TestLog();
    log.append(created(), ...turns(150)); // 1 201 events

    let loopTurned = false;
    setImmediate(() => {
      loopTurned = true;
    });
    await index.catchUp(catchUpInput(log));

    assert.equal(loopTurned, true, "a setImmediate queued before the catch-up ran during it");
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 1_201, lastByte: log.size });
    assert.equal(index.totalTurns(log.threadId), 150);
    assert.deepEqual(allTurns(index, log.threadId).map((turn) => turn.turnId), Array.from({ length: 150 }, (_, n) => `t${n + 1}`));
  });

  it("continues catch-up from a persisted cursor", async () => {
    const index = open();
    const log = new TestLog();
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(2)) });
    await index.drain();
    log.append(...turns(3, 3));

    await index.catchUp(catchUpInput(log));
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId).map((turn) => turn.turnId), ["t1", "t2", "t3", "t4", "t5"]);
  });

  it("re-indexes from byte 0 when the log no longer matches the cursor", async () => {
    const index = open();
    const original = new TestLog("thread-x");
    index.observe({
      threadId: original.threadId,
      ...META,
      ...original.append(created(), ...turns(3))
    });
    await index.drain();

    // Same thread, rewritten: different text, so no line starts at the cursor.
    const rewritten = new TestLog("thread-x");
    rewritten.append(
      created(),
      ...liveTurn({ n: 7, prompt: "entirely different prompt" }),
      ...turns(30, 8)
    );

    await index.catchUp(catchUpInput(rewritten));

    assert.deepEqual(index.search({ q: "prompt 2 words", limit: 5 }), []);
    assert.equal(index.search({ q: "entirely different", limit: 5 }).length, 1);
    assert.deepEqual(allTurns(index, "thread-x").map((turn) => turn.turnId), Array.from({ length: 31 }, (_, n) => `t${n + 7}`));
  });

  it("re-indexes a log that got SHORTER than the index (cursor ahead of logSeq)", async () => {
    const index = open();
    const original = new TestLog("thread-y");
    index.observe({
      threadId: original.threadId,
      ...META,
      ...original.append(created(), ...turns(4))
    });
    await index.drain();
    const shorter = new TestLog("thread-y");
    shorter.append(created(), ...turns(1, 9));

    await index.catchUp(catchUpInput(shorter));

    assert.equal(index.totalTurns("thread-y"), 1);
    assert.deepEqual(index.cursor("thread-y"), { lastSeq: shorter.lastSeq, lastByte: shorter.size });
  });

  it("leaves unreadable logs behind after catch-up returns", async () => {
    const index = open();
    const unreadable = async () => {
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
    assert.equal(index.cursor("t-bad"), null);
    assert.equal(await index.coverage("t-bad", 5), "behind");
  });

  it("fills the hole a live batch found before the boot catch-up reached its thread", async () => {
    const index = open();
    const log = new TestLog();
    log.append(created(), ...turns(2));
    // The host appends and observes before the catch-up loop gets here.
    const live = log.append(...turns(1, 3));
    index.observe({ threadId: log.threadId, ...META, ...live });
    await index.drain();
    assert.equal(index.cursor(log.threadId), null, "a batch past a hole is not applied");

    await index.catchUp(catchUpInput(log));
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId).map((turn) => turn.turnId), ["t1", "t2", "t3"]);
  });

  it("a live observe queued during a catch-up applies after it, in order", async () => {
    const index = open();
    const log = new TestLog();
    log.append(created(), ...turns(2));
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
    index.observe({ threadId: log.threadId, ...META, ...log.append(...turns(1, 3)) });
    gate.resolve();
    await running;
    await index.drain();

    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId).map((turn) => turn.turnId), ["t1", "t2", "t3"]);
  });
});

describe("thread index: deleteThread", () => {
  it("deletes the rows at once and drops what was queued or in flight for the thread", async () => {
    const index = open();
    const log = new TestLog();
    const other = new TestLog("other");
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(2)) });
    index.observe({ threadId: other.threadId, ...META, ...other.append(created(), ...turns(1)) });
    await index.drain();

    index.observe({ threadId: log.threadId, ...META, ...log.append(...turns(1, 3)) });
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
    fresh.append(created(), ...turns(2));
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
    const index = open();
    const log = new TestLog();
    index.observe({ threadId: log.threadId, ...META, ...log.append(created()) });
    await index.drain();

    const lock = new Database(filePath);
    lock.exec("BEGIN IMMEDIATE");
    index.observe({ threadId: log.threadId, ...META, ...log.append(...turns(1)) });
    await index.drain();
    lock.exec("ROLLBACK");
    lock.close();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 1, lastByte: log.at(2).byteOffset });

    // The next live batch finds the hole the failed one left…
    index.observe({ threadId: log.threadId, ...META, ...log.append(...turns(1, 2)) });
    await index.drain();
    assert.equal(index.cursor(log.threadId)!.lastSeq, 1);

    // …and the catch-up fills it: the writer is healthy again.
    await index.catchUp(catchUpInput(log));
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.deepEqual(allTurns(index, log.threadId).map((turn) => turn.turnId), ["t1", "t2"]);
    assert.equal(index.search({ q: "prompt 1", limit: 5 }).length, 1);
  });

  it("a turn not started yet survives a failed write: the catch-up adopts it at its prompt", async () => {
    const index = open();
    const log = new TestLog();
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(1)) });
    const request = log.append(userMessage("u2", "prompt 2 words"), turnStart("u2"));
    const promptSeq = request.events[0]!.seq;
    index.observe({ threadId: log.threadId, ...META, ...request });
    await index.drain();

    // The adoption's batch fails and rolls back, and the thread's memory —
    // the only place the pending turn lived — is dropped with it.
    const lock = new Database(filePath);
    lock.exec("BEGIN IMMEDIATE");
    index.observe({
      threadId: log.threadId,
      ...META,
      ...log.append(session("running", "t2"), done("a2", "t2", "answer 2 words"))
    });
    await index.drain();
    lock.exec("ROLLBACK");
    lock.close();
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
    assert.deepEqual(allTurns(index, log.threadId).map((turn) => turn.turnId), ["t1", "t2"]);
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
    const index = open();
    const log = new TestLog();
    log.append(created(), ...turns(150)); // 1 201 events: three chunks
    const queued = new TestLog("queued");
    const late = new TestLog("late");

    const running = index.catchUp(catchUpInput(log));
    // Chunk one is committed and the catch-up is parked on its loop yield.
    await new Promise((resolve) => setImmediate(resolve));
    index.observe({ threadId: queued.threadId, ...META, ...queued.append(created(), ...turns(1)) });
    const stopped = index.stop();
    assert.equal(index.available, false, "unavailable at once");
    index.observe({ threadId: late.threadId, ...META, ...late.append(created()) });
    await stopped;
    await running;
    assert.equal(index.available, false);
    assert.equal(index.cursor(log.threadId), null);
    assert.equal(index.totalTurns(log.threadId), 0);
    assert.deepEqual(index.search({ q: "words", limit: 5 }), []);
    await index.stop();
    await index.drain();

    // The next boot finds the catch-up's cursor behind the log, and finishes it.
    const next = open();
    assert.ok(next.cursor(log.threadId)!.lastSeq > 0);
    assert.ok(next.cursor(log.threadId)!.lastSeq < log.lastSeq);
    assert.deepEqual(next.cursor(queued.threadId), { lastSeq: queued.lastSeq, lastByte: queued.size });
    assert.equal(next.cursor(late.threadId), null, "an observe after the stop was refused");
    await next.catchUp(catchUpInput(log));
    assert.deepEqual(next.cursor(log.threadId), { lastSeq: log.lastSeq, lastByte: log.size });
    assert.equal(next.totalTurns(log.threadId), 150);
  });

  it("a catch-up still reading when the stop lands applies nothing of what it read", async () => {
    const index = open();
    const log = new TestLog();
    log.append(created(), ...turns(2));
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
    index.observe({ threadId: log.threadId, ...META, ...log.append(created(), ...turns(1)) });
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
