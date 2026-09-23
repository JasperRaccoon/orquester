/**
 * The fold snapshot, `threads/<id>/state.json` (thread-index spec, A2): a
 * cache of the folded state as of one `seq`, so a cold load folds only the
 * log's tail. A cache, never an authority — anything wrong with the file loads
 * as `null` and the caller folds the log from the top.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { agentChatDir, agentChatThreadStatePath } from "@orquester/config";
import type { AttachmentRef, DomainEvent } from "@orquester/api/agent-chat";
import {
  FOLD_SNAPSHOT_VERSION,
  deserializeFoldState,
  foldThread,
  parseFoldSnapshotFile,
  serializeFoldState
} from "@orquester/api/agent-chat";

import { createFakeThreadStore } from "../orchestration/testing/fakes.ts";
import type { AppendableDomainEvent, Clock, IdGen, ThreadStore } from "../services.ts";
import { createThreadStore } from "./index.ts";

const threadDirOf = (root: string, id: string): string => path.join(root, "threads", id);
const statePathOf = (root: string, id: string): string =>
  path.join(threadDirOf(root, id), "state.json");

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "orq-agent-store-snap-"));
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

/** A thread with a log, and the fold of exactly that log. */
async function seeded(store: ThreadStore, threadId = "t1") {
  const appended = await store.append({
    threadId,
    events: [created(threadId), say(threadId, "m1", "ñandú 🎉"), say(threadId, "m2", "second")]
  });
  return { appended, state: foldThread(appended.events) };
}

/**
 * A fold that has seen one event the log never got: self-consistent (its
 * head and state are at `seq + 1`), so nothing but a comparison with the log
 * can tell it is ahead.
 */
function foldAheadOf(events: readonly DomainEvent[], threadId: string) {
  const last = events[events.length - 1]!;
  const beyond = { ...say(threadId, "never-logged", "ahead"), seq: last.seq + 1 } as DomainEvent;
  return foldThread([...events, beyond]);
}

test("a saved fold snapshot loads back as written, on a reopened store", async () => {
  const rootDir = await tempRoot();
  const clock = fixedClock("2026-02-03T04:05:06.000Z");
  const store = createThreadStore({ rootDir, clock, idGen: countingIds() });
  const { appended, state } = await seeded(store);

  await store.saveFoldSnapshot({
    threadId: "t1",
    seq: appended.seq,
    logBytes: appended.logBytes,
    state,
    extras: { revertedTo: null, titleManual: true }
  });

  const reopened = createThreadStore({ rootDir, clock, idGen: countingIds() });
  const loaded = await reopened.loadFoldSnapshot("t1");
  assert.ok(loaded, "the snapshot must load");
  assert.equal(loaded.version, FOLD_SNAPSHOT_VERSION);
  assert.equal(loaded.threadId, "t1");
  assert.equal(loaded.seq, 3);
  assert.equal(loaded.logBytes, appended.logBytes);
  assert.equal(loaded.writtenAt, "2026-02-03T04:05:06.000Z");
  assert.deepEqual(loaded.extras, { revertedTo: null, titleManual: true });
  assert.deepEqual(deserializeFoldState(loaded.state), state);

  // And its cursor is one the log honours.
  const tail = await reopened.readEventsFrom("t1", {
    byteOffset: loaded.logBytes,
    afterSeq: loaded.seq
  });
  assert.equal(tail.mismatch, false);
  assert.deepEqual(tail.events, []);
});

test("extras are optional and stay absent when none were given", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store);

  await store.saveFoldSnapshot({ threadId: "t1", seq: appended.seq, logBytes: appended.logBytes, state });

  const raw = JSON.parse(await fs.readFile(statePathOf(rootDir, "t1"), "utf8")) as object;
  assert.equal("extras" in raw, false);
  const loaded = await store.loadFoldSnapshot("t1");
  assert.ok(loaded);
  assert.equal(loaded.extras, undefined);
});

test("state.json sits where @orquester/config says, 0600, written by rename", async () => {
  const appdir = await tempRoot();
  // `rootDir` is `<appdir>/daemon/agent`, exactly as the host wires it.
  const rootDir = agentChatDir(appdir);
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store);

  await store.saveFoldSnapshot({ threadId: "t1", seq: appended.seq, logBytes: appended.logBytes, state });

  const stat = await fs.stat(agentChatThreadStatePath(appdir, "t1"));
  assert.equal(stat.mode & 0o777, 0o600);
  const entries = await fs.readdir(threadDirOf(rootDir, "t1"));
  assert.deepEqual(entries.filter((entry) => entry.includes(".tmp")), []);
});

