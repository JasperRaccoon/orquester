import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_LAUNCH_ENV_VAR,
  findLeftoverProcesses,
  stopLeftoverProcesses,
  type ProcSource
} from "./leftover-processes.ts";

interface FakeProc {
  environ: string;
  starttime: number;
  /** Dies on this signal (never, when absent). */
  diesOn?: NodeJS.Signals;
  /** A zombie: its stat is readable, it is gone all the same. */
  zombie?: boolean;
}

/**
 * An in-memory /proc. `stat()` answers per call, so a test can recycle a pid
 * between two reads; `kill` records every signal and kills what dies of it.
 */
function fakeProc(initial: Record<number, FakeProc>) {
  const table = new Map<number, FakeProc>(Object.entries(initial).map(([pid, proc]) => [Number(pid), proc]));
  const signals: Array<[number, NodeJS.Signals]> = [];
  const statHooks = new Map<number, () => void>();
  const source: ProcSource = {
    pids: async () => await Promise.resolve([...table.keys()]),
    environ: async (pid) => await Promise.resolve(table.get(pid)?.environ ?? null),
    stat: async (pid) => {
      const hook = statHooks.get(pid);
      if (hook !== undefined) {
        statHooks.delete(pid);
        hook();
      }
      const proc = table.get(pid);
      return await Promise.resolve(
        proc === undefined ? null : { starttime: proc.starttime, state: proc.zombie === true ? "Z" : "S" }
      );
    }
  };
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    signals.push([pid, signal]);
    const proc = table.get(pid);
    if (proc === undefined) {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }
    if (signal === "SIGKILL" || proc.diesOn === signal) {
      table.delete(pid);
    }
  };
  return { table, signals, source, kill, statHooks };
}

function environ(vars: Record<string, string>): string {
  return `${Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\0")}\0`;
}

/** A clock that only moves when the sweep waits. */
function fakeClock() {
  let now = 0;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
      await Promise.resolve();
    },
    waits
  };
}

const LAUNCH = "launch-a";

test("finds exactly the processes carrying this launch's marker", async () => {
  const proc = fakeProc({
    100: { environ: environ({ PATH: "/bin", [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 10 },
    101: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: "launch-b" }), starttime: 11 },
    102: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: `${LAUNCH}x` }), starttime: 12 },
    103: { environ: environ({ ORQUESTER_SESSION_ID: LAUNCH }), starttime: 13 },
    104: { environ: `X_${AGENT_LAUNCH_ENV_VAR}=${LAUNCH}\0`, starttime: 14 },
    105: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 15 }
  });
  proc.table.set(process.pid, { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 1 });
  const found = await findLeftoverProcesses(LAUNCH, { proc: proc.source });
  assert.deepEqual(
    found.map((entry) => [entry.pid, entry.starttime]),
    [
      [100, 10],
      [105, 15]
    ],
    "another launch, a longer value, another variable and this process itself are never matched"
  );
});

test("a pid recycled while it was being read is not matched", async () => {
  const proc = fakeProc({ 200: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 20 } });
  // The second stat read sees a different process under the same pid: the
  // environ in between may have been either one's.
  let reads = 0;
  const source: ProcSource = {
    ...proc.source,
    stat: async (pid) => {
      reads += 1;
      const answer = await proc.source.stat(pid);
      return answer === null ? null : { ...answer, starttime: reads === 1 ? 20 : 21 };
    }
  };
  assert.deepEqual(await findLeftoverProcesses(LAUNCH, { proc: source }), []);
});

test("SIGTERM first; SIGKILL only for what outlived the grace, by a fresh scan", async () => {
  const proc = fakeProc({
    300: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 30, diesOn: "SIGTERM" },
    301: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 31 },
    302: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: "launch-b" }), starttime: 32 }
  });
  const clock = fakeClock();
  // A process the dying tree starts during the grace carries the marker too.
  proc.statHooks.set(301, () => {
    proc.table.set(303, { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 33 });
  });
  const result = await stopLeftoverProcesses({
    launchId: LAUNCH,
    graceMs: 1_000,
    pollMs: 100,
    proc: proc.source,
    kill: proc.kill,
    now: clock.now,
    sleep: clock.sleep,
    platform: "linux"
  });
  assert.deepEqual(proc.signals, [
    [300, "SIGTERM"],
    [301, "SIGTERM"],
    [301, "SIGKILL"],
    [303, "SIGKILL"]
  ]);
  assert.deepEqual(result, { found: 2, terminated: 2, killed: 2 });
  assert.equal(proc.table.has(302), true, "another launch's process is never signalled");
  assert.ok(clock.waits.reduce((sum, ms) => sum + ms, 0) >= 1_000, "the survivor had its whole grace");
});

