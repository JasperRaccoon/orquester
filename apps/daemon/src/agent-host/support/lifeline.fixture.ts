/**
 * A stand-in agent host for `lifeline.test.ts`: it starts one dummy CLI through the lifeline —
 * `spawnProviderChild` (`provider`) or the Claude SDK hook (`claude`) — prints `spawned <pid>`,
 * and then lives until the test kills it. In `graceful` mode the dummy exits by itself first and
 * the fixture prints `released` once the watcher has exited.
 *
 * argv: <mode> <dummy script for /bin/sh -c> <fifo path, the dummy's $0>
 */

import childProcess, { type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";

import { claudeLifelineSpawner } from "../adapters/claude/local-process.ts";
import { spawnProviderChild } from "./spawn.ts";

const [mode, script, fifo] = process.argv.slice(2) as [string, string, string];
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

// Only the watcher keeps fd 4: the graceful dummy closes its copy before it spawns its child.
// Observing that pipe's close gives the test the watcher's exit without polling /proc.
let watcherClosed: Promise<unknown> | undefined;
if (mode === "graceful") {
  const spawn = childProcess.spawn;
  childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const stdio = Array.isArray(options.stdio) ? options.stdio : [];
    const child = spawn(command, args, { ...options, stdio: [...stdio, "pipe"] });
    watcherClosed = once(child.stdio[4]!, "close");
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
}

if (mode === "claude") {
  const spawner = claudeLifelineSpawner(() => {})!;
  const child = spawner({ command: "/bin/sh", args: ["-c", script, fifo], env, signal: new AbortController().signal });
  process.stdout.write(`spawned ${(child as unknown as { pid: number }).pid}\n`);
} else {
  const child = spawnProviderChild({ command: "/bin/sh", args: ["-c", script, fifo], env, cwd: "/" });
  process.stdout.write(`spawned ${child.pid}\n`);
  if (mode === "graceful") void child.exited.then(async () => {
    await watcherClosed;
    process.stdout.write("released\n");
  });
}
// Lives until killed.
setInterval(() => {}, 1 << 30);
