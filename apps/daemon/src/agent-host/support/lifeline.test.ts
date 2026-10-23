/**
 * The host-death lifeline (`lifeline.ts`), live: a stand-in host (`lifeline.fixture.ts`) starts
 * a dummy CLI through it and is then SIGKILLed; the dummy's whole process group must be gone
 * within the grace window. Every wait is on an event: the dummies hold a FIFO open for writing,
 * so its reader sees EOF exactly when the last of them died.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";

import { LIFELINE_KILL_GRACE_S, LIFELINE_SUPPORTED } from "./lifeline.ts";
import { spawnProviderChild } from "./spawn.ts";

const dir = mkdtempSync(join(tmpdir(), "orq-lifeline-"));
/** Every stand-in host and dummy group, stopped whatever a test left behind. */
const started: { host: ChildProcess; pid: number }[] = [];
after(() => {
  for (const { host, pid } of started) {
    host.kill("SIGKILL");
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});
const FIXTURE = join(import.meta.dirname, "lifeline.fixture.ts");

/** The dummy: it and a background child both hold the FIFO ($0) open, then sleep. */
const DUMMY = 'exec 9>"$0"; sleep 1000 & exec sleep 1000';
const DUMMY_IGNORING_TERM = `trap '' TERM; ${DUMMY}`;

let fifos = 0;
function fifo(): string {
  const path = join(dir, `f${fifos++}`);
  execFileSync("mkfifo", [path]);
  return path;
}

/** The pids in process group `pgid`, read off `/proc`. */
function groupMembers(pgid: number): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) pids.push(Number(entry));
    } catch {
      // Gone meanwhile.
    }
  }
  return pids;
}

/** Starts the stand-in host; resolves with it, the dummy's pid, and the FIFO's reader once open. */
async function startHost(mode: string, script: string) {
  const path = fifo();
  const reader = createReadStream(path);
  reader.on("data", () => {});
  const opened = once(reader, "open");
  const closed = once(reader, "close");
  const host = spawn(process.execPath, ["--import", "tsx", FIXTURE, mode, script, path], {
    env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    stdio: ["ignore", "pipe", "inherit"]
  });
  // Buffered: a line that arrives before the test awaits it is not lost.
  const lines = createInterface({ input: host.stdout })[Symbol.asyncIterator]();
  const line = String((await lines.next()).value);
  const pid = Number(/^spawned (\d+)$/.exec(line)?.[1]);
  assert.ok(pid > 0, line);
  started.push({ host, pid });
  await opened;
  return { host, pid, lines, closed };
}

describe("the host-death lifeline", { skip: !LIFELINE_SUPPORTED || process.platform !== "linux" }, () => {
  for (const mode of ["provider", "claude"]) {
    it(`${mode}: the CLI's whole group is stopped when the host is SIGKILLed`, { timeout: 30_000 }, async () => {
      const { host, pid, closed } = await startHost(mode, DUMMY);
      assert.ok(groupMembers(pid).length >= 2, "the dummy runs in a group of its own");
      const started = Date.now();
      host.kill("SIGKILL");
      await closed;
      assert.ok(Date.now() - started < LIFELINE_KILL_GRACE_S * 1000, "SIGTERM stops it at once");
    });
  }

  it("a group that ignores SIGTERM is SIGKILLed after the grace", { timeout: 30_000 }, async () => {
    const { host, closed } = await startHost("provider", DUMMY_IGNORING_TERM);
    const started = Date.now();
    host.kill("SIGKILL");
    await closed;
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= LIFELINE_KILL_GRACE_S * 1000 - 500, `waited the grace (${elapsed} ms)`);
    assert.ok(elapsed < (LIFELINE_KILL_GRACE_S + 5) * 1000, `then killed (${elapsed} ms)`);
  });

  it("a CLI that ends while the host lives releases its watcher: nothing is signalled", { timeout: 30_000 }, async () => {
    // The dummy exits at once, leaving its background child in the group.
    const { host, pid, lines } = await startHost("graceful", 'exec 9>"$0"; sleep 1000 </dev/null >/dev/null 2>&1 & exit 0');
    assert.equal((await lines.next()).value, "exited");
    // The watcher goes on its own; only the background child is left.
    const deadline = Date.now() + 10_000;
    while (groupMembers(pid).length !== 1 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const [survivor] = groupMembers(pid);
    assert.equal(groupMembers(pid).length, 1, "only the background child remains");
    host.kill("SIGKILL");
    await once(host, "exit");
    assert.doesNotThrow(() => process.kill(survivor!, 0), "a released lifeline stops nothing");
  });
});

describe("spawnProviderChild through the lifeline", { skip: !LIFELINE_SUPPORTED }, () => {
  it("passes odd args verbatim, keeps the exit code, and never hands fd 3 to the CLI", async () => {
    const args = ["a b", "$HOME", "'q'", '"d"', "x;y", "$(id)", "--"];
    const child = spawnProviderChild({
      command: "/bin/sh",
      args: ["-c", 'if [ -e /proc/$$/fd/3 ]; then echo open; else echo closed; fi; printf "%s\\n" "$@"; exit 7', "cli", ...args],
      env: { PATH: process.env.PATH ?? "" },
      cwd: "/"
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const reason = await child.exited;
    assert.deepEqual(reason, { kind: "exit", code: 7, signal: null });
    assert.deepEqual(out.split("\n").slice(0, -1), [process.platform === "linux" ? "closed" : out.split("\n")[0], ...args]);
  });

  it("hands the CLI exactly the env it was given: nothing the shell exports by itself", async () => {
    // A PWD the caller sets is kept (sh rewrites one that does not name the cwd).
    const envs: Record<string, string>[] = [{ PATH: "/usr/bin:/bin" }, { PATH: "/usr/bin:/bin", PWD: "/" }];
    for (const env of envs) {
      const child = spawnProviderChild({ command: "/usr/bin/env", args: [], env, cwd: "/" });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      await child.exited;
      assert.deepEqual(out.trim().split("\n").sort(), Object.entries(env).map(([k, v]) => `${k}=${v}`).sort());
    }
  });

  it("a graceful kill still ends the CLI once, by SIGTERM", async () => {
    const child = spawnProviderChild({ command: "/bin/sleep", args: ["1000"], env: {}, cwd: "/" });
    assert.deepEqual(await child.kill(), { kind: "signal", code: null, signal: "SIGTERM" });
  });

  it("a command that cannot run is still a spawn error, not the wrapper's exit", async () => {
    const child = spawnProviderChild({ command: join(dir, "missing"), args: [], env: {}, cwd: "/" });
    assert.equal((await child.exited).kind, "spawn-error");
  });
});
