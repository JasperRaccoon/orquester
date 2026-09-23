/**
 * Byte positions in `events.ndjson` (thread-index spec, A2 + C): what `append`
 * reports for every line it writes, and the ranged reads that trust those
 * positions later — `readEventsFrom` (a fold snapshot's or the index's
 * cursor) and `readEventRange` (a history page).
 *
 * Offsets are BYTES, so the fixtures carry multi-byte UTF-8 text on purpose:
 * an implementation that counts UTF-16 code units must fail here. Expected
 * positions are found by scanning the file on disk for newline bytes, never by
 * asking the store.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createFakeThreadStore } from "../orchestration/testing/fakes.ts";
import type { AppendableDomainEvent, Clock, IdGen, ThreadStore } from "../services.ts";
import { truncateTornTail } from "./files.ts";
import { createThreadStore } from "./index.ts";

const eventsPathOf = (root: string, id: string): string =>
  path.join(root, "threads", id, "events.ndjson");

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "orq-agent-store-pos-"));
}

function fixedClock(iso = "2026-01-01T00:00:00.000Z"): Clock {
  return { now: () => new Date(iso), nowIso: () => iso };
}

function countingIds(): IdGen {
  let n = 0;
  return {
    eventId: () => `e${++n}`,
    messageId: (prefix) => `${prefix}:${++n}`,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
  };
}

function created(threadId = "t1"): AppendableDomainEvent {
  return {
    eventId: "e-created",
    threadId,
    type: "thread.created",
    payload: {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "New thread",
      adapter: "claude",
      refId: "claude",
      accountId: "acc-1",
      home: "account",
      modelSelection: { model: "sonnet" },
      runtimeMode: "approval-required"
    },
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as AppendableDomainEvent;
}

function say(threadId: string, id: string, text: string): AppendableDomainEvent {
  return {
    eventId: `e-${id}`,
    threadId,
    type: "thread.message-sent",
    payload: { messageId: id, role: "user", text, streaming: false, turnId: null },
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as AppendableDomainEvent;
}

interface DiskLine {
  seq: number;
  byteOffset: number;
  byteLength: number;
}

/**
 * Every line of the file, located by scanning for the newline BYTE — the
 * store's own arithmetic is what is under test, so it is not used here.
 */
async function linesOnDisk(filePath: string): Promise<DiskLine[]> {
  const bytes = await fs.readFile(filePath);
  const lines: DiskLine[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      const text = bytes.subarray(start, index).toString("utf8");
      lines.push({
        seq: (JSON.parse(text) as { seq: number }).seq,
        byteOffset: start,
        byteLength: index - start + 1
      });
      start = index + 1;
    }
  }
  return lines;
}

async function sizeOf(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).size;
}

function messageIds(events: ReadonlyArray<{ type: string; payload: unknown }>): string[] {
  return events.map((event) =>
    event.type === "thread.message-sent"
      ? (event.payload as { messageId: string }).messageId
      : event.type
  );
}

// --- append ----------------------------------------------------------------

test("append reports each line's byte offset and length, counted in UTF-8 bytes", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });

  const result = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñandú 🎉")]
  });

  const eventsPath = eventsPathOf(rootDir, "t1");
  assert.deepEqual(result.positions, await linesOnDisk(eventsPath));
  assert.equal(result.logBytes, await sizeOf(eventsPath));

  // The fixture really is multi-byte: "ñ" and "ú" cost one byte more than
  // their UTF-16 length, "🎉" two more — so bytes and chars differ by 4.
  const second = result.positions[1]!;
  const line = (await fs.readFile(eventsPath))
    .subarray(second.byteOffset, second.byteOffset + second.byteLength)
    .toString("utf8");
  assert.equal(second.byteLength - line.length, 4);
});

test("a second append continues the offsets where the first one ended", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });

  const first = await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });
  const second = await store.append({
    threadId: "t1",
    events: [say("t1", "m2", "🎉🎉"), say("t1", "m3", "plain")]
  });

  assert.equal(second.positions[0]!.byteOffset, first.logBytes);
  const eventsPath = eventsPathOf(rootDir, "t1");
  assert.deepEqual([...first.positions, ...second.positions], await linesOnDisk(eventsPath));
  assert.equal(second.logBytes, await sizeOf(eventsPath));
});

