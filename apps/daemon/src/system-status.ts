import type {
  KillProcessErrorCode,
  KillProcessSignal,
  SystemPortInfo,
  SystemPortsResponse,
  SystemProcessDetailsResponse,
  SystemProcessInfo,
  SystemProcessRole,
  SystemProcessState,
  SystemProcessesResponse,
  SystemProcessesScope,
  SystemResourcesResponse
} from "@orquester/api";
import { readFileSync } from "node:fs";
import { readFile, readdir, readlink, statfs } from "node:fs/promises";
import { arch, cpus, hostname, loadavg, release, uptime, userInfo } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_LAUNCH_ENV_VAR } from "./agent-host/support/leftover-processes.ts";
import { Tmux } from "./tmux";

/**
 * Host observability for a headless VPS: CPU/memory/disk/network, every
 * user-space process on the host with the tree that belongs to THIS daemon
 * marked `managed` (its own children plus every tmux session pane and their
 * descendants — and whatever a provider CLI left behind, see `rootPids`), and
 * the TCP ports the managed processes listen on. Only a managed process is
 * ever a kill target; the rest of the host is listed read-only.
 *
 * Linux-only by construction — everything here reads `/proc`, which no other
 * platform provides. Off Linux every read returns a `supported: false` payload
 * with zeroed/unknown data, the same host-gating shape `/api/fs/capabilities`
 * uses, so clients never have to special-case a missing field.
 *
 * Every per-source read is best-effort: `/proc` entries appear and vanish between
 * the directory scan and the per-pid read, so an ENOENT (or an EACCES on another
 * user's process) skips that entry instead of failing the request.
 */

/** True when this host exposes the `/proc` interfaces every read below depends on. */
export const SYSTEM_STATUS_SUPPORTED = process.platform === "linux";

/**
 * How long a resources snapshot is reused. The fork's Broadcaster exposes no
 * client-count hook, so there is no safe signal for "a client is watching" to
 * gate a background poller on; resources are computed on demand instead and this
 * cache keeps a page full of pollers from re-reading /proc on every request.
 */
const RESOURCES_CACHE_MS = 2500;

/**
 * How long the /proc process snapshot (and the tree derived from it) is reused.
 * `processes()` and `ports()` are the two heavy readers and a status panel polls
 * both; without this they would each scan every pid on the box, twice per tick.
 */
const SNAPSHOT_CACHE_MS = 2000;

/**
 * Beyond this gap the stored CPU baseline is thrown away and a fresh short
 * interval is measured instead — see `readCpuPercent()`.
 */
const CPU_STALE_INTERVAL_MS = 30_000;

/** Spacing of the two samples taken when the stored baseline was too old. */
const CPU_RESAMPLE_DELAY_MS = 200;

/**
 * Ceiling on concurrent `/proc` reads. A busy VPS has thousands of pids, and an
 * unbounded `Promise.all` over them opens that many file handles at once (EMFILE
 * territory) and floods the libuv threadpool, stalling every other request that
 * needs disk. Small enough to stay polite, large enough that a full scan is a
 * few milliseconds.
 */
const PROC_READ_CONCURRENCY = 24;

/**
 * Caps both the descent from a root and the ancestor walk in the kill guard.
 * Real process trees are a few levels deep; this only bounds the walk if a
 * racy reused-pid snapshot ever produced a parent-chain cycle.
 */
const MAX_DEPTH = 64;

export interface SystemStatusOptions {
  /** Volume to report disk usage for — the file-browser sandbox root. */
  fsRoot: string;
  /** Socket of the dedicated tmux server that owns session panes. */
  tmuxSocket: string;
  /** Ids of the sessions the daemon currently tracks (labels tree nodes). */
  listSessionIds: () => Set<string>;
  /**
   * Extra pids `kill` must refuse, alongside the daemon and the tmux server —
   * infrastructure that happens to sit in the daemon's own tree (today the agent
   * host), each with the label a refusal names. Read at kill time (not
   * construction): the set changes as things respawn.
   */
  protectedPids?: () => Iterable<{ pid: number; label: string; role?: SystemProcessRole }>;
  /**
   * Extra tree ROOTS to descend from, beyond this process and the `orq-*` tmux
   * panes — today the agent host (chat design spec §3.1 "Kill guard"). It runs
   * in the `orqsvc-agent-host` service session, which `panePids()` deliberately
   * excludes, so without this neither it nor any provider child it spawned
   * descends from a root and the spec's "provider children remain legal kill
   * targets" would be false on every tmux host. The host pid itself stays in
   * `protectedPids`; only its descendants become reachable.
   */
  extraRootPids?: () => Iterable<number>;
}

/** A `/proc/<pid>` snapshot row. */
interface ProcSnapshot {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
  rssBytes: number;
  /** The real uid, when the status names one: only our own processes' environments are read. */
  uid?: number;
  /** From /proc/<pid>/stat; absent when that read failed (the row is still listed). */
  stat?: ProcStatDetail;
  /** Cumulative block I/O, read only for our own uid (the kernel refuses the rest). */
  io?: ProcIo;
}

/** Aggregate jiffies of the `cpu ` line of /proc/stat. */
interface CpuSample {
  total: number;
  idle: number;
}

/** The per-process fields of /proc/<pid>/stat the process table shows. */
interface ProcStatDetail {
  /** PF_KTHREAD is set: a kernel thread, not a process anyone ran. */
  kernelThread: boolean;
  state: SystemProcessState;
  ppid: number;
  /** utime + stime, in USER_HZ ticks. */
  cpuTicks: number;
  threads: number;
  /** Ticks after boot. */
  starttime: number;
}

interface ProcIo {
  readBytes: number;
  writeBytes: number;
}

/**
 * The kernel's USER_HZ — the unit of every tick count /proc exposes to user
 * space. Fixed at 100 on every mainstream architecture regardless of the
 * kernel's internal HZ; only `startedAt` depends on it (CPU shares are a ratio
 * of two tick counts and need no unit).
 */
const USER_HZ = 100;

/** How long the uid → user name map from /etc/passwd is reused. */
const PASSWD_CACHE_MS = 5 * 60_000;

/** PF_KTHREAD in the `flags` field of /proc/<pid>/stat (include/linux/sched.h). */
const PF_KTHREAD = 0x00200000;

/**
 * The least time between two process scans that are diffed for rates. Two
 * scans can overlap (the kill guard's fresh one beside a poll) and finish
 * milliseconds apart; a delta over that sliver is noise, not a rate.
 */
const MIN_SAMPLE_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested without /proc)
// ---------------------------------------------------------------------------

/**
 * Sum the aggregate `cpu ` line of /proc/stat. `idle` counts iowait too (procps'
 * convention): a process blocked on I/O is not consuming the CPU, so charging
 * iowait as busy would show a disk-bound box as pegged.
 */
export function parseCpuSample(content: string): CpuSample | null {
  const line = content.split("\n").find((candidate) => candidate.startsWith("cpu "));
  if (!line) {
    return null;
  }
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return {
    total: fields.reduce((sum, value) => sum + value, 0),
    idle: fields[3] + (fields[4] ?? 0)
  };
}

