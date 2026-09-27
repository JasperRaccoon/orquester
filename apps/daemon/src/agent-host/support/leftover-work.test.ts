import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import { AGENT_LAUNCH_ENV_VAR, type ProcSource } from "./leftover-processes.ts";
import {
  LEFTOVER_WORK_LAUNCHES,
  LEFTOVER_WORK_SESSIONS,
  parseLeftoverWork,
  readLeftoverWork,
  recordLeftoverWork,
  sweepLeftoverWork
} from "./leftover-work.ts";

/** Every scratch directory, removed once the file is done. */
const scratchDirs: string[] = [];
after(async () => {
  for (const dir of scratchDirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "leftover-work-"));
  scratchDirs.push(dir);
  return join(dir, "leftover-work.json");
}

test("a thread's leftover work is kept per launch, merged by launch, the newest launches only, 0600", async () => {
  const path = await scratch();
  await recordLeftoverWork(path, { launchId: "l1", recordedAt: "t1", sessions: [{ sid: 10, leaderStarttime: 100 }] });
  await recordLeftoverWork(path, {
    launchId: "l1",
    recordedAt: "t2",
    sessions: [
      { sid: 10, leaderStarttime: 100 },
      { sid: 11, leaderStarttime: 110 }
    ]
  });
  assert.deepEqual(await readLeftoverWork(path), [
    {
      launchId: "l1",
      recordedAt: "t2",
      sessions: [
        { sid: 10, leaderStarttime: 100 },
        { sid: 11, leaderStarttime: 110 }
      ]
    }
  ]);
  assert.equal((await stat(path)).mode & 0o777, 0o600, "as sensitive as the thread dir it lives in");

  for (let launch = 2; launch <= LEFTOVER_WORK_LAUNCHES + 2; launch += 1) {
    await recordLeftoverWork(path, {
      launchId: `l${launch}`,
      recordedAt: `t${launch}`,
      sessions: [{ sid: launch * 100, leaderStarttime: launch }]
    });
  }
  const kept = await readLeftoverWork(path);
  assert.equal(kept.length, LEFTOVER_WORK_LAUNCHES, "the last few launches only");
  assert.equal(kept.at(-1)?.launchId, `l${LEFTOVER_WORK_LAUNCHES + 2}`, "newest last");
  assert.equal(kept.some((launch) => launch.launchId === "l1"), false, "the oldest dropped first");
});

test("a launch keeps its newest sessions only", async () => {
  const path = await scratch();
  const many = Array.from({ length: LEFTOVER_WORK_SESSIONS + 10 }, (_, index) => ({ sid: index + 2, leaderStarttime: index }));
  await recordLeftoverWork(path, { launchId: "l1", recordedAt: "t1", sessions: many });
  const [launch] = await readLeftoverWork(path);
  assert.equal(launch?.sessions.length, LEFTOVER_WORK_SESSIONS);
  assert.equal(launch?.sessions.at(-1)?.sid, LEFTOVER_WORK_SESSIONS + 11, "the newest sessions kept");
});

test("a file that is not what this host writes reads as nothing, entry by entry", async () => {
  assert.deepEqual(parseLeftoverWork(null), []);
  assert.deepEqual(parseLeftoverWork("not json"), []);
  assert.deepEqual(parseLeftoverWork(JSON.stringify({ version: 99, launches: [] })), []);
  assert.deepEqual(
    parseLeftoverWork(
      JSON.stringify({
        version: 1,
        launches: [
          { launchId: "", recordedAt: "t", sessions: [] },
          { launchId: "ok", recordedAt: "t", sessions: [{ sid: 5, leaderStarttime: 1 }, { sid: "x" }, { sid: 1, leaderStarttime: 2 }] },
          "junk"
        ]
      })
    ),
    [{ launchId: "ok", recordedAt: "t", sessions: [{ sid: 5, leaderStarttime: 1 }] }],
    "a session id is a pid above 1, a launch names itself"
  );
  const path = await scratch();
  await writeFile(path, "{ torn");
  assert.deepEqual(await readLeftoverWork(path), []);
  await recordLeftoverWork(path, { launchId: "l1", recordedAt: "t", sessions: [{ sid: 7, leaderStarttime: 3 }] });
  assert.equal((await readLeftoverWork(path)).length, 1, "and is replaced by the next record");
});

test("a record never recreates a thread directory that is gone — no ghost thread at the next boot", async () => {
  const path = await scratch();
  const threadDir = dirname(path);
  await rm(threadDir, { recursive: true });
  await recordLeftoverWork(path, { launchId: "late", recordedAt: "t", sessions: [{ sid: 9, leaderStarttime: 1 }] });
  assert.equal(existsSync(threadDir), false, "the store deleted the thread: a late record writes nothing");
  assert.deepEqual(await readLeftoverWork(path), []);
});

test("concurrent records of one thread are serialised: none is lost", async () => {
  const path = await scratch();
  await Promise.all(
    Array.from({ length: 6 }, async (_, index) =>
      await recordLeftoverWork(path, {
        launchId: `l${index}`,
        recordedAt: `t${index}`,
        sessions: [{ sid: 100 + index, leaderStarttime: index }]
      })
    )
  );
  assert.equal((await readLeftoverWork(path)).length, 6);
});