test("a reopened store continues from the log's length on disk, not from zero", async () => {
  const rootDir = await tempRoot();
  const first = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const before = await first.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñandú")]
  });
  await first.drain();

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const after = await reopened.append({ threadId: "t1", events: [say("t1", "m2", "🎉")] });

  const eventsPath = eventsPathOf(rootDir, "t1");
  assert.deepEqual([...before.positions, ...after.positions], await linesOnDisk(eventsPath));
  assert.equal(after.logBytes, await sizeOf(eventsPath));
});

test("an append with no events reports no positions and the current length", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const first = await store.append({ threadId: "t1", events: [created()] });

  const empty = await store.append({
    threadId: "t1",
    events: [],
    receipt: {
      commandId: "cmd-1",
      threadId: "t1",
      status: "rejected",
      acceptedAt: "2026-01-01T00:00:00.000Z"
    }
  });

  assert.deepEqual(empty.positions, []);
  assert.equal(empty.logBytes, first.logBytes);
  assert.equal(empty.logBytes, await sizeOf(eventsPathOf(rootDir, "t1")));
});

test("an append whose fsync fails leaves no trace, so the next one starts clean", async () => {
  // A failed `sync()` leaves the payload in the file although the caller was
  // told the append failed. Kept, it would be a batch nobody acknowledged —
  // and a PARTIAL write would be a torn fragment the next batch is glued onto.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const first = await store.append({ threadId: "t1", events: [created()] });

  const probe = await fs.open(path.join(rootDir, "probe"), "w");
  const fileHandleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const realSync = fileHandleProto.sync;
  fileHandleProto.sync = async () => {
    throw Object.assign(new Error("EIO: fsync failed"), { code: "EIO" });
  };
  try {
    await assert.rejects(
      store.append({ threadId: "t1", events: [say("t1", "m1", "ñandú")] }),
      /EIO/
    );
  } finally {
    fileHandleProto.sync = realSync;
  }

  const eventsPath = eventsPathOf(rootDir, "t1");
  assert.equal(await sizeOf(eventsPath), first.logBytes, "the failed batch was rolled back");

  const next = await store.append({ threadId: "t1", events: [say("t1", "m2", "🎉")] });
  assert.equal(next.seq, 2, "the failed batch's sequences were never handed out");
  assert.deepEqual([...first.positions, ...next.positions], await linesOnDisk(eventsPath));
  assert.equal(next.logBytes, await sizeOf(eventsPath));
  const all = await store.readAll("t1");
  assert.deepEqual(messageIds(all.events), ["thread.created", "m2"]);
  assert.equal(all.truncated, false);
});

test(
  "an append whose rollback fails too re-reads its counters from disk — no gap, no collision",
  { skip: process.getuid?.() === 0 ? "root ignores file modes" : false },
  async () => {
    // The double fault: the write lands, the fsync fails, and the compensating
    // truncate fails as well (here: the file turned read-only in between). The
    // caller is told the append failed, but the line IS on disk. Minting its
    // sequence again would be a collision `readLog` reads as corruption from
    // that line on; keeping the advanced counter would leave a hole the index
    // refuses to bridge until the next boot. The store must take the disk's
    // word instead, and say so.
    const rootDir = await tempRoot();
    const warnings: Array<{ message: string; detail: unknown }> = [];
    const store = createThreadStore({
      rootDir,
      clock: fixedClock(),
      idGen: countingIds(),
      logger: { warn: (message, detail) => warnings.push({ message, detail }) }
    });
    const first = await store.append({ threadId: "t1", events: [created()] });
    const eventsPath = eventsPathOf(rootDir, "t1");

    const probe = await fs.open(path.join(rootDir, "probe"), "w");
    const fileHandleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const realSync = fileHandleProto.sync;
    fileHandleProto.sync = async () => {
      await fs.chmod(eventsPath, 0o400);
      throw Object.assign(new Error("EIO: fsync failed"), { code: "EIO" });
    };
    try {
      await assert.rejects(
        store.append({ threadId: "t1", events: [say("t1", "m1", "landed anyway")] }),
        /EIO/
      );
    } finally {
      fileHandleProto.sync = realSync;
      await fs.chmod(eventsPath, 0o600);
    }

    const onDisk = await linesOnDisk(eventsPath);
    assert.equal(onDisk.length, 2, "the failed batch stayed on disk: nothing could roll it back");
    assert.equal(warnings.length, 1, "the double fault is reported, once");
    assert.match(warnings[0]!.message, /rollback failed too/);
    assert.equal((warnings[0]!.detail as { seq: number }).seq, 2);
    assert.equal(await store.lastSeq("t1"), 2, "the counter is what the last line on disk says");
    assert.equal(await store.logLength("t1"), await sizeOf(eventsPath));

    const next = await store.append({ threadId: "t1", events: [say("t1", "m2", "🎉")] });
    assert.equal(next.seq, 3, "neither re-minted nor skipped");
    assert.deepEqual([...first.positions, ...onDisk.slice(1), ...next.positions], await linesOnDisk(eventsPath));
    const all = await store.readAll("t1");
    assert.deepEqual(messageIds(all.events), ["thread.created", "m1", "m2"]);
    assert.equal(all.truncated, false, "no collision: the log still reads to its end");
  }
);

