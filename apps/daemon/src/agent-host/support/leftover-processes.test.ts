import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_LAUNCH_ENV_VAR,
  findLeftoverProcesses,
  recordChildSessions,
  stopLeftoverProcesses,
  type ProcSource,
  type RecordedSession
} from "./leftover-processes.ts";

interface FakeProc {
  environ: string;
  starttime: number;
  /** The session the process is in; its own pid when it leads one. */
  sid: number;
  ppid?: number;
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
  let environReads = 0;
  const source: ProcSource = {
    pids: async () => await Promise.resolve([...table.keys()]),
    environ: async (pid) => {
      environReads += 1;
      return await Promise.resolve(table.get(pid)?.environ ?? null);
    },
    stat: async (pid) => {
      const hook = statHooks.get(pid);
      if (hook !== undefined) {
        statHooks.delete(pid);
        hook();
      }
      const proc = table.get(pid);
      return await Promise.resolve(
        proc === undefined
          ? null
          : { starttime: proc.starttime, state: proc.zombie === true ? "Z" : "S", ppid: proc.ppid ?? 1, sid: proc.sid }
      );
    },
    children: async (pid) =>
      await Promise.resolve([...table.entries()].filter(([, proc]) => proc.ppid === pid).map(([child]) => child))
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
  return { table, signals, source, kill, statHooks, environReads: () => environReads };
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
const MARKED = environ({ PATH: "/bin", [AGENT_LAUNCH_ENV_VAR]: LAUNCH });

/** The session a recorded leader leads, as `recordChildSessions` records it. */
function led(sid: number, leaderStarttime: number): RecordedSession {
  return { sid, leaderStarttime };
}

test("finds exactly the processes of a recorded session carrying this launch's marker", async () => {
  const proc = fakeProc({
    100: { environ: MARKED, starttime: 10, sid: 100 },
    101: { environ: MARKED, starttime: 11, sid: 100 },
    102: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: "launch-b" }), starttime: 12, sid: 100 },
    103: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: `${LAUNCH}x` }), starttime: 13, sid: 100 },
    104: { environ: `X_${AGENT_LAUNCH_ENV_VAR}=${LAUNCH}\0`, starttime: 14, sid: 100 },
    // Daemonized into a session of its own (`setsid`): the marker came with
    // it, the session did not — a host-wide helper a chat happened to start.
    105: { environ: MARKED, starttime: 15, sid: 105, ppid: 1 }
  });
  proc.table.set(process.pid, { environ: MARKED, starttime: 1, sid: 100 });
  const found = await findLeftoverProcesses(LAUNCH, { proc: proc.source, sessions: [led(100, 10)] });
  assert.deepEqual(
    found.map((entry) => [entry.pid, entry.starttime]),
    [
      [100, 10],
      [101, 11]
    ],
    "another launch, a longer value, another variable, another session and this process itself are never matched"
  );
});

test("no recorded session, nothing read: an empty sweep costs no /proc scan", async () => {
  const proc = fakeProc({ 110: { environ: MARKED, starttime: 10, sid: 110 } });
  assert.deepEqual(await findLeftoverProcesses(LAUNCH, { proc: proc.source, sessions: [] }), []);
  assert.equal(proc.environReads(), 0);
  // Only a recorded session's members have their environment read at all.
  await findLeftoverProcesses(LAUNCH, { proc: proc.source, sessions: [led(999, 1)] });
  assert.equal(proc.environReads(), 0);
});

test("a recycled session id is not ours: its live leader must be the process recorded", async () => {
  const proc = fakeProc({
    // The recorded leader (starttime 10) is gone; pid 120 now leads a new
    // session, started at 20 — somebody else's, whatever its environment.
    120: { environ: MARKED, starttime: 20, sid: 120 },
    121: { environ: MARKED, starttime: 21, sid: 120 }
  });
  assert.deepEqual(await findLeftoverProcesses(LAUNCH, { proc: proc.source, sessions: [led(120, 10)] }), []);
});

