import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withDeadline } from "./agent-host/support/deadline.ts";
import { AGENT_LAUNCH_ENV_VAR } from "./agent-host/support/leftover-processes.ts";
import type { SystemStatusOptions } from "./system-status.ts";
import {
  SYSTEM_STATUS_SUPPORTED,
  SystemStatusService,
  collectTree,
  cpuPercentFromSamples,
  decodeProcNetAddress,
  descendsFromRoot,
  isVirtualInterface,
  launchMarkerOf,
  parseBootTime,
  parseCgroupPath,
  parseCmdline,
  parseCpuSample,
  parseDiskStats,
  parseMemInfo,
  parseNetDev,
  parsePasswd,
  parseProcIo,
  parseProcNetTcp,
  parseProcStat,
  parseProcStatDetail,
  parseProcStatus,
  parseSocketInode,
  procMetrics,
  processCpuPercent,
  processStateOf,
  ratePerSecond,
  readProcIdentity,
  resolveSocketOwners,
  shieldedPids,
  verifyProcessIdentity
} from "./system-status.ts";

/**
 * This test process's environment without the agent host's launch marker: run
 * from a Grok chat's shell, every orphan these tests make would carry it, and
 * an "unmanaged" orphan would be managed after all.
 */
function unmarkedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[AGENT_LAUNCH_ENV_VAR];
  return env;
}

/**
 * Run `script` under a `sh` that exits at once, orphaning what it started in
 * the background — which must announce its pids as ONE line on stdout. Resolves
 * once that line arrived AND the shell exited (so the orphans are init's, no
 * longer this process's); `gone` settles when every process still holding the
 * announcing pipe — the orphan and whatever inherited its stdout — has exited.
 * Nothing polls: both are events of the pipe and the shell.
 */
async function orphaned(
  script: string,
  env: NodeJS.ProcessEnv
): Promise<{ pids: number[]; gone: Promise<void> }> {
  const shell = spawn("sh", ["-c", script], { env, stdio: ["ignore", "pipe", "ignore"] });
  shell.stdout.setEncoding("utf8");
  const gone = once(shell.stdout, "close").then(() => undefined);
  const announced = new Promise<string>((resolve, reject) => {
    let buffer = "";
    shell.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end !== -1) resolve(buffer.slice(0, end));
    });
    void gone.then(() => reject(new Error("the orphan exited before it announced its pids")));
  });
  const [line] = await Promise.all([announced, once(shell, "exit")]);
  const pids = line.trim().split(/\s+/).map(Number);
  assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 1), `announced: ${line}`);
  return { pids, gone };
}

/** A live user-space process of another user, or null when this host shows none (or we are root). */
async function foreignPid(): Promise<number | null> {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) return null;
  for (const entry of await readdir("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 2) continue;
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const owner = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    // A kernel thread has no VmRSS; a user-space one always does.
    if (owner !== undefined && Number(owner) !== uid && /^VmRSS:/m.test(status)) return pid;
  }
  return null;
}

/** `gone`, bounded: a process that survives fails the test instead of hanging it. */
async function allGone(gone: Promise<void>, label: string): Promise<void> {
  await withDeadline(gone, { label, timeoutMs: 5_000 });
}

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

test("parseProcStatus reads the real uid when the status names one", () => {
  const status = "Name:\tgrok\nPPid:\t1\nUid:\t999\t998\t997\t996\nVmRSS:\t  4 kB\n";
  assert.deepEqual(parseProcStatus(status), { name: "grok", ppid: 1, rssBytes: 4096, uid: 999 });
});

