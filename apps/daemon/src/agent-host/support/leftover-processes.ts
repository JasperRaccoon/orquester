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
 * SIGTERM (Grok fixtures README observation 48).
 *
 * **Which processes are the launch's.** Once a process is orphaned its parent
 * chain is gone; two things are not. Its environment: the host sets a marker
 * on the launch environment — {@link AGENT_LAUNCH_ENV_VAR}, one value per
 * launch — which every descendant inherits. And its session: each child of
 * the CLI leads a session of its own, which everything that child starts
 * stays in unless it daemonizes (`setsid`, `ssh -f`, a browser daemon). The
 * CLI's children's sessions are recorded while the CLI lives
 * ({@link recordChildSessions}), and a sweep takes only the processes that
 * carry the marker AND sit in a recorded session: a host-wide helper a chat
 * happened to start first — agent-browser's daemon, an SSH ControlMaster —
 * daemonized into a session of its own, carries the marker, and is spared.
 * A descendant that scrubbed its environment (`env -i`, `sudo`'s
 * `env_reset`) carries no marker and escapes, as it escapes anything but a
 * process-tree walk its reparenting already defeated.
 *
 * **Never a recycled pid**, by the kill guard's rule (`system-status.ts`): a
 * process is identified by its `/proc` starttime, read on both sides of the
 * environment read that matched it and again immediately before each signal;
 * a pid whose starttime moved is somebody else's and is left alone. A session
 * id is a pid too: a session whose leader still lives must have the leader
 * that was recorded. A zombie is gone already.
 *
 * WHICH sessions a sweep takes is the caller's policy (`GrokSession`): a
 * deploy must never kill running work. **Linux-only**, by construction:
 * everything here reads `/proc`. Elsewhere nothing is read or signalled —
 * the direct-child kill in `spawn.ts` is all a stop does there.
 *
 * The daemon's Settings → System reads the same marker (`system-status.ts`):
 * an orphan carrying it is managed, and killable, whether or not a sweep ever
 * came for it.
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

/** One process as `/proc/<pid>/stat` names it: its identity, its place, whether it still runs. */
export interface ProcStat {
  /** Field 22: invariant for the life of a process — the identity a pid alone is not. */
  readonly starttime: number;
  /** Field 3: `Z` (zombie) and `X` (dead) are gone. */
  readonly state: string;
  /** Field 4. */
  readonly ppid: number;
  /** Field 6: the session — the pid of the process that leads it. */
  readonly sid: number;
}

/**
 * A session a provider CLI's child took part in, recorded while the CLI
 * lived: its id — the pid of its leader — and that leader's starttime, which
 * tells a session id recycled since from the one recorded.
 */
export interface RecordedSession {
  readonly sid: number;
  readonly leaderStarttime: number;
}

interface LeftoverProcess {
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
  const ppid = Number(fields[1]);
  const sid = Number(fields[3]);
  const starttime = Number(fields[19]);
  if (
    state === undefined ||
    state.length === 0 ||
    !Number.isInteger(ppid) ||
    !Number.isInteger(sid) ||
    !Number.isFinite(starttime)
  ) {
    return null;
  }
  return { starttime, state, ppid, sid };
}

async function readText(path: string, encoding: BufferEncoding): Promise<string | null> {
  try {
    return await readFile(path, encoding);
  } catch {
    return null;
  }
}

