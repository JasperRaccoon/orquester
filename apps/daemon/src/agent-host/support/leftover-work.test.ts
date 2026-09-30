import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import { drain, mockProc } from "./leftover-processes.testing.ts";
import {
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

  for (let launch = 2; launch <= 8 + 2; launch += 1) {
    await recordLeftoverWork(path, {
      launchId: `l${launch}`,
      recordedAt: `t${launch}`,
      sessions: [{ sid: launch * 100, leaderStarttime: launch }]
    });
  }
  const kept = await readLeftoverWork(path);
  assert.equal(kept.length, 8, "the last few launches only");
  assert.equal(kept.at(-1)?.launchId, `l${8 + 2}`, "newest last");
  assert.equal(kept.some((launch) => launch.launchId === "l1"), false, "the oldest dropped first");
});

test("a launch keeps its newest sessions only", async () => {
  const path = await scratch();
  const many = Array.from({ length: 64 + 10 }, (_, index) => ({ sid: index + 2, leaderStarttime: index }));
  await recordLeftoverWork(path, { launchId: "l1", recordedAt: "t1", sessions: many });
  const [launch] = await readLeftoverWork(path);
  assert.equal(launch?.sessions.length, 64);
  assert.equal(launch?.sessions.at(-1)?.sid, 64 + 11, "the newest sessions kept");
});

test("a file that is not what this host writes reads as nothing, entry by entry", async () => {
  const path = await scratch();
  assert.deepEqual(await readLeftoverWork(path), []);
  for (const contents of ["not json", JSON.stringify({ version: 99, launches: [] })]) {
    await writeFile(path, contents);
    assert.deepEqual(await readLeftoverWork(path), []);
  }
  await writeFile(path, JSON.stringify({
    version: 1,
    launches: [
      { launchId: "", recordedAt: "t", sessions: [] },
      { launchId: "ok", recordedAt: "t", sessions: [{ sid: 5, leaderStarttime: 1 }, { sid: "x" }, { sid: 1, leaderStarttime: 2 }] },
      "junk"
    ]
  }));
  assert.deepEqual(
    await readLeftoverWork(path),
    [{ launchId: "ok", recordedAt: "t", sessions: [{ sid: 5, leaderStarttime: 1 }] }],
    "a session id is a pid above 1, a launch names itself"
  );
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

test("the sweep stops each launch's work by its own marker and sessions — nothing else — then forgets it", async (t) => {
  const path = await scratch();
  await recordLeftoverWork(path, { launchId: "old", recordedAt: "t1", sessions: [{ sid: 200, leaderStarttime: 20 }] });
  await recordLeftoverWork(path, { launchId: "newer", recordedAt: "t2", sessions: [{ sid: 300, leaderStarttime: 30 }] });
  const marked = (launch: string) => `PATH=/bin\0ORQUESTER_AGENT_LAUNCH=${launch}\0`;
  const proc = mockProc(t, {
    200: { environ: marked("old"), starttime: 20, sid: 200, diesOn: "SIGTERM" },
    201: { environ: marked("old"), starttime: 21, sid: 200, diesOn: "SIGTERM" },
    300: { environ: marked("newer"), starttime: 30, sid: 300, diesOn: "SIGTERM" },
    250: { environ: marked("old"), starttime: 25, sid: 250 },
    202: { environ: marked("someone-else"), starttime: 22, sid: 200 }
  });
  const result = await sweepLeftoverWork(path);
  assert.deepEqual(proc.signals.map(([pid]) => pid).sort((a, b) => a - b), [200, 201, 300]);
  assert.deepEqual(result, { found: 3, terminated: 3, killed: 0 });
  assert.equal(proc.table.has(250) && proc.table.has(202), true);
  assert.deepEqual(await readLeftoverWork(path), []);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("a close sweeps every remembered launch at once: one grace window, not one per launch", async (t) => {
  const path = await scratch();
  const launches = 8;
  for (let index = 0; index < launches; index += 1) {
    await recordLeftoverWork(path, {
      launchId: `l${index}`,
      recordedAt: `t${index}`,
      sessions: [{ sid: 100 + index, leaderStarttime: index }]
    });
  }
  const proc = mockProc(t, Object.fromEntries(Array.from({ length: launches }, (_, index) => [
    100 + index,
    { environ: `ORQUESTER_AGENT_LAUNCH=l${index}\0`, starttime: index, sid: 100 + index }
  ])));
  let started!: () => void;
  const firstSignal = new Promise<void>((resolve) => { started = resolve; });
  proc.hooks.signal = started;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const running = sweepLeftoverWork(path, { graceMs: 2_000 });
  await firstSignal;
  await drain();
  assert.equal(proc.signals.filter(([, signal]) => signal === "SIGTERM").length, launches);
  t.mock.timers.tick(2_000);
  assert.deepEqual(await running, { found: launches, terminated: launches, killed: launches });
  assert.equal(proc.table.size, 0);
});

test("a thread with nothing remembered sweeps nothing, and off Linux nothing is read", async (t) => {
  const path = await scratch();
  assert.deepEqual(await sweepLeftoverWork(path), { found: 0, terminated: 0, killed: 0 });
  await recordLeftoverWork(path, { launchId: "l", recordedAt: "t", sessions: [{ sid: 9, leaderStarttime: 1 }] });
  const proc = mockProc(t, {});
  Object.defineProperty(process, "platform", { value: "darwin" });
  assert.deepEqual(await sweepLeftoverWork(path), { found: 0, terminated: 0, killed: 0 });
  assert.deepEqual(proc.reads, []);
  assert.deepEqual(proc.signals, []);
});
