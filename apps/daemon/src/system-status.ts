import type {
  KillProcessErrorCode,
  SystemPortInfo,
  SystemPortsResponse,
  SystemProcessInfo,
  SystemProcessesResponse,
  SystemResourcesResponse
} from "@orquester/api";
import { readFileSync } from "node:fs";
import { readFile, readdir, readlink, statfs } from "node:fs/promises";
import { cpus } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Tmux } from "./tmux";

/**
 * Host observability for a headless VPS: CPU/memory/disk, the process tree that
 * belongs to THIS daemon (its own children plus every tmux session pane and their
 * descendants), and the TCP ports those processes listen on.
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
   * infrastructure that happens to sit in the daemon's own tree. Read at kill
   * time (not construction): the set changes as things respawn.
   */
  protectedPids?: () => Iterable<number>;
  /** Injectable clock + sleep (tests drive the CPU resample path through these). */
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

/** A `/proc/<pid>` snapshot row. */
export interface ProcSnapshot {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
  rssBytes: number;
}

/** Aggregate jiffies of the `cpu ` line of /proc/stat. */
export interface CpuSample {
  total: number;
  idle: number;
}

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
 * Name/PPid/VmRSS from /proc/<pid>/status. Preferred over /proc/<pid>/stat: it
 * carries the RSS in kB (so there is no page-size to guess) and needs none of
 * stat's "comm may contain spaces and parentheses" handling.
 */
