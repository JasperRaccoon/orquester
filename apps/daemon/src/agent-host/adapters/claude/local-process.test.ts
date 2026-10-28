/**
 * The local Claude spawner (`local-process.ts`): its `exit` reaches the SDK only once the CLI's
 * stderr is drained into the session's capture — at most `EXIT_AFTER_STDERR_MS` after the exit —
 * as the SDK's own spawner does, so the CLI's last fatal line is never lost to the stream's end.
 */

import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import { LIFELINE_SUPPORTED } from "../../support/lifeline.ts";
import { claudeLifelineSpawner } from "./local-process.ts";

function start(script: string, ...args: string[]): { process: SpawnedProcess; stderr: () => string } {
  let captured = "";
  const spawner = claudeLifelineSpawner((data) => (captured += data))!;
  const child = spawner({
    command: "/bin/sh",
    args: ["-c", script, "sh", ...args],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    signal: new AbortController().signal
  });
  return { process: child, stderr: () => captured };
}

describe("the local Claude spawner", { skip: !LIFELINE_SUPPORTED }, () => {
  it("reports the exit only after stderr written past it has reached the capture", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orq-claude-stderr-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fifo = join(root, "release");
    execFileSync("mkfifo", [fifo]);
    // The cap never races this drain: it advances only under the mocked clock.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // The inherited writer waits on a pipe until the actual CLI process has exited.
    const { process: child, stderr } = start("(read release < \"$1\"; echo 'fatal: late line' >&2) & exit 3", fifo);
    t.after(() => {
      try {
        process.kill(-(child as unknown as { pid: number }).pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    });
    let atExit = "";
    const reported = new Promise((resolve) =>
      child.once("exit", (...args) => {
        atExit = stderr();
        resolve(args);
      })
    );
    // `exitCode` is the SDK's public process state; its `exit` event intentionally waits for stderr.
    while (child.exitCode === null) await new Promise<void>((resolve) => setImmediate(resolve));
    await writeFile(fifo, "release\n");
    const [code, signal] = (await reported) as [number | null, NodeJS.Signals | null];
    assert.deepEqual([code, signal], [3, null]);
    assert.equal(child.exitCode, 3);
    assert.match(atExit, /fatal: late line/);
  });

  it("does not wait past the cap for a stderr something else keeps open", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const native = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      stdio: [], exitCode: 0, signalCode: null
    });
    const spawn = t.mock.method(childProcess, "spawn", () => native as unknown as childProcess.ChildProcess);
    syncBuiltinESMExports();
    t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
    const { process: child } = start("exit 0");
    let reported = false;
    child.once("exit", () => { reported = true; });
    const exited = once(child as unknown as NodeJS.EventEmitter, "exit");
    native.emit("exit", 0, null);
    assert.equal(reported, false, "the open stderr defers the exit");
    t.mock.timers.runAll();
    assert.deepEqual(await exited, [0, null]);
    assert.equal(native.stderr.destroyed, false, "the cap releases the exit while stderr stays open");
  });

  it("a spawn error reaches the SDK's error listener and no exit is invented", async () => {
    const spawner = claudeLifelineSpawner(() => {})!;
    const child = spawner({ command: "/bin/sh", args: ["-c", "exit 0"], env: {}, cwd: "/nonexistent-dir", signal: new AbortController().signal });
    let exited = false;
    child.on("exit", () => { exited = true; });
    const [error] = (await once(child as unknown as NodeJS.EventEmitter, "error")) as [NodeJS.ErrnoException];
    assert.equal(error.code, "ENOENT");
    assert.equal(exited, false, "a spawn failure reports only its error");
  });
});
