/**
 * Thread store durability (spec §5.1): the sequence, the torn trailing line,
 * a corrupt `meta.json`, one bad thread never touching another, the atomic
 * head checkpoint, the receipt ring and the attachment rules.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { AttachmentRef, DomainEvent, ThreadHead } from "@orquester/api/agent-chat";
import { foldThread } from "@orquester/api/agent-chat";

// The store's layout under its own `rootDir` (`@orquester/config`'s helpers
// take the APPDIR; `rootDir` is already `<appdir>/daemon/agent`).
const threadDir = (root: string, id: string): string => path.join(root, "threads", id);
const metaPath = (root: string, id: string): string => path.join(threadDir(root, id), "meta.json");
const eventsPathOf = (root: string, id: string): string =>
  path.join(threadDir(root, id), "events.ndjson");
const attachmentsDirOf = (root: string, id: string): string =>
  path.join(threadDir(root, id), "attachments");
const receiptsPathOf = (root: string): string => path.join(root, "receipts.json");

import type { AppendableDomainEvent, Clock, IdGen } from "../services.ts";
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  HEAD_CHECKPOINT_EVENTS,
  createThreadStore,
  isSafeThreadId
} from "./index.ts";

/**
 * The sweep reads REAL file mtimes, so its clock has to move relative to now
 * rather than to a fixture date.
 */
function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "orq-agent-store-"));
}

function fixedClock(iso = "2026-01-01T00:00:00.000Z"): Clock {
  return { now: () => new Date(iso), nowIso: () => iso };
}

function countingIds(): IdGen {
  let n = 0;
  return {
    eventId: () => `e${++n}`,
    messageId: (prefix) => `${prefix}:${++n}`,
    // A real UUID shape is load-bearing: the attachment id pattern requires it.
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

function message(threadId: string, id: string, attachments?: AttachmentRef[]): AppendableDomainEvent {
  return {
    eventId: `e-${id}`,
    threadId,
    type: "thread.message-sent",
    payload: {
      messageId: id,
      role: "user",
      text: id,
      streaming: false,
      turnId: null,
      ...(attachments !== undefined ? { attachments } : {})
    },
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as AppendableDomainEvent;
}

test("append stamps a per-thread monotonic seq and returns what it persisted", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });

  const first = await store.append({ threadId: "t1", events: [created(), message("t1", "m1")] });
  assert.deepEqual(first.events.map((event) => event.seq), [1, 2]);
  assert.equal(first.seq, 2);

  // A second thread starts its own sequence at 1 — there is no global order.
  const other = await store.append({ threadId: "t2", events: [created("t2")] });
  assert.equal(other.seq, 1);

  const tail = await store.readAll("t1");
  assert.deepEqual(tail.events.map((event) => event.seq), [1, 2]);
  assert.equal(tail.truncated, false);
});

test("concurrent appends never reuse a sequence", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });

  const results = await Promise.all(
    Array.from({ length: 25 }, (_unused, index) =>
      store.append({ threadId: "t1", events: [message("t1", `m${index}`)] })
    )
  );
  const seqs = results.map((result) => result.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 25 }, (_unused, index) => index + 2));

  const tail = await store.readAll("t1");
  assert.equal(tail.events.length, 26);
  assert.equal(tail.seq, 26);
});

test("a first-touch read racing a first-touch append never re-uses a seq", async () => {
  // Q1 #2: `ensureLoaded` used to mark a thread loaded BEFORE its disk reads,
  // so a read that arrived in that window returned `seq: 0` and the queued
  // append stamped 1 over sequences already on disk. On-disk seqs came back
  // `[1, 2, 3, 1]`, and `readLog` then truncated the thread at the duplicate
  // FOREVER.
  const rootDir = await tempRoot();
  const first = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await first.append({
    threadId: "t1",
    events: [created(), message("t1", "m1"), message("t1", "m2")]
  });
  await first.drain();

  // A fresh instance: nothing is loaded, so both calls race the first load.
  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const [, appended] = await Promise.all([
    reopened.readAll("t1"),
    reopened.append({ threadId: "t1", events: [message("t1", "m3")] })
  ]);
  await reopened.drain();

  assert.equal(appended.seq, 4, "the append must continue the existing sequence");

  const onDisk = (await fs.readFile(eventsPathOf(rootDir, "t1"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { seq: number }).seq);
  assert.deepEqual(onDisk, [1, 2, 3, 4]);

  const tail = await reopened.readAll("t1");
  assert.equal(tail.truncated, false, "a duplicate seq would truncate the thread permanently");
  assert.equal(tail.events.length, 4);
});

test("many concurrent first-touch callers all serialise on one load", async () => {
  const rootDir = await tempRoot();
  const first = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await first.append({ threadId: "t1", events: [created()] });
  await first.drain();

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const work: Array<Promise<unknown>> = [];
  for (let i = 0; i < 12; i += 1) {
    work.push(reopened.readTail("t1", 0));
    work.push(reopened.loadHead("t1"));
    work.push(reopened.append({ threadId: "t1", events: [message("t1", `m${i}`)] }));
  }
  await Promise.all(work);
  await reopened.drain();

  const tail = await reopened.readAll("t1");
  assert.equal(tail.truncated, false);
  assert.deepEqual(
    tail.events.map((event) => event.seq),
    Array.from({ length: 13 }, (_unused, index) => index + 1)
  );
});

test("a torn trailing line is truncated on load, never fatal", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created(), message("t1", "m1")] });
  await store.drain();

  // Simulate a crash between write() and the newline.
  const eventsPath = eventsPathOf(rootDir, "t1");
  await fs.appendFile(eventsPath, '{"seq":3,"eventId":"e3","threa');

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const tail = await reopened.readAll("t1");
  assert.deepEqual(tail.events.map((event) => event.seq), [1, 2]);
  // The fragment was a batch that never completed: it is cut on load, so what
  // is left reads whole.
  assert.equal(tail.truncated, false);
  assert.equal(tail.seq, 2);

  // And the next append lands at 3, on a line of its own — not glued onto
  // the fragment, where a full read would stop before it forever.
  const appended = await reopened.append({ threadId: "t1", events: [message("t1", "m2")] });
  assert.equal(appended.seq, 3);
  const after = await reopened.readAll("t1");
  assert.deepEqual(after.events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(after.truncated, false);
});

