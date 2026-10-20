/**
 * Grok in a box — the config file a server's definition is read from (`readConfigSource`): a box
 * file is read with a length (the stat's size), and one past the size cap is not read at all.
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import type { BoxConnection } from "../../../boxes/contracts.ts";
import { readConfigSource } from "./box-launch.ts";

/** A Windows box (its paths map to the host only under `C:\orq`), whose one file is `content`. */
function windowsBox(content: string, size = Buffer.byteLength(content)) {
  const reads: { path: string; length?: number }[] = [];
  const connection = {
    request: async (method: string) => {
      assert.equal(method, "fs.stat");
      return { kind: "file", size, mode: 0o644, mtimeMs: 0 };
    },
    readFile: async (path: string, options?: { length?: number }) => {
      reads.push({ path, ...(options?.length !== undefined ? { length: options.length } : {}) });
      return Readable.from([Buffer.from(content)]);
    }
  } as unknown as BoxConnection;
  return { launch: { paths: { kind: "windows-prefix" as const, prefix: "C:\\orq" }, connection }, reads };
}

test("a box config file is read with the stat's size as its length", async () => {
  const { launch, reads } = windowsBox('[mcp_servers.x]\ncommand = "x"\n');
  const text = await readConfigSource(launch, "C:\\Users\\box\\.grok\\config.toml");
  assert.equal(text, '[mcp_servers.x]\ncommand = "x"\n');
  assert.deepEqual(reads, [{ path: "C:\\Users\\box\\.grok\\config.toml", length: 30 }]);
});

test("a box config file past the cap is not read", async () => {
  const { launch, reads } = windowsBox("{}", 2 * 1024 * 1024);
  assert.equal(await readConfigSource(launch, "C:\\Users\\box\\.grok\\config.toml"), null);
  assert.deepEqual(reads, []);
});

test("a box that sends more than the cap is cut off", async () => {
  const { launch } = windowsBox("x".repeat(1024 * 1024 + 10), 10);
  assert.equal(await readConfigSource(launch, "C:\\Users\\box\\.grok\\config.toml"), null);
});
