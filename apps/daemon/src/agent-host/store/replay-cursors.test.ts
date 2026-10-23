/**
 * A reconnect's `readTail(after)` reads `events.ndjson` from line `after + 1` when this process
 * appended it (`replay-cursors.ts`), and the whole log otherwise — always with the whole log's
 * answer. Bytes read are observed through the store's `onLogRead`.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { AppendableDomainEvent, Clock, IdGen } from "../services.ts";
import { createThreadStore } from "./index.ts";
import { REPLAY_CURSOR_CAPACITY, REPLAY_CURSOR_IDLE_MS, ReplayCursorRing } from "./replay-cursors.ts";

const eventsPathOf = (root: string, id: string): string => path.join(root, "threads", id, "events.ndjson");

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

async function openStore(rootDir: string) {
  const reads: Array<{ kind: "whole" | "from-cursor"; bytes: number }> = [];
  const store = createThreadStore({
    rootDir,
    clock: fixedClock(),
    idGen: countingIds(),
    onLogRead: ({ kind, bytes }) => reads.push({ kind, bytes })
  });
  return { store, reads };
}

/** A thread of `count` messages after its creation, appended in batches like a live turn's. */
async function seeded(count: number): Promise<{ rootDir: string; store: Awaited<ReturnType<typeof openStore>>["store"]; reads: Array<{ kind: string; bytes: number }> }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-agent-replay-"));
  const { store, reads } = await openStore(rootDir);
  await store.append({ threadId: "t1", events: [created()] });
  for (let start = 0; start < count; start += 25) {
    const batch = Array.from({ length: Math.min(25, count - start) }, (_, index) => say(`m${start + index + 1}`));
    await store.append({ threadId: "t1", events: batch });
  }
  reads.length = 0;
  return { rootDir, store, reads };
}

test("the cursors grow with appends, keep the newest positions only, and forget on clear", () => {
  const pos = (seq: number) => ({ seq, byteOffset: seq * 100, byteLength: 100 });
  const ring = new ReplayCursorRing(0, 4);
  assert.equal(ring.size, 0, "nothing allocated up front");
  ring.note([1, 2].map(pos), 0);
  assert.equal(ring.size, 2, "one number per appended line");
  ring.note([3, 4, 5, 6].map(pos), 0);
  assert.equal(ring.offsetOf(6), 600);
  assert.equal(ring.offsetOf(3), 300);
  assert.equal(ring.offsetOf(2), undefined, "older than the newest 4");
  assert.equal(ring.offsetOf(0), undefined);
  assert.equal(ring.offsetOf(7), undefined);
  // A gap in the sequences (the log re-read under them) starts over.
  ring.note([9].map(pos), 0);
  assert.equal(ring.offsetOf(6), undefined);
  assert.equal(ring.offsetOf(9), 900);
  ring.clear();
  assert.equal(ring.offsetOf(9), undefined);
  assert.equal(REPLAY_CURSOR_CAPACITY, 1_000, "the replay's own row cap");

  // At full capacity it holds at most the cap plus one trim batch, never the thread's whole length.
  const big = new ReplayCursorRing(0);
  for (let seq = 1; seq <= 10_000; seq += 1) big.note([pos(seq)], 0);
  assert.ok(big.size <= REPLAY_CURSOR_CAPACITY + 256, String(big.size));
  assert.equal(big.offsetOf(10_000 - REPLAY_CURSOR_CAPACITY), undefined);
  assert.equal(big.offsetOf(10_000 - REPLAY_CURSOR_CAPACITY + 1), (10_000 - REPLAY_CURSOR_CAPACITY + 1) * 100);
});