/** The real `/proc`. Unreadable entries — another user's environment, a pid gone mid-read — are null. */
const PROC = {
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
  environ: async (pid: number) => await readText(`/proc/${pid}/environ`, "latin1"),
  async stat(pid: number): Promise<ProcStat | null> {
    const content = await readText(`/proc/${pid}/stat`, "latin1");
    return content === null ? null : parseStat(content);
  },
  async children(pid: number): Promise<number[] | null> {
    // Every thread's own list (`CONFIG_PROC_CHILDREN`): a child is listed
    // under the thread that forked it.
    let tasks: string[];
    try {
      tasks = await readdir(`/proc/${pid}/task`);
    } catch {
      return [];
    }
    const children = new Set<number>();
    for (const task of tasks) {
      const listed = await readText(`/proc/${pid}/task/${task}/children`, "latin1");
      if (listed === null) {
        return null;
      }
      for (const entry of listed.split(" ")) {
        const child = Number(entry);
        if (Number.isInteger(child) && child > 1) children.add(child);
      }
    }
    return [...children];
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
 * The sessions `parentPid`'s direct children take part in, recorded now — a
 * provider CLI's, while it lives. A child that leads a session of its own
 * (every child of the Grok CLI, fixtures 24 and 31) names its own; one that
 * stayed in its parent's session names the parent's. A gone parent names
 * none. Linux-only; elsewhere, nothing.
 */
export async function recordChildSessions(
  parentPid: number
): Promise<RecordedSession[]> {
  if (process.platform !== "linux") {
    return [];
  }
  const proc = PROC;
  const parent = await proc.stat(parentPid);
  if (!running(parent)) {
    return [];
  }
  let children = await proc.children(parentPid);
  if (children === null) {
    // No per-thread child lists: find them by their parent instead.
    const found: number[] = [];
    await eachLimited(await proc.pids(), async (pid) => {
      const stat = await proc.stat(pid);
      if (running(stat) && stat.ppid === parentPid) found.push(pid);
    });
    children = found;
  }
  const sessions = new Map<number, RecordedSession>();
  for (const child of children) {
    const stat = await proc.stat(child);
    if (!running(stat) || stat.ppid !== parentPid) {
      continue;
    }
    if (stat.sid === child) {
      sessions.set(child, { sid: child, leaderStarttime: stat.starttime });
      continue;
    }
    if (stat.sid === parent.sid) {
      const leader = parent.sid === parentPid ? parent : await proc.stat(parent.sid);
      if (running(leader)) sessions.set(parent.sid, { sid: parent.sid, leaderStarttime: leader.starttime });
    }
  }
  return [...sessions.values()];
}

/**
 * Every live process in one of `sessions` whose environment carries
 * `AGENT_LAUNCH_ENV_VAR=<launchId>` exactly, in pid order — this process
 * excluded. Only a recorded session's members have their environment read.
 * A process's starttime is read on both sides of the environment read, and a
 * pid whose starttime moved in between is skipped: the environment matched may
 * have been either process's. A session whose leader still lives must have the
 * recorded leader (a session id is a pid, and pids are recycled); one whose
 * leader is gone is taken on its members' marker.
 */
export async function findLeftoverProcesses(
  launchId: string,
  options: { sessions: readonly RecordedSession[] }
): Promise<LeftoverProcess[]> {
  if (launchId.length === 0 || options.sessions.length === 0) {
    return [];
  }
  const proc = PROC;
  const bySid = new Map(options.sessions.map((session) => [session.sid, session]));
  const marker = `${AGENT_LAUNCH_ENV_VAR}=${launchId}`;
  const found: LeftoverProcess[] = [];
  const pids = (await proc.pids()).filter((pid) => pid !== process.pid);
  await eachLimited(pids, async (pid) => {
    const before = await proc.stat(pid);
    if (!running(before)) {
      return;
    }
    const session = bySid.get(before.sid);
    if (session === undefined) {
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
    const leader = before.sid === pid ? before : await proc.stat(before.sid);
    if (running(leader) && leader.starttime !== session.leaderStarttime) {
      return;
    }
    found.push({ pid, starttime: before.starttime });
  });
  return found.sort((left, right) => left.pid - right.pid);
}

export interface StopLeftoversOptions {
  /** The launch whose leftovers are stopped: the value its launch env gave the marker. */
  launchId: string;
  /** The recorded sessions to sweep; none, and nothing is read or signalled. */
  sessions: readonly RecordedSession[];
  /** SIGTERM, then SIGKILL this long after. Defaults to `spawn.ts`'s grace. */
  graceMs?: number;
}

export interface LeftoverSweepResult {
  /** Processes the first scan found carrying the marker in a recorded session. */
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
 * Stop what `launchId` left behind in `sessions`: SIGTERM each, wait until
 * they are gone or the grace runs out, then SIGKILL whatever a FRESH scan of
 * the same sessions still finds (a dying tree may start something on its way
 * out), and wait once more, as long again, for the kernel to finish them.
 * Each signal is preceded by a starttime check against the scan that found
 * the pid. Resolves with what it did; never rejects — a process that is gone
 * or not ours to signal is not an error here.
 */
export async function stopLeftoverProcesses(options: StopLeftoversOptions): Promise<LeftoverSweepResult> {
  if (process.platform !== "linux" || options.sessions.length === 0) {
    return { found: 0, terminated: 0, killed: 0 };
  }
  const proc = PROC;
  const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const find = async (): Promise<LeftoverProcess[]> =>
    await findLeftoverProcesses(options.launchId, { sessions: options.sessions });

  /** Signal each target still the process the scan saw; the count of signals sent. */
  const signalAll = async (targets: readonly LeftoverProcess[], signal: NodeJS.Signals): Promise<number> => {
    let sent = 0;
    for (const target of targets) {
      const current = await proc.stat(target.pid);
      if (!running(current) || current.starttime !== target.starttime) {
        continue;
      }
      try {
        process.kill(target.pid, signal);
        sent += 1;
      } catch {
        // Gone already (ESRCH), or not ours (EPERM): nothing to do either way.
      }
    }
    return sent;
  };

  /** Wait until none of `targets` runs any more, or `windowMs` has passed. */
  const waitGone = async (targets: readonly LeftoverProcess[], windowMs: number): Promise<void> => {
    const deadline = Date.now() + windowMs;
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
      if (alive.length === 0 || Date.now() >= deadline) {
        return;
      }
      await sleepFor(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  };

  const found = await find();
  if (found.length === 0) {
    return { found: 0, terminated: 0, killed: 0 };
  }
  const terminated = await signalAll(found, "SIGTERM");
  await waitGone(found, graceMs);
  const stubborn = await find();
  const killed = await signalAll(stubborn, "SIGKILL");
  if (killed > 0) {
    await waitGone(stubborn, graceMs);
  }
  return { found: found.length, terminated, killed };
}
