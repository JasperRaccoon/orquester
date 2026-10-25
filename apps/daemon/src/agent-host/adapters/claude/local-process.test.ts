/**
 * The local Claude spawner (`local-process.ts`): its `exit` reaches the SDK only once the CLI's
 * stderr is drained into the session's capture — at most `EXIT_AFTER_STDERR_MS` after the exit —
 * as the SDK's own spawner does, so the CLI's last fatal line is never lost to the stream's end.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import { LIFELINE_SUPPORTED } from "../../support/lifeline.ts";
import { claudeLifelineSpawner } from "./local-process.ts";

function start(script: string): { process: SpawnedProcess; stderr: () => string } {
  let captured = "";
  const spawner = claudeLifelineSpawner((data) => (captured += data))!;
  const child = spawner({
    command: "/bin/sh",
    args: ["-c", script],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    signal: new AbortController().signal
  });
  return { process: child, stderr: () => captured };
}

describe("the local Claude spawner", { skip: !LIFELINE_SUPPORTED }, () => {
  it("reports the exit only after stderr written past it has reached the capture", async () => {
    // The CLI exits at once; what it left behind writes the fatal line a moment later.
    const { process: child, stderr } = start("(sleep 0.1; echo 'fatal: late line' >&2) & exit 3");
    let atExit = "";
    const [code, signal] = (await new Promise((resolve) =>
      child.once("exit", (...args) => {
        atExit = stderr();
        resolve(args);
      })
    )) as [number | null, NodeJS.Signals | null];
    assert.deepEqual([code, signal], [3, null]);
    assert.equal(child.exitCode, 3);
    assert.match(atExit, /fatal: late line/);
  });

  it("does not wait past the cap for a stderr something else keeps open", { timeout: 10_000 }, async () => {
    const { process: child } = start("sleep 5 & exit 0");
    const exitedAt = Date.now();
    const [code] = (await once(child as unknown as NodeJS.EventEmitter, "exit")) as [number | null];
    assert.equal(code, 0);
    assert.ok(Date.now() - exitedAt < 2_000, "exit is bounded independently of the still-open stderr");
    process.kill(-(child as unknown as { pid: number }).pid, "SIGKILL");
  });

  it("a spawn error reaches the SDK's error listener and no exit is invented", async () => {
    const spawner = claudeLifelineSpawner(() => {})!;
    const child = spawner({ command: "/bin/sh", args: ["-c", "exit 0"], env: {}, cwd: "/nonexistent-dir", signal: new AbortController().signal });
    const [error] = (await once(child as unknown as NodeJS.EventEmitter, "error")) as [NodeJS.ErrnoException];
    assert.equal(error.code, "ENOENT");
  });
});