/** Busy share of the jiffies between two /proc/stat samples, or null if unusable. */
export function cpuPercentFromSamples(previous: CpuSample, current: CpuSample): number | null {
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) {
    return null;
  }
  const idleDelta = Math.min(totalDelta, Math.max(0, current.idle - previous.idle));
  return Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
}

/**
 * MemTotal + MemAvailable from /proc/meminfo, in bytes. MemAvailable (not
 * MemFree) is what could actually be handed to a new process: MemFree counts
 * reclaimable page cache as used and reads 90%+ on any idle box with a warm
 * cache. Pre-3.14 kernels have no MemAvailable — fall back to MemFree there.
 */
export function parseMemInfo(content: string): { totalBytes: number; availableBytes: number } | null {
  const values = new Map<string, number>();
  for (const line of content.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (match) {
      values.set(match[1], Number(match[2]) * 1024);
    }
  }
  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable") ?? values.get("MemFree");
  if (totalBytes === undefined || availableBytes === undefined) {
    return null;
  }
  return { totalBytes, availableBytes };
}

/**
 * Name/PPid/VmRSS (and the real uid) from /proc/<pid>/status. Preferred over
 * /proc/<pid>/stat: it carries the RSS in kB (so there is no page-size to
 * guess) and needs none of stat's "comm may contain spaces and parentheses"
 * handling.
 */
export function parseProcStatus(
  content: string
): { name: string; ppid: number; rssBytes: number; uid?: number } | null {
  let name: string | null = null;
  let ppid: number | null = null;
  let rssBytes = 0;
  let uid: number | undefined;
  for (const line of content.split("\n")) {
    if (name === null && line.startsWith("Name:")) {
      name = line.slice("Name:".length).trim();
    } else if (ppid === null && line.startsWith("PPid:")) {
      const parsed = Number(line.slice("PPid:".length).trim());
      ppid = Number.isInteger(parsed) ? parsed : null;
    } else if (line.startsWith("VmRSS:")) {
      const parsed = Number(line.slice("VmRSS:".length).replace(/kB$/i, "").trim());
      rssBytes = Number.isFinite(parsed) ? parsed * 1024 : 0;
    } else if (uid === undefined && line.startsWith("Uid:")) {
      // Real, effective, saved, filesystem: the first is the owner.
      const parsed = Number(line.slice("Uid:".length).trim().split(/\s+/)[0]);
      uid = Number.isInteger(parsed) ? parsed : undefined;
    }
  }
  if (name === null || ppid === null) {
    return null;
  }
  return uid === undefined ? { name, ppid, rssBytes } : { name, ppid, rssBytes, uid };
}

/**
 * The agent host's launch marker in a NUL-separated /proc/<pid>/environ —
 * `ORQUESTER_AGENT_LAUNCH=<one value per provider launch>`, which every process
 * a provider CLI starts inherits (`agent-host/support/leftover-processes.ts`) —
 * and the chat it was launched for (`ORQUESTER_SESSION_ID`, on the same launch
 * env). Null without a non-empty marker.
 */
export function launchMarkerOf(environ: string): { launchId: string; sessionId?: string } | null {
  let launchId: string | undefined;
  let sessionId: string | undefined;
  for (const entry of environ.split("\0")) {
    if (launchId === undefined && entry.startsWith(`${AGENT_LAUNCH_ENV_VAR}=`)) {
      launchId = entry.slice(AGENT_LAUNCH_ENV_VAR.length + 1);
    } else if (sessionId === undefined && entry.startsWith("ORQUESTER_SESSION_ID=")) {
      sessionId = entry.slice("ORQUESTER_SESSION_ID=".length);
    }
  }
  if (launchId === undefined || launchId.length === 0) {
    return null;
  }
  return sessionId === undefined || sessionId.length === 0 ? { launchId } : { launchId, sessionId };
}

/**
 * ppid (field 4) and starttime (field 22) of /proc/<pid>/stat — the identity
 * re-check the kill guard runs against its snapshot. Field 2 (`comm`) is the
 * raw executable name in parentheses and may itself contain spaces AND
 * parentheses, so the split starts after its LAST ")": from there field 3
 * (`state`) is index 0, hence ppid at 1 and starttime at 19.
 */
export function parseProcStat(content: string): { ppid: number; starttime: number } | null {
  const close = content.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const starttime = Number(fields[19]);
  if (!Number.isInteger(ppid) || !Number.isFinite(starttime)) {
    return null;
  }
  return { ppid, starttime };
}

/** The one-letter state of /proc/<pid>/stat as a named state. */
export function processStateOf(code: string): SystemProcessState {
  switch (code) {
    case "R":
      return "running";
    case "S":
      return "sleeping";
    case "D":
      return "disk-wait";
    case "T":
    case "t":
      return "stopped";
    case "Z":
    case "X":
      return "zombie";
    case "I":
      return "idle";
    default:
      return "other";
  }
}

/**
 * State, ppid, the kernel-thread flag (field 9), CPU ticks (utime + stime,
 * fields 14–15), thread count (field 20) and starttime (field 22) of
 * /proc/<pid>/stat, with the same after-the-last-")" split as
 * {@link parseProcStat}: field 3 is index 0 there.
 */
export function parseProcStatDetail(content: string): ProcStatDetail | null {
  const close = content.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const flags = Number(fields[6]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const threads = Number(fields[17]);
  const starttime = Number(fields[19]);
  if (
    !fields[0] ||
    !Number.isInteger(ppid) ||
    ![flags, utime, stime, threads, starttime].every((value) => Number.isFinite(value))
  ) {
    return null;
  }
  return {
    // `&` works on 32 bits; the flag sits well inside them.
    kernelThread: (flags & PF_KTHREAD) !== 0,
    state: processStateOf(fields[0]),
    ppid,
    cpuTicks: utime + stime,
    threads,
    starttime
  };
}

/**
 * `read_bytes`/`write_bytes` of /proc/<pid>/io — bytes that actually reached
 * the block layer, unlike `rchar`/`wchar`, which count page-cache hits and
 * pipe/socket traffic too.
 */
export function parseProcIo(content: string): ProcIo | null {
  let readBytes: number | null = null;
  let writeBytes: number | null = null;
  for (const line of content.split("\n")) {
    if (line.startsWith("read_bytes:")) {
      readBytes = Number(line.slice("read_bytes:".length).trim());
    } else if (line.startsWith("write_bytes:")) {
      writeBytes = Number(line.slice("write_bytes:".length).trim());
    }
  }
  if (readBytes === null || writeBytes === null || !Number.isFinite(readBytes) || !Number.isFinite(writeBytes)) {
    return null;
  }
  return { readBytes, writeBytes };
}

/**
 * Interfaces whose traffic is not the host's own wire traffic: loopback, and
 * container/VPN plumbing (veth pairs, bridges, overlay and tunnel devices) whose
 * bytes ALSO cross the physical interface — counting both would double them.
 */
export function isVirtualInterface(name: string): boolean {
  return /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vxlan|tailscale|tun|tap|wg|zt)/.test(name);
}

