/**
 * A reconnect's `readTail(after)` reads `events.ndjson` from line `after + 1` when this process
 * appended it (`replay-cursors.ts`), and the whole log otherwise — always with the whole log's
 * answer. Bytes read are observed at the real filesystem boundary.
 */

import assert from "node:assert/strict";
import fsNative from "node:fs";
import * as fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, type TestContext } from "node:test";

import type { AppendableDomainEvent, Clock, IdGen } from "../services.ts";
import { createThreadStore } from "./index.ts";

const eventsPathOf = (root: string, id: string): string => path.join(root, "threads", id, "events.ndjson");
const roots: string[] = [];
after(async () => { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); });

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

function say(id: string, text = `message ${id} ñandú 🎉`): AppendableDomainEvent {
  return {
    eventId: `e-${id}`,
    threadId: "t1",
    type: "thread.message-sent",
    payload: { messageId: id, role: "user", text, streaming: false, turnId: null },
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as AppendableDomainEvent;
}

const ids = (events: ReadonlyArray<{ seq: number; type: string; payload: unknown }>): string[] =>
  events.map((event) => (event.type === "thread.message-sent" ? (event.payload as { messageId: string }).messageId : event.type));

/** Observe actual bytes without asking the store to report its own read cost. */
function observeReads(t: TestContext, rootDir: string) {
  let bytes = 0;
  const owns = (file: unknown) => String(file) === eventsPathOf(rootDir, "t1");
  const readFile = fsNative.promises.readFile;
  const open = fsNative.promises.open;
  t.mock.method(fsNative.promises, "readFile", (async (...args: unknown[]) => {
    const value: string | Buffer = await Reflect.apply(readFile, fsNative.promises, args);
    if (owns(args[0])) {
      bytes += Buffer.byteLength(value);
    }
    return value;
  }) as typeof fs.readFile);
  t.mock.method(fsNative.promises, "open", (async (...args: unknown[]) => {
    const handle: fs.FileHandle = await Reflect.apply(open, fsNative.promises, args);
    if (owns(args[0])) {
      const read = handle.read;
      t.mock.method(handle, "read", (async (...readArgs: unknown[]) => {
        const result = await Reflect.apply(read, handle, readArgs);
        bytes += result.bytesRead;
        return result;
      }) as typeof handle.read);
    }
    return handle;
  }) as typeof fs.open);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    get bytes() { return bytes; },
    clear() { bytes = 0; }
  };
}

/** A thread of `count` messages after its creation, appended in batches like a live turn's. */
async function seeded(t: TestContext, count: number) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-agent-replay-"));
  roots.push(rootDir);
  const reads = observeReads(t, rootDir);
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  for (let start = 0; start < count; start += 1_000) {
    const batch = Array.from({ length: Math.min(1_000, count - start) }, (_, index) => say(`m${start + index + 1}`));
    await store.append({ threadId: "t1", events: batch });
  }
  reads.clear();
  return { rootDir, store, reads };
}

test("a thread idle for the drop interval loses its cursors; reconnects then read the whole log, and its next append starts over", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-agent-replay-idle-"));
  roots.push(rootDir);
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const reads = observeReads(t, rootDir);
  const store = createThreadStore({
    rootDir,
    clock: { now: () => new Date(nowMs), nowIso: () => new Date(nowMs).toISOString() },
    idGen: countingIds()
  });
  t.after(() => store.close());
  await store.append({ threadId: "t1", events: [created(), say("m1"), say("m2")] });
  const whole = (await fs.stat(eventsPathOf(rootDir, "t1"))).size;
  reads.clear();

  nowMs += (10 * 60_000) - 1;
  assert.equal(store.dropIdleReplayCursors(), 0, "not idle long enough");
  await store.readTail("t1", 2);
  assert.ok(reads.bytes > 0 && reads.bytes < whole);

  nowMs += 1;
  assert.equal(store.dropIdleReplayCursors(), 1);
  reads.clear();
  assert.deepEqual(ids((await store.readTail("t1", 2)).events), ["m2"]);
  assert.ok(reads.bytes >= whole, "dropped: read the whole log, same answer");

  await store.append({ threadId: "t1", events: [say("m3")] });
  reads.clear();
  assert.deepEqual(ids((await store.readTail("t1", 3)).events), ["m3"]);
  assert.ok(reads.bytes > 0 && reads.bytes < whole);
});

