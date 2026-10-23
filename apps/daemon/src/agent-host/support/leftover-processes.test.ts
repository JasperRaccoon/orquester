import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_LAUNCH_ENV_VAR,
  findLaunchRoot,
  findLeftoverProcesses,
  isSharedDaemon,
  recordChildSessions,
  recordHelperProcesses,
  recordOwnGroup,
  stopLeftoverProcesses,
  type RecordedSession
} from "./leftover-processes.ts";
import { LIFELINE_ARGV0, LIFELINE_SCRIPT } from "./lifeline.ts";
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
// Scopes beyond a session: the CLI's own group, recorded helper processes

const BROWSER_DAEMON = `${MARKED}AGENT_BROWSER_DAEMON=1\0`;

test("isSharedDaemon: agent-browser's daemon (and what inherits its env) and a tmux server", () => {
  assert.equal(isSharedDaemon(BROWSER_DAEMON, "agent-browser-l"), true);
  assert.equal(isSharedDaemon(MARKED, "tmux: server"), true);
  assert.equal(isSharedDaemon(MARKED, "agent-browser-l"), false, "agent-browser's per-chat MCP server is no daemon");
  assert.equal(isSharedDaemon(`X_AGENT_BROWSER_DAEMON=1\0`, "node"), false);
});

test("a group scope takes this launch's marked members, and spares shared daemons, strangers and the setsid'd", async (t) => {
  const proc = mockProc(t, {
    800: { environ: MARKED, starttime: 80, sid: 800, pgid: 800 },
    801: { environ: MARKED, starttime: 81, sid: 800, pgid: 800, ppid: 800 },
    802: { environ: environ({ ORQUESTER_AGENT_LAUNCH: "launch-b" }), starttime: 82, sid: 800, pgid: 800 },
    803: { environ: BROWSER_DAEMON, starttime: 83, sid: 800, pgid: 800, comm: "agent-browser-l" },
    804: { environ: `${BROWSER_DAEMON}CHROME=1\0`, starttime: 84, sid: 800, pgid: 800, comm: "chrome", ppid: 803 },
    805: { environ: MARKED, starttime: 85, sid: 800, pgid: 800, comm: "tmux: server" },
    806: { environ: MARKED, starttime: 86, sid: 806, pgid: 806, ppid: 1 },
    807: { environ: MARKED, starttime: 87, sid: 900, pgid: 900 }
  });
  proc.table.set(process.pid, { environ: MARKED, starttime: 1, sid: 800, pgid: 800 });
  const found = await findLeftoverProcesses(LAUNCH, { group: { pgid: 800, leaderStarttime: 80 } });
  assert.deepEqual(found.map((entry) => entry.pid), [800, 801]);
});

test("a group whose live leader is not the recorded one is somebody else's", async (t) => {
  mockProc(t, {
    810: { environ: MARKED, starttime: 99, sid: 810, pgid: 810 },
    811: { environ: MARKED, starttime: 91, sid: 810, pgid: 810 }
  });
  assert.deepEqual(await findLeftoverProcesses(LAUNCH, { group: { pgid: 810, leaderStarttime: 81 } }), []);
});

test("recordOwnGroup: only a process that leads its group records one", async (t) => {
  mockProc(t, {
    820: { environ: MARKED, starttime: 20, sid: 820, pgid: 820 },
    821: { environ: MARKED, starttime: 21, sid: 1, pgid: 1 }
  });
  assert.deepEqual(await recordOwnGroup(820), { pgid: 820, leaderStarttime: 20 });
  assert.equal(await recordOwnGroup(821), null, "a CLI spawned into the host's group never sweeps it");
  assert.equal(await recordOwnGroup(829), null);
  assert.equal(await recordOwnGroup(undefined), null);
});

test("recorded processes are looked up by pid alone, under their recorded starttime", async (t) => {
  const proc = mockProc(t, {
    830: { environ: MARKED, starttime: 30, sid: 1 },
    831: { environ: MARKED, starttime: 99, sid: 1 },
    832: { environ: BROWSER_DAEMON, starttime: 32, sid: 1 }
  });
  const found = await findLeftoverProcesses(LAUNCH, {
    processes: [{ pid: 830, starttime: 30 }, { pid: 831, starttime: 31 }, { pid: 832, starttime: 32 }]
  });
  assert.deepEqual(found.map((entry) => entry.pid), [830]);
  assert.equal(proc.reads.includes("/proc"), false, "no scan of every pid");
});