test("an event type from a NEWER host folds inertly and never truncates (R1-8, §8)", async () => {
  // §8: the thread log is outside every rollback — events appended by a newer
  // host stay on disk and the older host must still fold them. A closed type
  // enum made a new event type indistinguishable from a malformed line, so an
  // older host silently dropped the whole tail after it.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created(), message("t1", "m1")] });
  await store.drain();

  // A future build appends a type this build has never heard of, then carries
  // on writing events this build DOES know.
  const future = {
    seq: 3,
    eventId: "e-future",
    threadId: "t1",
    type: "thread.snoozed",
    payload: { until: "2027-01-01T00:00:00.000Z", nested: { anything: true } },
    occurredAt: "2026-01-01T00:00:03.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  };
  const after = {
    seq: 4,
    eventId: "e-after",
    threadId: "t1",
    type: "thread.message-sent",
    payload: {
      messageId: "m2",
      role: "user",
      text: "written after the unknown event",
      streaming: false,
      turnId: null
    },
    occurredAt: "2026-01-01T00:00:04.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  };
  await fs.appendFile(
    eventsPathOf(rootDir, "t1"),
    `${JSON.stringify(future)}\n${JSON.stringify(after)}\n`
  );

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const tail = await reopened.readAll("t1");
  assert.equal(tail.truncated, false, "an unknown type is decodable, not malformed");
  assert.deepEqual(tail.events.map((event) => event.seq), [1, 2, 3, 4]);
  assert.equal(tail.seq, 4);
  assert.equal(reopened.threadError("t1"), null, "a future event does not mark the thread error");

  // The events after it still reach the fold.
  const state = foldThread(tail.events);
  assert.ok(
    state.items.some((item) => item.id === "m2"),
    "the tail after an unknown event must still fold"
  );
  // …and the unknown event itself changes nothing but the sequence floor.
  assert.equal(state.seq, 4);
  assert.equal(state.head?.seq, 4);

  // The next append continues the sequence rather than re-using 3 or 4.
  const appended = await reopened.append({ threadId: "t1", events: [message("t1", "m3")] });
  assert.equal(appended.seq, 5);
});

test("an unknown type as the LAST line still seeds seq, so no append re-uses it", async () => {
  // The seq-reuse half of R1-8: when the undecodable line was the last one,
  // `entry.seq` was seeded from the TRUNCATED scan (line N-1) while `append`
  // stamped `++entry.seq` regardless — permanently corrupting the ordering
  // that the fold and `/events?after=` depend on.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created(), message("t1", "m1")] });
  await store.drain();

  await fs.appendFile(
    eventsPathOf(rootDir, "t1"),
    `${JSON.stringify({
      seq: 3,
      eventId: "e-future",
      threadId: "t1",
      type: "thread.pinned",
      payload: {},
      occurredAt: "2026-01-01T00:00:03.000Z",
      commandId: null,
      causationEventId: null,
      metadata: {}
    })}\n`
  );

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appended = await reopened.append({ threadId: "t1", events: [message("t1", "m2")] });
  assert.equal(appended.seq, 4, "the sequence must continue past the unknown event");

  const onDisk = (await fs.readFile(eventsPathOf(rootDir, "t1"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { seq: number }).seq);
  assert.deepEqual(onDisk, [1, 2, 3, 4], "no sequence is re-used");
  assert.equal((await reopened.readAll("t1")).truncated, false);
});

test("genuinely malformed lines still truncate — §5.1's rule is unchanged", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  await store.drain();

  // Not JSON at all, and a JSON object missing the envelope's own fields:
  // both are corruption, not a newer build.
  for (const bad of ['{"seq":2,"type":', JSON.stringify({ seq: 2, type: "thread.deleted" })]) {
    const rootDir2 = await tempRoot();
    const s2 = createThreadStore({ rootDir: rootDir2, clock: fixedClock(), idGen: countingIds() });
    await s2.append({ threadId: "t1", events: [created()] });
    await s2.drain();
    await fs.appendFile(eventsPathOf(rootDir2, "t1"), `${bad}\n`);
    const reopened = createThreadStore({
      rootDir: rootDir2,
      clock: fixedClock(),
      idGen: countingIds()
    });
    const tail = await reopened.readAll("t1");
    assert.equal(tail.truncated, true, bad);
    assert.equal(tail.events.length, 1, bad);
  }
});

test("a malformed middle line truncates the fold at that point", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created(), message("t1", "m1")] });
  await store.drain();

  const eventsPath = eventsPathOf(rootDir, "t1");
  const contents = await fs.readFile(eventsPath, "utf8");
  const lines = contents.split("\n").filter((line) => line.length > 0);
  await fs.writeFile(eventsPath, `${lines[0]}\nnot json\n${lines[1]}\n`);

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const tail = await reopened.readAll("t1");
  assert.equal(tail.events.length, 1, "everything after the bad line is dropped");
  assert.equal(tail.truncated, true);
});