test(
  "a fragment the rollback could not cut is cut before the next append writes — or that append writes nothing",
  { skip: process.getuid?.() === 0 ? "root ignores file modes" : false },
  async () => {
    // A PARTIAL write, then a rollback that cannot truncate: a torn fragment
    // stays at the end of the log. Written straight after, the next batch's
    // first line would be glued onto it — one malformed line `readAll` stops
    // at forever, taking every later event with it.
    const rootDir = await tempRoot();
    const warnings: string[] = [];
    const store = createThreadStore({
      rootDir,
      clock: fixedClock(),
      idGen: countingIds(),
      logger: { warn: (message) => warnings.push(message) }
    });
    const first = await store.append({ threadId: "t1", events: [created()] });
    const eventsPath = eventsPathOf(rootDir, "t1");

    const probe = await fs.open(path.join(rootDir, "probe"), "w");
    const fileHandleProto = Object.getPrototypeOf(probe) as {
      writeFile: (data: string, encoding?: BufferEncoding) => Promise<void>;
    };
    await probe.close();
    const realWriteFile = fileHandleProto.writeFile;
    fileHandleProto.writeFile = async function (this: unknown, data: string) {
      await realWriteFile.call(this, data.slice(0, 12), "utf8");
      await fs.chmod(eventsPath, 0o400);
      throw Object.assign(new Error("EIO: write failed"), { code: "EIO" });
    };
    try {
      await assert.rejects(store.append({ threadId: "t1", events: [say("t1", "m1", "cut short")] }), /EIO/);
    } finally {
      fileHandleProto.writeFile = realWriteFile;
    }
    assert.equal(await sizeOf(eventsPath), first.logBytes + 12, "the fragment could not be cut");
    assert.equal(warnings.length, 1);
    assert.equal(await store.lastSeq("t1"), 1, "the counter is the last COMPLETE line's");

    // Still unwritable: the next append cannot cut the fragment, so it must
    // not write either — no sequence minted, not a byte appended.
    await assert.rejects(store.append({ threadId: "t1", events: [say("t1", "m2", "refused")] }), /EACCES|EPERM/);
    assert.equal(await sizeOf(eventsPath), first.logBytes + 12, "nothing was glued onto the fragment");
    assert.equal(await store.lastSeq("t1"), 1);

    await fs.chmod(eventsPath, 0o600);
    const next = await store.append({ threadId: "t1", events: [say("t1", "m3", "ñandú 🎉")] });
    assert.equal(next.seq, 2, "the failed attempts minted nothing");
    assert.deepEqual([...first.positions, ...next.positions], await linesOnDisk(eventsPath));
    assert.equal(next.logBytes, await sizeOf(eventsPath));
    const all = await store.readAll("t1");
    assert.deepEqual(messageIds(all.events), ["thread.created", "m3"]);
    assert.equal(all.truncated, false, "the log reads cleanly to its end");
  }
);