test("the wait ends as soon as everything is gone — a zombie counts as gone", async () => {
  const proc = fakeProc({
    400: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 40, diesOn: "SIGTERM" },
    401: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 41 }
  });
  // 401 turns into a zombie on SIGTERM: stat still answers, but it is dead.
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    proc.kill(pid, signal);
    if (pid === 401 && signal === "SIGTERM") {
      proc.table.set(401, { environ: "", starttime: 41, zombie: true });
    }
  };
  const clock = fakeClock();
  const result = await stopLeftoverProcesses({
    launchId: LAUNCH,
    graceMs: 5_000,
    pollMs: 100,
    proc: proc.source,
    kill,
    now: clock.now,
    sleep: clock.sleep,
    platform: "linux"
  });
  assert.deepEqual(result, { found: 2, terminated: 2, killed: 0 });
  assert.ok(clock.waits.reduce((sum, ms) => sum + ms, 0) <= 100, "no waiting out a grace nobody needs");
});

test("a pid recycled before its signal is never signalled", async () => {
  const proc = fakeProc({ 500: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: LAUNCH }), starttime: 50 } });
  const clock = fakeClock();
  // Found with starttime 50; by the time the SIGTERM would go out, pid 500 is
  // somebody else's — another starttime, another environment (the third stat
  // read is the pre-signal check).
  let reads = 0;
  const source: ProcSource = {
    ...proc.source,
    stat: async (pid) => {
      reads += 1;
      if (reads === 3) {
        proc.table.set(500, { environ: environ({ PATH: "/bin" }), starttime: 51 });
      }
      return await proc.source.stat(pid);
    }
  };
  const result = await stopLeftoverProcesses({
    launchId: LAUNCH,
    proc: source,
    kill: proc.kill,
    now: clock.now,
    sleep: clock.sleep,
    platform: "linux"
  });
  assert.deepEqual(proc.signals, []);
  assert.deepEqual(result, { found: 1, terminated: 0, killed: 0 });
});

test("off Linux there is no /proc: nothing is read and nothing is signalled", async () => {
  let touched = false;
  const source: ProcSource = {
    pids: async () => {
      touched = true;
      return await Promise.resolve([]);
    },
    environ: async () => await Promise.resolve(null),
    stat: async () => await Promise.resolve(null)
  };
  const result = await stopLeftoverProcesses({
    launchId: LAUNCH,
    proc: source,
    kill: () => {
      touched = true;
    },
    platform: "darwin"
  });
  assert.deepEqual(result, { found: 0, terminated: 0, killed: 0 });
  assert.equal(touched, false);
});

test("an empty launch id matches nothing", async () => {
  const proc = fakeProc({ 600: { environ: `${AGENT_LAUNCH_ENV_VAR}=\0`, starttime: 60 } });
  assert.deepEqual(await findLeftoverProcesses("", { proc: proc.source }), []);
});

// ---------------------------------------------------------------------------
// The real /proc

/** Whether `pid` is still a live (non-zombie) process. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/** Start `script` under `sh` with `env` and read the pid it prints: an orphan once `sh` exits. */
async function orphan(script: string, env: Record<string, string>): Promise<number> {
  const shell = spawn("sh", ["-c", script], { env, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  shell.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  await new Promise<void>((resolve) => shell.on("close", () => resolve()));
  const pid = Number(out.trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `no pid from ${script}`);
  return pid;
}

test("the real /proc: an orphan carrying the marker is stopped, one that ignores SIGTERM killed, a stranger spared", {
  skip: process.platform !== "linux"
}, async () => {
  const launchId = randomUUID();
  const base = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  const marked = { ...base, [AGENT_LAUNCH_ENV_VAR]: launchId };
  // Detached the way the Grok CLI detaches its background shells (a session of
  // its own), then orphaned: the parent chain is gone, the environment is not.
  const polite = await orphan("setsid sleep 60 </dev/null >/dev/null 2>&1 & echo $!", marked);
  const stubborn = await orphan(
    "setsid sh -c 'trap \"\" TERM; exec sleep 60' </dev/null >/dev/null 2>&1 & echo $!",
    marked
  );
  const stranger = await orphan("setsid sleep 60 </dev/null >/dev/null 2>&1 & echo $!", {
    ...base,
    [AGENT_LAUNCH_ENV_VAR]: randomUUID()
  });
  try {
    const found = await findLeftoverProcesses(launchId);
    assert.deepEqual(
      found.map((entry) => entry.pid).sort((a, b) => a - b),
      [polite, stubborn].sort((a, b) => a - b)
    );
    const result = await stopLeftoverProcesses({ launchId, graceMs: 300, pollMs: 20 });
    assert.equal(result.found, 2);
    assert.equal(alive(polite), false, "SIGTERM stopped it");
    assert.equal(alive(stubborn), false, "SIGKILL after the grace stopped the one ignoring SIGTERM");
    assert.equal(alive(stranger), true, "another launch's process is never touched");
  } finally {
    for (const pid of [polite, stubborn, stranger]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});
