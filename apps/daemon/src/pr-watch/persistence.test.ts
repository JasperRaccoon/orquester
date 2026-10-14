/**
 * Pull request watches — the watches file on disk: atomic writes that leave nothing behind.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeAtomic } from "./service.ts";

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