// --- readEventsFrom ----------------------------------------------------------

test("readEventsFrom returns exactly the events after a recorded cursor, with their positions", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const first = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñandú")]
  });
  const second = await store.append({
    threadId: "t1",
    events: [say("t1", "m2", "🎉"), say("t1", "m3", "plain")]
  });
  await store.drain();

  // A fresh instance, as a restarted host reads it.
  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const tail = await reopened.readEventsFrom("t1", {
    byteOffset: first.logBytes,
    afterSeq: first.seq
  });
  assert.equal(tail.mismatch, false);
  assert.equal(tail.truncated, false);
  assert.deepEqual(messageIds(tail.events), ["m2", "m3"]);
  assert.deepEqual(tail.positions, second.positions);
  assert.equal(tail.seq, 4);
  assert.equal(tail.logBytes, second.logBytes);

  // From the top, it is the whole log.
  const whole = await reopened.readEventsFrom("t1", { byteOffset: 0, afterSeq: 0 });
  assert.equal(whole.mismatch, false);
  assert.deepEqual(messageIds(whole.events), ["thread.created", "m1", "m2", "m3"]);
  assert.deepEqual(whole.positions, [...first.positions, ...second.positions]);
});

test("readEventsFrom at the end of the log is an empty tail, not a mismatch", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });

  assert.deepEqual(
    await store.readEventsFrom("t1", { byteOffset: appended.logBytes, afterSeq: appended.seq }),
    {
      events: [],
      positions: [],
      truncated: false,
      seq: 2,
      logBytes: appended.logBytes,
      mismatch: false
    }
  );
  // A thread with no log yet: the empty cursor is not stale.
  assert.deepEqual(await store.readEventsFrom("t9", { byteOffset: 0, afterSeq: 0 }), {
    events: [],
    positions: [],
    truncated: false,
    seq: 0,
    logBytes: 0,
    mismatch: false
  });
});

test("a cursor whose line does not carry afterSeq + 1 is a mismatch", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const first = await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });
  await store.append({ threadId: "t1", events: [say("t1", "m2", "🎉")] });

  // The line at `first.logBytes` is seq 3: only afterSeq 2 matches it.
  for (const afterSeq of [1, 3]) {
    const tail = await store.readEventsFrom("t1", { byteOffset: first.logBytes, afterSeq });
    assert.equal(tail.mismatch, true, `afterSeq ${afterSeq}`);
    assert.deepEqual(tail.events, []);
    assert.deepEqual(tail.positions, []);
  }
});

test("a log shorter than the cursor's offset is a mismatch", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });

  const past = await store.readEventsFrom("t1", {
    byteOffset: appended.logBytes + 1,
    afterSeq: appended.seq
  });
  assert.equal(past.mismatch, true);
  assert.deepEqual(past.events, []);

  // No log at all, but a cursor that remembers one.
  assert.equal((await store.readEventsFrom("t9", { byteOffset: 10, afterSeq: 2 })).mismatch, true);
});

test("a cursor into a rewritten log is a mismatch, never a misread", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const old = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "a much longer first message ñandú 🎉"), say("t1", "m2", "x")]
  });
  const cursor = { byteOffset: old.positions[2]!.byteOffset, afterSeq: 2 };

  // The same thread id, a different log.
  await store.deleteThread("t1");
  await store.append({
    threadId: "t1",
    events: [
      created(),
      say("t1", "n1", "short"),
      say("t1", "n2", "and"),
      say("t1", "n3", "a few more lines")
    ]
  });
  const eventsPath = eventsPathOf(rootDir, "t1");
  assert.ok(
    !(await linesOnDisk(eventsPath)).some((line) => line.byteOffset === cursor.byteOffset),
    "precondition: the old offset lands inside a line of the new log"
  );

  const tail = await store.readEventsFrom("t1", cursor);
  assert.equal(tail.mismatch, true);
  assert.deepEqual(tail.events, []);
});

