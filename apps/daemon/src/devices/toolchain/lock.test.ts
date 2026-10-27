import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EMPTY_LOCK_STALE_MS, inspectLock, withLock } from "./lock.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orq-lock-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("lock: the pid file appears whole; the dir goes after the run", async () => {
  await withDir(async (dir) => {
    const path = join(dir, ".tool.lock");
    await withLock(path, new AbortController().signal, async () => {
      assert.equal((await readFile(join(path, "pid"), "utf8")).trim(), String(process.pid));
      assert.deepEqual((await readdir(path)).sort(), ["pid"], "no temp file left behind");
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
    const waiting = withLock(path, abort.signal, async () => "ran");
    setTimeout(() => abort.abort(), 700);
    await assert.rejects(waiting, "a young empty lock is not taken over");
    await writeFile(join(path, "pid"), "");
    const old = (Date.now() - EMPTY_LOCK_STALE_MS - 5_000) / 1000;
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