test("a thread whose meta.json is corrupt is marked error and still readable", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "bad", events: [created("bad")] });
  await store.append({ threadId: "good", events: [created("good")] });
  await store.saveHead({
    ...(await headOf(store, "bad")),
    title: "Bad"
  });
  await store.drain();
  await fs.writeFile(metaPath(rootDir, "bad"), "{ not json");

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal(await reopened.loadHead("bad"), null);
  assert.match(reopened.threadError("bad") ?? "", /meta\.json/);
  // The other thread is untouched: one bad directory never spreads (§5.1).
  assert.equal(reopened.threadError("good"), null);
  const good = await reopened.readAll("good");
  assert.equal(good.events.length, 1);
  assert.equal(good.truncated, false);
  // And the bad thread's LOG is still the record.
  const bad = await reopened.readAll("bad");
  assert.equal(bad.events.length, 1);
});

test("a meta.json that does not match the schema marks the thread error", async () => {
  const rootDir = await tempRoot();
  await fs.mkdir(threadDir(rootDir, "t1"), { recursive: true });
  await fs.writeFile(
    metaPath(rootDir, "t1"),
    JSON.stringify({ id: "t1", adapter: "not-an-adapter" })
  );
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal(await store.loadHead("t1"), null);
  assert.match(store.threadError("t1") ?? "", /schema/);
});

test("a metadata-only head read never scans a malformed event log", async () => {
  const rootDir = await tempRoot();
  const writer = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await writer.append({ threadId: "t1", events: [created()] });
  const head = await headOf(writer, "t1");
  await writer.saveHead(head);
  await writer.drain();
  writer.close();
  await fs.appendFile(eventsPathOf(rootDir, "t1"), "{malformed}\n");

  const reader = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const loaded = await reader.loadHead("t1", { seedRuntime: false });

  assert.equal(loaded?.id, "t1");
  assert.equal(reader.threadError("t1"), null, "events.ndjson was not inspected");
  reader.close();
});

test("a metadata-only head read never rolls a seeded thread's head back to meta.json", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  await store.saveHead(await headOf(store, "t1"));
  // Between two checkpoints the seeded head moves on and meta.json does not.
  await store.append({ threadId: "t1", events: [message("t1", "m1")] });
  await store.drain();
  const onDisk = JSON.parse(
    await fs.readFile(path.join(threadDir(rootDir, "t1"), "meta.json"), "utf8")
  ) as ThreadHead;
  assert.equal(onDisk.seq, 1);

  const metaOnly = await store.loadHead("t1", { seedRuntime: false });

  assert.equal(metaOnly?.seq, 2, "the seeded head answers, not the older file");
  assert.equal((await headOf(store, "t1")).seq, 2, "and the seeded head is left as it was");
  store.close();
});

async function headOf(
  store: ReturnType<typeof createThreadStore>,
  threadId: string
): Promise<ThreadHead> {
  const head = await store.loadHead(threadId);
  assert.ok(head, `no head for ${threadId}`);
  return head;
}