test("launchMarkerOf reads the agent host's launch marker and the chat it belongs to", () => {
  const environ = (vars: Record<string, string>): string =>
    Object.entries(vars)
      .map(([key, value]) => `${key}=${value}\0`)
      .join("");
  assert.deepEqual(
    launchMarkerOf(environ({ PATH: "/bin", [AGENT_LAUNCH_ENV_VAR]: "l-1", ORQUESTER_SESSION_ID: "chat-1" })),
    { launchId: "l-1", sessionId: "chat-1" }
  );
  assert.deepEqual(launchMarkerOf(environ({ [AGENT_LAUNCH_ENV_VAR]: "l-2" })), { launchId: "l-2" });
  assert.equal(launchMarkerOf(environ({ [AGENT_LAUNCH_ENV_VAR]: "" })), null, "an empty marker is none");
  assert.equal(launchMarkerOf(environ({ ORQUESTER_SESSION_ID: "chat-1" })), null, "a session id alone is not a launch");
  assert.equal(launchMarkerOf(`X${AGENT_LAUNCH_ENV_VAR}=l-3\0`), null);
  assert.equal(launchMarkerOf(""), null);
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

test("descendsFromRoot does not loop on a parent cycle", () => {
  const cyclic = new Map<number, { ppid: number }>([
    [5, { ppid: 6 }],
    [6, { ppid: 5 }]
  ]);
  assert.equal(descendsFromRoot(cyclic, new Set([99]), 5), false);
});

test("shieldedPids covers each guarded pid and every ancestor up to init, cycle-safe", () => {
  const procs = new Map<number, { ppid: number }>([
    [10, { ppid: 1 }],
    [20, { ppid: 10 }],
    [30, { ppid: 20 }],
    [40, { ppid: 10 }],
    [50, { ppid: 51 }],
    [51, { ppid: 50 }]
  ]);
  assert.deepEqual([...shieldedPids(procs, [30])].sort((a, b) => a - b), [10, 20, 30], "init is never shielded");
  assert.equal(shieldedPids(procs, [30]).has(40), false, "a sibling is not");
  assert.deepEqual([...shieldedPids(procs, [50])].sort((a, b) => a - b), [50, 51]);
  assert.deepEqual([...shieldedPids(procs, [99])], [99], "a guarded pid the snapshot missed is still guarded");
});

test("parseProcStat survives a comm containing spaces and parentheses", () => {
  const line =
    "4242 (my (weird) proc) S 1197 4242 4242 0 -1 4194304 100 0 0 0 " +
    "11 22 0 0 20 0 5 0 987654 1234 56 " +
    "18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n";
  assert.deepEqual(parseProcStat(line), { ppid: 1197, starttime: 987654 });
  assert.equal(parseProcStat("garbage without a paren"), null);
});

test("parseProcStatDetail reads state, cpu ticks, threads and starttime past a weird comm", () => {
  const line =
    "4242 (my (weird) proc) S 1197 4242 4242 0 -1 4194304 100 0 0 0 " +
    "11 22 0 0 20 0 5 0 987654 1234 56 " +
    "18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n";
  assert.deepEqual(parseProcStatDetail(line), {
    kernelThread: false,
    state: "sleeping",
    ppid: 1197,
    cpuTicks: 33,
    threads: 5,
    starttime: 987654
  });
  // PF_KTHREAD (0x00200000) in the flags field marks a kernel thread, whatever its pid.
  const kthread = "17 (kworker/0:1) I 2 0 0 0 -1 69238880 0 0 0 0 0 5 0 0 20 0 1 0 300 0 0";
  assert.equal(parseProcStatDetail(kthread)?.kernelThread, true);
  assert.equal(parseProcStatDetail("garbage without a paren"), null);
  assert.equal(parseProcStatDetail("1 (x) R 0"), null);
});

test("processStateOf names every scheduler state and falls back to other", () => {
  assert.deepEqual(
    ["R", "S", "D", "T", "t", "Z", "X", "I", "W"].map(processStateOf),
    ["running", "sleeping", "disk-wait", "stopped", "stopped", "zombie", "zombie", "idle", "other"]
  );
});

test("parseProcIo reads the block-layer byte counters, not rchar/wchar", () => {
  const io = "rchar: 4092\nwchar: 10\nsyscr: 9\nsyscw: 0\nread_bytes: 8192\nwrite_bytes: 4096\ncancelled_write_bytes: 0\n";
  assert.deepEqual(parseProcIo(io), { readBytes: 8192, writeBytes: 4096 });
  assert.equal(parseProcIo("rchar: 1\n"), null);
});

test("parseNetDev sums physical interfaces and skips loopback, bridges and tunnels", () => {
  const dev = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 900 1 0 0 0 0 0 0 900 1 0 0 0 0 0 0",
    "  eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0",
    "  ens4: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0",
    "docker0: 50 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0",
    "veth1a2b: 50 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0",
    "tailscale0: 70 1 0 0 0 0 0 0 70 1 0 0 0 0 0 0"
  ].join("\n");
  assert.deepEqual(parseNetDev(dev), { rxBytes: 110, txBytes: 220 });
  assert.equal(parseNetDev(dev.split("\n").slice(0, 3).join("\n")), null, "loopback alone is no measurement");
  assert.equal(isVirtualInterface("br-12ab"), true);
  assert.equal(isVirtualInterface("wg0"), true);
  assert.equal(isVirtualInterface("enp3s0"), false);
});

test("parseDiskStats counts whole disks only, in 512-byte sectors", () => {
  const stats = [
    "   7       0 loop0 11 0 28 0 0 0 0 0 0 1 0",
    "   8       0 sda 100 0 10 0 50 0 20 0 0 0 0",
    "   8       1 sda1 100 0 10 0 50 0 20 0 0 0 0",
    " 259       0 nvme0n1 1 0 2 0 1 0 4 0 0 0 0",
    " 259       1 nvme0n1p1 1 0 2 0 1 0 4 0 0 0 0",
    " 253       0 dm-0 1 0 99 0 1 0 99 0 0 0 0"
  ].join("\n");
  assert.deepEqual(parseDiskStats(stats), { readBytes: 12 * 512, writeBytes: 24 * 512 });
  assert.equal(parseDiskStats("   7       0 loop0 11 0 28 0 0 0 0 0 0 1 0"), null);
});

test("parsePasswd maps uids to names and skips malformed lines", () => {
  const users = parsePasswd("root:x:0:0:root:/root:/bin/bash\norquester:x:999:999::/var/lib/orquester:/bin/sh\nbroken\n:x:5:5\n");
  assert.deepEqual([...users], [[0, "root"], [999, "orquester"]]);
});

test("parseBootTime reads btime from /proc/stat", () => {
  assert.equal(parseBootTime("cpu  1 2 3 4\nbtime 1700000000\nprocesses 5\n"), 1700000000);
  assert.equal(parseBootTime("cpu  1 2 3 4\n"), null);
});

test("parseCgroupPath prefers the unified v2 line, then v1's systemd hierarchy", () => {
  assert.equal(parseCgroupPath("0::/system.slice/orquester.service\n"), "/system.slice/orquester.service");
  assert.equal(
    parseCgroupPath("12:cpu,cpuacct:/user.slice\n1:name=systemd:/user.slice/session-3.scope\n0::/\n"),
    "/"
  );
  assert.equal(
    parseCgroupPath("12:cpu,cpuacct:/user.slice\n1:name=systemd:/user.slice/session-3.scope\n"),
    "/user.slice/session-3.scope"
  );
  assert.equal(parseCgroupPath("4:memory:/docker/abc\n"), "/docker/abc");
  assert.equal(parseCgroupPath(""), null);
  assert.equal(parseCgroupPath("garbage"), null);
});

test("ratePerSecond and processCpuPercent refuse resets and empty intervals", () => {
  assert.equal(ratePerSecond(1000, 3000, 2000), 1000);
  assert.equal(ratePerSecond(3000, 1000, 2000), null, "a counter that went backwards was reset");
  assert.equal(ratePerSecond(1000, 3000, 0), null);
  // 12 ticks of a 400-tick interval across all cores is 3% of the machine.
  assert.equal(processCpuPercent(100, 112, 400), 3);
  assert.equal(processCpuPercent(100, 101, 300), 0.3);
  assert.equal(processCpuPercent(112, 100, 400), null);
  assert.equal(processCpuPercent(100, 112, 0), null);
});

test("procMetrics diffs only the same process within the staleness window", () => {
  const first = procMetrics(
    new Map([
      [10, { stat: { starttime: 5, cpuTicks: 100 }, io: { readBytes: 0, writeBytes: 0 } }],
      [11, { stat: { starttime: 6, cpuTicks: 50 } }]
    ]),
    null,
    1_000,
    10_000
  );
  assert.deepEqual(first.metrics.get(10), { cpuPercent: null, diskReadBps: null, diskWriteBps: null }, "first sight has no delta");

  const second = procMetrics(
    new Map([
      [10, { stat: { starttime: 5, cpuTicks: 120 }, io: { readBytes: 4096, writeBytes: 2048 } }],
      // Pid 11 was recycled: a new starttime must not be diffed against the old process.
      [11, { stat: { starttime: 99, cpuTicks: 10 } }],
      [12, {}]
    ]),
    first.samples,
    3_000,
    10_400
  );
  assert.deepEqual(second.metrics.get(10), { cpuPercent: 5, diskReadBps: 2048, diskWriteBps: 1024 });
  assert.deepEqual(second.metrics.get(11), { cpuPercent: null, diskReadBps: null, diskWriteBps: null });
  assert.equal(second.metrics.has(12), false, "a row with no stat has nothing to measure");

  const stale = procMetrics(
    new Map([[10, { stat: { starttime: 5, cpuTicks: 200 } }]]),
    second.samples,
    3_000 + 60_000,
    20_000
  );
  assert.equal(stale.metrics.get(10)?.cpuPercent, null, "a baseline a minute old is not 'now'");
  // Two scans that land together (the kill guard's fresh scan beside a poll):
  // the second diffs over a sliver of time, which is noise, and must not
  // become the next baseline either.
  const sliver = procMetrics(new Map([[10, { stat: { starttime: 5, cpuTicks: 121 } }]]), second.samples, 3_200, 10_402);
  assert.equal(sliver.metrics.get(10)?.cpuPercent, null, "a 200 ms delta is not a rate");
  assert.equal(sliver.samples, second.samples, "the earlier baseline is kept");
});

test("cpuPercentFromSamples is the busy share of the delta", () => {
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 1100, idle: 950 }), 50);
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 1100, idle: 1000 }), 0);
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 1100, idle: 900 }), 100);
  // A counter that did not move (or went backwards after a suspend) is unusable.
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 1000, idle: 900 }), null);
  assert.equal(cpuPercentFromSamples({ total: 1000, idle: 900 }, { total: 900, idle: 800 }), null);
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