test("a thread idle for the drop interval loses its cursors; reconnects then read the whole log, and its next append starts over", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-agent-replay-idle-"));
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const reads: string[] = [];
  const store = createThreadStore({
    rootDir,
    clock: { now: () => new Date(nowMs), nowIso: () => new Date(nowMs).toISOString() },
    idGen: countingIds(),
    onLogRead: ({ kind }) => reads.push(kind)
  });
  t.after(() => store.close());
  await store.append({ threadId: "t1", events: [created(), say("m1"), say("m2")] });

  nowMs += REPLAY_CURSOR_IDLE_MS - 1;
  assert.equal(store.dropIdleReplayCursors(), 0, "not idle long enough");
  await store.readTail("t1", 2);
  assert.deepEqual(reads, ["from-cursor"]);

  nowMs += 1;
  assert.equal(store.dropIdleReplayCursors(), 1);
  reads.length = 0;
  assert.deepEqual(ids((await store.readTail("t1", 2)).events), ["m2"]);
  assert.deepEqual(reads, ["whole"], "dropped: the whole log, same answer");

  await store.append({ threadId: "t1", events: [say("m3")] });
  reads.length = 0;
  assert.deepEqual(ids((await store.readTail("t1", 3)).events), ["m3"]);
  assert.deepEqual(reads, ["from-cursor"], "the next append starts new cursors");
});

test("a small gap is read from its line's offset, not the whole log, with the whole log's answer", async (t) => {
  const { rootDir, store, reads } = await seeded(400);
  t.after(() => store.close());
  const whole = (await fs.stat(eventsPathOf(rootDir, "t1"))).size;

  const tail = await store.readTail("t1", 398);
  assert.deepEqual(ids(tail.events), ["m398", "m399", "m400"]);
  assert.deepEqual(tail.events.map((event) => event.seq), [399, 400, 401]);
  assert.equal(tail.seq, 401);
  assert.equal(tail.truncated, false);
  assert.deepEqual(reads.map((read) => read.kind), ["from-cursor"]);
  assert.ok(reads[0]!.bytes < whole / 50, `${reads[0]!.bytes} of ${whole} bytes`);

  // Exactly what the whole read answers.
  const all = await store.readAll("t1");
  assert.deepEqual(tail.events, all.events.filter((event) => event.seq > 398));
});

test("a gap the ring does not hold — older than its capacity, or before this process appended — reads the whole log", async (t) => {
  const { rootDir, store, reads } = await seeded(REPLAY_CURSOR_CAPACITY + 50);
  t.after(() => store.close());
  const tail = await store.readTail("t1", 10);
  assert.equal(tail.events.length, REPLAY_CURSOR_CAPACITY + 50 + 1 - 10);
  assert.equal(tail.events[0]?.seq, 11);
  assert.deepEqual(reads.map((read) => read.kind), ["whole"]);

  // A restarted host (a fresh store on the same log): empty ring, whole read, same answer.
  await store.close();
  const again = await openStore(rootDir);
  t.after(() => again.store.close());
  const replay = await again.store.readTail("t1", 1040);
  assert.deepEqual(replay.events.map((event) => event.seq), [1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050, 1051]);
  assert.deepEqual(again.reads.map((read) => read.kind), ["whole"]);
  // Its next append fills the ring again.
  await again.store.append({ threadId: "t1", events: [say("late")] });
  again.reads.length = 0;
  assert.deepEqual(ids((await again.store.readTail("t1", 1051)).events), ["late"]);
  assert.deepEqual(again.reads.map((read) => read.kind), ["from-cursor"]);
});

test("an offset that no longer holds its line (the log rewritten under it) falls back to the whole log, correctly", async (t) => {
  const { rootDir, store, reads } = await seeded(60);
  t.after(() => store.close());
  // Something rewrote the log behind the store: an early line grew, shifting every later one.
  const eventsPath = eventsPathOf(rootDir, "t1");
  const text = await fs.readFile(eventsPath, "utf8");
  await fs.writeFile(eventsPath, text.replace("message m3 ", "message m3, now somewhat longer, "));

  const tail = await store.readTail("t1", 55);
  assert.deepEqual(ids(tail.events), ["m55", "m56", "m57", "m58", "m59", "m60"]);
  assert.equal(tail.truncated, false);
  assert.deepEqual(reads.map((read) => read.kind), ["from-cursor", "whole"], "tried the cursor, then the log");

  // A malformed line past the cursor: the whole read's verdict (truncated) stands.
  const lines = (await fs.readFile(eventsPath, "utf8")).split("\n");
  lines[58] = "{not json";
  await fs.writeFile(eventsPath, lines.join("\n"));
  reads.length = 0;
  const cut = await store.readTail("t1", 50);
  assert.equal(cut.truncated, true);
  assert.equal(reads.at(-1)?.kind, "whole");
});
