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
import { HEAD_CHECKPOINT_EVENTS, createThreadStore } from "./index.ts";

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
  assert.equal(tail.truncated, true);
  assert.equal(tail.seq, 2);

  // And the next append lands at 3, not on top of the fragment.
  const appended = await reopened.append({ threadId: "t1", events: [message("t1", "m2")] });
  assert.equal(appended.seq, 3);
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
  // The same bytes as a plain file are under the 50 MiB file limit.
  const ref = await store.putAttachment({
    threadId: "t1",
    name: "big.png",
    mimeType: "application/octet-stream",
    sourcePath: big
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