test("kill() refuses with a discriminating code, kills our own user's processes and never another user's", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  const status = service();
  const invalid = await status.kill(0);
  assert.equal(invalid.ok === false && invalid.code, "INVALID_PID");
  assert.equal((await status.kill(Number.NaN)).ok, false);
  const self = await status.kill(process.pid);
  assert.equal(self.ok, false);
  assert.equal(self.ok === false && self.code, "PROCESS_PROTECTED");
  // pid 1 is init: outside the tree AND below the pid floor.
  assert.equal((await status.kill(1)).ok, false);

  // A live process OUTSIDE the tree: `sh` exits immediately, so its backgrounded
  // sleep is reparented away from this process — but it still runs as our user,
  // who could `kill` it from any terminal tab, so the guard lets it through.
  const { pids: [orphan], gone: orphanGone } = await orphaned("sleep 30 & echo $!", unmarkedEnv());
  assert.ok(orphan !== undefined && orphan > 1);
  try {
    const unmanaged = await status.kill(orphan);
    assert.equal(unmanaged.ok === true && unmanaged.killed, 1, "our own user's orphan is a target");
    await allGone(orphanGone, "the orphaned sleep exiting");
  } finally {
    try {
      process.kill(orphan, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  // Another user's process is never one: refused before anything is signalled.
  const foreign = await foreignPid();
  if (foreign !== null) {
    const refused = await status.kill(foreign);
    assert.equal(refused.ok === false && refused.code, "PROCESS_NOT_MANAGED");
  }

  // A child of this test process IS in the tree (process.pid is a root). The
  // backgrounded sleep is the interesting one: killing the shell orphans it, so
  // it only dies if the whole subtree was signalled before any parent exited.
  const victim = spawn("sh", ["-c", 'sleep 30 & a=$!; sleep 30 & b=$!; printf "%s %s\\n" "$a" "$b"; wait'], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  const exited = once(victim, "exit");
  const gone = once(victim.stdout, "close").then(() => undefined);
  const [announced] = await once(victim.stdout, "data");
  const subtree = String(announced).trim().split(/\s+/).map(Number);
  try {
    assert.ok(victim.pid);
    assert.equal(subtree.length, 2, "the shell announced both children after spawning them");
    assert.ok(subtree.every((pid) => Number.isInteger(pid) && pid > 1));
    const result = await status.kill(victim.pid);
    assert.equal(result.ok, true);
    assert.ok(result.ok === true && result.killed >= 2, "the victim subtree should be signalled");
    await exited;
    // Both sleeps inherit stdout: closure proves no descendant still holds it.
    await allGone(gone, "the entire selected subtree exiting");
  } finally {
    for (const pid of [victim.pid, ...subtree]) {
      if (!pid) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }

});

test("kill() sends SIGKILL when asked, ending a process SIGTERM cannot, and refuses any other signal", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  const status = service();
  // The shell announces itself only once its trap is in place; the sleeps it
  // runs inherit the ignored SIGTERM, so nothing in the subtree dies of one.
  const stubborn = spawn("sh", ["-c", 'trap "" TERM; echo ready; while :; do sleep 1; done'], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  const exited = once(stubborn, "exit");
  await once(stubborn.stdout, "data");
  try {
    assert.ok(stubborn.pid);
    const refused = await status.kill(stubborn.pid, "SIGSTOP");
    assert.equal(refused.ok === false && refused.code, "INVALID_SIGNAL");

    const term = await status.kill(stubborn.pid);
    assert.equal(term.ok === true && term.signal, "SIGTERM", "SIGTERM stays the default");
    assert.doesNotThrow(() => process.kill(stubborn.pid!, 0), "the shell ignores SIGTERM");

    const forced = await status.kill(stubborn.pid, "SIGKILL");
    assert.equal(forced.ok === true && forced.signal, "SIGKILL");
    const [, signal] = await withDeadline(exited, { label: "the SIGTERM-proof shell exiting", timeoutMs: 5_000 });
    assert.equal(signal, "SIGKILL");
  } finally {
    try { process.kill(stubborn.pid!, "SIGKILL"); } catch { /* Already gone. */ }
  }
});

test("a process carrying the agent host's launch marker is managed even as an orphan: listed, labelled, killable", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  // What a provider CLI leaves behind when it dies with the host: a shell in a
  // session of its own, with two children, reparented away from every root —
  // only its environment still says whose it is.
  const env = { ...unmarkedEnv(), [AGENT_LAUNCH_ENV_VAR]: randomUUID(), ORQUESTER_SESSION_ID: "chat-1" };
  const { pids, gone } = await orphaned(
    `setsid sh -c 'sleep 30 & a=$!; sleep 30 & b=$!; echo "$$ $a $b"; wait' &`,
    env
  );
  const [orphan, ...children] = pids as [number, ...number[]];
  try {
    assert.equal(children.length, 2, "the orphan started its two sleeps");
    const status = service({ listSessionIds: () => new Set(["chat-1"]) });
    const listed = (await status.processes()).processes;
    const root = listed.find((row) => row.pid === orphan);
    assert.ok(root, "the marked orphan is listed");
    assert.equal(root?.sessionId, "chat-1", "labelled with the chat its launch belongs to");
    for (const child of children) {
      const sleep = listed.find((row) => row.pid === child);
      assert.ok(sleep, "and so is what it started");
      assert.equal(sleep?.sessionId, "chat-1");
    }

    const result = await status.kill(orphan);
    assert.equal(result.ok, true, "managed: the kill guard lets it through");
    // `killed` counts signals actually sent: the shell may exit on its own once
    // its foreground sleep dies, so only the two sleeps are guaranteed.
    assert.ok(result.ok === true && result.killed >= 2, "the orphan's subtree is signalled");
    await allGone(gone, "the orphan and its two sleeps exiting after the kill");
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("a marked process whose parent still runs outside every root is no orphan: listed unmanaged, stoppable as our user's", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) {
    return;
  }
  // Only a process init adopted — or whose parent is gone — is what a provider
  // CLI left behind; what such an orphan started comes with it, as a
  // descendant. A marked process whose parent is alive and none of ours (here
  // an unmarked shell that set the marker on its child by hand) is that
  // parent's, and no marker makes it ours.
  const { pids, gone } = await orphaned(
    `setsid sh -c '${AGENT_LAUNCH_ENV_VAR}=${randomUUID()} ORQUESTER_SESSION_ID=chat-1 sleep 30 & echo "$$ $!"; wait' &`,
    unmarkedEnv()
  );
  const [parent, marked] = pids as [number, number];
  try {
    const status = service({ listSessionIds: () => new Set(["chat-1"]) });
    const listed = (await status.processes("host")).processes;
    const markedRow = listed.find((row) => row.pid === marked);
    const parentRow = listed.find((row) => row.pid === parent);
    assert.equal(markedRow?.managed, false, "the marked child is not Orquester's");
    assert.equal(parentRow?.managed, false, "nor is its unmarked parent");
    assert.equal(markedRow?.stoppable, true, "but it runs as our user, so Stop is offered");
    assert.equal(parentRow?.stoppable, true);
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await allGone(gone, "the test's own processes exiting");
  }
});

test("kill() refuses a protectedPids entry and every process it runs under", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) return;
  const guarded = spawn("sleep", ["30"], { stdio: "ignore" });
  const started = once(guarded, "spawn");
  const guardedGone = once(guarded, "exit").then(() => undefined);
  const parent = spawn("sh", ["-c", "sleep 30 & child=$!; printf '%s\\n' \"$child\"; wait \"$child\""], { stdio: ["ignore", "pipe", "ignore"] });
  const parentGone = once(parent, "exit").then(() => undefined);
  const childAnnounced = once(parent.stdout, "data");
  let spared: number | undefined;
  try {
    const [, [line]] = await Promise.all([started, childAnnounced]);
    spared = Number(String(line).trim());
    assert.ok(guarded.pid && parent.pid);
    assert.ok(Number.isInteger(spared) && spared > 1);
    const status = service({ protectedPids: () => [{ pid: guarded.pid!, label: "the agent host" }] });
    const refused = await status.kill(guarded.pid);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.code, "PROCESS_PROTECTED");
    assert.doesNotThrow(() => process.kill(guarded.pid!, 0));

    // The parent of a protected pid is refused outright: a subtree kill would
    // orphan the protected process at best.
    const sub = service({ protectedPids: () => [{ pid: spared!, label: "the agent host" }] });
    const parentRefused = await sub.kill(parent.pid);
    assert.equal(parentRefused.ok === false && parentRefused.code, "PROCESS_PROTECTED");
    assert.doesNotThrow(() => process.kill(parent.pid!, 0), "a refused kill signalled nothing");
    assert.doesNotThrow(() => process.kill(spared!, 0));

    const throwing = service({ protectedPids: () => { throw new Error("boom"); } });
    assert.equal((await throwing.kill(guarded.pid)).ok, true);
    await allGone(guardedGone, "the unprotected child exiting");
  } finally {
    for (const pid of [guarded.pid, parent.pid, spared]) {
      if (!pid) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    await allGone(Promise.all([parentGone, guardedGone]).then(() => undefined), "owned children exiting");
  }
});

test("processes() lists only our own tree unless the whole host is asked for", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) return;
  const status = service();
  const tree = (await status.processes()).processes;
  assert.ok(tree.length > 0);
  assert.ok(tree.every((row) => row.managed === true), "an older client offers Stop on every row it gets");
  const host = (await status.processes("host")).processes;
  assert.ok(host.length > tree.length, "the host has processes that are not ours");
});

