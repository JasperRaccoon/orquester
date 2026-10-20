import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { detachedStartCommand } from "./gpu-common.ts";

/**
 * Runs `detachedStartCommand` the way a provider does (`<shell> -c <line>`), with a stand-in
 * bootstrap that blocks on a FIFO until that shell has exited, then reports whether its file
 * still exists and whether any process above it still carries the command line (the token rides
 * in its base64).
 */
for (const shellName of ["sh", "bash"]) {
  const available = spawnSync(shellName, ["-c", "true"]).status === 0;
  test(`detachedStartCommand (${shellName}): the bootstrap deletes its file and no ancestor keeps the command line`, { skip: process.platform !== "linux" || !available }, async (t) => {
    await runStartCommand(t, shellName);
  });
}

async function runStartCommand(t: { after: (fn: () => Promise<void>) => void }, shellName: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orq-gpu-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fifo = join(dir, "go");
  const report = join(dir, "report");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const marker = "ORQ-TEST-BOOTSTRAP-TOKEN-0123456789";
  const script = `#!/bin/sh
# ${marker}
read go < '${fifo}'
if [ -e "$0" ]; then file=kept; else file=deleted; fi
leak=none
pid=$$
while [ "$pid" -gt 1 ]; do
  pid=$(awk '{ print $4 }' "/proc/$pid/stat" 2>/dev/null) || break
  [ -n "$pid" ] && [ "$pid" -gt 1 ] || break
  if tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- 'base64 -d'; then leak=$pid; fi
done
echo "file=$file leak=$leak" > '${report}.tmp'
mv '${report}.tmp' '${report}'
`;
  const line = detachedStartCommand(script);
  assert.equal(line.includes(marker), false, "the token travels only base64-encoded");
  const shell = spawn(shellName, ["-c", line], { env: { ...process.env, TMPDIR: dir }, stdio: "ignore" });
  const [code] = (await once(shell, "exit")) as [number | null];
  assert.equal(code, 0);
  // The provider's shell is gone: let the bootstrap look around.
  await writeFile(fifo, "go\n");
  const result = await waitForFile(report);
  assert.equal(result.trim(), "file=deleted leak=none");
}

/** Resolves with the file's content once it exists (the stand-in renames it into place). */
async function waitForFile(path: string): Promise<string> {
  const dir = join(path, "..");
  return await new Promise<string>((resolve, reject) => {
    const watcher = watch(dir, () => {
      readFile(path, "utf8").then(
        (content) => {
          watcher.close();
          resolve(content);
        },
        () => undefined
      );
    });
    readFile(path, "utf8").then(
      (content) => {
        watcher.close();
        resolve(content);
      },
      () => undefined
    );
    setTimeout(() => {
      watcher.close();
      reject(new Error(`${path} never appeared`));
    }, 20_000).unref();
  });
}