test("meta.json is checkpointed every 50 events and rewritten atomically", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  await store.drain();

  const meta = metaPath(rootDir, "t1");
  await assert.rejects(fs.stat(meta), "nothing is written before the checkpoint threshold");

  for (let i = 0; i < HEAD_CHECKPOINT_EVENTS; i += 1) {
    await store.append({ threadId: "t1", events: [message("t1", `m${i}`)] });
  }
  await store.drain();

  const written = JSON.parse(await fs.readFile(meta, "utf8")) as ThreadHead;
  assert.equal(written.id, "t1");
  assert.equal(written.seq, HEAD_CHECKPOINT_EVENTS, "the checkpoint fires ON the 50th event");

  // tmp + rename: no temp file is left behind.
  const entries = await fs.readdir(threadDir(rootDir, "t1"));
  assert.deepEqual(entries.filter((entry) => entry.includes(".tmp")), []);
});

test("saveHead wins over the store's own projection and survives a reopen", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  const head = await headOf(store, "t1");
  await store.saveHead({ ...head, continueAfterRestart: { turnId: "T-9", prepared: true } });
  await store.drain();

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const loaded = await headOf(reopened, "t1");
  assert.deepEqual(loaded.continueAfterRestart, { turnId: "T-9", prepared: true });
});

test("the goal-resume marker is head-only state that survives a reopen (goals §5.5)", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  await store.saveHead({ ...(await headOf(store, "t1")), resumeGoalAfterRestart: true });
  // The store's own projection carries it forward across appends — no domain
  // event names it, so only a `saveHead` may move it.
  await store.append({ threadId: "t1", events: [message("t1", "m1")] });
  assert.equal((await headOf(store, "t1")).resumeGoalAfterRestart, true);
  await store.drain();
  store.close();

  // The boot candidate check reads meta.json alone, like `isOrphanedHead`.
  const metaOnly = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const persisted = await metaOnly.loadHead("t1", { seedRuntime: false });
  assert.equal(persisted?.resumeGoalAfterRestart, true);
  metaOnly.close();

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const loaded = await headOf(reopened, "t1");
  assert.equal(loaded.resumeGoalAfterRestart, true);
  // Cleared by the next head save that omits it.
  const { resumeGoalAfterRestart: _cleared, ...cleared } = loaded;
  void _cleared;
  await reopened.saveHead(cleared);
  await reopened.drain();
  reopened.close();
  const after = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal((await headOf(after, "t1")).resumeGoalAfterRestart, undefined);
  after.close();
});

test("the goal-hold marker is head-only state that survives a reopen (goals §5.7)", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  await store.saveHead({ ...(await headOf(store, "t1")), goalHeldForHandover: true });
  // Carried forward across appends by the store's own projection: no domain
  // event names it, and a crash between the hold and the next head save must
  // still find it.
  await store.append({ threadId: "t1", events: [message("t1", "m1")] });
  assert.equal((await headOf(store, "t1")).goalHeldForHandover, true);
  await store.drain();
  store.close();

  // The boot's candidate check reads meta.json alone.
  const metaOnly = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const persisted = await metaOnly.loadHead("t1", { seedRuntime: false });
  assert.equal(persisted?.goalHeldForHandover, true);
  metaOnly.close();

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const loaded = await headOf(reopened, "t1");
  assert.equal(loaded.goalHeldForHandover, true);
  const { goalHeldForHandover: _cleared, ...cleared } = loaded;
  void _cleared;
  await reopened.saveHead(cleared);
  await reopened.drain();
  reopened.close();
  const after = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal((await headOf(after, "t1")).goalHeldForHandover, undefined);
  after.close();
});

test("deleteThread deletes the thread's checkpoint refs before its directory", async () => {
  const rootDir = await tempRoot();
  const calls: Array<{ threadId: string; cwd: string }> = [];
  const store = createThreadStore({
    rootDir,
    clock: fixedClock(),
    idGen: countingIds(),
    deleteThreadRefs: async (input) => {
      calls.push(input);
      // The directory must still be there when the refs are cleaned up.
      await fs.stat(threadDir(rootDir, input.threadId));
    }
  });
  await store.append({ threadId: "t1", events: [created()] });
  await store.deleteThread("t1");
  assert.deepEqual(calls, [{ threadId: "t1", cwd: "/w/p" }]);
  await assert.rejects(fs.stat(threadDir(rootDir, "t1")));
});

test("a failing ref cleanup aborts the delete rather than orphaning refs", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({
    rootDir,
    clock: fixedClock(),
    idGen: countingIds(),
    deleteThreadRefs: async () => {
      throw new Error("git is busy");
    }
  });
  await store.append({ threadId: "t1", events: [created()] });
  await assert.rejects(store.deleteThread("t1"), /git is busy/);
  // Still whole, so the delete can be retried.
  await fs.stat(threadDir(rootDir, "t1"));
  assert.deepEqual(await store.listThreads(), ["t1"]);
});