test("a missing, corrupt, other-version or other-thread snapshot loads as null", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store, "t1");
  await seeded(store, "t2");

  assert.equal(await store.loadFoldSnapshot("t1"), null, "no state.json yet");
  assert.equal(await store.loadFoldSnapshot("never"), null, "no thread at all");

  await store.saveFoldSnapshot({ threadId: "t1", seq: appended.seq, logBytes: appended.logBytes, state });
  const good = JSON.parse(await fs.readFile(statePathOf(rootDir, "t1"), "utf8")) as Record<
    string,
    unknown
  >;

  // Another thread's file, copied into t2's directory.
  await fs.writeFile(statePathOf(rootDir, "t2"), JSON.stringify(good));
  assert.equal(await store.loadFoldSnapshot("t2"), null, "another thread's snapshot");

  const variants: Array<[string, string]> = [
    ["corrupt JSON", "{ not json"],
    ["a newer version", JSON.stringify({ ...good, version: FOLD_SNAPSHOT_VERSION + 1 })],
    ["an older version", JSON.stringify({ ...good, version: FOLD_SNAPSHOT_VERSION - 1 })],
    ["not a snapshot at all", JSON.stringify([good])],
    ["a state that is not a fold", JSON.stringify({ ...good, state: "nope" })]
  ];
  for (const [label, contents] of variants) {
    await fs.writeFile(statePathOf(rootDir, "t1"), contents);
    assert.equal(await store.loadFoldSnapshot("t1"), null, label);
  }
});

test("loadFoldSnapshot never throws, even for an unusable thread id", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  for (const bad of ["../escape", "", "a/b"]) {
    assert.equal(await store.loadFoldSnapshot(bad), null, bad);
  }
});

test("a snapshot file AHEAD of the log is discarded, never trusted", async () => {
  // Written after the append it covers, a snapshot can only trail the log. One
  // that claims more (a log restored from an older backup, a hand edit) would
  // make the fold drop every event appended up to its seq.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store);
  await store.saveFoldSnapshot({ threadId: "t1", seq: appended.seq, logBytes: appended.logBytes, state });
  const good = JSON.parse(await fs.readFile(statePathOf(rootDir, "t1"), "utf8")) as Record<
    string,
    unknown
  >;

  const variants: Array<[string, Record<string, unknown>]> = [
    [
      "a seq past the log's last line",
      { seq: appended.seq + 1, state: serializeFoldState(foldAheadOf(appended.events, "t1")) }
    ],
    ["a byte offset past the log's end", { logBytes: appended.logBytes + 100 }]
  ];
  for (const [label, claim] of variants) {
    const planted = { ...good, ...claim };
    assert.ok(parseFoldSnapshotFile(planted, "t1"), `precondition: ${label} is a valid file`);
    await fs.writeFile(statePathOf(rootDir, "t1"), JSON.stringify(planted));
    const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
    assert.equal(await reopened.loadFoldSnapshot("t1"), null, label);
  }
});

test("a save the log cannot honour is never written", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store);
  await store.saveFoldSnapshot({ threadId: "t1", seq: appended.seq, logBytes: appended.logBytes, state });

  const claims = [
    { seq: appended.seq + 1, logBytes: appended.logBytes, state: foldAheadOf(appended.events, "t1") },
    { seq: appended.seq, logBytes: appended.logBytes + 1, state }
  ];
  for (const claim of claims) {
    await store.saveFoldSnapshot({ threadId: "t1", ...claim });
    const loaded = await store.loadFoldSnapshot("t1");
    // The earlier, honest snapshot is still the one on disk.
    assert.equal(loaded?.seq, appended.seq, `seq ${claim.seq}`);
    assert.equal(loaded?.logBytes, appended.logBytes, `logBytes ${claim.logBytes}`);
  }
});

test("a save whose state is not folded to its seq is refused loudly", async () => {
  // Such a file could never load (the parser demands state.seq === seq), so
  // writing it would be a silent, permanent cache miss.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store);

  await assert.rejects(
    store.saveFoldSnapshot({ threadId: "t1", seq: appended.seq - 1, logBytes: appended.logBytes, state }),
    /seq/
  );
  await assert.rejects(fs.stat(statePathOf(rootDir, "t1")), { code: "ENOENT" });
});

