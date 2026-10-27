import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendNodeRequireOption,
  boxToolVersionDir,
  boxToolingArchivePath,
  boxToolingPluginDir,
  toolingJoinPath
} from "./index.ts";

test("box tooling paths follow the target's separators", () => {
  assert.equal(boxToolVersionDir("linux", "/var/lib/orq-agent", "tsrs", "0.16.0"), "/var/lib/orq-agent/tooling/tsrs/versions/0.16.0");
  assert.equal(boxToolVersionDir("win32", "C:\\orq\\agent", "tsc-rs", "0.7.0"), "C:\\orq\\agent\\tooling\\tsc-rs\\versions\\0.7.0");
  assert.equal(boxToolingPluginDir("darwin", "/Users/me/.orq-agent/", "ts-rust"), "/Users/me/.orq-agent/tooling/ts-rust");
  assert.equal(toolingJoinPath("win32", "C:\\", "orq", "a/b"), "C:\\orq\\a\\b");
  assert.equal(toolingJoinPath("linux", "/", "tmp"), "/tmp");
  assert.equal(
    boxToolingArchivePath("/base", { tool: "tsrs", version: "0.16.0", os: "linux", arch: "arm64", libc: "musl" }),
    "/base/daemon/boxes/tooling-cache/tsrs/0.16.0/linux-arm64-musl.tgz"
  );
  assert.equal(
    boxToolingArchivePath("/base", { tool: "tsc-rs", version: "0.7.0", os: "win32", arch: "x64", libc: null }),
    "/base/daemon/boxes/tooling-cache/tsc-rs/0.7.0/win32-x64.tgz"
  );
});

test("Node loads preloads with backslashes, spaces and quotes while preserving existing options", { skip: process.platform === "win32" ? "POSIX file names" : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-tooling-node-options-"));
  try {
    const files = ["C:\\orq\\preload.cjs", "C:\\Program Files\\preload.cjs", 'C:\\odd "quoted" dir\\preload.cjs', "C:\\trailing\\"].map((name) => join(dir, name));
    await Promise.all(files.map((file, index) => writeFile(file, `process.stdout.write("preloaded ${index}\\n");\n`)));
    let options = '--title "a b"';
    for (const file of files) options = appendNodeRequireOption(options, file);
    const result = spawnSync(process.execPath, ["-e", 'process.stdout.write(process.title + "\\n")'], {
      env: { NODE_OPTIONS: options }, encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "preloaded 0\npreloaded 1\npreloaded 2\npreloaded 3\na b\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requiring the same file twice adds it once", () => {
  const once = appendNodeRequireOption(undefined, "/a.cjs");
  assert.equal(appendNodeRequireOption(once, "/a.cjs"), '--require "/a.cjs"');
});