test("listThreads names every directory on disk; deleteThread removes one whole", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "a", events: [created("a")] });
  await store.append({ threadId: "b", events: [created("b")] });
  await store.drain();
  assert.deepEqual(await store.listThreads(), ["a", "b"]);

  await store.deleteThread("a");
  assert.deepEqual(await store.listThreads(), ["b"]);
  await assert.rejects(fs.stat(threadDir(rootDir, "a")));
});

// --- receipts --------------------------------------------------------------

test("a receipt is written with the events and replays their sequence", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const result = await store.append({
    threadId: "t1",
    events: [created(), message("t1", "m1")],
    receipt: {
      commandId: "cmd-1",
      threadId: "t1",
      status: "accepted",
      acceptedAt: "2026-01-01T00:00:00.000Z"
    }
  });
  await store.drain();

  const receipt = await store.getReceipt("cmd-1");
  assert.equal(receipt?.seq, result.seq);
  assert.equal(receipt?.status, "accepted");
  assert.equal(receipt?.threadId, "t1");

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal((await reopened.getReceipt("cmd-1"))?.seq, result.seq);
  assert.equal(await reopened.getReceipt("never-seen"), null);
});

test("a rejected receipt is persisted too, so a retry replays the rejection", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.putReceipt({
    commandId: "cmd-bad",
    threadId: "t1",
    seq: 0,
    status: "rejected",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    error: { code: "TURN_ACTIVE", message: "a turn is already running" }
  });
  await store.drain();
  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const receipt = await reopened.getReceipt("cmd-bad");
  assert.equal(receipt?.status, "rejected");
  assert.equal(receipt?.error?.code, "TURN_ACTIVE");
});

test("the receipt ring evicts oldest-first at 500", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  for (let i = 0; i < 520; i += 1) {
    await store.putReceipt({
      commandId: `cmd-${i}`,
      threadId: "t1",
      seq: i,
      status: "accepted",
      acceptedAt: "2026-01-01T00:00:00.000Z"
    });
  }
  await store.drain();
  assert.equal(await store.getReceipt("cmd-0"), null, "the oldest are gone");
  assert.equal((await store.getReceipt("cmd-519"))?.seq, 519);

  const onDisk = JSON.parse(await fs.readFile(receiptsPathOf(rootDir), "utf8")) as {
    receipts: unknown[];
  };
  assert.equal(onDisk.receipts.length, 500);
});

test("an unreadable receipts file costs at most a replayed command, never a thread", async () => {
  const rootDir = await tempRoot();
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(receiptsPathOf(rootDir), "}}} not json");
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  assert.equal(await store.getReceipt("cmd-1"), null);
  const result = await store.append({
    threadId: "t1",
    events: [created()],
    receipt: {
      commandId: "cmd-1",
      threadId: "t1",
      status: "accepted",
      acceptedAt: "2026-01-01T00:00:00.000Z"
    }
  });
  assert.equal((await store.getReceipt("cmd-1"))?.seq, result.seq);
});

// --- attachments -----------------------------------------------------------

async function writeSource(dir: string, name: string, bytes: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(bytes, 1));
  return filePath;
}

test("putAttachment copies the file, names the thread in the id and stats the size", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const source = await writeSource(path.join(rootDir, "src"), "shot.PNG", 64);

  const ref = await store.putAttachment({
    threadId: "t1",
    name: "shot.PNG",
    mimeType: "IMAGE/PNG",
    sourcePath: source
  });
  assert.equal(ref.type, "image");
  assert.equal(ref.sizeBytes, 64);
  assert.ok(ref.id.startsWith("t1-"), `id ${ref.id} names its thread`);

  const resolved = await store.resolveAttachment("t1", ref.id);
  // The reply names the absolute path the composer puts in the prompt (§7.4).
  assert.equal(ref.path, resolved);
  assert.equal(path.dirname(resolved), attachmentsDirOf(rootDir, "t1"));

  // Copied, not linked: editing the delivered file must not touch the source.
  await fs.writeFile(resolved, Buffer.alloc(8, 2));
  assert.equal((await fs.stat(source)).size, 64);
});

test("an attachment id belonging to another thread is refused, not looked up", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const source = await writeSource(path.join(rootDir, "src"), "a.bin", 8);
  const ref = await store.putAttachment({ threadId: "t1", name: "a.bin", sourcePath: source });
  // The file arm names its absolute path too (§7.4).
  assert.equal(ref.type, "file");
  assert.equal(ref.path, await store.resolveAttachment("t1", ref.id));

  await assert.rejects(store.resolveAttachment("t2", ref.id), /does not belong/);
  await assert.rejects(
    store.resolveAttachment("t1", "../../../etc/passwd"),
    /does not belong/,
    "a traversal-shaped id never parses"
  );
  await assert.rejects(store.resolveAttachment("t1", "t1-00000000-0000-4000-8000-000000009999-bin"), /not found/);
});