/** Summed rx/tx bytes of /proc/net/dev over every non-virtual interface. */
export function parseNetDev(content: string): { rxBytes: number; txBytes: number } | null {
  let rxBytes = 0;
  let txBytes = 0;
  let seen = false;
  for (const line of content.split("\n").slice(2)) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    const fields = line.slice(separator + 1).trim().split(/\s+/).map(Number);
    if (isVirtualInterface(name) || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) {
      continue;
    }
    rxBytes += fields[0];
    txBytes += fields[8];
    seen = true;
  }
  return seen ? { rxBytes, txBytes } : null;
}

/** A whole block device — not a partition, loop, ram, zram, device-mapper or optical drive. */
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/**
 * Bytes read/written by whole disks in /proc/diskstats. Partitions and the
 * device-mapper volumes stacked on a disk are skipped: their I/O is the same
 * I/O the disk below already counts. Sectors here are always 512 bytes.
 */
export function parseDiskStats(content: string): { readBytes: number; writeBytes: number } | null {
  let readBytes = 0;
  let writeBytes = 0;
  let seen = false;
  for (const line of content.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (!WHOLE_DISK.test(fields[2] ?? "")) {
      continue;
    }
    const sectorsRead = Number(fields[5]);
    const sectorsWritten = Number(fields[9]);
    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) {
      continue;
    }
    readBytes += sectorsRead * 512;
    writeBytes += sectorsWritten * 512;
    seen = true;
  }
  return seen ? { readBytes, writeBytes } : null;
}

/** uid → name from /etc/passwd; malformed lines are skipped. */
export function parsePasswd(content: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of content.split("\n")) {
    const [name, , rawUid] = line.split(":");
    const uid = Number(rawUid);
    if (name && rawUid !== undefined && rawUid !== "" && Number.isInteger(uid) && !users.has(uid)) {
      users.set(uid, name);
    }
  }
  return users;
}

/** The `btime` line of /proc/stat: boot time in epoch seconds. */
export function parseBootTime(content: string): number | null {
  const line = content.split("\n").find((candidate) => candidate.startsWith("btime "));
  const value = Number(line?.slice("btime ".length).trim());
  return line && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The cgroup a /proc/<pid>/cgroup names: the v2 unified line ("0::<path>")
 * when present, else v1's systemd hierarchy, else the first line's path.
 */
export function parseCgroupPath(content: string): string | null {
  const paths = new Map<string, string>();
  for (const line of content.split("\n")) {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const key = `${line.slice(0, first)}:${line.slice(first + 1, second)}`;
    if (!paths.has(key)) paths.set(key, line.slice(second + 1).trim());
  }
  const path = paths.get("0:") ?? [...paths].find(([key]) => key.endsWith(":name=systemd"))?.[1] ?? [...paths.values()][0];
  return path ? path : null;
}

/** Per-second rate of a cumulative counter, or null when unusable (reset, no time passed). */
export function ratePerSecond(previous: number, current: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0 || current < previous) {
    return null;
  }
  return Math.round(((current - previous) / elapsedMs) * 1000);
}

/**
 * A process's share of the whole host's CPU between two scans: its own tick
 * delta over the delta of /proc/stat's aggregate line (which sums every core),
 * so every core busy is 100. One decimal; null when either delta is unusable.
 */
export function processCpuPercent(previousTicks: number, currentTicks: number, totalDelta: number): number | null {
  if (totalDelta <= 0 || currentTicks < previousTicks) {
    return null;
  }
  const percent = ((currentTicks - previousTicks) / totalDelta) * 100;
  return Math.round(Math.min(100, percent) * 10) / 10;
}

/** NUL-separated /proc/<pid>/cmdline → a display string (empty for kernel threads). */
export function parseCmdline(content: string): string {
  return content.split("\0").filter(Boolean).join(" ").trim();
}

/** RFC 5952 text for 16 raw address bytes (longest zero run collapsed to "::"). */
function formatIpv6(bytes: number[]): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((bytes[index] << 8) | bytes[index + 1]);
  }
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index] === 0) {
      if (runStart < 0) {
        runStart = index;
        runLength = 0;
      }
      runLength += 1;
      if (runLength > bestLength) {
        bestStart = runStart;
        bestLength = runLength;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }
  const hex = (value: number): string => value.toString(16);
  if (bestLength < 2) {
    return groups.map(hex).join(":");
  }
  const head = groups.slice(0, bestStart).map(hex).join(":");
  const tail = groups.slice(bestStart + bestLength).map(hex).join(":");
  return `${head}::${tail}`;
}

/**
 * Decode a `local_address` cell of /proc/net/tcp[6] ("<hex addr>:<hex port>").
 * The address is a sequence of 32-bit words in HOST byte order, so on a
 * little-endian host each 4-byte word is reversed: "0100007F" is 127.0.0.1.
 */
export function decodeProcNetAddress(value: string, ipv6: boolean): { address: string; port: number } | null {
  const separator = value.lastIndexOf(":");
  if (separator < 0) {
    return null;
  }
  const rawAddress = value.slice(0, separator);
  const rawPort = value.slice(separator + 1);
  if (!/^[0-9A-Fa-f]+$/.test(rawPort)) {
    return null;
  }
  const port = Number.parseInt(rawPort, 16);
  const expected = ipv6 ? 32 : 8;
  if (rawAddress.length !== expected || !/^[0-9A-Fa-f]+$/.test(rawAddress)) {
    return null;
  }
  const bytes: number[] = [];
  for (let word = 0; word < expected; word += 8) {
    const wordBytes: number[] = [];
    for (let pair = 0; pair < 8; pair += 2) {
      wordBytes.push(Number.parseInt(rawAddress.slice(word + pair, word + pair + 2), 16));
    }
    bytes.push(...wordBytes.reverse());
  }
  const address = ipv6 ? formatIpv6(bytes) : bytes.join(".");
  return { address, port };
}

/** LISTEN (state `0A`) rows of a /proc/net/tcp[6] dump. */
export function parseProcNetTcp(
  content: string,
  ipv6: boolean
): Array<{ address: string; port: number; inode: number }> {
  const rows: Array<{ address: string; port: number; inode: number }> = [];
  for (const line of content.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A") {
      continue;
    }
    const decoded = decodeProcNetAddress(fields[1] ?? "", ipv6);
    const inode = Number(fields[9]);
    if (!decoded || !Number.isInteger(inode)) {
      continue;
    }
    rows.push({ ...decoded, inode });
  }
  return rows;
}

/** Inode of a `socket:[N]` /proc/<pid>/fd symlink target, or null. */
export function parseSocketInode(target: string): number | null {
  const match = /^socket:\[(\d+)\]$/.exec(target);
  if (!match) {
    return null;
  }
  const inode = Number(match[1]);
  return Number.isInteger(inode) ? inode : null;
}

/**
 * Every pid reachable downward from `roots`, mapped to the session id it belongs
 * to (inherited from the nearest ancestor root that names one). A `visited` set
 * plus the depth cap make a corrupted parent chain terminate instead of looping.
 */
