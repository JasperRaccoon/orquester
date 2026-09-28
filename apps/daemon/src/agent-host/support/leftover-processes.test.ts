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
  type RecordedSession
} from "./leftover-processes.ts";
import { drain, mockProc } from "./leftover-processes.testing.ts";

function environ(vars: Record<string, string>): string {
  return `${Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\0")}\0`;
}
const LAUNCH = "launch-a";
const MARKED = "PATH=/bin\0ORQUESTER_AGENT_LAUNCH=launch-a\0";
const led = (sid: number, leaderStarttime: number): RecordedSession => ({ sid, leaderStarttime });

test("finds exactly the processes of a recorded session carrying this launch's marker", async (t) => {
  const proc = mockProc(t, {
    100: { environ: MARKED, starttime: 10, sid: 100 },
    101: { environ: MARKED, starttime: 11, sid: 100 },
    102: { environ: environ({ ORQUESTER_AGENT_LAUNCH: "launch-b" }), starttime: 12, sid: 100 },
    103: { environ: environ({ ORQUESTER_AGENT_LAUNCH: `${LAUNCH}x` }), starttime: 13, sid: 100 },
    104: { environ: `X_ORQUESTER_AGENT_LAUNCH=${LAUNCH}\0`, starttime: 14, sid: 100 },
    105: { environ: MARKED, starttime: 15, sid: 105, ppid: 1 }
  });
  proc.table.set(process.pid, { environ: MARKED, starttime: 1, sid: 100 });
  const found = await findLeftoverProcesses(LAUNCH, { sessions: [led(100, 10)] });
  assert.deepEqual(found.map((entry) => [entry.pid, entry.starttime]), [[100, 10], [101, 11]]);
});

test("a recycled session id is not ours: its live leader must be the process recorded", async (t) => {
  mockProc(t, {
    120: { environ: MARKED, starttime: 20, sid: 120 },
    121: { environ: MARKED, starttime: 21, sid: 120 }
  });
  assert.deepEqual(await findLeftoverProcesses(LAUNCH, { sessions: [led(120, 10)] }), []);
});

test("a member whose leader is gone is still its session's", async (t) => {
  mockProc(t, { 131: { environ: MARKED, starttime: 31, sid: 130 } });
  const found = await findLeftoverProcesses(LAUNCH, { sessions: [led(130, 30)] });
  assert.deepEqual(found.map((entry) => entry.pid), [131]);
});

test("a pid recycled while it was being read is not matched", async (t) => {
  const proc = mockProc(t, { 200: { environ: MARKED, starttime: 20, sid: 200 } });
  proc.hooks.environ = () => {
    proc.table.set(200, { environ: "PATH=/bin\0", starttime: 21, sid: 200 });
  };
  assert.deepEqual(await findLeftoverProcesses(LAUNCH, { sessions: [led(200, 20)] }), []);
});

test("SIGTERM first; SIGKILL only for what outlived the grace, by a fresh scan of the same sessions", async (t) => {
  const proc = mockProc(t, {
    300: { environ: MARKED, starttime: 30, sid: 300, diesOn: "SIGTERM" },
    301: { environ: MARKED, starttime: 31, sid: 300 },
    302: { environ: environ({ ORQUESTER_AGENT_LAUNCH: "launch-b" }), starttime: 32, sid: 300 }
  });
  proc.hooks.signal = (pid, signal) => {
    if (pid === 300 && signal === "SIGTERM") {
      proc.table.set(303, { environ: MARKED, starttime: 33, sid: 300 });
    }
  };
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const running = stopLeftoverProcesses({ launchId: LAUNCH, sessions: [led(300, 30)], graceMs: 1_000 });
  await drain();
  t.mock.timers.tick(999);
  await drain();
  assert.deepEqual(proc.signals, [[300, "SIGTERM"], [301, "SIGTERM"]], "no early escalation");
  t.mock.timers.tick(1);
  assert.deepEqual(await running, { found: 2, terminated: 2, killed: 2 });
  assert.deepEqual(proc.signals, [[300, "SIGTERM"], [301, "SIGTERM"], [301, "SIGKILL"], [303, "SIGKILL"]]);
  assert.equal(proc.table.has(302), true);
});