test("bounds are checked against the stat'd file, per kind", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const big = await writeSource(path.join(rootDir, "src"), "big.png", 11 * 1024 * 1024);
  await assert.rejects(
    store.putAttachment({ threadId: "t1", name: "big.png", mimeType: "image/png", sourcePath: big }),
    /over the/
  );
  // The same bytes under a non-image name are under the 50 MiB file limit.
  const blob = await writeSource(path.join(rootDir, "src"), "big.bin", 11 * 1024 * 1024);
  const ref = await store.putAttachment({
    threadId: "t1",
    name: "big.bin",
    mimeType: "application/octet-stream",
    sourcePath: blob
  });
  assert.equal(ref.type, "file");
});

test("pruneAttachments keeps referenced files and sweeps stale orphans", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const src = path.join(rootDir, "src");
  const keptRef = await store.putAttachment({
    threadId: "t1",
    name: "kept.bin",
    sourcePath: await writeSource(src, "kept.bin", 8)
  });
  const orphanRef = await store.putAttachment({
    threadId: "t1",
    name: "orphan.bin",
    sourcePath: await writeSource(src, "orphan.bin", 8)
  });
  await store.append({ threadId: "t1", events: [created(), message("t1", "m1", [keptRef])] });
  await store.drain();

  // Right now nothing is swept: an unreferenced upload inside the grace window
  // is a turn that has not dispatched yet (§6.3).
  await store.pruneAttachments({ threadId: "t1", now: hoursFromNow(1) });
  await store.resolveAttachment("t1", orphanRef.id);

  // Two days later it is an orphan.
  await store.pruneAttachments({ threadId: "t1", now: hoursFromNow(48) });
  await store.resolveAttachment("t1", keptRef.id);
  await assert.rejects(store.resolveAttachment("t1", orphanRef.id), /not found/);
});

test("pruneAttachments sweeps .part files after an hour and pending uploads after a day", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  await store.drain();

  const attachments = attachmentsDirOf(rootDir, "t1");
  await fs.mkdir(attachments, { recursive: true });
  const partial = path.join(attachments, "upload.part");
  await fs.writeFile(partial, "x");

  const pending = store.pendingAttachmentsDir();
  await fs.mkdir(pending, { recursive: true });
  const pendingFile = path.join(pending, "pending-00000000-0000-4000-8000-000000000001-bin.bin");
  await fs.writeFile(pendingFile, "x");

  await store.pruneAttachments({ now: hoursFromNow(0.5) });
  await fs.stat(partial);
  await fs.stat(pendingFile);

  await store.pruneAttachments({ now: hoursFromNow(2) });
  await assert.rejects(fs.stat(partial), "a .part is stale after an hour");
  await fs.stat(pendingFile);

  await store.pruneAttachments({ now: hoursFromNow(48) });
  await assert.rejects(fs.stat(pendingFile), "a pending upload is stale after a day");
});

test("a revert's truncation is what the attachment sweep recomputes against", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const src = path.join(rootDir, "src");
  const ref = await store.putAttachment({
    threadId: "t1",
    name: "gone.bin",
    sourcePath: await writeSource(src, "gone.bin", 8)
  });

  await store.append({
    threadId: "t1",
    events: [
      created(),
      {
        ...(message("t1", "assistant:1", [ref]) as DomainEvent),
        payload: {
          messageId: "assistant:1",
          role: "assistant",
          text: "here",
          streaming: false,
          turnId: "T-9",
          attachments: [ref]
        }
      } as AppendableDomainEvent,
      {
        eventId: "e-revert",
        threadId: "t1",
        type: "thread.reverted",
        payload: { turnCount: 0 },
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: null,
        causationEventId: null,
        metadata: {}
      } as AppendableDomainEvent
    ]
  });
  await store.drain();

  await store.pruneAttachments({ threadId: "t1", now: hoursFromNow(48) });
  await assert.rejects(
    store.resolveAttachment("t1", ref.id),
    /not found/,
    "an attachment only a truncated message referenced is unlinked"
  );
});

test("readItem serves the FULL payload, even for a row past the fold's window", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const bigOutput = "y".repeat(40_000);
  const activity = {
    kind: "activity" as const,
    id: "a-old",
    tone: "tool" as const,
    activityKind: "tool.completed",
    summary: "pnpm test",
    payload: { itemType: "command_execution", data: { rawOutput: { stdout: bigOutput } } },
    turnId: null,
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z"
  };
  const appendActivity = (id: string, payload: unknown): AppendableDomainEvent =>
    ({
      eventId: `e-${id}`,
      threadId: "t1",
      type: "thread.activity-appended",
      payload: { activity: { ...activity, id, payload } },
      occurredAt: "2026-01-01T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      metadata: {}
    }) as AppendableDomainEvent;

  await store.append({ threadId: "t1", events: [created(), appendActivity("a-old", activity.payload)] });
  // Push it well past the 500-row retention window the fold keeps.
  for (let i = 0; i < 600; i += 1) {
    await store.append({ threadId: "t1", events: [appendActivity(`noise-${i}`, { i })] });
  }
  await store.drain();

  const item = await store.readItem("t1", "a-old");
  assert.ok(item && item.kind === "activity");
  const payload = item.payload as { data: { rawOutput: { stdout: string } } };
  assert.equal(payload.data.rawOutput.stdout.length, bigOutput.length);
  assert.equal(await store.readItem("t1", "never-written"), null);
});