export function collectTree(
  procs: Map<number, { ppid: number }>,
  roots: Map<number, string | undefined>
): Map<number, string | undefined> {
  const children = new Map<number, number[]>();
  for (const [pid, proc] of procs) {
    const siblings = children.get(proc.ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      children.set(proc.ppid, [pid]);
    }
  }
  const tree = new Map<number, string | undefined>();
  const queue: Array<{ pid: number; sessionId: string | undefined; depth: number }> = [];
  for (const [pid, sessionId] of roots) {
    if (procs.has(pid) && !tree.has(pid)) {
      tree.set(pid, sessionId);
      queue.push({ pid, sessionId, depth: 0 });
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= MAX_DEPTH) {
      continue;
    }
    for (const child of children.get(current.pid) ?? []) {
      if (tree.has(child)) {
        continue;
      }
      const sessionId = roots.get(child) ?? current.sessionId;
      tree.set(child, sessionId);
      queue.push({ pid: child, sessionId, depth: current.depth + 1 });
    }
  }
  return tree;
}

/**
 * True if `pid` is one of `roots` or descends from one. Walks ANCESTORS (cheap:
 * one hop per level) with the depth cap as the cycle guard — the boundary the
 * kill route enforces before signalling anything.
 */
export function descendsFromRoot(
  procs: Map<number, { ppid: number }>,
  roots: ReadonlySet<number>,
  pid: number
): boolean {
  let current = pid;
  for (let hop = 0; hop <= MAX_DEPTH; hop += 1) {
    if (roots.has(current)) {
      return true;
    }
    const proc = procs.get(current);
    if (!proc || proc.ppid <= 0 || proc.ppid === current) {
      return false;
    }
    current = proc.ppid;
  }
  return false;
}

/** `pid` plus every pid currently under it (depth-capped, cycle-safe). */
function collectDescendants(procs: Map<number, { ppid: number }>, pid: number): number[] {
  return [...collectTree(procs, new Map([[pid, undefined]])).keys()];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** `items.map(fn)` with at most `limit` calls in flight; order is preserved. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function usedPercent(total: number, free: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round(((total - free) / total) * 100);
}

function unsupportedResources(path: string): SystemResourcesResponse {
  return {
    supported: false,
    // Zeroed, not the real core count: off Linux nothing here was measured, and
    // a half-real payload invites a client to render it as if it were.
    cpu: { percent: 0, cores: 0 },
    memory: { totalBytes: 0, availableBytes: 0, usedPercent: 0 },
    workspacesDisk: { totalBytes: null, freeBytes: null, usedPercent: null, path }
  };
}

/** ppid + starttime of a live pid, or null when it is gone/unreadable. */
export async function readProcIdentity(
  pid: number
): Promise<{ ppid: number; starttime: number } | null> {
  const raw = await readTextFile(`/proc/${pid}/stat`);
  return raw ? parseProcStat(raw) : null;
}

/**
 * Confirm a pid is still the process the /proc snapshot saw, and hand back its
 * starttime as a stable handle on that identity.
 *
 * Between the snapshot and `process.kill` a target can exit and the kernel can
 * hand its pid to an unrelated process; the signal would then hit a stranger
 * that never passed the tree guard. The parent is what the snapshot recorded, so
 * it is what proves the pid was not recycled — but ppid is NOT usable once
 * signalling starts (a parent that exits reparents its children), which is why
 * the caller switches to starttime, invariant for the life of a process, for the
 * final check before each signal.
 */
export async function verifyProcessIdentity(pid: number, expectedPpid: number): Promise<number | null> {
  const identity = await readProcIdentity(pid);
  return identity !== null && identity.ppid === expectedPpid ? identity.starttime : null;
}

/**
 * One reading of every cumulative host counter the resource rates derive from,
 * taken together so CPU, network and disk all describe the same interval.
 */
interface HostCounters {
  /** Monotonic milliseconds (`performance.now()`). */
  at: number;
  cpu: CpuSample | null;
  net: { rxBytes: number; txBytes: number } | null;
  disk: { readBytes: number; writeBytes: number } | null;
}

function parseHostCounters(
  at: number,
  stat: string | null,
  netDev: string | null,
  diskStats: string | null
): HostCounters {
  return {
    at,
    cpu: stat ? parseCpuSample(stat) : null,
    net: netDev ? parseNetDev(netDev) : null,
    disk: diskStats ? parseDiskStats(diskStats) : null
  };
}

function readHostCountersSync(): HostCounters {
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  return parseHostCounters(performance.now(), read("/proc/stat"), read("/proc/net/dev"), read("/proc/diskstats"));
}

async function readHostCounters(): Promise<HostCounters> {
  const [stat, netDev, diskStats] = await Promise.all([
    readTextFile("/proc/stat"),
    readTextFile("/proc/net/dev"),
    readTextFile("/proc/diskstats")
  ]);
  return parseHostCounters(performance.now(), stat, netDev, diskStats);
}

/** Both directions of a counter pair as rates, or null if either is unusable. */
function ratePair<K extends string>(
  previous: Record<K, number> | null,
  current: Record<K, number> | null,
  elapsedMs: number,
  keys: readonly [K, K]
): [number, number] | null {
  if (!previous || !current) {
    return null;
  }
  const first = ratePerSecond(previous[keys[0]], current[keys[0]], elapsedMs);
  const second = ratePerSecond(previous[keys[1]], current[keys[1]], elapsedMs);
  return first === null || second === null ? null : [first, second];
}

/** Host identity for the status footer; a field that cannot be read is left out. */
function hostInfo(): NonNullable<SystemResourcesResponse["host"]> {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry for this uid (a bare container): leave it blank.
  }
  return { hostname: hostname(), kernel: release(), arch: arch(), user };
}

/** What one process scan measured for a pid, against the scan before it. */
interface ProcMetrics {
  cpuPercent: number | null;
  diskReadBps: number | null;
  diskWriteBps: number | null;
}

/** The counters a scan keeps per pid so the next scan can take a delta. */
interface ProcSample {
  /** Identity: a recycled pid has a different starttime and must not be diffed. */
  starttime: number;
  cpuTicks: number;
  io?: ProcIo;
}

interface ProcSamples {
  /** Monotonic milliseconds (`performance.now()`): a wall-clock step must not stall the rates. */
  at: number;
  /** /proc/stat's aggregate tick total at the scan. */
  totalTicks: number;
  byPid: Map<number, ProcSample>;
}

/**
 * Per-pid CPU share and disk rates of `procs` against `previous`. A pid absent
 * from the previous scan, recycled since (different starttime), or diffed over
 * a gap outside [`MIN_SAMPLE_INTERVAL_MS`, `CPU_STALE_INTERVAL_MS`] gets null:
 * a number averaged over an idle hour is not "now", and one over a few
 * milliseconds is noise. `samples` is the baseline for the next scan — the
 * previous one is kept until a scan is far enough past it to replace it.
 */