test("an offset inside a line is a mismatch", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñ"), say("t1", "m2", "🎉")]
  });

  const tail = await store.readEventsFrom("t1", {
    byteOffset: appended.positions[1]!.byteOffset + 1,
    afterSeq: 1
  });
  assert.equal(tail.mismatch, true);
  assert.deepEqual(tail.events, []);
});

test("a cursor that is not a byte offset at all is a mismatch", async () => {
  // Position -1 means "the file's current position" to `read(2)`, which would
  // quietly read from the top and mint positions off by one.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });

  for (const cursor of [
    { byteOffset: -1, afterSeq: 0 },
    { byteOffset: 0.5, afterSeq: 0 },
    { byteOffset: Number.NaN, afterSeq: 0 },
    { byteOffset: 0, afterSeq: -1 },
    { byteOffset: 0, afterSeq: 0.5 }
  ]) {
    const tail = await store.readEventsFrom("t1", cursor);
    assert.equal(tail.mismatch, true, JSON.stringify(cursor));
    assert.deepEqual(tail.events, []);
  }
});

test("readEventsFrom stops at a malformed line, with logBytes past the last good one", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñ"), say("t1", "m2", "🎉"), say("t1", "m3", "z")]
  });
  await store.drain();

  // Corrupt seq 3's line in place, newline kept, so nothing else moves.
  const eventsPath = eventsPathOf(rootDir, "t1");
  const bytes = await fs.readFile(eventsPath);
  const third = appended.positions[2]!;
  bytes.fill(0x78, third.byteOffset, third.byteOffset + third.byteLength - 1);
  await fs.writeFile(eventsPath, bytes);

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const tail = await reopened.readEventsFrom("t1", {
    byteOffset: appended.positions[1]!.byteOffset,
    afterSeq: 1
  });
  assert.equal(tail.mismatch, false);
  assert.equal(tail.truncated, true);
  assert.deepEqual(messageIds(tail.events), ["m1"]);
  assert.deepEqual(tail.positions, [appended.positions[1]]);
  assert.equal(tail.seq, 2);
  assert.equal(tail.logBytes, third.byteOffset);
});

test("a write seen mid-way is not an event: truncated, and logBytes stops before it", async () => {
  // A fragment present at load is cut (see below); one that appears AFTER it
  // is a write still in flight, and a read must not mistake it for a line.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñ"), say("t1", "m2", "🎉")]
  });
  await store.drain();

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal(await reopened.lastSeq("t1"), 3, "loaded before the write begins");
  await fs.appendFile(eventsPathOf(rootDir, "t1"), '{"seq":4,"eventId":"e4","thr');
  const tail = await reopened.readEventsFrom("t1", {
    byteOffset: appended.positions[1]!.byteOffset,
    afterSeq: 1
  });
  assert.equal(tail.mismatch, false);
  assert.equal(tail.truncated, true);
  assert.deepEqual(messageIds(tail.events), ["m1", "m2"]);
  assert.equal(tail.seq, 3);
  assert.equal(tail.logBytes, appended.logBytes);

  // A cursor sitting right before the in-flight write has nothing to read yet.
  const atFragment = await reopened.readEventsFrom("t1", {
    byteOffset: appended.logBytes,
    afterSeq: appended.seq
  });
  assert.equal(atFragment.mismatch, false);
  assert.equal(atFragment.truncated, true);
  assert.deepEqual(atFragment.events, []);
  assert.equal(atFragment.seq, appended.seq);
  assert.equal(atFragment.logBytes, appended.logBytes);
});

// --- readEventRange ----------------------------------------------------------

test("readEventRange returns exactly the events whose positions it was given", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const first = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñandú"), say("t1", "m2", "🎉")]
  });
  const second = await store.append({
    threadId: "t1",
    events: [say("t1", "m3", "plain"), say("t1", "m4", "más 🎉"), say("t1", "m5", "end")]
  });
  await store.drain();

  // seq 3..5: a window that spans the two appends.
  const from = first.positions[2]!;
  const to = second.positions[1]!;
  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const range = await reopened.readEventRange("t1", {
    fromByte: from.byteOffset,
    toByte: to.byteOffset + to.byteLength
  });
  assert.equal(range.truncated, false);
  assert.deepEqual(messageIds(range.events), ["m2", "m3", "m4"]);
  assert.deepEqual(
    range.events.map((event) => event.seq),
    [3, 4, 5]
  );
});