test("readItem rebuilds a streamed message's accumulated body", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const delta = (text: string, streaming: boolean): AppendableDomainEvent =>
    ({
      eventId: `e-${text}`,
      threadId: "t1",
      type: "thread.message-sent",
      payload: {
        messageId: "assistant:1",
        role: "assistant",
        text,
        streaming,
        turnId: null
      },
      occurredAt: "2026-01-01T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      metadata: {}
    }) as AppendableDomainEvent;

  await store.append({
    threadId: "t1",
    events: [created(), delta("Hel", true), delta("lo", true), delta("", false)]
  });
  await store.drain();
  const item = await store.readItem("t1", "assistant:1");
  assert.ok(item && item.kind === "message");
  assert.equal(item.text, "Hello");
});

test("drain settles every queued write", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const appends = Array.from({ length: 10 }, (_unused, index) =>
    store.append({ threadId: `t${index}`, events: [created(`t${index}`)] })
  );
  await store.drain();
  await Promise.all(appends);
  assert.equal((await store.listThreads()).length, 10);
});

// --- fix-wave regressions ---------------------------------------------------

test("an unusable thread id is refused before it reaches path.join or rm -rf", async () => {
  // S1 #11: the host is a separate process with its own trust boundary; one
  // wrong caller would turn a DELETE into an arbitrary recursive delete.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  for (const bad of ["../../etc", "a/b", "", ".hidden", "..", "x".repeat(200)]) {
    assert.equal(isSafeThreadId(bad), false, bad);
    await assert.rejects(store.deleteThread(bad), /unusable thread id/, bad);
    await assert.rejects(store.loadHead(bad), /unusable thread id/, bad);
  }
  assert.equal(isSafeThreadId("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), true);
});

test("the image cap follows the stored extension, not just the declared mime", async () => {
  // S1 #7: `?name=x.png&type=application/octet-stream` carried 40 MiB in under
  // the 50 MiB FILE limit and was then re-declared `image/png` on the turn.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const big = await writeSource(path.join(rootDir, "src"), "sneaky.png", 11 * 1024 * 1024);
  await assert.rejects(
    store.putAttachment({
      threadId: "t1",
      name: "sneaky.png",
      mimeType: "application/octet-stream",
      sourcePath: big
    }),
    /over the/
  );

  // A genuine non-image extension still gets the file bound.
  const blob = await writeSource(path.join(rootDir, "src"), "dump.bin", 11 * 1024 * 1024);
  const ref = await store.putAttachment({
    threadId: "t1",
    name: "dump.bin",
    mimeType: "application/octet-stream",
    sourcePath: blob
  });
  assert.equal(ref.type, "file");
});

test("two head writes in the same millisecond do not collide on a temp name", async () => {
  // Q1 #51: the temp name was `pid + Date.now()`, so the second rename threw
  // ENOENT out of saveHead.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  const head = await headOf(store, "t1");
  await Promise.all([
    store.saveHead({ ...head, title: "one" }),
    store.saveHead({ ...head, title: "two" }),
    store.saveHead({ ...head, title: "three" })
  ]);
  await store.drain();
  const written = JSON.parse(await fs.readFile(metaPath(rootDir, "t1"), "utf8")) as ThreadHead;
  assert.ok(["one", "two", "three"].includes(written.title));
  const leftovers = (await fs.readdir(threadDir(rootDir, "t1"))).filter((entry) =>
    entry.includes(".tmp")
  );
  assert.deepEqual(leftovers, []);
});

test("the receipts file is compact JSON, not a pretty-printed ring", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.putReceipt({
    commandId: "cmd-1",
    threadId: "t1",
    seq: 1,
    status: "accepted",
    acceptedAt: "2026-01-01T00:00:00.000Z"
  });
  await store.drain();
  const raw = await fs.readFile(receiptsPathOf(rootDir), "utf8");
  assert.ok(!raw.includes("\n  "), "the ring is rewritten once per command; do not indent it");
  assert.equal((JSON.parse(raw) as { receipts: unknown[] }).receipts.length, 1);
});

