import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";

import { packTar } from "./tar.ts";

test("packTar writes an archive tar extracts: long and non-ASCII names, modes, mtimes; a vanished file is left out", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "orq-tar-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const src = join(base, "src");
  await mkdir(src);
  const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(80)}.md`;
  const files = [
    { name: "a.txt", content: "A" },
    { name: long, content: "long" },
    { name: "skills/café/SKILL.md", content: "unicode" },
    { name: "bin/run.sh", content: "#!/bin/sh\n", mode: 0o755 },
    { name: "empty", content: "" },
    { name: "big.bin", content: "z".repeat(700_000) }
  ];
  const entries = [];
  for (const [index, file] of files.entries()) {
    const source = join(src, `f${index}`);
    await writeFile(source, file.content);
    if (file.mode) await chmod(source, file.mode);
    entries.push({ name: file.name, source, mode: file.mode ?? 0o644 });
  }
  entries.push({ name: "gone.txt", source: join(src, "missing"), mode: 0o644 });
  const written = new Map<string, number>();
  const named: string[] = [];
  const out = join(base, "out");
  await mkdir(out);
  const tar = spawn("tar", ["-xf", "-", "-C", out], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  tar.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => tar.on("exit", resolve));
  await pipeline(Readable.from(packTar(entries, written, (name) => void named.push(name))), tar.stdin!);
  assert.equal(await exited, 0, stderr);
  for (const file of files) assert.equal(await readFile(join(out, file.name), "utf8"), file.content, file.name);
  assert.equal((await stat(join(out, "bin", "run.sh"))).mode & 0o777, 0o755);
  const sourceMtime = Math.floor((await stat(join(src, "f0"))).mtimeMs / 1000);
  assert.equal(Math.floor((await stat(join(out, "a.txt"))).mtimeMs / 1000), sourceMtime, "whole-second mtime kept");
  assert.equal(written.get("big.bin"), 700_000);
  assert.equal(written.has("gone.txt"), false);
  assert.deepEqual(
    named,
    files.map((file) => file.name)
  );
});