test("processes() lists the whole host, marks our tree managed and tags the daemon and agent host", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) return;
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const exited = once(child, "exit").then(() => undefined);
  try {
    await once(child, "spawn");
    assert.ok(child.pid);
    const status = service({ protectedPids: () => [{ pid: child.pid!, label: "the agent host", role: "agent-host" }] });
    const { processes, daemonPid } = await status.processes("host");
    const self = processes.find((row) => row.pid === daemonPid);
    assert.equal(self?.role, "daemon");
    assert.equal(self?.managed, true);
    assert.ok(self?.state && self.state !== "zombie");
    assert.ok((self?.threads ?? 0) >= 1);
    assert.ok(self?.user && self.user.length > 0);
    assert.ok(self?.startedAt && Math.abs(self.startedAt - (Date.now() - process.uptime() * 1000)) < 5_000, "startedAt is when this process began");

    assert.equal(self?.stoppable, false, "the daemon is never a target");
    const parent = processes.find((row) => row.pid === process.ppid);
    if (parent) assert.equal(parent.stoppable, false, "nor is what it runs under");

    const sleeper = processes.find((row) => row.pid === child.pid);
    assert.equal(sleeper?.role, "agent-host");
    assert.equal(sleeper?.managed, true);
    assert.equal(sleeper?.stoppable, false, "nor is the agent host");
    assert.equal(sleeper?.cpuPercent, null, "nothing to diff against on the first scan");

    const init = processes.find((row) => row.pid === 1);
    if (init) assert.equal(init.managed, false, "init is listed but never ours");
    if (init) assert.equal(init.stoppable, false);
    const foreign = await foreignPid();
    const other = processes.find((row) => row.pid === foreign);
    if (other) assert.equal(other.stoppable, false, "another user's process is listed read-only");
    assert.equal(processes.some((row) => row.pid === 2 || row.ppid === 2), false, "kernel threads are left out");
  } finally {
    child.kill("SIGKILL");
    await allGone(exited, "the sleep exiting");
  }
});