export function parseProcStatus(content: string): { name: string; ppid: number; rssBytes: number } | null {
  let name: string | null = null;
  let ppid: number | null = null;
  let rssBytes = 0;
  for (const line of content.split("\n")) {
    if (name === null && line.startsWith("Name:")) {
      name = line.slice("Name:".length).trim();
    } else if (ppid === null && line.startsWith("PPid:")) {
      const parsed = Number(line.slice("PPid:".length).trim());
      ppid = Number.isInteger(parsed) ? parsed : null;
    } else if (line.startsWith("VmRSS:")) {
      const parsed = Number(line.slice("VmRSS:".length).replace(/kB$/i, "").trim());
      rssBytes = Number.isFinite(parsed) ? parsed * 1024 : 0;
    }
  }
  if (name === null || ppid === null) {
    return null;
  }
  return { name, ppid, rssBytes };
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
export function collectDescendants(procs: Map<number, { ppid: number }>, pid: number): number[] {
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
export async function mapLimited<T, R>(
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

interface TimedCpuSample {
  sample: CpuSample;
  at: number;
}

/** The /proc process scan plus the tree derived from it, cached for a beat. */
interface TreeSnapshot {
  at: number;
  procs: Map<number, ProcSnapshot>;
  roots: Map<number, string | undefined>;
  tree: Map<number, string | undefined>;
}

export type KillResult =
  | { ok: true; killed: number }
  | { ok: false; code: KillProcessErrorCode; error: string };

export class SystemStatusService {
  private readonly tmux: Tmux;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private cpuSample: TimedCpuSample | null = null;
  private lastCpuPercent = 0;
  private resourcesCache: { at: number; value: SystemResourcesResponse } | null = null;
  private treeCache: TreeSnapshot | null = null;
  /** The /proc scan currently in flight, shared by concurrent cold callers. */
  private treeScan: Promise<TreeSnapshot> | null = null;

  constructor(private readonly options: SystemStatusOptions) {
    this.tmux = new Tmux(options.tmuxSocket);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
    // Seed the CPU delta at construction so the first read has something to
    // subtract from (sysinfo does the same); without it the first GET is 0%.
    if (SYSTEM_STATUS_SUPPORTED) {
      try {
        const sample = parseCpuSample(readFileSync("/proc/stat", "utf8"));
        this.cpuSample = sample ? { sample, at: this.now() } : null;
      } catch {
        this.cpuSample = null;
      }
    }
  }

  async resources(): Promise<SystemResourcesResponse> {
    if (!SYSTEM_STATUS_SUPPORTED) {
      return unsupportedResources(this.options.fsRoot);
    }
    const now = this.now();
    if (this.resourcesCache && now - this.resourcesCache.at < RESOURCES_CACHE_MS) {
      return this.resourcesCache.value;
    }
    const value = await this.readResources();
    this.resourcesCache = { at: now, value };
    return value;
  }

  /**
   * Busy CPU share since the previous read. With no background poller the stored
   * baseline is as old as the last request — after an idle hour the first read
   * would report the average load over that hour, not the load right now. Past
   * `CPU_STALE_INTERVAL_MS` the stale baseline is discarded and a fresh pair of
   * samples a few hundred ms apart is measured instead.
   */
  private async readCpuPercent(): Promise<number> {
    const raw = await readTextFile("/proc/stat");
    const sample = raw ? parseCpuSample(raw) : null;
    if (!sample) {
      return this.lastCpuPercent;
    }
    const at = this.now();
    const previous = this.cpuSample;
    this.cpuSample = { sample, at };

    if (previous && at - previous.at <= CPU_STALE_INTERVAL_MS) {
      const percent = cpuPercentFromSamples(previous.sample, sample);
      if (percent !== null) {
        this.lastCpuPercent = percent;
      }
      return this.lastCpuPercent;
    }

    await this.sleep(CPU_RESAMPLE_DELAY_MS);
    const secondRaw = await readTextFile("/proc/stat");
    const second = secondRaw ? parseCpuSample(secondRaw) : null;
    if (second) {
      this.cpuSample = { sample: second, at: this.now() };
      const percent = cpuPercentFromSamples(sample, second);
      if (percent !== null) {
        this.lastCpuPercent = percent;
      }
    }
    return this.lastCpuPercent;
  }

  private async readResources(): Promise<SystemResourcesResponse> {
    const [cpuPercent, memRaw, disk] = await Promise.all([
      this.readCpuPercent(),
      readTextFile("/proc/meminfo"),
      statfs(this.options.fsRoot).catch(() => null)
    ]);

    const memory = (memRaw ? parseMemInfo(memRaw) : null) ?? { totalBytes: 0, availableBytes: 0 };
    // bavail (not bfree) is the space an unprivileged process can actually use —
    // bfree includes the root-reserved blocks. A failed statfs reports null
    // ("unknown"), never 0/0%: an unmeasurable volume must not look like a full one.
    const diskTotal = disk ? Number(disk.blocks) * Number(disk.bsize) : null;
    const diskFree = disk ? Number(disk.bavail) * Number(disk.bsize) : null;

    return {
      supported: true,
      cpu: { percent: cpuPercent, cores: cpus().length },
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
      }
    };
  }

  async processes(): Promise<SystemProcessesResponse> {
    if (!SYSTEM_STATUS_SUPPORTED) {
      return { supported: false, daemonPid: process.pid, processes: [] };
    }
    const { procs, tree } = await this.snapshot();

    const processes: SystemProcessInfo[] = [];
    for (const [pid, sessionId] of tree) {
      const proc = procs.get(pid);
      if (!proc) {
        continue;
      }
      processes.push({
        pid,
        ppid: proc.ppid,
        name: proc.name,
        // Kernel threads and processes that scrubbed their argv have no cmdline;
        // the comm name is the only thing left to show.
        cmdline: proc.cmdline || proc.name,
        rssBytes: proc.rssBytes,
        ...(sessionId ? { sessionId } : {})
      });
    }
    processes.sort((left, right) => left.pid - right.pid);
    return { supported: true, daemonPid: process.pid, processes };
  }

  /**
   * Pids that are never a legitimate target, read fresh on each kill.
   * Best-effort: a throwing supplier must not turn a kill into a 500.
   */
  private protectedPids(): Set<number> {
    try {
      return new Set(this.options.protectedPids?.() ?? []);
    } catch {
      return new Set();
    }
  }

  /**
   * SIGTERM `pid` and everything under it. Refused unless `pid` is inside this
   * daemon's own tree, and refused outright for the daemon itself, for the
   * tmux server — the tmux server IS the session-persistence layer, so killing
   * it would take down every terminal on the box, and it is never a legitimate
   * target even though it sits at the top of the session panes — and for
   * anything the host reports via `protectedPids`.
   */
  async kill(pid: number): Promise<KillResult> {
    if (!SYSTEM_STATUS_SUPPORTED) {
      return {
        ok: false,
        code: "UNSUPPORTED_PLATFORM",
        error: "Process management is only available on Linux."
      };
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
    // Daemon-owned infrastructure that is a plain child on this host — today the
    // model proxy when tmux is absent. Under tmux it isn't in our tree at all,
    // so the guard is a no-op there.
    const protectedPids = this.protectedPids();
    if (protectedPids.has(pid)) {
      return {
        ok: false,
        code: "PROCESS_PROTECTED",
        error: "Cannot stop the model proxy that backs claudex/claudemix sessions."
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
    // signal and we must never hand a SIGTERM to a stranger. Pass one confirms
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
      // must not sweep up the daemon, the tmux server or the model proxy that
      // happens to hang below the pid the user picked.
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
        process.kill(target.pid, "SIGTERM");
        killed += 1;
      } catch {
        // Already gone (ESRCH) or not ours (EPERM) — best-effort by design.
      }
    }
    // The tree just changed; don't let a poll a moment later show the corpses.
    this.treeCache = null;
    return { ok: true, killed };
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
    const now = this.now();
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
      const [procs, roots] = await Promise.all([snapshotProcs(), this.rootPids()]);
      const value: TreeSnapshot = { at: now, procs, roots, tree: collectTree(procs, roots) };
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
   * scan would miss every terminal. Service sessions (`orqsvc-`, e.g. the
   * managed model proxy) are deliberately excluded — they are not user sessions
   * and must not become kill targets.
   */
  private async rootPids(): Promise<Map<number, string | undefined>> {
    const roots = new Map<number, string | undefined>([[process.pid, undefined]]);
    const known = this.options.listSessionIds();
    for (const [sessionId, pids] of await this.tmux.panePids()) {
      for (const pid of pids) {
        roots.set(pid, known.has(sessionId) ? sessionId : undefined);
      }
    }
    return roots;
  }
}

/** Every process on the host, by pid. Vanished/unreadable entries are skipped. */
async function snapshotProcs(): Promise<Map<number, ProcSnapshot>> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return new Map();
  }
  const pids = entries.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  const rows = await mapLimited(
    pids,
    PROC_READ_CONCURRENCY,
    async (pid): Promise<ProcSnapshot | null> => {
      const [status, cmdline] = await Promise.all([
        readTextFile(`/proc/${pid}/status`),
        readTextFile(`/proc/${pid}/cmdline`)
      ]);
      const parsed = status ? parseProcStatus(status) : null;
      if (!parsed) {
        return null;
      }
      return { pid, ...parsed, cmdline: parseCmdline(cmdline ?? "") };
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

export interface SocketOwner {
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
