/**
 * Host updates (spec 2026-11-01 P2.3 R16, R18): the store beside another host. Its sweeps never
 * touch a thread that host serves, a retiring host sweeps nothing, and a thread of another host is
 * read without a write — no torn tail cut, no cache entry — for a fork that reads its parent.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";

import type { AppendableDomainEvent } from "../services.ts";
import { createThreadStore } from "./index.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orq-agent-store-foreign-"));
  roots.push(root);
  return root;
}

function created(threadId: string): AppendableDomainEvent {
  return {
    eventId: `e-created-${threadId}`,
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

async function stalePart(rootDir: string, threadId: string): Promise<string> {
  const dir = path.join(rootDir, "threads", threadId, "attachments");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "attachment-stale.part");
  await fs.writeFile(file, "half an upload");
  const long = new Date(Date.now() - 6 * 60 * 60_000);
  await fs.utimes(file, long, long);
  return file;
}

const exists = (file: string): Promise<boolean> =>
  fs.stat(file).then(
    () => true,
    () => false
  );

test("the boot sweep and the scheduled one skip another host's thread, and a retiring host sweeps nothing", async (t) => {
  const rootDir = await tempRoot();
  let retiring = false;
  const store = createThreadStore({
    rootDir,
    sweepScope: { owns: (threadId) => threadId !== "theirs", suspended: () => retiring }
  });
  t.after(() => store.close());
  for (const threadId of ["ours", "theirs"]) await store.append({ threadId, events: [created(threadId)] });

  const theirs = await stalePart(rootDir, "theirs");
  let ours = await stalePart(rootDir, "ours");
  await store.sweepStartup();
  assert.equal(await exists(ours), false, "its own partial upload is collected");
  assert.equal(await exists(theirs), true, "another host's thread is never swept");

  ours = await stalePart(rootDir, "ours");
  await store.pruneAttachments();
  assert.equal(await exists(ours), false);
  assert.equal(await exists(theirs), true);

  retiring = true;
  ours = await stalePart(rootDir, "ours");
  await store.pruneAttachments();
  await store.sweepStartup();
  assert.equal(await exists(ours), true, "a retiring host leaves every sweep to the primary");
});

test("a read-only read of another host's thread leaves its files byte for byte, a half-written line included", async (t) => {
  const rootDir = await tempRoot();
  const writer = createThreadStore({ rootDir });
  t.after(() => writer.close());
  await writer.append({ threadId: "theirs", events: [created("theirs")] });
  // `meta.json`, as the writing host's orchestrator saves it on every head-shaped change.
  await writer.saveHead((await writer.loadHead("theirs"))!);
  await writer.drain();
  const events = path.join(rootDir, "threads", "theirs", "events.ndjson");
  // The other host is in the middle of appending its next line.
  await fs.appendFile(events, '{"seq":2,"half');
  const before = await fs.readFile(events, "utf8");

  const reader = createThreadStore({ rootDir });
  t.after(() => reader.close());
  const read = await reader.readThreadReadOnly("theirs");
  assert.equal(read?.head?.id, "theirs");
  assert.deepEqual(read?.events.map((event) => event.seq), [1], "only complete lines");
  assert.equal(await fs.readFile(events, "utf8"), before, "no torn tail was cut under the writer");
  assert.equal(await reader.readThreadReadOnly("missing"), null);
});
