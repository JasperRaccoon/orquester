import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { localBoxConnection } from "./testing.ts";

async function extractionPath(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orq-local-tar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "out");
}

function closingExtractor(source: PassThrough, code: number) {
  let bytes = 0;
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; kill(): boolean };
  child.stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback();
      child.stdin.destroy();
    }
  });
  child.stdin.once("close", () => {
    // The extractor has accepted the archive. Its stdin closes before the
    // producer emits its final padding and EOF, without relying on timers.
    child.emit("exit", code);
    source.end(Buffer.from("padding"));
  });
  child.kill = () => false;
  return { spawnTar: (() => child) as unknown as typeof spawn, bytes: () => bytes };
}

test("local tar writes drain the source when a successful extractor closes stdin before source EOF", async (t) => {
  const path = await extractionPath(t);
  const source = new PassThrough();
  const extractor = closingExtractor(source, 0);
  const connection = localBoxConnection({ spawnTar: extractor.spawnTar });
  source.write(Buffer.from("archive"));
  await connection.writeTar(path, source);
  assert.equal(extractor.bytes(), 7);
  assert.equal(source.readableEnded, true, "the source must be consumed through its EOF");
});

test("local tar writes reject an extractor failure even when its stdin closed early", async (t) => {
  const path = await extractionPath(t);
  const source = new PassThrough();
  const extractor = closingExtractor(source, 2);
  const connection = localBoxConnection({ spawnTar: extractor.spawnTar });
  source.write(Buffer.from("archive"));
  await assert.rejects(connection.writeTar(path, source), /tar exited 2/);
});

test("local tar writes preserve source failures and stop the extractor", async (t) => {
  const path = await extractionPath(t);
  const source = new PassThrough();
  const failure = new Error("archive source failed");
  let stopped = false;
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; kill(): boolean };
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
      source.destroy(failure);
    }
  });
  child.kill = () => {
    stopped = true;
    child.emit("exit", null);
    return true;
  };
  const connection = localBoxConnection({ spawnTar: (() => child) as unknown as typeof spawn });
  source.write(Buffer.from("archive"));
  await assert.rejects(connection.writeTar(path, source), (error) => error === failure);
  assert.equal(stopped, true);
});

test("local tar writes propagate extractor spawn failures", async (t) => {
  const path = await extractionPath(t);
  const source = new PassThrough();
  const failure = new Error("tar does not exist");
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; kill(): boolean };
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.kill = () => false;
  const spawnTar = (() => {
    queueMicrotask(() => child.emit("error", failure));
    return child;
  }) as unknown as typeof spawn;
  const connection = localBoxConnection({ spawnTar });
  source.write(Buffer.from("archive"));
  await assert.rejects(connection.writeTar(path, source), (error) => error === failure);
});
