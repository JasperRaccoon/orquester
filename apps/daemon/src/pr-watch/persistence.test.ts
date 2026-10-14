/**
 * Pull request watches — the watches file on disk: atomic writes that leave nothing behind, and a
 * read that never overwrites what it cannot read.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { PullRequestWatchError, writeAtomic } from "./service.ts";
import { cleanupHarnesses, harness, prStatus, REMOTE, type Harness } from "./testing.ts";

test("a write whose rename fails leaves no temp file behind", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-pr-watch-write-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The target is a directory: the rename fails after the temp file was written.
  const target = join(dir, "pr-watches.json");
  await mkdir(target);
  await assert.rejects(writeAtomic(target, "{}"));
  assert.deepEqual(await readdir(dir), ["pr-watches.json"]);
});

test("a write lands whole, 0600", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-pr-watch-write-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "pr-watches.json");
  await writeAtomic(target, '{"version":1}');
  assert.deepEqual(await readdir(dir), ["pr-watches.json"]);
});

// ---------------------------------------------------------------------------
// Reading the file (D-I2): tolerant of a newer build, never overwriting what it cannot read
// ---------------------------------------------------------------------------

const KEY = `${REMOTE}#12`;

async function created(h: Harness) {
  h.pulls.set(KEY, prStatus());
  const result = await h.service.create("s1", { number: 12 });
  await h.service.idle();
  return result;
}

test("a corrupt watches file or another version is moved aside, never overwritten", async (t) => {
  t.after(cleanupHarnesses);
  for (const body of ["{not json", JSON.stringify({ version: 2, watches: [{ from: "the future" }] })]) {
    const h = await harness();
    await mkdir(dirname(h.file), { recursive: true });
    await writeFile(h.file, body);
    await h.restart();
    const files = await readdir(dirname(h.file));
    const aside = files.find((name) => name.startsWith("pr-watches.json.corrupt-"));
    assert.ok(aside, `moved aside: ${files.join(", ")}`);
    assert.equal(await readFile(join(dirname(h.file), aside), "utf8"), body, "kept as it was");
    // The service works on from an empty list.
    assert.equal((await created(h)).created, true);
  }
});

test("an unreadable watches file makes the watches read-only for the run: nothing is written over it", async (t) => {
  t.after(cleanupHarnesses);
  const h = await harness();
  // A directory where the file should be: the read fails with EISDIR, not ENOENT.
  await mkdir(h.file, { recursive: true });
  await h.restart();
  h.pulls.set(KEY, prStatus());
  await assert.rejects(h.service.create("s1", { number: 12 }), (error: unknown) => error instanceof PullRequestWatchError && error.status === 503);
  assert.ok((await stat(h.file)).isDirectory(), "left as it was");
});

test("unknown top-level keys of a newer build survive a rewrite", async (t) => {
  t.after(cleanupHarnesses);
  const h = await harness();
  await mkdir(dirname(h.file), { recursive: true });
  await writeFile(h.file, JSON.stringify({ version: 1, watches: [], fromNewerBuild: { keep: true } }));
  await h.restart();
  await created(h);
  const disk = JSON.parse(await readFile(h.file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(disk.fromNewerBuild, { keep: true });
  assert.equal((disk.watches as unknown[]).length, 1);
});
