import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BoxConnection } from "../contracts.ts";
import { localBoxConnection } from "../testing.ts";
import { execBoxHasher, readBoxFile } from "./box-fs.ts";

type ReadOptions = Parameters<BoxConnection["readFile"]>[1];

/** A local box whose `readFile` calls are recorded (and whose `exec` can be made to fail). */
function spyBox(options: { failExec?: boolean } = {}): { connection: BoxConnection; reads: { path: string; options: ReadOptions }[] } {
  const inner = localBoxConnection();
  const reads: { path: string; options: ReadOptions }[] = [];
  const connection = Object.create(inner) as BoxConnection;
  connection.readFile = (path, readOptions) => {
    reads.push({ path, options: readOptions });
    return inner.readFile(path, readOptions);
  };
  if (options.failExec) {
    connection.exec = () => {
      throw new Error("no exec in this box");
    };
  }
  return { connection, reads };
}

async function scratch(t: test.TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orq-box-fs-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("readBoxFile always names a length: the stat's size, or what is left past the offset", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "f.txt");
  await writeFile(file, "0123456789");
  const { connection, reads } = spyBox();

  assert.equal((await readBoxFile(connection, file))?.toString(), "0123456789");
  assert.equal(reads.at(-1)?.options?.length, 10);
  assert.equal((await readBoxFile(connection, file, { offset: 4 }))?.toString(), "456789");
  assert.equal(reads.at(-1)?.options?.length, 6);
  assert.equal(reads.at(-1)?.options?.offset, 4);
  assert.equal((await readBoxFile(connection, file, { offset: 2, length: 3 }))?.toString(), "234");
  assert.equal(reads.at(-1)?.options?.length, 3);
  // An explicit length past the file asks for at most one byte over the limit.
  assert.equal((await readBoxFile(connection, file, { length: 1_000, maxBytes: 100 }))?.toString(), "0123456789");
  assert.equal(reads.at(-1)?.options?.length, 101);

  const reading = reads.length;
  await writeFile(file, "");
  assert.equal((await readBoxFile(connection, file))?.length, 0, "an empty file needs no read");
  assert.equal(await readBoxFile(connection, join(dir, "missing")), null);
  assert.equal(reads.length, reading);
});

test("readBoxFile refuses a file the stat shows past maxBytes before reading a byte", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "big.bin");
  await writeFile(file, Buffer.alloc(64, 1));
  const { connection, reads } = spyBox();

  await assert.rejects(readBoxFile(connection, file, { maxBytes: 63 }), /larger than 63 bytes/);
  await assert.rejects(readBoxFile(connection, file, { length: 64, maxBytes: 63 }), /larger than 63 bytes/);
  assert.equal(reads.length, 0);
  assert.equal((await readBoxFile(connection, file, { maxBytes: 64 }))?.length, 64, "a file at the limit is read");
  assert.equal((await readBoxFile(connection, file, { offset: 1, maxBytes: 63 }))?.length, 63, "the limit counts the bytes read");
  for (const maxBytes of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5]) {
    await assert.rejects(readBoxFile(connection, file, { maxBytes }), RangeError, String(maxBytes));
  }
});

test("the read-back hasher (no hash tool in the box) hashes whole files and requested prefixes", async (t) => {
  const dir = await scratch(t);
  await writeFile(join(dir, "a"), "hello");
  await writeFile(join(dir, "b"), "hello world");
  const { connection } = spyBox({ failExec: true });

  const [whole, prefix, missing] = await execBoxHasher(connection, [{ path: join(dir, "a") }, { path: join(dir, "b"), length: 5 }, { path: join(dir, "c") }]);
  const helloSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  assert.deepEqual([whole, prefix], [helloSha256, helloSha256]);
  assert.equal(missing, null);
});