test("a range that starts inside a line is truncated, never a misread", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñ"), say("t1", "m2", "🎉")]
  });

  const range = await store.readEventRange("t1", {
    fromByte: appended.positions[1]!.byteOffset + 1,
    toByte: appended.logBytes
  });
  assert.equal(range.truncated, true);
  assert.deepEqual(range.events, []);
});

test("a range that ends inside a line drops that line and is truncated", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñ"), say("t1", "m2", "🎉")]
  });

  const range = await store.readEventRange("t1", {
    fromByte: 0,
    toByte: appended.logBytes - 1
  });
  assert.equal(range.truncated, true);
  assert.deepEqual(messageIds(range.events), ["thread.created", "m1"]);
});

test("a range past the end of the log reads what is there and says it is short", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });

  const range = await store.readEventRange("t1", {
    fromByte: appended.positions[1]!.byteOffset,
    toByte: appended.logBytes + 500
  });
  assert.equal(range.truncated, true);
  assert.deepEqual(messageIds(range.events), ["m1"]);

  assert.deepEqual(await store.readEventRange("t9", { fromByte: 0, toByte: 10 }), {
    events: [],
    truncated: true
  });
});

test("an empty range is empty; an unusable one is refused before any read", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });

  assert.deepEqual(
    await store.readEventRange("t1", { fromByte: appended.logBytes, toByte: appended.logBytes }),
    { events: [], truncated: false }
  );
  for (const range of [
    { fromByte: -1, toByte: 10 },
    { fromByte: 0.5, toByte: 10 },
    { fromByte: 10, toByte: 5 },
    { fromByte: 0, toByte: Number.NaN }
  ]) {
    await assert.rejects(store.readEventRange("t1", range), RangeError, JSON.stringify(range));
  }
});

// --- lastSeq / logLength -------------------------------------------------------

test("lastSeq and logLength answer from the log's last line and length, not a full read", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await store.append({
    threadId: "t1",
    events: [created(), say("t1", "m1", "ñ"), say("t1", "m2", "🎉"), say("t1", "m3", "z")]
  });
  assert.equal(await store.lastSeq("t1"), appended.seq);
  assert.equal(await store.logLength("t1"), appended.logBytes);
  await store.drain();

  // Corrupt seq 2 in place: a full read stops at seq 1, the last line is fine.
  const eventsPath = eventsPathOf(rootDir, "t1");
  const bytes = await fs.readFile(eventsPath);
  const secondLine = appended.positions[1]!;
  bytes.fill(0x78, secondLine.byteOffset, secondLine.byteOffset + secondLine.byteLength - 1);
  await fs.writeFile(eventsPath, bytes);

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal(await reopened.lastSeq("t1"), 4);
  assert.equal(await reopened.logLength("t1"), await sizeOf(eventsPath));
  assert.equal((await reopened.readAll("t1")).seq, 1, "precondition: a full read stops early");

  assert.equal(await reopened.lastSeq("t9"), 0);
  assert.equal(await reopened.logLength("t9"), 0);
});

// --- the contract, real store and fake alike -----------------------------------

/**
 * Everything a consumer may rely on using ONLY the positions a store reported
 * — never real byte counts. The orchestrator and the index are tested against
 * the fake, so the fake must keep exactly this contract: absolute offsets are
 * its own business, the relations between them are not.
 */