export function procMetrics(
  procs: ReadonlyMap<number, { stat?: { starttime: number; cpuTicks: number }; io?: ProcIo }>,
  previous: ProcSamples | null,
  at: number,
  totalTicks: number | null
): { metrics: Map<number, ProcMetrics>; samples: ProcSamples | null } {
  const metrics = new Map<number, ProcMetrics>();
  const gap = previous ? at - previous.at : 0;
  const usable =
    previous !== null &&
    totalTicks !== null &&
    gap >= MIN_SAMPLE_INTERVAL_MS &&
    gap <= CPU_STALE_INTERVAL_MS;
  const elapsedMs = previous ? at - previous.at : 0;
  const totalDelta = previous && totalTicks !== null ? totalTicks - previous.totalTicks : 0;
  const byPid = new Map<number, ProcSample>();
  for (const [pid, proc] of procs) {
    if (!proc.stat) {
      continue;
    }
    const sample: ProcSample = { starttime: proc.stat.starttime, cpuTicks: proc.stat.cpuTicks };
    if (proc.io) {
      sample.io = proc.io;
    }
    byPid.set(pid, sample);
    const before = usable ? previous.byPid.get(pid) : undefined;
    if (!before || before.starttime !== sample.starttime) {
      metrics.set(pid, { cpuPercent: null, diskReadBps: null, diskWriteBps: null });
      continue;
    }
    const io = ratePair(before.io ?? null, sample.io ?? null, elapsedMs, ["readBytes", "writeBytes"]);
    metrics.set(pid, {
      cpuPercent: processCpuPercent(before.cpuTicks, sample.cpuTicks, totalDelta),
      diskReadBps: io ? io[0] : null,
      diskWriteBps: io ? io[1] : null
    });
  }
  // Replace the baseline only once this scan is far enough past it (or past
  // staleness) — a scan that finished right after another must not become the
  // next one's baseline.
  const replaces = totalTicks !== null && (previous === null || gap >= MIN_SAMPLE_INTERVAL_MS);
  return { metrics, samples: replaces ? { at, totalTicks, byPid } : previous };
}

/** The /proc process scan plus the tree derived from it, cached for a beat. */
interface TreeSnapshot {
  at: number;
  procs: Map<number, ProcSnapshot>;
  roots: Map<number, string | undefined>;
  tree: Map<number, string | undefined>;
  metrics: Map<number, ProcMetrics>;
  tmuxServerPid: number | null;
}

type KillResult =
  | { ok: true; killed: number; signal: KillProcessSignal }
  | { ok: false; code: KillProcessErrorCode; error: string };

export class SystemStatusService {
  private readonly tmux: Tmux;
  private counters: HostCounters | null = null;
  private lastCpuPercent = 0;
  private resourcesCache: { at: number; value: SystemResourcesResponse } | null = null;
  private treeCache: TreeSnapshot | null = null;
  /** The /proc scan currently in flight, shared by concurrent cold callers. */
  private treeScan: Promise<TreeSnapshot> | null = null;
  /** Per-pid counters of the latest scan, the baseline of the next one's rates. */
  private procSamples: ProcSamples | null = null;
  private passwd: { at: number; users: Map<number, string> } | null = null;

  constructor(private readonly options: SystemStatusOptions) {
    this.tmux = new Tmux(options.tmuxSocket);
    // Seed the counters at construction so the first read has something to
    // subtract from (sysinfo does the same); without it the first GET is 0%.
    if (SYSTEM_STATUS_SUPPORTED) {
      this.counters = readHostCountersSync();
    }
  }

  async resources(): Promise<SystemResourcesResponse> {
    if (!SYSTEM_STATUS_SUPPORTED) {
      return unsupportedResources(this.options.fsRoot);
    }
    const now = Date.now();
    if (this.resourcesCache && now - this.resourcesCache.at < RESOURCES_CACHE_MS) {
      return this.resourcesCache.value;
    }
    const value = await this.readResources();
    this.resourcesCache = { at: now, value };
    return value;
  }

  /**
   * CPU share and network/disk rates since the previous read. With no
   * background poller the stored baseline is as old as the last request — after
   * an idle hour the first read would report the average over that hour, not
   * the load right now. Past `CPU_STALE_INTERVAL_MS` the stale baseline is
   * discarded and a fresh pair of samples a few hundred ms apart is measured
   * instead.
   */
  private async readHostRates(): Promise<
    Pick<SystemResourcesResponse, "network" | "diskIo"> & { cpuPercent: number }
  > {
    let previous = this.counters;
    let current = await readHostCounters();
    if (!previous || current.at - previous.at > CPU_STALE_INTERVAL_MS) {
      await delay(CPU_RESAMPLE_DELAY_MS);
      previous = current;
      current = await readHostCounters();
    }
    this.counters = current;

    const percent = previous.cpu && current.cpu ? cpuPercentFromSamples(previous.cpu, current.cpu) : null;
    if (percent !== null) {
      this.lastCpuPercent = percent;
    }
    const elapsedMs = current.at - previous.at;
    const net = ratePair(previous.net, current.net, elapsedMs, ["rxBytes", "txBytes"]);
    const disk = ratePair(previous.disk, current.disk, elapsedMs, ["readBytes", "writeBytes"]);
    return {
      cpuPercent: this.lastCpuPercent,
      network: net ? { rxBps: net[0], txBps: net[1] } : null,
      diskIo: disk ? { readBps: disk[0], writeBps: disk[1] } : null
    };
  }

  private async readResources(): Promise<SystemResourcesResponse> {
    const [rates, memRaw, disk] = await Promise.all([
      this.readHostRates(),
      readTextFile("/proc/meminfo"),
      statfs(this.options.fsRoot).catch(() => null)
    ]);

    const memory = (memRaw ? parseMemInfo(memRaw) : null) ?? { totalBytes: 0, availableBytes: 0 };
    // bavail (not bfree) is the space an unprivileged process can actually use —
    // bfree includes the root-reserved blocks. A failed statfs reports null
    // ("unknown"), never 0/0%: an unmeasurable volume must not look like a full one.
    const diskTotal = disk ? Number(disk.blocks) * Number(disk.bsize) : null;
    const diskFree = disk ? Number(disk.bavail) * Number(disk.bsize) : null;
    const [one, five, fifteen] = loadavg();

    return {
      supported: true,
      cpu: { percent: rates.cpuPercent, cores: cpus().length },
      memory: {
        totalBytes: memory.totalBytes,
        availableBytes: memory.availableBytes,
        usedPercent: usedPercent(memory.totalBytes, memory.availableBytes)
      },
      workspacesDisk: {
        totalBytes: diskTotal,
        freeBytes: diskFree,
        usedPercent: diskTotal === null || diskFree === null ? null : usedPercent(diskTotal, diskFree),
        path: this.options.fsRoot
      },
      network: rates.network,
      diskIo: rates.diskIo,
      loadAverage: [one, five, fifteen],
      uptimeSeconds: Math.round(uptime()),
      host: hostInfo()
    };
  }

