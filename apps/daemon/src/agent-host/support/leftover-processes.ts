/**
 * Agent host — what a provider CLI leaves behind when it ends (spec §3.1 "A
 * running state never outlives its process").
 *
 * `spawn.ts` puts every provider child at the head of its own process group
 * and a stop signals the whole group. That is not enough for Grok: its CLI
 * starts every child of its own in a SESSION of its own — its background
 * shells and the MCP servers it boots alike (`pgid = sid = pid`, read off
 * `/proc` on 2026-09-26 against 1.0.34) — so the group signal reaches the CLI
 * alone, and whatever it started is reparented to init the moment it exits:
 * the `sleep 45` of that run, its `bash` and two MCP servers survived a clean
 * SIGTERM (Grok fixtures README observation 48). A parent chain is gone once a
 * process is orphaned; its environment is not. So the host sets a marker on
 * the launch environment — {@link AGENT_LAUNCH_ENV_VAR}, one value per launch
 * — which every descendant inherits (eleven processes carried it in that run,
 * the orphaned `sleep` among them), and at the session's end every process
 * still carrying it is stopped: SIGTERM, then SIGKILL past a grace.
 *
 * **Never a recycled pid**, by the kill guard's rule (`system-status.ts`): a
 * process is identified by its `/proc` starttime, read on both sides of the
 * environment read that matched it and again immediately before each signal;
 * a pid whose starttime moved is somebody else's and is left alone. A zombie
 * is gone already. A descendant that scrubbed its environment (`env -i`,
 * `sudo`'s `env_reset`) carries no marker and escapes, as it escapes anything
 * but a process-tree walk that its reparenting already defeated.
 *
 * **Linux-only**, by construction: everything here reads `/proc`. Elsewhere
 * {@link stopLeftoverProcesses} answers at once, having read and signalled
 * nothing — the direct-child kill in `spawn.ts` is all a stop does there.
 *
 * The daemon's Settings → System reads the same marker (`system-status.ts`):
 * a process carrying it is managed, and killable, even as an orphan — after a
 * host crash, when no session end ran this sweep.
 */

import { readFile, readdir } from "node:fs/promises";

import { DEFAULT_KILL_GRACE_MS } from "./spawn.ts";

/**
 * The launch marker: `<name>=<one value per provider launch>`, set on the
 * launch environment and inherited by every descendant. Read by this module
 * (a launch's own leftovers) and by the daemon's kill guard (any launch's).
 */
export const AGENT_LAUNCH_ENV_VAR = "ORQUESTER_AGENT_LAUNCH";

/** How often the grace window checks whether everything is gone already. */
const POLL_MS = 50;

/** At most this many `/proc` reads in flight — the same politeness as the kill guard's scan. */
const READ_CONCURRENCY = 16;

/** One process as `/proc/<pid>/stat` names it: the identity and whether it is still running. */
export interface ProcStat {
  /** Field 22: invariant for the life of a process — the identity a pid alone is not. */
  readonly starttime: number;
  /** Field 3: `Z` (zombie) and `X` (dead) are gone. */
  readonly state: string;
}

/** Where the sweep reads processes from — the real `/proc` unless a test says otherwise. */
export interface ProcSource {
  pids(): Promise<number[]>;
  /** `/proc/<pid>/environ` (NUL-separated), or null when unreadable or gone. */
  environ(pid: number): Promise<string | null>;
  stat(pid: number): Promise<ProcStat | null>;
}

export interface LeftoverProcess {
  readonly pid: number;
  readonly starttime: number;
}

/** The fields of `/proc/<pid>/stat` the sweep needs; null for anything unparsable. */
export function parseStat(content: string): ProcStat | null {
  // comm (field 2) may hold spaces and parentheses: everything after the LAST
  // ')' is the fixed-format tail, starting with state (field 3).
  const close = content.lastIndexOf(")");
  if (close === -1) {
    return null;
  }
  const fields = content.slice(close + 2).split(" ");
  const state = fields[0];
  const starttime = Number(fields[19]);
  if (state === undefined || state.length === 0 || !Number.isFinite(starttime)) {
    return null;
  }
  return { starttime, state };
}

async function readText(path: string, encoding: BufferEncoding): Promise<string | null> {
  try {
    return await readFile(path, encoding);
  } catch {
    return null;
  }
}

/** The real `/proc`. Unreadable entries — another user's environment, a pid gone mid-read — are null. */
export const PROC: ProcSource = {
  async pids(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir("/proc");
    } catch {
      return [];
    }
    return entries.map(Number).filter((pid) => Number.isInteger(pid) && pid > 1);
  },
  // latin1: an environment is bytes, and the marker is ASCII — a non-UTF-8
  // value elsewhere in it must not be able to hide it.
  environ: async (pid) => await readText(`/proc/${pid}/environ`, "latin1"),
  async stat(pid) {
    const content = await readText(`/proc/${pid}/stat`, "latin1");
    return content === null ? null : parseStat(content);
  }
};