async function positionsContract(store: ThreadStore): Promise<void> {
  const first = await store.append({
    threadId: "c1",
    events: [created("c1"), say("c1", "m1", "ñandú")]
  });
  const second = await store.append({
    threadId: "c1",
    events: [say("c1", "m2", "🎉"), say("c1", "m3", "z")]
  });

  // Contiguous lines from byte 0, each append continuing the last.
  const all = [...first.positions, ...second.positions];
  assert.deepEqual(all.map((position) => position.seq), [1, 2, 3, 4]);
  assert.equal(all[0]!.byteOffset, 0);
  for (let index = 1; index < all.length; index += 1) {
    const previous = all[index - 1]!;
    assert.equal(all[index]!.byteOffset, previous.byteOffset + previous.byteLength);
  }
  assert.equal(first.logBytes, second.positions[0]!.byteOffset);
  const last = all[all.length - 1]!;
  assert.equal(second.logBytes, last.byteOffset + last.byteLength);

  // A recorded cursor resumes exactly where it was taken.
  const tail = await store.readEventsFrom("c1", {
    byteOffset: first.logBytes,
    afterSeq: first.seq
  });
  assert.deepEqual(
    { ...tail, events: messageIds(tail.events) },
    {
      events: ["m2", "m3"],
      positions: second.positions,
      truncated: false,
      seq: 4,
      logBytes: second.logBytes,
      mismatch: false
    }
  );
  const atEnd = await store.readEventsFrom("c1", {
    byteOffset: second.logBytes,
    afterSeq: second.seq
  });
  assert.equal(atEnd.mismatch, false);
  assert.deepEqual(atEnd.events, []);
  assert.equal(atEnd.seq, second.seq);
  assert.equal(atEnd.logBytes, second.logBytes);

  // Stale cursors: the wrong seq, past the end, inside a line.
  for (const cursor of [
    { byteOffset: first.logBytes, afterSeq: first.seq - 1 },
    { byteOffset: second.logBytes + 1, afterSeq: second.seq },
    { byteOffset: first.positions[1]!.byteOffset + 1, afterSeq: 1 }
  ]) {
    const stale = await store.readEventsFrom("c1", cursor);
    assert.equal(stale.mismatch, true, JSON.stringify(cursor));
    assert.deepEqual(stale.events, []);
  }

  // A page is exactly the lines its recorded positions name.
  const range = await store.readEventRange("c1", {
    fromByte: all[1]!.byteOffset,
    toByte: all[2]!.byteOffset + all[2]!.byteLength
  });
  assert.deepEqual(
    { ...range, events: messageIds(range.events) },
    { events: ["m1", "m2"], truncated: false }
  );
  const cut = await store.readEventRange("c1", {
    fromByte: all[1]!.byteOffset + 1,
    toByte: second.logBytes
  });
  assert.equal(cut.truncated, true);

  assert.equal(await store.lastSeq("c1"), 4);
  assert.equal(await store.logLength("c1"), second.logBytes);
  assert.equal(await store.lastSeq("nobody"), 0);
  assert.equal(await store.logLength("nobody"), 0);
}

test("the real store keeps the positions contract", async () => {
  const rootDir = await tempRoot();
  await positionsContract(createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() }));
});

test("the fake store keeps the same positions contract", async () => {
  await positionsContract(createFakeThreadStore());
});

test("the fake reads a truncateAt cut the way the real store reads a malformed line", async () => {
  const store = createFakeThreadStore();
  const appended = await store.append({
    threadId: "c1",
    events: [created("c1"), say("c1", "m1", "ñ"), say("c1", "m2", "🎉"), say("c1", "m3", "z")]
  });
  store.truncateAt("c1", 2);

  const tail = await store.readEventsFrom("c1", { byteOffset: 0, afterSeq: 0 });
  assert.equal(tail.mismatch, false);
  assert.equal(tail.truncated, true);
  assert.deepEqual(messageIds(tail.events), ["thread.created", "m1"]);
  assert.equal(tail.seq, 2);
  assert.equal(tail.logBytes, appended.positions[2]!.byteOffset);

  // A cursor AT the unreadable line cannot be trusted.
  const atCut = await store.readEventsFrom("c1", {
    byteOffset: appended.positions[2]!.byteOffset,
    afterSeq: 2
  });
  assert.equal(atCut.mismatch, true);

  const range = await store.readEventRange("c1", { fromByte: 0, toByte: appended.logBytes });
  assert.equal(range.truncated, true);
  assert.deepEqual(messageIds(range.events), ["thread.created", "m1"]);

  // The last line and the length are still what was written.
  assert.equal(await store.lastSeq("c1"), 4);
  assert.equal(await store.logLength("c1"), appended.logBytes);
});