test("a small gap is read from its line's offset, not the whole log, with the whole log's answer", async (t) => {
  const { rootDir, store, reads } = await seeded(t, 400);
  t.after(() => store.close());
  const whole = (await fs.stat(eventsPathOf(rootDir, "t1"))).size;

  const tail = await store.readTail("t1", 398);
  assert.deepEqual(ids(tail.events), ["m398", "m399", "m400"]);
  assert.deepEqual(tail.events.map((event) => event.seq), [399, 400, 401]);
  assert.equal(tail.seq, 401);
  assert.equal(tail.truncated, false);
  assert.ok(reads.bytes > 0 && reads.bytes < whole / 50, `${reads.bytes} of ${whole} bytes`);

  // Exactly what the whole read answers.
  const all = await store.readAll("t1");
  assert.deepEqual(tail.events, all.events.filter((event) => event.seq > 398));
});

test("a gap the ring does not hold — older than its capacity, or before this process appended — reads the whole log", async (t) => {
  const { rootDir, store, reads } = await seeded(t, 1_000 + 50);
  t.after(() => store.close());
  const tail = await store.readTail("t1", 10);
  assert.equal(tail.events.length, 1_000 + 50 + 1 - 10);
  assert.equal(tail.events[0]?.seq, 11);
  assert.ok(reads.bytes >= (await fs.stat(eventsPathOf(rootDir, "t1"))).size);

  // A restarted host (a fresh store on the same log): empty ring, whole read, same answer.
  await store.close();
  const again = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  t.after(() => again.close());
  reads.clear();
  const replay = await again.readTail("t1", 1040);
  assert.deepEqual(replay.events.map((event) => event.seq), [1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050, 1051]);
  assert.ok(reads.bytes >= (await fs.stat(eventsPathOf(rootDir, "t1"))).size);
  // Its next append fills the ring again.
  await again.append({ threadId: "t1", events: [say("late")] });
  reads.clear();
  assert.deepEqual(ids((await again.readTail("t1", 1051)).events), ["late"]);
  assert.ok(reads.bytes > 0 && reads.bytes < (await fs.stat(eventsPathOf(rootDir, "t1"))).size);
});

test("an offset that no longer holds its line (the log rewritten under it) falls back to the whole log, correctly", async (t) => {
  const { rootDir, store, reads } = await seeded(t, 60);
  t.after(() => store.close());
  // Something rewrote the log behind the store: an early line grew, shifting every later one.
  const eventsPath = eventsPathOf(rootDir, "t1");
  const text = await fs.readFile(eventsPath, "utf8");
  await fs.writeFile(eventsPath, text.replace("message m3 ", "message m3, now somewhat longer, "));
  const whole = (await fs.stat(eventsPath)).size;
  reads.clear();

  const tail = await store.readTail("t1", 55);
  assert.deepEqual(ids(tail.events), ["m55", "m56", "m57", "m58", "m59", "m60"]);
  assert.equal(tail.truncated, false);
  assert.ok(reads.bytes > whole, "tried the cursor, then the log");

  // A malformed line past the cursor: the whole read's verdict (truncated) stands.
  const lines = (await fs.readFile(eventsPath, "utf8")).split("\n");
  lines[58] = "{not json";
  await fs.writeFile(eventsPath, lines.join("\n"));
  reads.clear();
  const cut = await store.readTail("t1", 50);
  assert.equal(cut.truncated, true);
  assert.ok(reads.bytes >= (await fs.stat(eventsPath)).size);
});