  /** uid → user name, re-read from /etc/passwd every few minutes. */
  private async users(): Promise<Map<number, string>> {
    const now = Date.now();
    if (this.passwd && now - this.passwd.at < PASSWD_CACHE_MS) {
      return this.passwd.users;
    }
    const raw = await readTextFile("/etc/passwd");
    this.passwd = { at: now, users: raw ? parsePasswd(raw) : new Map() };
    return this.passwd.users;
  }

  /**
   * `tree` (the default) lists the daemon's own tree only — what a client that
   * predates whole-host listing renders, with Stop on every row; `host` lists
   * every user-space process with `managed` marking ours.
   */
  async processes(scope: SystemProcessesScope = "tree"): Promise<SystemProcessesResponse> {
    if (!SYSTEM_STATUS_SUPPORTED) {
      return { supported: false, daemonPid: process.pid, processes: [] };
    }
    const [{ procs, tree, metrics, tmuxServerPid }, users, bootTime] = await Promise.all([
      this.snapshot(),
      this.users(),
      readTextFile("/proc/stat").then((raw) => (raw ? parseBootTime(raw) : null))
    ]);
    const roles = new Map<number, SystemProcessRole>([[process.pid, "daemon"]]);
    if (tmuxServerPid !== null) {
      roles.set(tmuxServerPid, "tmux");
    }
    for (const [pid, entry] of this.protectedPidEntries()) {
      if (entry.role) {
        roles.set(pid, entry.role);
      }
    }

    const processes: SystemProcessInfo[] = [];
    for (const [pid, proc] of procs) {
      const managed = tree.has(pid);
      if (proc.stat?.kernelThread || (scope === "tree" && !managed)) {
        continue;
      }
      const sessionId = tree.get(pid);
      const role = roles.get(pid);
      const measured = metrics.get(pid);
      const row: SystemProcessInfo = {
        pid,
        ppid: proc.ppid,
        name: proc.name,
        // Processes that scrubbed their argv have no cmdline; the comm name is
        // the only thing left to show.
        cmdline: proc.cmdline || proc.name,
        rssBytes: proc.rssBytes,
        ...(sessionId ? { sessionId } : {}),
        managed,
        ...(role ? { role } : {}),
        cpuPercent: measured?.cpuPercent ?? null,
        diskReadBps: measured?.diskReadBps ?? null,
        diskWriteBps: measured?.diskWriteBps ?? null
      };
      if (proc.stat) {
        row.state = proc.stat.state;
        row.threads = proc.stat.threads;
        if (bootTime !== null) {
          row.startedAt = Math.round((bootTime + proc.stat.starttime / USER_HZ) * 1000);
        }
      }
      if (proc.uid !== undefined) {
        row.user = users.get(proc.uid) ?? String(proc.uid);
      }
      processes.push(row);
    }
    processes.sort((left, right) => left.pid - right.pid);
    return { supported: true, daemonPid: process.pid, processes };
  }