test("findLaunchRoot: the parent's child carrying this launch's marker", async (t) => {
  mockProc(t, {
    840: { environ: MARKED, starttime: 40, sid: 1 },
    841: { environ: environ({ ORQUESTER_AGENT_LAUNCH: "launch-b" }), starttime: 41, sid: 1, ppid: 840 },
    842: { environ: MARKED, starttime: 42, sid: 1, ppid: 840 }
  });
  assert.deepEqual(await findLaunchRoot(LAUNCH, 840), { pid: 842, starttime: 42 });
  assert.equal(await findLaunchRoot("launch-c", 840), null);
});

test("recordHelperProcesses: the CLI's children and what stays in their session; never a daemon nor below one", async (t) => {
  const proc = mockProc(t, {
    // The CLI, in the host's session and group (as the Claude SDK spawns it).
    850: { environ: MARKED, starttime: 50, sid: 1, pgid: 1 },
    // An MCP server and the server its wrapper started.
    851: { environ: MARKED, starttime: 51, sid: 1, pgid: 1, ppid: 850 },
    852: { environ: MARKED, starttime: 52, sid: 1, pgid: 1, ppid: 851 },
    // A helper's child that daemonized away.
    853: { environ: MARKED, starttime: 53, sid: 853, pgid: 853, ppid: 851 },
    // agent-browser's MCP server, its daemon (same session: a build that stopped detaching) and Chromium.
    854: { environ: MARKED, starttime: 54, sid: 1, pgid: 1, ppid: 850, comm: "agent-browser-l" },
    855: { environ: BROWSER_DAEMON, starttime: 55, sid: 1, pgid: 1, ppid: 854, comm: "agent-browser-l" },
    856: { environ: BROWSER_DAEMON, starttime: 56, sid: 1, pgid: 1, ppid: 855, comm: "chrome" }
  });
  const cli = { pid: 850, starttime: 50 };
  const first = await recordHelperProcesses(cli);
  assert.deepEqual(first.map((entry) => entry.pid), [851, 852, 854]);

  // Later: the user's shell is a NEW child of the CLI; the MCP server started one more process.
  proc.table.set(857, { environ: MARKED, starttime: 57, sid: 1, pgid: 1, ppid: 850 });
  proc.table.set(858, { environ: MARKED, starttime: 58, sid: 1, pgid: 1, ppid: 852 });
  proc.table.delete(851);
  const refreshed = await recordHelperProcesses(cli, first);
  assert.deepEqual(refreshed.map((entry) => entry.pid), [852, 854, 858]);

  // A CLI gone (or recycled) records nothing new.
  proc.table.set(850, { environ: MARKED, starttime: 99, sid: 1 });
  assert.deepEqual(await recordHelperProcesses(cli), []);
});

test("the CLI's lifeline watcher is never a helper, nor taken by a sweep of its group", async (t) => {
  const watcher = ["/bin/sh", "-c", LIFELINE_SCRIPT, LIFELINE_ARGV0, "--", "/usr/bin/claude", ""].join("\0");
  const proc = mockProc(t, {
    // The CLI leads its own group (the lifeline wrapper exec'd into it).
    870: { environ: MARKED, starttime: 70, sid: 870, pgid: 870, cmdline: "/usr/bin/claude\0" },
    // The watcher the wrapper forked before the exec: the CLI's child, marked, in its group.
    871: { environ: MARKED, starttime: 71, sid: 870, pgid: 870, ppid: 870, comm: "sh", cmdline: watcher },
    // An MCP server.
    872: { environ: MARKED, starttime: 72, sid: 870, pgid: 870, ppid: 870, cmdline: "node\0server.js\0" },
    // A look-alike: another `sh -c` with a different script is no watcher.
    873: { environ: MARKED, starttime: 73, sid: 870, pgid: 870, ppid: 870, comm: "sh", cmdline: `/bin/sh\0-c\0sleep 9\0${LIFELINE_ARGV0}\0` }
  });
  const helpers = await recordHelperProcesses({ pid: 870, starttime: 70 });
  assert.deepEqual(helpers.map((entry) => entry.pid), [872, 873]);
  const found = await findLeftoverProcesses(LAUNCH, { group: { pgid: 870, leaderStarttime: 70 }, processes: [{ pid: 871, starttime: 71 }] });
  assert.deepEqual(found.map((entry) => entry.pid), [870, 872, 873]);
  assert.equal(proc.signals.length, 0);
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
