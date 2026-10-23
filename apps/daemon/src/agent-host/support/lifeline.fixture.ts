/**
 * A stand-in agent host for `lifeline.test.ts`: it starts one dummy CLI through the lifeline —
 * `spawnProviderChild` (`provider`) or the Claude SDK hook (`claude`) — prints `spawned <pid>`,
 * and then lives until the test kills it. In `graceful` mode the dummy exits by itself first and
 * the fixture prints `exited` once the host side has seen it.
 *
 * argv: <mode> <dummy script for /bin/sh -c> <fifo path, the dummy's $0>
 */

import { claudeLifelineSpawner } from "../adapters/claude/local-process.ts";
import { spawnProviderChild } from "./spawn.ts";

const [mode, script, fifo] = process.argv.slice(2) as [string, string, string];
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

if (mode === "claude") {
  const spawner = claudeLifelineSpawner(() => {})!;
  const child = spawner({ command: "/bin/sh", args: ["-c", script, fifo], env, signal: new AbortController().signal });
  process.stdout.write(`spawned ${(child as unknown as { pid: number }).pid}\n`);
} else {
  const child = spawnProviderChild({ command: "/bin/sh", args: ["-c", script, fifo], env, cwd: "/" });
  process.stdout.write(`spawned ${child.pid}\n`);
  if (mode === "graceful") void child.exited.then(() => process.stdout.write("exited\n"));
}
// Lives until killed.
setInterval(() => {}, 1 << 30);