  /**
   * What one process' expanded row adds to its listing. Null for a pid that
   * cannot name a process. Each read is independent: a process owned by
   * another user still reports its start and cgroup.
   */
  async processDetails(pid: number): Promise<SystemProcessDetailsResponse | null> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    const empty = { pid, startedAt: null, exe: null, cwd: null, openFiles: null, cgroup: null };
    if (!SYSTEM_STATUS_SUPPORTED) {
      return { supported: false, found: false, ...empty };
    }
    const [identity, bootTime, exe, cwd, fds, cgroup] = await Promise.all([
      readProcIdentity(pid),
      readTextFile("/proc/stat").then((raw) => (raw ? parseBootTime(raw) : null)),
      readlink(`/proc/${pid}/exe`).catch(() => null),
      readlink(`/proc/${pid}/cwd`).catch(() => null),
      readdir(`/proc/${pid}/fd`).catch(() => null),
      readTextFile(`/proc/${pid}/cgroup`)
    ]);
    if (identity === null) {
      return { supported: true, found: false, ...empty };
    }
    return {
      supported: true,
      found: true,
      pid,
      startedAt: bootTime === null ? null : Math.round((bootTime + identity.starttime / USER_HZ) * 1000),
      exe,
      cwd,
      openFiles: fds ? fds.length : null,
      cgroup: cgroup ? parseCgroupPath(cgroup) : null
    };
  }

  /** The `protectedPids` supplier as a map; a throwing supplier yields nothing. */
  private protectedPidEntries(): Map<number, { label: string; role?: SystemProcessRole }> {
    const out = new Map<number, { label: string; role?: SystemProcessRole }>();
    try {
      for (const entry of this.options.protectedPids?.() ?? []) {
        out.set(entry.pid, entry.role ? { label: entry.label, role: entry.role } : { label: entry.label });
      }
    } catch {
      return new Map();
    }
    return out;
  }

  /**
   * Pids that are never a legitimate target, read fresh on each kill.
   * Best-effort: a throwing supplier must not turn a kill into a 500.
   */
  private protectedPids(): Map<number, string> {
    return new Map([...this.protectedPidEntries()].map(([pid, entry]) => [pid, entry.label] as const));
  }

  /**
   * Signal `pid` and everything under it — SIGTERM unless the caller asks for
   * SIGKILL; any other value is refused. Refused unless `pid` is inside this
   * daemon's own tree, and refused outright for the daemon itself, for the
   * tmux server — the tmux server IS the session-persistence layer, so killing
   * it would take down every terminal on the box, and it is never a legitimate
   * target even though it sits at the top of the session panes — and for
   * anything the host reports via `protectedPids`.
   */
  async kill(pid: number, signal: unknown = "SIGTERM"): Promise<KillResult> {
    if (!SYSTEM_STATUS_SUPPORTED) {
      return {
        ok: false,
        code: "UNSUPPORTED_PLATFORM",
        error: "Process management is only available on Linux."
      };
    }
    if (signal !== "SIGTERM" && signal !== "SIGKILL") {
      return { ok: false, code: "INVALID_SIGNAL", error: "Signal must be SIGTERM or SIGKILL." };
    }
    if (!Number.isInteger(pid) || pid <= 1) {
      return { ok: false, code: "INVALID_PID", error: "Invalid pid." };
    }
    if (pid === process.pid) {
      return {
        ok: false,
        code: "PROCESS_PROTECTED",
        error: "Cannot stop the Orquester daemon itself."
      };
    }
    const serverPid = await this.tmux.serverPid();
    if (serverPid !== null && pid === serverPid) {
      return {
        ok: false,
        code: "PROCESS_PROTECTED",
        error: "Cannot stop the tmux server that keeps sessions alive."
      };
    }
    // Daemon-owned infrastructure the host names — today the agent host, which is
    // a plain daemon child when tmux is absent and an extra tree root under tmux.
    // Name what was refused by its label.
    const protectedPids = this.protectedPids();
    const protectedLabel = protectedPids.get(pid);
    if (protectedLabel !== undefined) {
      return {
        ok: false,
        code: "PROCESS_PROTECTED",
        error: `Cannot stop ${protectedLabel}.`
      };
    }

    // Never guard a kill on the shared cache: a snapshot up to SNAPSHOT_CACHE_MS
    // old is exactly the window in which a pid can already have been recycled.
    const { procs, roots } = await this.snapshot(true);
    if (!descendsFromRoot(procs, new Set(roots.keys()), pid)) {
      return {
        ok: false,
        code: "PROCESS_NOT_MANAGED",
        error: "Process is not managed by this daemon."
      };
    }

    // Two passes, because a pid can be recycled between the snapshot and the
    // signal and we must never hand a signal to a stranger. Pass one confirms
    // every target is still the process the snapshot saw (its parent is
    // unchanged) and records its starttime; pass two re-checks that starttime
    // immediately before signalling. Splitting them is what makes killing a
    // whole subtree work: once the first signal lands, parents start exiting and
    // their children reparent, so ppid stops being a usable identity — but
    // starttime, captured while the tree was still intact, never changes.
    // Deepest-first (collectDescendants is breadth-first, hence the reverse) so
    // children get their signal before the parent that would orphan them.
    const targets: Array<{ pid: number; starttime: number }> = [];
    for (const target of collectDescendants(procs, pid).reverse()) {
      // Same exclusions as the direct-target guards above: killing a subtree
      // must not sweep up the daemon, the tmux server or the protected
      // infrastructure that happens to hang below the pid the user picked.
      if (target === process.pid || target === serverPid || protectedPids.has(target)) {
        continue;
      }
      const snapshot = procs.get(target);
      if (!snapshot) {
        continue;
      }
      const starttime = await verifyProcessIdentity(target, snapshot.ppid);
      if (starttime !== null) {
        targets.push({ pid: target, starttime });
      }
    }

    let killed = 0;
    for (const target of targets) {
      const identity = await readProcIdentity(target.pid);
      if (identity === null || identity.starttime !== target.starttime) {
        continue;
      }
      try {
        process.kill(target.pid, signal);
        killed += 1;
      } catch {
        // Already gone (ESRCH) or not ours (EPERM) — best-effort by design.
      }
    }
    // The tree just changed; don't let a poll a moment later show the corpses.
    this.treeCache = null;
    return { ok: true, killed, signal };
  }

  async ports(): Promise<SystemPortsResponse> {
    if (!SYSTEM_STATUS_SUPPORTED) {
      return { supported: false, ports: [] };
    }
    const [tcp4, tcp6] = await Promise.all([
      readTextFile("/proc/net/tcp"),
      readTextFile("/proc/net/tcp6")
    ]);
    const listening = [
      ...parseProcNetTcp(tcp4 ?? "", false),
      ...parseProcNetTcp(tcp6 ?? "", true)
    ];
    if (listening.length === 0) {
      return { supported: true, ports: [] };
    }

    const { procs, tree } = await this.snapshot();
    // Only our own pids are scanned for socket fds: it keeps the readlink storm
    // proportional to our tree (not the whole box) and avoids EACCES noise from
    // other users' /proc/<pid>/fd.
    const wanted = new Set(listening.map((row) => row.inode));
    const owners = await socketOwners(tree, procs, wanted);

    const ports: SystemPortInfo[] = [];
    for (const row of listening) {
      const owner = owners.get(row.inode);
      if (!owner) {
        continue;
      }
      ports.push({
        port: row.port,
        address: row.address,
        pid: owner.pid,
        processName: owner.processName,
        ...(owner.sessionId ? { sessionId: owner.sessionId } : {})
      });
    }
    ports.sort(
      (left, right) =>
        left.port - right.port || left.pid - right.pid || left.address.localeCompare(right.address)
    );
    return { supported: true, ports };
  }

  /**
   * The /proc scan + our tree, shared between `processes()` and `ports()` (a
   * status panel polls both, and each is a full scan of every pid on the box).
   * `fresh` forces a re-scan — the kill guard must never decide on stale data.
   */
  private async snapshot(fresh = false): Promise<TreeSnapshot> {
    const now = Date.now();
    const cached = this.treeCache;
    if (!fresh && cached && now - cached.at < SNAPSHOT_CACHE_MS) {
      return cached;
    }
    // The cache only helps SEQUENTIAL callers: the status panel fires
    // `processes()` and `ports()` together, so on a cold cache both would run a
    // full /proc walk (thousands of reads each) before either could store its
    // result. Share the in-flight scan instead. `fresh` (the kill guard) still
    // gets its own — but it also publishes it, so a concurrent cold read can
    // ride along with a scan that is by definition newer than the cache.
    const pending = this.treeScan;
    if (!fresh && pending) {
      return pending;
    }
    const scan = (async (): Promise<TreeSnapshot> => {
      const known = this.options.listSessionIds();
      const [procs, roots, statRaw, tmuxServerPid] = await Promise.all([
        snapshotProcs(),
        this.rootPids(known),
        readTextFile("/proc/stat"),
        this.tmux.serverPid().catch(() => null)
      ]);
      // Whatever a provider CLI left behind is ours too, though no root leads
      // to it any more: an orphan is found by the launch marker it inherited.
      for (const [pid, sessionId] of await launchedOrphans(procs, collectTree(procs, roots), known)) {
        roots.set(pid, sessionId);
      }
      // Rates are diffed against the previous scan. Two scans can overlap (the
      // kill guard's fresh one beside a poll); `procMetrics` diffs only over a
      // gap of at least MIN_SAMPLE_INTERVAL_MS, so the second of two scans that
      // land together reads null, never garbage.
      const totalTicks = statRaw ? (parseCpuSample(statRaw)?.total ?? null) : null;
      const { metrics, samples } = procMetrics(procs, this.procSamples, performance.now(), totalTicks);
      this.procSamples = samples;
      const value: TreeSnapshot = {
        at: now,
        procs,
        roots,
        tree: collectTree(procs, roots),
        metrics,
        tmuxServerPid
      };
      this.treeCache = value;
      return value;
    })();
    this.treeScan = scan;
    try {
      return await scan;
    } finally {
      // Cleared on settle (success OR failure), so one rejected scan can never
      // pin every later caller to the same rejection.
      if (this.treeScan === scan) {
        this.treeScan = null;
      }
    }
  }

  /**
   * The pids to descend from: this daemon (its direct children are the attach
   * PTYs and, on the no-tmux backend, the session PTYs themselves) plus every
   * tmux session pane. With the tmux backend a session's command lives in the
   * tmux server's process tree, NOT the daemon's, so without the pane pids the
   * scan would miss every terminal. Service sessions (`orqsvc-`, e.g. the agent
   * host) are deliberately excluded — they are not user sessions and must not
   * become kill targets (the host re-enters as an `extraRootPids` root).
   */
  private async rootPids(known: Set<string>): Promise<Map<number, string | undefined>> {
    const roots = new Map<number, string | undefined>([[process.pid, undefined]]);
    for (const [sessionId, pids] of await this.tmux.panePids()) {
      for (const pid of pids) {
        roots.set(pid, known.has(sessionId) ? sessionId : undefined);
      }
    }
    // Service-session infrastructure whose CHILDREN are legal targets even
    // though its own pane is excluded from the scan — the agent host and every
    // provider child it spawns (chat design spec §3.1 "Kill guard": "provider
    // children remain legal kill targets"). The host pid itself is refused by
    // `protectedPids`, which runs before the tree check.
    try {
      for (const pid of this.options.extraRootPids?.() ?? []) {
        if (Number.isInteger(pid) && pid > 0 && !roots.has(pid)) roots.set(pid, undefined);
      }
    } catch {
      // A throwing supplier must not blank the root set.
    }
    return roots;
  }
}

