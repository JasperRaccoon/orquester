/**
 * Box tooling installs — `readBoxText`: a small box file is read with a length (the stat's size),
 * a file past the cap is not read, and a box that sends more than the cap is cut off.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import type { BoxConnection } from "../contracts.ts";
import { localBoxConnection } from "../testing.ts";
import { readBoxText } from "./install.ts";

const ROOT = mkdtempSync(join(tmpdir(), "orq-tooling-install-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test("readBoxText reads with the stat's size as its length", async () => {
  const connection = localBoxConnection({ sys: { home: ROOT } });
  const reads: (number | undefined)[] = [];
  const readFile = connection.readFile.bind(connection);
  connection.readFile = (path, options) => {
    reads.push(options?.length);
    return readFile(path, options);
  };
  writeFileSync(join(ROOT, "version"), "1.2.3\n");
  assert.equal(await readBoxText(connection, join(ROOT, "version")), "1.2.3\n");
  assert.deepEqual(reads, [6]);
  assert.equal(await readBoxText(connection, join(ROOT, "missing")), null);
  writeFileSync(join(ROOT, "big"), "x".repeat(100));
  assert.equal(await readBoxText(connection, join(ROOT, "big"), 10), null);
  assert.deepEqual(reads, [6], "a file past the cap is not read");
});

test("readBoxText refuses a box that sends more than the cap", async () => {
  const connection = {
    request: async () => ({ kind: "file", size: 4, mode: 0o644, mtimeMs: 0 }),
    readFile: async () => Readable.from([Buffer.from("x".repeat(64))])
  } as unknown as BoxConnection;
  assert.equal(await readBoxText(connection, "/v", 16), null);
});