test("the host-wide raw-log ceiling runs on the sweep schedule", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await store.append({ threadId: "t1", events: [created()] });
  await store.drain();
  // A stale rotated rung from a thread with no open writer.
  const rung = path.join(rootDir, "threads", "t1", "raw.ndjson.1");
  await fs.writeFile(rung, "old\n");
  const ancient = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  await fs.utimes(rung, ancient, ancient);

  await store.pruneAttachments({ now: hoursFromNow(0) });
  await assert.rejects(fs.stat(rung), "the sweep must reach raw logs, not just attachments");
});

test("the startup sweep avoids history folds and leaves completed attachments for the deep sweep", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, idGen: countingIds() });
  const src = path.join(rootDir, "src");
  const orphan = await store.putAttachment({
    threadId: "t1",
    name: "orphan.bin",
    sourcePath: await writeSource(src, "orphan.bin", 8)
  });
  await store.append({ threadId: "t1", events: [created()] });
  await store.drain();

  const partial = path.join(attachmentsDirOf(rootDir, "t1"), "upload.part");
  await fs.writeFile(partial, "partial");
  const ancient = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  await fs.utimes(partial, ancient, ancient);
  const rung = path.join(threadDir(rootDir, "t1"), "raw.ndjson.1");
  await fs.writeFile(rung, "old\n");
  await fs.utimes(rung, ancient, ancient);

  await store.sweepStartup();

  await store.resolveAttachment("t1", orphan.id);
  await assert.rejects(fs.stat(partial), "the cheap pass still removes stale partial uploads");
  await assert.rejects(fs.stat(rung), "the cheap pass still enforces the raw-log ceiling");

  await store.pruneAttachments({ threadId: "t1", now: hoursFromNow(48) });
  await assert.rejects(
    store.resolveAttachment("t1", orphan.id),
    "the scheduled deep pass still collects completed orphans"
  );
  store.close();
});

// --- S1-5 residual: the sweep needs a production scheduler ------------------

test("the store schedules its own host-wide sweep", async () => {
  // V1 residual on S1-5: the ceiling was hoisted correctly but the only
  // production caller passes a threadId (`orchestrator.ts` revert path), which
  // skips the host-wide branch — so nothing ever ran it. The store now owns
  // the cadence itself.
  const rootDir = await tempRoot();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const store = createThreadStore({
    rootDir,
    // A REAL clock: the sweep compares against real file mtimes, so a fixture
    // date in the past makes everything look like it is from the future.
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    idGen: countingIds(),
    sweepIntervalMs: 60_000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => undefined
  });
  assert.equal(timers.length, 1, "a sweep is scheduled at construction");
  assert.equal(timers[0]?.ms, 60_000);

  await store.append({ threadId: "t1", events: [created()] });
  await store.drain();

  // A stale rotated rung that only the ARGUMENT-LESS sweep collects.
  const rung = path.join(rootDir, "threads", "t1", "raw.ndjson.1");
  await fs.writeFile(rung, "old\n");
  const ancient = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  await fs.utimes(rung, ancient, ancient);

  // A per-thread prune must NOT collect it — that is the gap V1 found.
  await store.pruneAttachments({ threadId: "t1", now: hoursFromNow(0) });
  await fs.stat(rung);

  // Firing the scheduled callback does.
  timers[0]!.fn();
  await store.drain();
  // The timer body is fire-and-forget, so wait for the sweep it started.
  await store.sweepNow();
  await assert.rejects(fs.stat(rung), "the scheduled sweep must reach raw logs");

  store.close();
});

test("sweepIntervalMs 0 disables the scheduler, and close() stops it", async () => {
  const rootDir = await tempRoot();
  const timers: Array<() => void> = [];
  let cleared = 0;
  const off = createThreadStore({
    rootDir,
    clock: fixedClock(),
    idGen: countingIds(),
    sweepIntervalMs: 0,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {
      cleared += 1;
    }
  });
  assert.equal(timers.length, 0, "0 means no background sweep");
  off.close();
  assert.equal(cleared, 0, "nothing to clear");

  const on = createThreadStore({
    rootDir,
    clock: fixedClock(),
    idGen: countingIds(),
    sweepIntervalMs: 1_000,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {
      cleared += 1;
    }
  });
  assert.equal(timers.length, 1);
  on.close();
  assert.equal(cleared, 1, "close() stops the scheduled sweep");
  on.close();
  assert.equal(cleared, 1, "close() is idempotent");
});

test("the default cadence is used when none is given", async () => {
  const rootDir = await tempRoot();
  const seen: number[] = [];
  const store = createThreadStore({
    rootDir,
    clock: fixedClock(),
    idGen: countingIds(),
    setTimer: (_fn, ms) => {
      seen.push(ms);
      return 1;
    },
    clearTimer: () => undefined
  });
  assert.deepEqual(seen, [DEFAULT_SWEEP_INTERVAL_MS]);
  store.close();
});