test("a member whose leader is gone is still its session's", async () => {
  // A shell that started a server and exited: the server runs on in the
  // shell's session, its leader gone.
  const proc = fakeProc({ 131: { environ: MARKED, starttime: 31, sid: 130 } });
  const found = await findLeftoverProcesses(LAUNCH, { proc: proc.source, sessions: [led(130, 30)] });
  assert.deepEqual(found.map((entry) => entry.pid), [131]);
});

test("a pid recycled while it was being read is not matched", async () => {
  const proc = fakeProc({ 200: { environ: MARKED, starttime: 20, sid: 200 } });
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
  assert.deepEqual(await findLeftoverProcesses(LAUNCH, { proc: source, sessions: [led(200, 20)] }), []);
});

test("SIGTERM first; SIGKILL only for what outlived the grace, by a fresh scan of the same sessions", async () => {
  const proc = fakeProc({
    300: { environ: MARKED, starttime: 30, sid: 300, diesOn: "SIGTERM" },
    301: { environ: MARKED, starttime: 31, sid: 300 },
    302: { environ: environ({ [AGENT_LAUNCH_ENV_VAR]: "launch-b" }), starttime: 32, sid: 300 }
  });
  const clock = fakeClock();
  // A process the dying tree starts during the grace carries the marker too.
  proc.statHooks.set(301, () => {
    proc.table.set(303, { environ: MARKED, starttime: 33, sid: 300 });
  });
  const result = await stopLeftoverProcesses({
    launchId: LAUNCH,
    sessions: [led(300, 30)],
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
    400: { environ: MARKED, starttime: 40, sid: 400, diesOn: "SIGTERM" },
    401: { environ: MARKED, starttime: 41, sid: 400 }
  });
  // 401 turns into a zombie on SIGTERM: stat still answers, but it is dead.
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    proc.kill(pid, signal);
    if (pid === 401 && signal === "SIGTERM") {
      proc.table.set(401, { environ: "", starttime: 41, sid: 400, zombie: true });
    }
  };
  const clock = fakeClock();
  const result = await stopLeftoverProcesses({
    launchId: LAUNCH,
    sessions: [led(400, 40)],
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
  const proc = fakeProc({ 500: { environ: MARKED, starttime: 50, sid: 500 } });
  const clock = fakeClock();
  // Found with starttime 50; by the time the SIGTERM would go out, pid 500 is
  // somebody else's — another starttime, another environment (the pre-signal
  // check is the third stat read: two around the environ read; a leader needs
  // no read of its own).
  let reads = 0;
  const source: ProcSource = {
    ...proc.source,
    stat: async (pid) => {
      reads += 1;
      if (reads === 3) {
        proc.table.set(500, { environ: environ({ PATH: "/bin" }), starttime: 51, sid: 500 });
      }
      return await proc.source.stat(pid);
    }
  };
  const result = await stopLeftoverProcesses({
    launchId: LAUNCH,
    sessions: [led(500, 50)],
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
    stat: async () => {
      touched = true;
      return await Promise.resolve(null);
    },
    children: async () => {
      touched = true;
      return await Promise.resolve([]);
    }
  };
  const result = await stopLeftoverProcesses({
    launchId: LAUNCH,
    sessions: [led(1, 1)],
    proc: source,
    kill: () => {
      touched = true;
    },
    platform: "darwin"
  });
  assert.deepEqual(result, { found: 0, terminated: 0, killed: 0 });
  assert.deepEqual(await recordChildSessions(100, { proc: source, platform: "darwin" }), []);
  assert.equal(touched, false);
});

test("an empty launch id matches nothing", async () => {
  const proc = fakeProc({ 600: { environ: `${AGENT_LAUNCH_ENV_VAR}=\0`, starttime: 60, sid: 600 } });
  assert.deepEqual(await findLeftoverProcesses("", { proc: proc.source, sessions: [led(600, 60)] }), []);
});

test("recordChildSessions: each child's own session, and the parent's for a child that shares it", async () => {
  const proc = fakeProc({
    700: { environ: MARKED, starttime: 70, sid: 700 },
    // Two children leading sessions of their own (a shell, an MCP server)…
    701: { environ: MARKED, starttime: 71, sid: 701, ppid: 700 },
    702: { environ: MARKED, starttime: 72, sid: 702, ppid: 700 },
    // …one that stayed in the parent's session, and a grandchild.
    703: { environ: MARKED, starttime: 73, sid: 700, ppid: 700 },
    704: { environ: MARKED, starttime: 74, sid: 701, ppid: 701 }
  });
  const sessions = await recordChildSessions(700, { proc: proc.source, platform: "linux" });
  assert.deepEqual(
    [...sessions].sort((a, b) => a.sid - b.sid),
    [led(700, 70), led(701, 71), led(702, 72)]
  );
  assert.deepEqual(await recordChildSessions(799, { proc: proc.source, platform: "linux" }), [], "a gone parent: nothing");
});

// ---------------------------------------------------------------------------
// The real /proc

/** Whether `pid` is a live (non-zombie) process. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/** The `name:pid` lines a process tree prints once each member is in place, by name. */
function announced(stream: NodeJS.ReadableStream, names: readonly string[]): Promise<Map<string, number>> {
  return new Promise((resolve, reject) => {
    const seen = new Map<string, number>();
    let buffer = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const [name, pid] = buffer.slice(0, newline).trim().split(":");
        buffer = buffer.slice(newline + 1);
        if (name !== undefined && pid !== undefined) seen.set(name, Number(pid));
        if (names.every((wanted) => seen.has(wanted))) {
          resolve(seen);
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    stream.on("end", () => reject(new Error(`the tree ended before announcing ${names.join(", ")}`)));
  });
}

test("the real /proc: a recorded session's members are stopped, a daemon and a stranger spared", {
  skip: process.platform !== "linux"
}, async () => {
  const launchId = randomUUID();
  const base = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  // The CLI stand-in leads its own session (Node's `detached`) and starts a
  // shell in a session of its own, as the Grok CLI does (fixture 24). The
  // shell runs a polite member, a member that ignores SIGTERM (an ignored
  // signal survives `exec`) and a daemon that `setsid`s away. Every one says
  // it is in place only once it is: no timing, no sleep.
  const inner = [
    "sleep 60 & echo polite:$!;",
    'sh -c "trap \\"\\" TERM; echo stubborn:\\$\\$; exec sleep 60" &',
    'setsid sh -c "echo daemon:\\$\\$; exec sleep 60" &',
    "echo shell:$$; wait"
  ].join(" ");
  const script = `setsid sh -c '${inner}' & wait`;
  const cli = spawn("sh", ["-c", script], {
    detached: true,
    env: { ...base, [AGENT_LAUNCH_ENV_VAR]: launchId },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const stranger = spawn("sleep", ["60"], {
    detached: true,
    env: { ...base, [AGENT_LAUNCH_ENV_VAR]: randomUUID() },
    stdio: "ignore"
  });
  const pids = await announced(cli.stdout!, ["polite", "stubborn", "daemon", "shell"]);
  const all = [...pids.values(), stranger.pid ?? 0];
  try {
    const sessions = await recordChildSessions(cli.pid!);
    assert.ok(
      sessions.some((session) => session.sid === pids.get("shell")),
      "the shell's own session is recorded while its parent lives"
    );
    // The CLI stand-in dies first, as it does before every sweep: its
    // children are reparented to init and only their sessions tie them to it.
    const gone = new Promise<void>((resolve) => cli.once("exit", () => resolve()));
    process.kill(cli.pid!, "SIGKILL");
    await gone;

    const result = await stopLeftoverProcesses({ launchId, sessions, graceMs: 300, pollMs: 20 });
    assert.equal(result.found, 3, "the shell and its two members");
    assert.equal(alive(pids.get("shell")!), false);
    assert.equal(alive(pids.get("polite")!), false, "SIGTERM stopped it");
    assert.equal(alive(pids.get("stubborn")!), false, "SIGKILL after the grace stopped the one ignoring SIGTERM");
    assert.equal(alive(pids.get("daemon")!), true, "a process that daemonized into a session of its own is spared");
    assert.equal(alive(stranger.pid!), true, "another launch's process is never touched");
  } finally {
    for (const pid of all) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});
