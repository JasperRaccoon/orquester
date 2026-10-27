import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { silentLogger } from "./test-fakes.ts";
import { VectorCache } from "./vector-cache.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const rows = (count: number, fill: number) => new Float32Array(count * 4).map((_, i) => fill + i);

async function dir(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "kg-vectors-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const open = (path: string, modelId = "m", logger = silentLogger(), versions: { chunker?: string; input?: string } = {}) =>
  VectorCache.open({ dir: path, modelId, dimensions: 4, chunker: versions.chunker ?? "c1", input: versions.input ?? "i1", logger });

test("another chunker or embedding input version discards the cache; so does a manifest written before the input version", async (t) => {
  const path = await dir(t);
  const cache = await open(path);
  await cache.put(H1, rows(1, 1));
  await cache.flush();
  assert.ok((await open(path)).get(H1), "same versions: kept");
  const logger = silentLogger();
  assert.equal((await open(path, "m", logger, { input: "i2" })).get(H1), null);
  assert.ok(logger.lines.some((l) => l.includes("embedding input")));
  // The discarded cache was replaced by an empty one for i2; back on i1 it is rebuilt again.
  assert.equal((await open(path)).get(H1), null);

  const path2 = await dir(t);
  const c2 = await open(path2);
  await c2.put(H2, rows(1, 2));
  await c2.flush();
  assert.equal((await open(path2, "m", silentLogger(), { chunker: "c2" })).get(H2), null);

  // A manifest from before `input` existed (no field) is from other embedding input.
  const path3 = await dir(t);
  const c3 = await open(path3);
  await c3.put(H3, rows(1, 3));
  await c3.flush();
  const manifest = JSON.parse(await readFile(join(path3, "vectors.json"), "utf8")) as Record<string, unknown>;
  delete manifest.input;
  await writeFile(join(path3, "vectors.json"), JSON.stringify(manifest));
  assert.equal((await open(path3)).get(H3), null);
  assert.deepEqual((await readdir(path3)).filter((n) => n.endsWith(".bin")), [], "the old vector file is removed");
});

test("rows survive a reopen; an interrupted append past the manifest is cut off", async (t) => {
  const path = await dir(t);
  const cache = await open(path);
  await cache.put(H1, rows(2, 10));
  await cache.put(H2, rows(1, 20));
  await cache.flush();
  const bin = (await readdir(path)).find((n) => n.endsWith(".bin"))!;
  await appendFile(join(path, bin), Buffer.alloc(12)); // half a row, never in the manifest
  const again = await open(path);
  assert.deepEqual([...again.get(H1)!], [...rows(2, 10)]);
  assert.deepEqual([...again.get(H2)!], [...rows(1, 20)]);
  assert.equal((await stat(join(path, bin))).size, 3 * 4 * 4);
  assert.equal(again.get(H3), null);
});

test("rows put but not flushed are dropped on reopen (the manifest is the truth)", async (t) => {
  const path = await dir(t);
  const cache = await open(path);
  await cache.put(H1, rows(1, 1));
  await cache.flush();
  await cache.put(H2, rows(1, 2));
  const again = await open(path);
  assert.ok(again.get(H1));
  assert.equal(again.get(H2), null);
  await again.put(H2, rows(1, 3));
  await again.flush();
  assert.deepEqual([...(await open(path)).get(H2)!], [...rows(1, 3)]);
});

test("another model, a corrupt manifest or a short file discards the cache", async (t) => {
  const path = await dir(t);
  const cache = await open(path);
  await cache.put(H1, rows(1, 1));
  await cache.flush();
  assert.equal((await open(path, "other")).get(H1), null);

  const path2 = await dir(t);
  const c2 = await open(path2);
  await c2.put(H1, rows(2, 1));
  await c2.flush();
  const bin = (await readdir(path2)).find((n) => n.endsWith(".bin"))!;
  await writeFile(join(path2, bin), Buffer.alloc(8));
  const logger = silentLogger();
  const reopened = await open(path2, "m", logger);
  assert.equal(reopened.get(H1), null);
  assert.ok(logger.lines.some((l) => l.includes("shorter")));
  await reopened.put(H1, rows(1, 1));
  await reopened.flush();
  await writeFile(join(path2, "vectors.json"), "{invalid JSON");
  assert.equal((await open(path2)).get(H1), null);
});

test("retain forgets dead hashes and compacts into a new generation", async (t) => {
  const path = await dir(t);
  const cache = await open(path);
  await cache.put(H1, rows(300, 1));
  await cache.put(H2, rows(1, 2));
  await cache.flush();
  const before = (await readdir(path)).filter((n) => n.endsWith(".bin"));
  await cache.retain(new Set([H2]));
  assert.equal(cache.get(H1), null);
  assert.deepEqual([...cache.get(H2)!], [...rows(1, 2)]);
  const after = (await readdir(path)).filter((n) => n.endsWith(".bin"));
  assert.equal(after.length, 1);
  assert.equal((await stat(join(path, after[0]!))).size, 16);
  assert.notEqual(before[0], after[0]);
  const again = await open(path);
  assert.deepEqual([...again.get(H2)!], [...rows(1, 2)]);
  assert.equal(again.get(H1), null);
});
