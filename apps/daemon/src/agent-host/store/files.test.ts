/**
 * The store's file primitives (§5.1): tmp + rename, and the torn-line rules
 * the log readers depend on.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  atomicWriteFile,
  readFileOrNull,
  readLastCompleteLine,
  splitCompleteLines
} from "./files.ts";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "orq-store-files-"));
}

test("atomicWriteFile leaves no temp file behind and overwrites in place", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "nested", "meta.json");
  await atomicWriteFile(filePath, "first\n");
  await atomicWriteFile(filePath, "second\n");
  assert.equal(await fs.readFile(filePath, "utf8"), "second\n");
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ["meta.json"]);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test("readFileOrNull answers null for a missing file and rethrows otherwise", async () => {
  const dir = await tempDir();
  assert.equal(await readFileOrNull(path.join(dir, "nope")), null);
  await assert.rejects(readFileOrNull(dir), /EISDIR/);
});

test("splitCompleteLines drops a torn trailing fragment and reports it", () => {
  assert.deepEqual(splitCompleteLines(""), { lines: [], torn: false });
  assert.deepEqual(splitCompleteLines("a\nb\n"), { lines: ["a", "b"], torn: false });
  assert.deepEqual(splitCompleteLines("a\nb"), { lines: ["a"], torn: true });
  assert.deepEqual(splitCompleteLines("only-a-fragment"), { lines: [], torn: true });
});

test("readLastCompleteLine finds the tail without reading the whole file", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "events.ndjson");

  assert.equal(await readLastCompleteLine(filePath), null, "a missing file has no tail");
  await fs.writeFile(filePath, "");
  assert.equal(await readLastCompleteLine(filePath), null, "an empty file has no tail");

  const lines = Array.from({ length: 5_000 }, (_unused, index) =>
    JSON.stringify({ seq: index + 1, filler: "x".repeat(200) })
  );
  await fs.writeFile(filePath, `${lines.join("\n")}\n`);
  const last = await readLastCompleteLine(filePath);
  assert.equal((JSON.parse(last!) as { seq: number }).seq, 5_000);

  // A torn trailing write must not become the answer.
  await fs.appendFile(filePath, '{"seq":5001,"fill');
  const afterTear = await readLastCompleteLine(filePath);
  assert.equal((JSON.parse(afterTear!) as { seq: number }).seq, 5_000);
});

test("readLastCompleteLine handles a file shorter than one window", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "events.ndjson");
  await fs.writeFile(filePath, '{"seq":1}\n');
  assert.equal(await readLastCompleteLine(filePath), '{"seq":1}');
});