// --- a torn trailing fragment on load -------------------------------------------

test("a torn trailing fragment is cut on load, so the next append gets a line of its own", async () => {
  // A crash mid-write leaves a fragment with no newline. Left in place, the
  // next batch is written onto it: one glued, malformed line that `readAll`
  // stops at forever while position-based reads step over it.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñandú")] });
  await store.drain();
  const eventsPath = eventsPathOf(rootDir, "t1");
  const clean = await sizeOf(eventsPath);
  await fs.appendFile(eventsPath, '{"seq":3,"eventId":"e3","threadId":"t1","ty');

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await reopened.append({ threadId: "t1", events: [say("t1", "m2", "🎉")] });
  assert.equal(appended.seq, 3);
  assert.equal(appended.positions[0]!.byteOffset, clean, "written where the fragment began");

  const all = await reopened.readAll("t1");
  assert.equal(all.truncated, false);
  assert.deepEqual(messageIds(all.events), ["thread.created", "m1", "m2"]);
  const fromTop = await reopened.readEventsFrom("t1", { byteOffset: 0, afterSeq: 0 });
  assert.equal(fromTop.mismatch, false);
  assert.equal(fromTop.truncated, false);
  assert.deepEqual(fromTop.events, all.events);
  assert.equal(await reopened.logLength("t1"), await sizeOf(eventsPath));
  assert.deepEqual(
    (await linesOnDisk(eventsPath)).map((line) => line.seq),
    [1, 2, 3],
    "every line on disk decodes"
  );
});

test("a log that is nothing but a fragment is cut to empty", async () => {
  const rootDir = await tempRoot();
  const eventsPath = eventsPathOf(rootDir, "t1");
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  await fs.writeFile(eventsPath, '{"seq":1,"eventId":"e1","thr');

  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal(await store.lastSeq("t1"), 0);
  assert.equal(await store.logLength("t1"), 0);
  assert.equal(await sizeOf(eventsPath), 0);

  const appended = await store.append({ threadId: "t1", events: [created()] });
  assert.equal(appended.seq, 1);
  assert.equal(appended.positions[0]!.byteOffset, 0);
  assert.deepEqual(messageIds((await store.readAll("t1")).events), ["thread.created"]);
});

test("a complete line that does not decode is left alone — only a fragment is cut", async () => {
  // It ends with its newline, so it is not a write that stopped mid-way: it
  // stays the §5.1 truncated read, and the file is not touched.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });
  await store.drain();
  const eventsPath = eventsPathOf(rootDir, "t1");
  await fs.appendFile(eventsPath, '{"seq":3,"not":"an event"}\n');
  const before = await fs.readFile(eventsPath);

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal(await reopened.logLength("t1"), before.length);
  assert.deepEqual(await fs.readFile(eventsPath), before, "not a byte changed");
  const all = await reopened.readAll("t1");
  assert.equal(all.truncated, true);
  assert.deepEqual(messageIds(all.events), ["thread.created", "m1"]);
});

test("the cut walks back window by window to the last newline, however far it is", async () => {
  const dir = await tempRoot();
  const filePath = path.join(dir, "events.ndjson");
  const windowBytes = 16;

  // The last newline is many windows before the end.
  await fs.writeFile(filePath, `{"a":1}\n{"b":"ñ"}\n${"x".repeat(200)}`);
  assert.equal(await truncateTornTail(filePath, windowBytes), 19);
  assert.equal(await fs.readFile(filePath, "utf8"), '{"a":1}\n{"b":"ñ"}\n');

  // Already whole: untouched.
  assert.equal(await truncateTornTail(filePath, windowBytes), 19);
  assert.equal(await fs.readFile(filePath, "utf8"), '{"a":1}\n{"b":"ñ"}\n');

  // No newline anywhere, across several windows: empty.
  await fs.writeFile(filePath, "y".repeat(100));
  assert.equal(await truncateTornTail(filePath, windowBytes), 0);
  assert.equal(await sizeOf(filePath), 0);

  assert.equal(await truncateTornTail(path.join(dir, "missing.ndjson"), windowBytes), 0);
});