test("deleteThread removes the snapshot with the thread", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store);
  await store.saveFoldSnapshot({ threadId: "t1", seq: appended.seq, logBytes: appended.logBytes, state });
  await fs.stat(statePathOf(rootDir, "t1"));

  await store.deleteThread("t1");

  await assert.rejects(fs.stat(statePathOf(rootDir, "t1")), { code: "ENOENT" });
  assert.equal(await store.loadFoldSnapshot("t1"), null);
});

test("a snapshot save queued behind a delete does not bring the thread back", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store);

  // Fire-and-forget, as the orchestrator does, landing after the delete.
  const deleting = store.deleteThread("t1");
  const saving = store.saveFoldSnapshot({
    threadId: "t1",
    seq: appended.seq,
    logBytes: appended.logBytes,
    state
  });
  await Promise.all([deleting, saving]);
  await store.drain();

  await assert.rejects(fs.stat(threadDirOf(rootDir, "t1")), { code: "ENOENT" });
  assert.deepEqual(await store.listThreads(), []);
});

test("the snapshot is what the caller handed over at call time", async () => {
  // Saves are fire-and-forget on the write queue while the caller keeps
  // folding: what lands must be the state AS OF `seq`, not whatever the
  // caller's objects hold by the time the queue reaches it.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const { appended, state } = await seeded(store);

  const extras: Record<string, unknown> = { revertedTo: 1 };
  const saving = store.saveFoldSnapshot({
    threadId: "t1",
    seq: appended.seq,
    logBytes: appended.logBytes,
    state,
    extras
  });
  extras.revertedTo = 2;
  await saving;

  const loaded = await store.loadFoldSnapshot("t1");
  assert.deepEqual(loaded?.extras, { revertedTo: 1 });
});

test("two saves land in call order: the later one wins", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const first = await store.append({ threadId: "t1", events: [created(), say("t1", "m1", "ñ")] });
  const second = await store.append({ threadId: "t1", events: [say("t1", "m2", "🎉")] });

  void store.saveFoldSnapshot({
    threadId: "t1",
    seq: first.seq,
    logBytes: first.logBytes,
    state: foldThread(first.events)
  });
  void store.saveFoldSnapshot({
    threadId: "t1",
    seq: second.seq,
    logBytes: second.logBytes,
    state: foldThread([...first.events, ...second.events])
  });
  await store.drain();

  assert.equal((await store.loadFoldSnapshot("t1"))?.seq, second.seq);
});

// --- the contract, real store and fake alike -----------------------------------

async function snapshotContract(store: ThreadStore): Promise<void> {
  const { appended, state } = await seeded(store, "s1");
  await seeded(store, "s2");

  assert.equal(await store.loadFoldSnapshot("s1"), null);
  await store.saveFoldSnapshot({
    threadId: "s1",
    seq: appended.seq,
    logBytes: appended.logBytes,
    state,
    extras: { titleManual: true }
  });
  await store.drain();

  const loaded = await store.loadFoldSnapshot("s1");
  assert.ok(loaded);
  assert.equal(loaded.version, FOLD_SNAPSHOT_VERSION);
  assert.equal(loaded.threadId, "s1");
  assert.equal(loaded.seq, appended.seq);
  assert.equal(loaded.logBytes, appended.logBytes);
  assert.deepEqual(loaded.extras, { titleManual: true });
  assert.deepEqual(deserializeFoldState(loaded.state), state);
  assert.equal(await store.loadFoldSnapshot("s2"), null, "a snapshot is per thread");

  // Ahead of the log: never served.
  await store.saveFoldSnapshot({
    threadId: "s1",
    seq: appended.seq + 1,
    logBytes: appended.logBytes,
    state: foldAheadOf(appended.events, "s1")
  });
  await store.drain();
  assert.equal((await store.loadFoldSnapshot("s1"))?.seq, appended.seq);

  await store.deleteThread("s1");
  assert.equal(await store.loadFoldSnapshot("s1"), null, "deleted with its thread");
}

test("the real store keeps the snapshot contract", async () => {
  const rootDir = await tempRoot();
  await snapshotContract(createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() }));
});