test("the sweep stops each launch's work by its own marker and sessions — nothing else — then forgets it", async () => {
  const path = await scratch();
  await recordLeftoverWork(path, { launchId: "old", recordedAt: "t1", sessions: [{ sid: 200, leaderStarttime: 20 }] });
  await recordLeftoverWork(path, { launchId: "newer", recordedAt: "t2", sessions: [{ sid: 300, leaderStarttime: 30 }] });
  const marked = (launch: string) => `PATH=/bin\0${AGENT_LAUNCH_ENV_VAR}=${launch}\0`;
  const table = new Map<number, { environ: string; starttime: number; sid: number }>([
    // The first launch's dev server: its shell (the session's leader) and a member.
    [200, { environ: marked("old"), starttime: 20, sid: 200 }],
    [201, { environ: marked("old"), starttime: 21, sid: 200 }],
    // The later launch's shell.
    [300, { environ: marked("newer"), starttime: 30, sid: 300 }],
    // What daemonized away from the first launch's shell: its marker, a session of its own.
    [250, { environ: marked("old"), starttime: 25, sid: 250 }],
    // Another launch's process in a recorded session id (a recycled leader would say so too).
    [202, { environ: marked("someone-else"), starttime: 22, sid: 200 }]
  ]);
  const signals: Array<[number, NodeJS.Signals]> = [];
  const proc: ProcSource = {
    pids: async () => await Promise.resolve([...table.keys()]),
    environ: async (pid) => await Promise.resolve(table.get(pid)?.environ ?? null),
    stat: async (pid) => {
      const entry = table.get(pid);
      return await Promise.resolve(
        entry === undefined ? null : { starttime: entry.starttime, state: "S", ppid: 1, sid: entry.sid }
      );
    },
    children: async () => await Promise.resolve([])
  };
  const result = await sweepLeftoverWork(path, {
    proc,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      table.delete(pid);
    },
    now: () => 0,
    sleep: async () => {},
    platform: "linux"
  });
  assert.deepEqual(
    signals.map(([pid]) => pid).sort((a, b) => a - b),
    [200, 201, 300],
    "each launch's own, in its own sessions"
  );
  assert.deepEqual(result, { found: 3, terminated: 3, killed: 0 });
  assert.equal(table.has(250) && table.has(202), true, "never what daemonized away, never another launch's");
  assert.deepEqual(await readLeftoverWork(path), [], "and the thread remembers none of it any more");
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("a close sweeps every remembered launch at once: one grace window, not one per launch", async () => {
  const path = await scratch();
  const launches = 8;
  for (let index = 0; index < launches; index += 1) {
    await recordLeftoverWork(path, {
      launchId: `l${index}`,
      recordedAt: `t${index}`,
      sessions: [{ sid: 100 + index, leaderStarttime: index }]
    });
  }
  // Every launch left a process that ignores SIGTERM: each sweep waits out its grace, then SIGKILLs.
  const table = new Map<number, { environ: string; starttime: number; sid: number }>(
    Array.from({ length: launches }, (_, index) => [
      100 + index,
      { environ: `${AGENT_LAUNCH_ENV_VAR}=l${index}\0`, starttime: index, sid: 100 + index }
    ])
  );
  const signals: Array<[number, NodeJS.Signals]> = [];
  let now = 0;
  let waiting = 0;
  let mostWaitingAtOnce = 0;
  const graceMs = 2_000;
  const result = await sweepLeftoverWork(path, {
    proc: {
      pids: async () => await Promise.resolve([...table.keys()]),
      environ: async (pid) => await Promise.resolve(table.get(pid)?.environ ?? null),
      stat: async (pid) => {
        const entry = table.get(pid);
        return await Promise.resolve(
          entry === undefined ? null : { starttime: entry.starttime, state: "S", ppid: 1, sid: entry.sid }
        );
      },
      children: async () => await Promise.resolve([])
    },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") table.delete(pid);
    },
    now: () => now,
    // One shared clock: every grace window a sweep waits advances it.
    sleep: async (ms) => {
      waiting += 1;
      mostWaitingAtOnce = Math.max(mostWaitingAtOnce, waiting);
      await new Promise<void>((resolve) => setImmediate(resolve));
      now += ms;
      waiting -= 1;
    },
    graceMs,
    pollMs: 50,
    platform: "linux"
  });
  assert.deepEqual(result, { found: launches, terminated: launches, killed: launches });
  assert.equal(mostWaitingAtOnce, launches, "every launch's grace window runs at the same time");
  assert.ok(now < 2 * graceMs, `the close waited ${now} ms: one grace window, never ${launches} of them`);
  assert.equal(table.size, 0);
});

test("a thread with nothing remembered sweeps nothing, and off Linux nothing is read", async () => {
  const path = await scratch();
  assert.deepEqual(await sweepLeftoverWork(path), { found: 0, terminated: 0, killed: 0 });
  await recordLeftoverWork(path, { launchId: "l", recordedAt: "t", sessions: [{ sid: 9, leaderStarttime: 1 }] });
  assert.deepEqual(await sweepLeftoverWork(path, { platform: "darwin" }), { found: 0, terminated: 0, killed: 0 });
});