function running(stat: ProcStat | null): stat is ProcStat {
  return stat !== null && stat.state !== "Z" && stat.state !== "X";
}

async function eachLimited<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
}

/**
 * Every live process whose environment carries `AGENT_LAUNCH_ENV_VAR=<launchId>`
 * exactly, in pid order — this process excluded. Its starttime is read on both
 * sides of the environment read, and a pid whose starttime moved in between is
 * skipped: the environment matched may have been either process's.
 */
export async function findLeftoverProcesses(
  launchId: string,
  options: { proc?: ProcSource } = {}
): Promise<LeftoverProcess[]> {
  if (launchId.length === 0) {
    return [];
  }
  const proc = options.proc ?? PROC;
  const marker = `${AGENT_LAUNCH_ENV_VAR}=${launchId}`;
  const found: LeftoverProcess[] = [];
  const pids = (await proc.pids()).filter((pid) => pid !== process.pid);
  await eachLimited(pids, async (pid) => {
    const before = await proc.stat(pid);
    if (!running(before)) {
      return;
    }
    const environ = await proc.environ(pid);
    if (environ === null || !environ.split("\0").includes(marker)) {
      return;
    }
    const after = await proc.stat(pid);
    if (!running(after) || after.starttime !== before.starttime) {
      return;
    }
    found.push({ pid, starttime: before.starttime });
  });
  return found.sort((left, right) => left.pid - right.pid);
}

export interface StopLeftoversOptions {
  /** The launch whose leftovers are stopped: the value its launch env gave the marker. */
  launchId: string;
  /** SIGTERM, then SIGKILL this long after. Defaults to `spawn.ts`'s grace. */
  graceMs?: number;
  pollMs?: number;
  proc?: ProcSource;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

export interface LeftoverSweepResult {
  /** Processes the first scan found carrying the marker. */
  readonly found: number;
  /** SIGTERMs sent. */
  readonly terminated: number;
  /** SIGKILLs sent: what outlived the grace, by a fresh scan. */
  readonly killed: number;
}

const sleepFor = async (ms: number): Promise<void> =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Stop every process `launchId` left behind: SIGTERM each, wait until they
 * are gone or the grace runs out, then SIGKILL whatever a FRESH scan still
 * finds carrying the marker (a dying tree may start something on its way
 * out), and wait once more, as long again, for the kernel to finish them.
 * Each signal is preceded by a starttime check against the scan that found
 * the pid. Resolves with what it did; never rejects — a process that is gone
 * or not ours to signal is not an error here.
 */
export async function stopLeftoverProcesses(options: StopLeftoversOptions): Promise<LeftoverSweepResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return { found: 0, terminated: 0, killed: 0 };
  }
  const proc = options.proc ?? PROC;
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const pollMs = options.pollMs ?? POLL_MS;

  /** Signal each target still the process the scan saw; the count of signals sent. */
  const signalAll = async (targets: readonly LeftoverProcess[], signal: NodeJS.Signals): Promise<number> => {
    let sent = 0;
    for (const target of targets) {
      const current = await proc.stat(target.pid);
      if (!running(current) || current.starttime !== target.starttime) {
        continue;
      }
      try {
        kill(target.pid, signal);
        sent += 1;
      } catch {
        // Gone already (ESRCH), or not ours (EPERM): nothing to do either way.
      }
    }
    return sent;
  };

  /** Wait until none of `targets` runs any more, or `windowMs` has passed. */
  const waitGone = async (targets: readonly LeftoverProcess[], windowMs: number): Promise<void> => {
    const deadline = now() + windowMs;
    let alive = [...targets];
    for (;;) {
      const still: LeftoverProcess[] = [];
      for (const target of alive) {
        const current = await proc.stat(target.pid);
        if (running(current) && current.starttime === target.starttime) {
          still.push(target);
        }
      }
      alive = still;
      if (alive.length === 0 || now() >= deadline) {
        return;
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  };

  const found = await findLeftoverProcesses(options.launchId, { proc });
  if (found.length === 0) {
    return { found: 0, terminated: 0, killed: 0 };
  }
  const terminated = await signalAll(found, "SIGTERM");
  await waitGone(found, graceMs);
  const stubborn = await findLeftoverProcesses(options.launchId, { proc });
  const killed = await signalAll(stubborn, "SIGKILL");
  if (killed > 0) {
    await waitGone(stubborn, graceMs);
  }
  return { found: found.length, terminated, killed };
}