test("the fake store keeps the same snapshot contract, and exposes what it holds", async () => {
  const store = createFakeThreadStore();
  await snapshotContract(store);

  // Tests reach into `snapshots` to plant a stale or broken cache, and the
  // fake refuses it exactly as the real store refuses the file.
  const { appended, state } = await seeded(store, "s3");
  await store.saveFoldSnapshot({ threadId: "s3", seq: appended.seq, logBytes: appended.logBytes, state });
  const held = store.snapshots.get("s3");
  assert.ok(held);
  assert.equal(held.seq, appended.seq);

  store.snapshots.set("s3", { ...held, version: FOLD_SNAPSHOT_VERSION + 1 });
  assert.equal(await store.loadFoldSnapshot("s3"), null, "a planted bad version is refused");

  const ahead = {
    ...held,
    seq: appended.seq + 1,
    state: serializeFoldState(foldAheadOf(appended.events, "s3"))
  };
  assert.ok(parseFoldSnapshotFile(ahead, "s3"), "precondition: a valid file");
  store.snapshots.set("s3", ahead);
  assert.equal(await store.loadFoldSnapshot("s3"), null, "a planted snapshot ahead of the log");

  store.snapshots.set("s3", { ...held, logBytes: appended.logBytes + 1 });
  assert.equal(await store.loadFoldSnapshot("s3"), null, "planted bytes past the log's end");
});

// --- the attachment sweep reads references off the snapshot ------------------------

/** The sweep compares REAL file mtimes, so its clock moves relative to now. */
function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function writeSource(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(8, 1));
  return filePath;
}

function withFiles(event: AppendableDomainEvent, refs: AttachmentRef[]): AppendableDomainEvent {
  const message = event as Extract<AppendableDomainEvent, { type: "thread.message-sent" }>;
  return { ...message, payload: { ...message.payload, attachments: refs } } as AppendableDomainEvent;
}

