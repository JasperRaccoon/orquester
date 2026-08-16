import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { promisify } from "node:util";
import type { SystemStatusOptions } from "./system-status.ts";
import {
  SYSTEM_STATUS_SUPPORTED,
  SystemStatusService,
  collectDescendants,
  collectTree,
  cpuPercentFromSamples,
  decodeProcNetAddress,
  descendsFromRoot,
  mapLimited,
  parseCmdline,
  parseCpuSample,
  parseMemInfo,
  parseProcNetTcp,
  parseProcStat,
  parseProcStatus,
  parseSocketInode,
  readProcIdentity,
  resolveSocketOwners,
  verifyProcessIdentity
} from "./system-status.ts";

const exec = promisify(execFile);

test("parseCpuSample sums the aggregate line and counts iowait as idle", () => {
  const sample = parseCpuSample("cpu  100 2 30 900 50 0 8 0 0 0\ncpu0 1 1 1 1\n");
  assert.deepEqual(sample, { total: 1090, idle: 950 });
});

test("parseCpuSample tolerates junk", () => {
  assert.equal(parseCpuSample("intr 1 2 3\n"), null);
  assert.equal(parseCpuSample("cpu  1 2\n"), null);
});

test("parseMemInfo prefers MemAvailable and converts kB to bytes", () => {
  const info = parseMemInfo("MemTotal:       2048 kB\nMemFree:         100 kB\nMemAvailable:   1024 kB\n");
  assert.deepEqual(info, { totalBytes: 2048 * 1024, availableBytes: 1024 * 1024 });
});

test("parseMemInfo falls back to MemFree on pre-3.14 kernels", () => {
  const info = parseMemInfo("MemTotal:       2048 kB\nMemFree:         100 kB\n");
  assert.deepEqual(info, { totalBytes: 2048 * 1024, availableBytes: 100 * 1024 });
  assert.equal(parseMemInfo("Buffers: 4 kB\n"), null);
});

test("parseProcStatus reads name, ppid and RSS", () => {
  const status = "Name:\tclaude\nUmask:\t0022\nState:\tS (sleeping)\nPPid:\t1197\nVmRSS:\t  832852 kB\n";
  assert.deepEqual(parseProcStatus(status), { name: "claude", ppid: 1197, rssBytes: 832852 * 1024 });
});

test("parseProcStatus tolerates a kernel thread with no VmRSS", () => {
  assert.deepEqual(parseProcStatus("Name:\tkthreadd\nPPid:\t2\n"), {
    name: "kthreadd",
    ppid: 2,
    rssBytes: 0
  });
  assert.equal(parseProcStatus("State:\tS\n"), null);
});

test("parseCmdline joins the NUL-separated argv", () => {
  assert.equal(parseCmdline("node\0--import\0tsx\0cli.ts\0"), "node --import tsx cli.ts");
  assert.equal(parseCmdline(""), "");
});

test("decodeProcNetAddress decodes little-endian v4 and v6 addresses", () => {
  assert.deepEqual(decodeProcNetAddress("0100007F:1F90", false), { address: "127.0.0.1", port: 8080 });
  assert.deepEqual(decodeProcNetAddress("00000000:B9A7", false), { address: "0.0.0.0", port: 47527 });
  assert.deepEqual(decodeProcNetAddress("00000000000000000000000001000000:1F90", true), {
    address: "::1",
    port: 8080
  });
  assert.deepEqual(decodeProcNetAddress("00000000000000000000000000000000:0016", true), {
    address: "::",
    port: 22
  });
});

test("decodeProcNetAddress rejects malformed cells", () => {
  assert.equal(decodeProcNetAddress("0100007F", false), null);
  assert.equal(decodeProcNetAddress("01007F:1F90", false), null);
  assert.equal(decodeProcNetAddress("zzzzzzzz:1F90", false), null);
});

test("parseProcNetTcp keeps only LISTEN rows", () => {
  const dump = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:5B68 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 2142173 1 0 100 0 0 10 0",
    "   1: 0100007F:5B69 0100007F:C350 01 00000000:00000000 00:00000000 00000000   999        0 2142177 1 0 100 0 0 10 0"
  ].join("\n");
  assert.deepEqual(parseProcNetTcp(dump, false), [{ address: "127.0.0.1", port: 23400, inode: 2142173 }]);
  assert.deepEqual(parseProcNetTcp("", false), []);
});

test("parseSocketInode only matches socket links", () => {
  assert.equal(parseSocketInode("socket:[2142173]"), 2142173);
  assert.equal(parseSocketInode("/dev/null"), null);
  assert.equal(parseSocketInode("anon_inode:[eventpoll]"), null);
});