test("the wait ends as soon as everything is gone — a zombie counts as gone", async (t) => {
  const proc = mockProc(t, {
    400: { environ: MARKED, starttime: 40, sid: 400, diesOn: "SIGTERM" },
    401: { environ: MARKED, starttime: 41, sid: 400 }
  });
  proc.hooks.signal = (pid, signal) => {
    if (pid === 401 && signal === "SIGTERM") {
      proc.table.set(401, { environ: "", starttime: 41, sid: 400, zombie: true });
    }
  };
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let result: Awaited<ReturnType<typeof stopLeftoverProcesses>> | undefined;
  void stopLeftoverProcesses({ launchId: LAUNCH, sessions: [led(400, 40)], graceMs: 5_000 })
    .then((done) => { result = done; });
  await drain();
  assert.deepEqual(result, { found: 2, terminated: 2, killed: 0 });
  assert.deepEqual(proc.signals, [[400, "SIGTERM"], [401, "SIGTERM"]]);
});

test("a pid recycled before its signal is never signalled", async (t) => {
  const proc = mockProc(t, {
    499: { environ: MARKED, starttime: 49, sid: 499, diesOn: "SIGTERM" },
    500: { environ: MARKED, starttime: 50, sid: 499, diesOn: "SIGTERM" }
  });
  let recycled: number | undefined;
  proc.hooks.signal = (pid) => {
    if (recycled !== undefined) return;
    recycled = pid === 499 ? 500 : 499;
    proc.table.set(recycled, { environ: "PATH=/bin\0", starttime: 51, sid: 499 });
  };
  const result = await stopLeftoverProcesses({ launchId: LAUNCH, sessions: [led(499, 49)] });
  assert.deepEqual(result, { found: 2, terminated: 1, killed: 0 });
  assert.ok(recycled !== undefined && proc.table.has(recycled));
  assert.equal(proc.signals.some(([pid]) => pid === recycled), false);
});

test("off Linux there is no /proc: nothing is read and nothing is signalled", async (t) => {
  const proc = mockProc(t, {});
  Object.defineProperty(process, "platform", { value: "darwin" });
  assert.deepEqual(await stopLeftoverProcesses({ launchId: LAUNCH, sessions: [led(100, 10)] }), { found: 0, terminated: 0, killed: 0 });
  assert.deepEqual(await recordChildSessions(100), []);
  assert.deepEqual(proc.reads, []);
  assert.deepEqual(proc.signals, []);
});

test("an empty launch id matches nothing", async (t) => {
  mockProc(t, { 600: { environ: "ORQUESTER_AGENT_LAUNCH=\0", starttime: 60, sid: 600 } });
  assert.deepEqual(await findLeftoverProcesses("", { sessions: [led(600, 60)] }), []);
});

test("recordChildSessions: each child's own session, and the parent's for a child that shares it", async (t) => {
  mockProc(t, {
    700: { environ: MARKED, starttime: 70, sid: 700 },
    701: { environ: MARKED, starttime: 71, sid: 701, ppid: 700 },
    702: { environ: MARKED, starttime: 72, sid: 702, ppid: 700 },
    703: { environ: MARKED, starttime: 73, sid: 700, ppid: 700 },
    704: { environ: MARKED, starttime: 74, sid: 701, ppid: 701 }
  });
  const sessions = await recordChildSessions(700);
  assert.deepEqual([...sessions].sort((a, b) => a.sid - b.sid), [led(700, 70), led(701, 71), led(702, 72)]);
  assert.deepEqual(await recordChildSessions(799), []);
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

    const result = await stopLeftoverProcesses({ launchId, sessions, graceMs: 300 });
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
