import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectLock, withLock } from "./lock.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orq-lock-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("lock: the owner pid is published while held and the lock is removed after the run", async () => {
  await withDir(async (dir) => {
    const path = join(dir, ".tool.lock");
    await withLock(path, new AbortController().signal, async () => {
      assert.equal((await readFile(join(path, "pid"), "utf8")).trim(), String(process.pid));
        });
    assert.deepEqual(await readdir(dir), []);
  });
});

test("lock: a young dir with no pid file is held (its owner is between mkdir and the rename); an old one is stale", async () => {
  await withDir(async (dir) => {
    const path = join(dir, ".tool.lock");
    await mkdir(path);
    assert.deepEqual(await inspectLock(path), { state: "held" });
    const abort = new AbortController();
    const cancelled = new Error("install cancelled");
    abort.abort(cancelled);
    await assert.rejects(withLock(path, abort.signal, async () => "ran"), (error) => error === cancelled);
    await writeFile(join(path, "pid"), "");
    const old = (Date.now() - 60_000) / 1000;
    await utimes(path, old, old);
    assert.equal((await inspectLock(path)).state, "stale");
    assert.equal(await withLock(path, new AbortController().signal, async () => "ran"), "ran");
  });
});

test("lock: a live owner holds it; a dead owner's lock is taken over", async () => {
  await withDir(async (dir) => {
    const path = join(dir, ".tool.lock");
    await mkdir(path);
    await writeFile(join(path, "pid"), String(process.ppid));
    assert.deepEqual(await inspectLock(path), { state: "held" });
    await writeFile(join(path, "pid"), "2147483646");
    assert.equal((await inspectLock(path)).state, "stale");
    assert.equal(await withLock(path, new AbortController().signal, async () => "ran"), "ran");
    assert.deepEqual(await readdir(dir), [], "the stale dir is gone too");
  });
});