test("processDetails() resolves our own exe and cwd, refuses a bad pid and reports a gone one", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) return;
  const status = service();
  const self = await status.processDetails(process.pid);
  assert.equal(self?.found, true);
  assert.equal(self?.exe, process.execPath);
  assert.equal(self?.cwd, process.cwd());
  assert.ok((self?.openFiles ?? 0) >= 3, "stdin, stdout and stderr at least");
  assert.ok(self?.startedAt && Math.abs(self.startedAt - (Date.now() - process.uptime() * 1000)) < 5_000);

  assert.equal(await status.processDetails(0), null);
  assert.equal(await status.processDetails(Number.NaN), null);

  const child = spawn("true", [], { stdio: "ignore" });
  await once(child, "exit");
  const gone = await status.processDetails(child.pid!);
  assert.equal(gone?.found, false);
  assert.equal(gone?.exe, null);
});

test("resources() reports host rates, load, uptime and identity", async () => {
  if (!SYSTEM_STATUS_SUPPORTED) return;
  const resources = await service().resources();
  assert.equal(resources.loadAverage?.length, 3);
  assert.ok((resources.uptimeSeconds ?? 0) > 0);
  assert.ok(resources.host?.hostname);
  assert.ok(resources.host?.kernel);
  // The constructor seeds a baseline, so both rates exist on any host that
  // exposes a physical interface / a whole disk; either may be null in a container.
  for (const rate of [resources.network?.rxBps, resources.network?.txBps, resources.diskIo?.readBps, resources.diskIo?.writeBps]) {
    if (rate !== undefined) assert.ok(rate >= 0);
  }
});