// pid 10 = daemon, pid 20 = tmux server (NOT a root), 21/22 = panes.
const procs = new Map<number, { ppid: number }>([
  [1, { ppid: 0 }],
  [10, { ppid: 1 }],
  [11, { ppid: 10 }],
  [20, { ppid: 1 }],
  [21, { ppid: 20 }],
  [22, { ppid: 20 }],
  [30, { ppid: 21 }],
  [31, { ppid: 30 }],
  [40, { ppid: 1 }]
]);
const roots = new Map<number, string | undefined>([
  [10, undefined],
  [21, "sess-a"],
  [22, "sess-b"]
]);

test("collectTree tags descendants with the nearest ancestor session", () => {
  const tree = collectTree(procs, roots);
  assert.deepEqual(
    [...tree].sort((left, right) => left[0] - right[0]),
    [
      [10, undefined],
      [11, undefined],
      [21, "sess-a"],
      [22, "sess-b"],
      [30, "sess-a"],
      [31, "sess-a"]
    ]
  );
  // The tmux server (20) sits ABOVE the pane roots, so it never enters the tree;
  // neither does an unrelated process (40) or init.
  assert.equal(tree.has(20), false);
  assert.equal(tree.has(40), false);
  assert.equal(tree.has(1), false);
});

test("collectTree terminates on a corrupted parent cycle", () => {
  const cyclic = new Map<number, { ppid: number }>([
    [5, { ppid: 6 }],
    [6, { ppid: 5 }]
  ]);
  assert.deepEqual([...collectTree(cyclic, new Map([[5, undefined]])).keys()], [5, 6]);
});

test("descendsFromRoot is the kill boundary", () => {
  const rootPids = new Set(roots.keys());
  assert.equal(descendsFromRoot(procs, rootPids, 31), true);
  assert.equal(descendsFromRoot(procs, rootPids, 11), true);
  assert.equal(descendsFromRoot(procs, rootPids, 21), true);
  // Outside the tree: an unrelated process, init, and the tmux server itself.
  assert.equal(descendsFromRoot(procs, rootPids, 40), false);
  assert.equal(descendsFromRoot(procs, rootPids, 1), false);
  assert.equal(descendsFromRoot(procs, rootPids, 20), false);
  assert.equal(descendsFromRoot(procs, rootPids, 999), false);
});

test("descendsFromRoot does not loop on a parent cycle", () => {
  const cyclic = new Map<number, { ppid: number }>([
    [5, { ppid: 6 }],
    [6, { ppid: 5 }]
  ]);
  assert.equal(descendsFromRoot(cyclic, new Set([99]), 5), false);
});

test("collectDescendants returns the pid plus everything under it", () => {
  assert.deepEqual(collectDescendants(procs, 21).sort((left, right) => left - right), [21, 30, 31]);
  assert.deepEqual(collectDescendants(procs, 31), [31]);
});

test("parseProcStat survives a comm containing spaces and parentheses", () => {
  const line =
    "4242 (my (weird) proc) S 1197 4242 4242 0 -1 4194304 100 0 0 0 " +
    "11 22 0 0 20 0 5 0 987654 1234 56 " +
    "18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n";
  assert.deepEqual(parseProcStat(line), { ppid: 1197, starttime: 987654 });
  assert.equal(parseProcStat("garbage without a paren"), null);
});

test("parseProcStat agrees with parseProcStatus on this very process", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  const [stat, status] = await Promise.all([
    readFile(`/proc/${process.pid}/stat`, "utf8"),
    readFile(`/proc/${process.pid}/status`, "utf8")
  ]);
  assert.equal(parseProcStat(stat)?.ppid, parseProcStatus(status)?.ppid);
  assert.ok((parseProcStat(stat)?.starttime ?? 0) > 0);
});

test("cpuPercentFromSamples is the busy share of the delta", () => {
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 1100, idle: 950 }), 50);
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 1100, idle: 1000 }), 0);
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 1100, idle: 900 }), 100);
  // A counter that did not move (or went backwards after a suspend) is unusable.
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 1000, idle: 900 }), null);
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 900, idle: 800 }), null);
});