function assistantWithFiles(
  threadId: string,
  id: string,
  turnId: string,
  refs: AttachmentRef[]
): AppendableDomainEvent {
  return {
    eventId: `e-${id}`,
    threadId,
    type: "thread.message-sent",
    payload: { messageId: id, role: "assistant", text: id, streaming: false, turnId, attachments: refs },
    occurredAt: "2026-01-01T00:00:02.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as AppendableDomainEvent;
}

function reverted(threadId: string, turnCount: number): AppendableDomainEvent {
  return {
    eventId: `e-revert-${threadId}`,
    threadId,
    type: "thread.reverted",
    payload: { turnCount },
    occurredAt: "2026-01-01T00:00:03.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as AppendableDomainEvent;
}

async function survivors(
  store: ThreadStore,
  threadId: string,
  refs: Record<string, AttachmentRef>
): Promise<string[]> {
  const alive: string[] = [];
  for (const [label, ref] of Object.entries(refs)) {
    try {
      await store.resolveAttachment(threadId, ref.id);
      alive.push(label);
    } catch {
      continue;
    }
  }
  return alive;
}

/**
 * Three threads, swept host-wide the way the boot sweep does it:
 * - `keep`: A in the snapshot's part of the log, C in the tail, B an orphan;
 * - `undo`: E in the snapshot's part, then a tail that adds D and REVERTS to
 *   zero turns (dropping E and D), then adds F;
 * - `plain`: never snapshotted — G referenced, H an orphan.
 */
async function sweepScenario(snapshots: boolean): Promise<Record<string, string[]>> {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const src = path.join(rootDir, "src");
  const put = async (threadId: string, label: string) =>
    store.putAttachment({
      threadId,
      name: `${label}.bin`,
      sourcePath: await writeSource(src, `${threadId}-${label}.bin`)
    });
  const snapshotHere = async (threadId: string, events: DomainEvent[], logBytes: number) => {
    if (snapshots) {
      await store.saveFoldSnapshot({
        threadId,
        seq: events[events.length - 1]!.seq,
        logBytes,
        state: foldThread(events)
      });
    }
  };

  const keep = { A: await put("keep", "A"), B: await put("keep", "B"), C: await put("keep", "C") };
  const keepHead = await store.append({
    threadId: "keep",
    events: [created("keep"), withFiles(say("keep", "m1", "a"), [keep.A])]
  });
  await snapshotHere("keep", keepHead.events, keepHead.logBytes);
  await store.append({ threadId: "keep", events: [withFiles(say("keep", "m2", "c"), [keep.C])] });

  const undo = { D: await put("undo", "D"), E: await put("undo", "E"), F: await put("undo", "F") };
  const undoHead = await store.append({
    threadId: "undo",
    events: [created("undo"), withFiles(say("undo", "m1", "e"), [undo.E])]
  });
  await snapshotHere("undo", undoHead.events, undoHead.logBytes);
  await store.append({
    threadId: "undo",
    events: [
      assistantWithFiles("undo", "a1", "T-9", [undo.D]),
      reverted("undo", 0),
      withFiles(say("undo", "m3", "f"), [undo.F])
    ]
  });

  const plain = { G: await put("plain", "G"), H: await put("plain", "H") };
  await store.append({
    threadId: "plain",
    events: [created("plain"), withFiles(say("plain", "m1", "g"), [plain.G])]
  });
  await store.drain();

  await store.pruneAttachments({ now: hoursFromNow(48) });
  return {
    keep: await survivors(store, "keep", keep),
    undo: await survivors(store, "undo", undo),
    plain: await survivors(store, "plain", plain)
  };
}

test("the sweep keeps exactly the same attachments with snapshots as without them", async () => {
  const withSnapshots = await sweepScenario(true);
  const withoutSnapshots = await sweepScenario(false);
  // Hand-derived: the tail's revert drops E (which the snapshot alone still
  // references) and D; a thread with no snapshot sweeps as it always did.
  assert.deepEqual(withSnapshots, { keep: ["A", "C"], undo: ["F"], plain: ["G"] });
  assert.deepEqual(withoutSnapshots, withSnapshots);
});

test("with a snapshot, the sweep reads the log only past the snapshot's cursor", async () => {
  // Proven with damage only a whole-log read can see: an early line corrupted
  // AFTER the snapshot folded it. A whole-log fold stops there and loses every
  // reference from that line on; the snapshot and its tail do not.
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const src = path.join(rootDir, "src");
  const a = await store.putAttachment({ threadId: "t1", name: "a.bin", sourcePath: await writeSource(src, "a.bin") });
  const c = await store.putAttachment({ threadId: "t1", name: "c.bin", sourcePath: await writeSource(src, "c.bin") });
  const head = await store.append({
    threadId: "t1",
    events: [created(), withFiles(say("t1", "m1", "a"), [a])]
  });
  await store.saveFoldSnapshot({
    threadId: "t1",
    seq: head.seq,
    logBytes: head.logBytes,
    state: foldThread(head.events)
  });
  await store.append({ threadId: "t1", events: [withFiles(say("t1", "m2", "c"), [c])] });
  await store.drain();

  const eventsPath = path.join(threadDirOf(rootDir, "t1"), "events.ndjson");
  const bytes = await fs.readFile(eventsPath);
  const early = head.positions[1]!;
  bytes.fill(0x78, early.byteOffset, early.byteOffset + early.byteLength - 1);
  await fs.writeFile(eventsPath, bytes);

  const warm = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await warm.pruneAttachments({ now: hoursFromNow(48) });
  assert.deepEqual(await survivors(warm, "t1", { a, c }), ["a", "c"]);

  // The control: the same sweep without the snapshot reads the whole log.
  await fs.rm(statePathOf(rootDir, "t1"));
  const cold = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await cold.pruneAttachments({ now: hoursFromNow(48) });
  assert.deepEqual(await survivors(cold, "t1", { a, c }), []);
});

test("a snapshot whose cursor the log does not honour is ignored: the sweep reads the whole log", async () => {
  const rootDir = await tempRoot();
  const store = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  const src = path.join(rootDir, "src");
  const put = async (label: string) =>
    store.putAttachment({ threadId: "t1", name: `${label}.bin`, sourcePath: await writeSource(src, `${label}.bin`) });
  const a = await put("a");
  const c = await put("c");
  const x = await put("x");
  const head = await store.append({
    threadId: "t1",
    events: [created(), withFiles(say("t1", "m1", "a"), [a])]
  });
  const tail = await store.append({ threadId: "t1", events: [withFiles(say("t1", "m2", "c"), [c])] });

  // A snapshot that remembers a different second message (x, not a), with a
  // cursor pointing inside the tail's line: its state must not be used.
  const [createdEvent] = head.events;
  const otherSecond = { ...withFiles(say("t1", "m1", "x"), [x]), seq: 2 } as DomainEvent;
  await store.saveFoldSnapshot({
    threadId: "t1",
    seq: 2,
    logBytes: head.logBytes,
    state: foldThread([createdEvent!, otherSecond])
  });
  await store.drain();
  const file = JSON.parse(await fs.readFile(statePathOf(rootDir, "t1"), "utf8")) as Record<string, unknown>;
  await fs.writeFile(
    statePathOf(rootDir, "t1"),
    JSON.stringify({ ...file, logBytes: tail.positions[0]!.byteOffset + 1 })
  );

  const reopened = createThreadStore({ rootDir, clock: fixedClock(), idGen: countingIds() });
  await reopened.pruneAttachments({ now: hoursFromNow(48) });
  assert.deepEqual(await survivors(reopened, "t1", { a, c, x }), ["a", "c"]);
});
