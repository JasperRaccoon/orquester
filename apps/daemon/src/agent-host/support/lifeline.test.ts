/**
 * The host-death lifeline (`lifeline.ts`), live: a stand-in host (`lifeline.fixture.ts`) starts
 * a dummy CLI through it and is then SIGKILLed; the dummy's whole process group must be gone
 * after the graceful and forced-stop steps. Every wait is on an event: the dummies hold a FIFO open for writing,
 * so its reader sees EOF exactly when the last of them died.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";

import { AGENT_LAUNCH_ENV_VAR, recordHelperProcesses } from "./leftover-processes.ts";
import { isLifelineWatcher, LIFELINE_SUPPORTED } from "./lifeline.ts";
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
const DUMMY = 'trap \'printf \"term\\n\" >&9; exit 0\' TERM; exec 9>"$0"; /bin/sleep 1000 & wait';
const DUMMY_IGNORING_TERM = 'trap \'\' TERM; exec 9>"$0"; /bin/sleep 1000 & exec /bin/sleep 1000';

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
      if (Number(fields[2]) === pgid && fields[0] !== "Z") pids.push(Number(entry));
    } catch {
      // Gone meanwhile.
    }
  }
  return pids;
}

/** Starts the stand-in host; resolves with it, the dummy's pid, and the FIFO's reader once open. */
async function startHost(mode: string, script: string, pathEnv = process.env.PATH) {
  const path = fifo();
  const reader = createReadStream(path);
  let output = "";
  reader.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
  const opened = once(reader, "open");
  const closed = once(reader, "close").then(() => output);
  const host = spawn(process.execPath, ["--import", "tsx", FIXTURE, mode, script, path], {
    env: { ...process.env, PATH: pathEnv, TSX_DISABLE_CACHE: "1" },
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
    it(`${mode}: the CLI's whole group is stopped when the host is SIGKILLed`, async () => {
      const { host, pid, closed } = await startHost(mode, DUMMY);
      assert.ok(groupMembers(pid).length >= 2, "the dummy runs in a group of its own");
      host.kill("SIGKILL");
      assert.equal(await closed, "term\n", "the CLI received SIGTERM before its group ended");
    });
  }

  it("a group that ignores SIGTERM is SIGKILLed after the grace", async () => {
    // The shell's sleep is a barrier: reaching it proves TERM was sent; releasing it permits KILL.
    const graceStarted = fifo();
    const graceRelease = fifo();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "sleep"), `#!/bin/sh\nprintf '%s\\n' \"$1\" > '${graceStarted}'\nread -r _ < '${graceRelease}'\n`, { mode: 0o700 });
    const entered = createReadStream(graceStarted);
    let requestedGrace = "";
    entered.on("data", (chunk: Buffer | string) => { requestedGrace += chunk.toString(); });
    const graceEntered = once(entered, "end");
    const { host, closed } = await startHost("provider", DUMMY_IGNORING_TERM, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
    let ended = false;
    void closed.then(() => { ended = true; });
    host.kill("SIGKILL");
    await graceEntered;
    assert.equal(requestedGrace, "5\n", "the watcher requests its five-second grace before KILL");
    assert.equal(ended, false, "the group remains alive inside its grace period");
    const release = createWriteStream(graceRelease);
    release.end("\n");
    await closed;
  });

  it("a CLI that ends while the host lives releases its watcher: nothing is signalled", async () => {
    // The dummy exits at once, leaving its background child in the group.
    const { host, pid, lines } = await startHost("graceful", 'exec 4>&-; exec 9>"$0"; sleep 1000 </dev/null >/dev/null 2>&1 & exit 0');
    // The fixture's extra inherited pipe closes when the watcher has exited.
    assert.equal((await lines.next()).value, "released");
    const [survivor] = groupMembers(pid);
    assert.equal(groupMembers(pid).length, 1, "only the background child remains");
    host.kill("SIGKILL");
    await once(host, "exit");
    assert.doesNotThrow(() => process.kill(survivor!, 0), "a released lifeline stops nothing");
  });
});

/** `/proc/<pid>/stat` field 22, the starttime that makes a pid one process. */
function starttime(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}

describe("the lifeline and the leftover sweep (real /proc)", { skip: process.platform !== "linux" }, () => {
  it("the watcher, a marked child of the CLI, is never recorded as one of its helpers", async () => {
    const child = spawnProviderChild({
      command: "/bin/sh",
      args: ["-c", "sleep 1000 & echo ready; wait"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", [AGENT_LAUNCH_ENV_VAR]: "lifeline-test" },
      cwd: "/"
    });
    try {
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      assert.equal((await lines.next()).value, "ready");
      const pid = child.pid!;
      const members = groupMembers(pid).filter((member) => member !== pid);
      const watchers = members.filter((member) => isLifelineWatcher(readFileSync(`/proc/${member}/cmdline`, "latin1")));
      assert.equal(watchers.length, 1, "the CLI's group holds its watcher");
      const helpers = await recordHelperProcesses({ pid, starttime: starttime(pid) });
      assert.deepEqual(
        helpers.map((entry) => entry.pid),
        members.filter((member) => !watchers.includes(member)),
        "its `sleep` is a helper, its watcher is not"
      );
    } finally {
      await child.kill();
    }
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