test("mapLimited preserves order and never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 50 }, (_, index) => index);
  const results = await mapLimited(items, 4, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return item * 2;
  });
  assert.deepEqual(results, items.map((item) => item * 2));
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the limit`);
  assert.deepEqual(await mapLimited([], 4, async () => 1), []);
});

test("resolveSocketOwners picks the lowest pid sharing a listen socket", () => {
  const tree = new Map<number, string | undefined>([
    [700, "sess-a"],
    [701, "sess-a"],
    [702, "sess-a"]
  ]);
  const names = new Map([
    [700, "nginx"],
    [701, "nginx"],
    [702, "nginx"]
  ]);
  // A prefork pool: the whole pool holds inode 55. Scan order must not matter.
  const links = [
    { pid: 702, inode: 55 },
    { pid: 700, inode: 55 },
    { pid: 701, inode: 55 },
    { pid: 701, inode: 66 }
  ];
  const forward = resolveSocketOwners(links, tree, names, new Set([55]));
  const reversed = resolveSocketOwners([...links].reverse(), tree, names, new Set([55]));
  assert.deepEqual(forward.get(55), { pid: 700, processName: "nginx", sessionId: "sess-a" });
  assert.deepEqual(reversed.get(55), forward.get(55));
  // Inode 66 is not in the LISTEN set, so it is never attributed.
  assert.equal(forward.has(66), false);
});

// --- Live-host tests (Linux only; they only ever touch this process' own children).

const service = (overrides: Partial<SystemStatusOptions> = {}): SystemStatusService =>
  new SystemStatusService({
    fsRoot: process.cwd(),
    // A socket no tmux server listens on: panePids()/serverPid() answer empty,
    // so the tree roots at THIS test process and nothing live is ever a target.
    tmuxSocket: join(tmpdir(), `orq-system-status-test-${process.pid}.sock`),
    listSessionIds: () => new Set<string>(),
    ...overrides
  });

test("resources() resamples CPU when the stored baseline is stale", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  const slept: number[] = [];
  let clock = Date.now();
  const stale = service({
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      await setTimeoutPromise(ms);
    }
  });
  // Jump past the staleness bound: the constructor's baseline is now useless.
  clock += 60_000;
  const resourcesAfterGap = await stale.resources();
  assert.deepEqual(slept, [200], "a stale baseline must be replaced by a fresh short-interval pair");
  assert.ok(resourcesAfterGap.cpu.percent >= 0 && resourcesAfterGap.cpu.percent <= 100);
  assert.equal(resourcesAfterGap.supported, true);
  assert.ok((resourcesAfterGap.workspacesDisk.totalBytes ?? 0) > 0);

  // A second read a beat later reuses the (now fresh) baseline: no resample.
  clock += 5000;
  await stale.resources();
  assert.deepEqual(slept, [200], "a fresh baseline must not trigger a second sample");
});

test("resources() reports an unmeasurable volume as unknown, not as 0 bytes", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  const missing = join(tmpdir(), `orq-no-such-dir-${process.pid}`);
  const { workspacesDisk } = await service({ fsRoot: missing }).resources();
  assert.deepEqual(workspacesDisk, {
    totalBytes: null,
    freeBytes: null,
    usedPercent: null,
    path: missing
  });
});

test("verifyProcessIdentity rejects a pid whose parent changed under us", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    assert.ok(child.pid);
    const starttime = await verifyProcessIdentity(child.pid, process.pid);
    assert.ok(starttime !== null && starttime > 0, "a matching parent yields the starttime handle");
    // Same pid, a parent that does not match the snapshot => the pid was reused
    // since the scan, so the kill loop must skip it.
    assert.equal(await verifyProcessIdentity(child.pid, process.pid + 1), null);
    // starttime is stable across reads — that is what makes it usable as the
    // pre-signal identity check once parents start exiting.
    assert.equal((await readProcIdentity(child.pid))?.starttime, starttime);
    assert.equal((await readProcIdentity(child.pid))?.ppid, process.pid);
  } finally {
    child.kill("SIGKILL");
  }
  // A pid that no longer exists at all is not signalable either.
  assert.equal(await verifyProcessIdentity(2 ** 22 - 1, 1), null);
  assert.equal(await readProcIdentity(2 ** 22 - 1), null);
});

test("kill() refuses with a discriminating code and only kills our own subtree", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  const status = service();
  assert.deepEqual(
    { ...(await status.kill(0)) },
    { ok: false, code: "INVALID_PID", error: "Invalid pid." }
  );
  assert.equal((await status.kill(Number.NaN)).ok, false);
  const self = await status.kill(process.pid);
  assert.equal(self.ok, false);
  assert.equal(self.ok === false && self.code, "PROCESS_PROTECTED");
  // pid 1 is init: outside the tree AND below the pid floor.
  assert.equal((await status.kill(1)).ok, false);

  // A live process OUTSIDE the tree: `sh` exits immediately, so its backgrounded
  // sleep is reparented away from this process and is no longer ours to kill.
  const { stdout: orphanPid } = await exec("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"]);
  const orphan = Number(orphanPid.trim());
  assert.ok(Number.isInteger(orphan) && orphan > 1);
  try {
    const unmanaged = await status.kill(orphan);
    assert.equal(unmanaged.ok === false && unmanaged.code, "PROCESS_NOT_MANAGED");
    const { stdout } = await exec("sh", ["-c", `kill -0 ${orphan} 2>/dev/null && echo alive || echo gone`]);
    assert.equal(stdout.trim(), "alive", "a refused kill must not have signalled anything");
  } finally {
    try {
      process.kill(orphan, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  // A child of this test process IS in the tree (process.pid is a root). The
  // backgrounded sleep is the interesting one: killing the shell orphans it, so
  // it only dies if the whole subtree was signalled before any parent exited.
  const victim = spawn("sh", ["-c", "sleep 30 & sleep 30"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => victim.on("exit", () => resolve()));
  await setTimeoutPromise(300);
  assert.ok(victim.pid);
  const { stdout: childPids } = await exec("pgrep", ["-P", String(victim.pid)]);
  const subtree = childPids.trim().split("\n").map(Number);
  assert.equal(subtree.length, 2, "the shell should have both sleeps as children");

  const result = await status.kill(victim.pid);
  assert.equal(result.ok, true);
  // `killed` counts signals actually sent: the shell usually exits on its own
  // once its foreground child dies, so only the two sleeps are guaranteed.
  assert.ok(result.ok === true && result.killed >= 2, "the victim subtree should be signalled");
  await exited;
  await setTimeoutPromise(200);
  for (const pid of [victim.pid, ...subtree]) {
    const { stdout } = await exec("sh", ["-c", `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`]);
    assert.equal(stdout.trim(), "gone", `pid ${pid} survived the subtree kill`);
  }
});

test("kill() refuses a protectedPids entry, directly and inside a subtree", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  // Stands in for the tmux-less model-proxy child: a real child of this
  // process, so it passes the "managed by this daemon" gate and would be
  // killable if the guard were missing.
  const proxy = spawn("sleep", ["30"], { stdio: "ignore" });
  const parent = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
  try {
    await setTimeoutPromise(300);
    assert.ok(proxy.pid && parent.pid);
    const status = service({ protectedPids: () => [proxy.pid as number] });

    const refused = await status.kill(proxy.pid);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.code, "PROCESS_PROTECTED");
    const { stdout: alive } = await exec("sh", [
      "-c",
      `kill -0 ${proxy.pid} 2>/dev/null && echo alive || echo gone`
    ]);
    assert.equal(alive.trim(), "alive", "a refused kill must not have signalled anything");

    // Protected INSIDE a requested subtree: killing the shell must spare it.
    const { stdout: kids } = await exec("pgrep", ["-P", String(parent.pid)]);
    const spared = Number(kids.trim().split("\n")[0]);
    assert.ok(Number.isInteger(spared) && spared > 1);
    const sub = service({ protectedPids: () => [spared] });
    assert.equal((await sub.kill(parent.pid)).ok, true);
    await setTimeoutPromise(200);
    const { stdout: after } = await exec("sh", [
      "-c",
      `kill -0 ${spared} 2>/dev/null && echo alive || echo gone`
    ]);
    assert.equal(after.trim(), "alive", "a protected descendant must survive a subtree kill");

    // The spared sleep is now reparented (its shell died), so it is no longer
    // ours — clean it up by hand rather than through the service.
    try {
      process.kill(spared, "SIGKILL");
    } catch {
      // Already gone.
    }

    // A supplier that throws must not turn a legitimate kill into a 500 — nor
    // fail closed and refuse everything.
    const throwing = service({
      protectedPids: () => {
        throw new Error("boom");
      }
    });
    assert.equal((await throwing.kill(proxy.pid)).ok, true);
  } finally {
    for (const child of [proxy, parent]) {
      child.kill("SIGKILL");
    }
  }
});

test("concurrent cold processes()+ports() share one /proc scan", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  // rootPids() calls listSessionIds() exactly once per scan, so it counts scans
  // without reaching into the private cache.
  let scans = 0;
  const status = service({
    listSessionIds: () => {
      scans += 1;
      return new Set<string>();
    }
  });

  // Cold cache, both in flight: without the in-flight memo each would walk
  // every pid on the box before either could store its result.
  await Promise.all([status.processes(), status.ports()]);
  assert.equal(scans, 1, "the second caller must join the scan already running");

  // The settled scan is now the ordinary cache — still one scan.
  await status.processes();
  assert.equal(scans, 1);

  // The kill guard must never ride a shared scan: `fresh` always rescans.
  // pid 2 (kthreadd) is not a descendant of this process, so nothing is
  // signalled — the guard rejects it after the scan.
  const result = await status.kill(2);
  assert.equal(result.ok, false);
  assert.equal(scans, 2, "a fresh snapshot must not reuse the shared one");
});