/**
 * The orphans a provider CLI left behind, as extra roots: every process of ours
 * OUTSIDE the tree whose parent is init — or gone — and whose environment
 * carries the agent host's launch marker ({@link launchMarkerOf}), labelled
 * with its chat when the daemon knows it. What an orphan started comes with it
 * as its descendant ({@link collectTree}), never as a root of its own; and a
 * marked process whose parent still runs outside every root is that parent's —
 * no marker makes it ours. A gap by construction: an orphan a SUBREAPER adopted
 * (`systemd --user` around the desktop app, a container's non-pid-1 init) has a
 * live parent that is not init, and is not rooted either. The Grok CLI starts
 * its background shells and MCP servers in sessions of their own, so they
 * outlive it reparented to init; the host stops its MCP servers at every
 * session end but the work its agent started only when the user ends the
 * session — a deploy must never kill running work — so a dev server runs on
 * here by design, and a host that crashed swept nothing (Grok fixtures README
 * observation 48). A parent chain is gone once a process is orphaned — its
 * environment is not. Only processes of this daemon's own uid are read (another
 * user's environment is not ours to read, and nothing of theirs is ours to
 * kill), and only those no root already reaches.
 */
async function launchedOrphans(
  procs: Map<number, ProcSnapshot>,
  tree: Map<number, string | undefined>,
  known: Set<string>
): Promise<Map<number, string | undefined>> {
  const uid = process.getuid?.();
  const candidates = [...procs.values()].filter(
    (proc) =>
      !tree.has(proc.pid) &&
      proc.pid > 1 &&
      (proc.ppid === 1 || !procs.has(proc.ppid)) &&
      (uid === undefined || proc.uid === uid)
  );
  const markers = await mapLimited(candidates, PROC_READ_CONCURRENCY, async (proc) => {
    // latin1: an environment is bytes; the marker is ASCII and must not hide
    // behind a value elsewhere that is not UTF-8.
    let environ: string;
    try {
      environ = await readFile(`/proc/${proc.pid}/environ`, "latin1");
    } catch {
      return null;
    }
    const marker = launchMarkerOf(environ);
    return marker === null ? null : { pid: proc.pid, sessionId: marker.sessionId };
  });
  const orphans = new Map<number, string | undefined>();
  for (const marker of markers) {
    if (marker !== null) {
      orphans.set(
        marker.pid,
        marker.sessionId !== undefined && known.has(marker.sessionId) ? marker.sessionId : undefined
      );
    }
  }
  return orphans;
}

/**
 * Every process on the host, by pid, with its stat detail and — for our own
 * uid — its I/O counters. Vanished/unreadable entries are skipped.
 */
async function snapshotProcs(): Promise<Map<number, ProcSnapshot>> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return new Map();
  }
  const pids = entries.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  const ownUid = process.getuid?.();
  const rows = await mapLimited(
    pids,
    PROC_READ_CONCURRENCY,
    async (pid): Promise<ProcSnapshot | null> => {
      const [status, cmdline, stat] = await Promise.all([
        readTextFile(`/proc/${pid}/status`),
        readTextFile(`/proc/${pid}/cmdline`),
        readTextFile(`/proc/${pid}/stat`)
      ]);
      const parsed = status ? parseProcStatus(status) : null;
      if (!parsed) {
        return null;
      }
      const row: ProcSnapshot = { pid, ...parsed, cmdline: parseCmdline(cmdline ?? "") };
      const detail = stat ? parseProcStatDetail(stat) : null;
      if (detail) {
        row.stat = detail;
      }
      // The kernel shows /proc/<pid>/io to the owner only; asking for anyone
      // else's is a guaranteed EACCES per pid per scan.
      if (ownUid !== undefined && parsed.uid === ownUid) {
        const io = await readTextFile(`/proc/${pid}/io`);
        const parsedIo = io ? parseProcIo(io) : null;
        if (parsedIo) {
          row.io = parsedIo;
        }
      }
      return row;
    }
  );
  const procs = new Map<number, ProcSnapshot>();
  for (const row of rows) {
    if (row) {
      procs.set(row.pid, row);
    }
  }
  return procs;
}

interface SocketOwner {
  pid: number;
  processName: string;
  sessionId: string | undefined;
}

/**
 * Attribute each listening inode to exactly one holder. A listen socket can be
 * shared by a whole prefork/cluster pool, so several pids legitimately hold the
 * same inode: pick the LOWEST pid — usually the parent that opened it, and
 * always the same answer for the same host state, whereas first-holder-wins
 * would make the reported owner depend on the order /proc happened to be walked.
 */
export function resolveSocketOwners(
  links: ReadonlyArray<{ pid: number; inode: number }>,
  tree: Map<number, string | undefined>,
  names: Map<number, string>,
  wanted: ReadonlySet<number>
): Map<number, SocketOwner> {
  const owners = new Map<number, SocketOwner>();
  for (const { pid, inode } of links) {
    if (!wanted.has(inode)) {
      continue;
    }
    const existing = owners.get(inode);
    if (existing && existing.pid <= pid) {
      continue;
    }
    owners.set(inode, { pid, processName: names.get(pid) ?? "", sessionId: tree.get(pid) });
  }
  return owners;
}

/** inode → owning process, for the listening inodes held by pids in our tree. */
async function socketOwners(
  tree: Map<number, string | undefined>,
  procs: Map<number, ProcSnapshot>,
  wanted: ReadonlySet<number>
): Promise<Map<number, SocketOwner>> {
  const candidates = [...tree.keys()].filter((pid) => procs.has(pid));
  const fdLists = await mapLimited(candidates, PROC_READ_CONCURRENCY, async (pid) => {
    try {
      return { pid, fds: await readdir(`/proc/${pid}/fd`) };
    } catch {
      return { pid, fds: [] as string[] };
    }
  });
  // Flattened before the readlink pass so the limiter bounds the TOTAL number of
  // in-flight symlink reads, not the number per process.
  const targets = await mapLimited(
    fdLists.flatMap(({ pid, fds }) => fds.map((fd) => ({ pid, fd }))),
    PROC_READ_CONCURRENCY,
    async ({ pid, fd }): Promise<{ pid: number; inode: number } | null> => {
      let target: string;
      try {
        target = await readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        return null;
      }
      const inode = parseSocketInode(target);
      return inode === null ? null : { pid, inode };
    }
  );

  const names = new Map([...procs].map(([pid, proc]) => [pid, proc.name] as const));
  return resolveSocketOwners(
    targets.filter((row): row is { pid: number; inode: number } => row !== null),
    tree,
    names,
    wanted
  );
}
