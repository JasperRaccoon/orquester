/**
 * Linux `/proc` reads for the local Android host: is a recorded pid still the process we started
 * (its environment names this appdir), its process group, its CPU time (golden-snapshot settle),
 * its children (hub capture sessions), and the loopback connections on a port (hub viewers).
 * Parsers are pure and tested; the readers swallow errors (a vanished pid reads as gone).
 */

import { readdir, readFile } from "node:fs/promises";

export interface ProcStat {
  pid: number;
  comm: string;
  /** R, S, D, Z, T, … */
  state: string;
  ppid: number;
  pgrp: number;
  /** utime + stime, in clock ticks. */
  cpuTicks: number;
}

/** `/proc/<pid>/stat` (the comm may hold spaces and parentheses: split after the last `)`). */
export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0] = state (field 3), rest[1] = ppid (4), rest[2] = pgrp (5), rest[11] = utime (14), rest[12] = stime (15)
  const nums = [rest[1], rest[2], rest[11], rest[12]].map(Number);
  if (!Number.isInteger(pid) || rest.length < 13 || nums.some((n) => !Number.isFinite(n))) return null;
  return { pid, comm: text.slice(open + 1, close), state: rest[0]!, ppid: nums[0]!, pgrp: nums[1]!, cpuTicks: nums[2]! + nums[3]! };
}

export async function readProcStat(pid: number): Promise<ProcStat | null> {
  try {
    return parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/** Alive and not a zombie. */
export async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const stat = await readProcStat(pid);
  return stat !== null && stat.state !== "Z" && stat.state !== "X";
}

export async function readCmdline(pid: number): Promise<string[]> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** The process's environment (same-user processes only), or null when unreadable. */
export async function readEnviron(pid: number): Promise<Map<string, string> | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8");
    const env = new Map<string, string>();
    for (const entry of raw.split("\0")) {
      const at = entry.indexOf("=");
      if (at > 0) env.set(entry.slice(0, at), entry.slice(at + 1));
    }
    return env;
  } catch {
    return null;
  }
}

/** Whether `pid` runs with `key=value` in its environment and its argv contains every `argvIncludes` (the pid was not reused). */
export async function processMatches(pid: number, marker: { key: string; value: string }, argvIncludes: readonly string[] = []): Promise<boolean> {
  if (!(await isProcessAlive(pid))) return false;
  const env = await readEnviron(pid);
  if (!env || env.get(marker.key) !== marker.value) return false;
  if (argvIncludes.length === 0) return true;
  const argv = await readCmdline(pid);
  return argvIncludes.every((part) => argv.some((arg) => arg.includes(part)));
}

/** Every pid now. */
export async function listPids(): Promise<number[]> {
  try {
    return (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  } catch {
    return [];
  }
}

/** Every live process's stat (one pass over /proc). */
export async function listProcStats(): Promise<ProcStat[]> {
  const stats = await Promise.all((await listPids()).map((pid) => readProcStat(pid)));
  return stats.filter((stat): stat is ProcStat => stat !== null && stat.state !== "Z");
}

/** The live descendants of `pid` in a process list. */
export function descendantsOf(pid: number, stats: readonly ProcStat[]): ProcStat[] {
  const children = new Map<number, ProcStat[]>();
  for (const stat of stats) {
    const list = children.get(stat.ppid) ?? [];
    list.push(stat);
    children.set(stat.ppid, list);
  }
  const found: ProcStat[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** Signal a process group (falling back to the pid alone); false when nothing was signalled. */
export function signalGroup(pgid: number | null, pid: number, signal: NodeJS.Signals): boolean {
  if (pgid !== null && pgid > 1) {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch {
      // the group is gone: try the pid
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Resolves once `pid` exited (true) or `timeoutMs` passed (false). Polls: the pid may not be our child. */
export async function waitForExit(pid: number, timeoutMs: number, pollMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) return true;
    await delay(pollMs);
  }
  return !(await isProcessAlive(pid));
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

// ---------------------------------------------------------------------------
// /proc/net/tcp
// ---------------------------------------------------------------------------

export interface TcpRow {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  /** Hex state: `01` ESTABLISHED, `0A` LISTEN. */
  state: string;
}

/** `/proc/net/tcp` (IPv4) rows. */
export function parseProcNetTcp(text: string): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [local, remote, state] = [fields[1]!, fields[2]!, fields[3]!];
    const [la, lp] = local.split(":");
    const [ra, rp] = remote.split(":");
    if (!la || !lp || !ra || !rp) continue;
    rows.push({ localAddress: la, localPort: parseInt(lp, 16), remoteAddress: ra, remotePort: parseInt(rp, 16), state: state.toUpperCase() });
  }
  return rows;
}

/** Established connections accepted on `port` (the server side of each). */
export function establishedOnPort(rows: readonly TcpRow[], port: number): number {
  return rows.filter((row) => row.state === "01" && row.localPort === port).length;
}

export async function readEstablishedOnPort(port: number): Promise<number> {
  let count = 0;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      count += establishedOnPort(parseProcNetTcp(await readFile(file, "utf8")), port);
    } catch {
      // no IPv6
    }
  }
  return count;
}

/** `MemAvailable` from `/proc/meminfo`, in bytes; null when unreadable. */
export function parseMemAvailable(text: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
  return match ? Number(match[1]) * 1024 : null;
}

export async function readMemAvailable(): Promise<number | null> {
  try {
    return parseMemAvailable(await readFile("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}
