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
 * **What a sweep may take — its scope.** A process is taken only when it
 * carries the ending launch's marker exactly, is not a shared daemon (below),
 * and belongs to one of the scopes the caller recorded while the CLI lived:
 * - a recorded SESSION ({@link recordChildSessions}; Grok, whose children each
 *   lead one);
 * - the CLI's own PROCESS GROUP ({@link recordOwnGroup}): only a CLI that
 *   leads its group (`spawn.ts` starts every provider `detached`), so a
 *   provider spawned into the host's own group — the Claude SDK's — never
 *   records one, and nothing here can reach the host's group;
 * - recorded HELPER PROCESSES ({@link recordHelperProcesses}): the CLI's
 *   children while its session opened — its MCP servers, before any of the
 *   user's work ran — and their descendants that stayed in their session,
 *   each by pid and starttime.
 *
 * **The CLI's lifeline watcher is never taken** (`lifeline.ts`, {@link isLifelineWatcher}): a
 * child of the CLI carrying its marker, it would read as a helper, and a sweep that stopped it
 * while the CLI still ran would leave that CLI working after a host death. It ends by itself.
 *
 * **Shared daemons are never taken** ({@link isSharedDaemon}), whichever scope
 * would hold them. agent-browser's daemon is one long-lived process every
 * chat on a host shares, with the Chromium it drives: the first chat to use
 * it starts it, so it carries THAT chat's marker. It `setsid`s away, which the
 * session and group scopes already spare, and it marks itself (and so the
 * browser it launches) with `AGENT_BROWSER_DAEMON` in its environment, which
 * this module spares explicitly in case a build stops detaching. A tmux
 * server — the user's, or one an agent started — is spared by name. T3 Code
 * (`apps/server/src/process/agentScope.ts`, `stop`) reaps an agent's whole
 * systemd scope, agent-browser and Chrome included; here the shared browser
 * outlives the chat by design, so the rule is narrower.
 *
 * WHICH scopes a sweep takes, and when, is the caller's policy
 * (`GrokSession`, `ProviderLeftovers`): a deploy must never kill running
 * work. **Linux-only**, by construction: everything here reads `/proc`.
 * Elsewhere nothing is read or signalled — the direct-child kill in
 * `spawn.ts` is all a stop does there.
 *
 * The daemon's Settings → System reads the same marker (`system-status.ts`):
 * an orphan carrying it is managed, and killable, whether or not a sweep ever
 * came for it.
 */

import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

import { isLifelineWatcher } from "./lifeline.ts";
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
  /** Field 5: the process group — the pid of the process that leads it. */
  readonly pgid: number;
  /** Field 6: the session — the pid of the process that leads it. */
  readonly sid: number;
  /** Field 2, without its parentheses: the executable's name, at most 15 bytes. */
  readonly comm: string;
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

/**
 * A provider CLI's own process group, recorded while it lived: its id — the
 * CLI's pid, as it leads the group — and the CLI's starttime.
 */
export interface RecordedGroup {
  readonly pgid: number;
  readonly leaderStarttime: number;
}

/** One process recorded while the CLI lived: by pid, and by the starttime that makes it this process. */
export interface RecordedProcess {
  readonly pid: number;
  readonly starttime: number;
}

/** What a sweep may take: any of these scopes, each optional ({@link findLeftoverProcesses}). */
export interface LeftoverScope {
  readonly sessions?: readonly RecordedSession[];
  readonly group?: RecordedGroup;
  readonly processes?: readonly RecordedProcess[];
}

type LeftoverProcess = RecordedProcess;

/**
 * The environment variables that mark a process as a host-wide daemon every
 * chat shares — never one launch's leftover, whatever marker it carries.
 * `AGENT_BROWSER_DAEMON`: agent-browser's daemon (0.39 reads it at start-up
 * to run as the daemon), inherited by the Chromium it launches.
 */
const SHARED_DAEMON_ENV_VARS: readonly string[] = ["AGENT_BROWSER_DAEMON"];

/** Executable names (`comm`) of host-wide daemons: a tmux server is the user's terminal. */
const SHARED_DAEMON_COMM = /^tmux/;

/** Whether a process is a shared daemon a sweep never takes: by its environment, or by its name. */
function isSharedDaemon(environ: string, comm: string): boolean {
  if (SHARED_DAEMON_COMM.test(comm)) return true;
  return environ.split("\0").some((entry) => SHARED_DAEMON_ENV_VARS.some((name) => entry.startsWith(`${name}=`)));
}

/** At most this many helper processes are recorded per launch: an MCP server's tree, not a build farm. */
const MAX_HELPER_PROCESSES = 256;

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
  const pgid = Number(fields[2]);
  const sid = Number(fields[3]);
  const starttime = Number(fields[19]);
  if (
    state === undefined ||
    state.length === 0 ||
    !Number.isInteger(ppid) ||
    !Number.isInteger(pgid) ||
    !Number.isInteger(sid) ||
    !Number.isFinite(starttime)
  ) {
    return null;
  }
  const open = content.indexOf("(");
  const comm = open === -1 || open > close ? "" : content.slice(open + 1, close);
  return { starttime, state, ppid, pgid, sid, comm };
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
  /** Whether `pid` is the CLI's lifeline watcher (`lifeline.ts`), which nothing here takes. */
  async lifeline(pid: number): Promise<boolean> {
    const cmdline = await readText(`/proc/${pid}/cmdline`, "latin1");
    return cmdline !== null && isLifelineWatcher(cmdline);
  },
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

/**
 * Whether the process `pid` still runs — the one first seen under it: its
 * starttime is remembered in `seen` (keyed by `key`) at the first look, and a
 * pid recycled since reads as gone. `false` for a process that is gone (no
 * `/proc` entry, a zombie), `undefined` when it cannot be told (not Linux, an
 * unreadable entry). Synchronous: one small `/proc` read, for the liveness
 * registry's per-read check.
 */
export function processStillRunning(
  pid: number,
  seen: Map<string, number>,
  key: string
): boolean | undefined {
  if (process.platform !== "linux") return undefined;
  let content: string;
  try {
    content = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ESRCH" ? false : undefined;
  }
  const stat = parseStat(content);
  if (stat === null) return undefined;
  if (!running(stat)) return false;
  const first = seen.get(key);
  if (first === undefined) {
    seen.set(key, stat.starttime);
    return true;
  }
  return first === stat.starttime;
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
 * stayed in its parent's session names the parent's — except the CLI's
 * lifeline watcher (`lifeline.ts`), which names nothing. A gone parent names
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
    // The CLI's lifeline watcher stays in the CLI's own session: it must not put that session —
    // the CLI itself, and whatever runs beside it — in a helper's or a task's scope.
    if (await proc.lifeline(child)) {
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
 * The CLI's own process group, recorded now — while `pid` lives and only if
 * it leads its group (a `detached` spawn). Null for a process in somebody
 * else's group (the Claude SDK spawns its CLI into the host's): a sweep can
 * then never reach the group the host itself is in. Linux-only.
 */
export async function recordOwnGroup(pid: number | undefined): Promise<RecordedGroup | null> {
  if (process.platform !== "linux" || pid === undefined || pid <= 1 || pid === process.pid) {
    return null;
  }
  const stat = await PROC.stat(pid);
  if (!running(stat) || stat.pgid !== pid) {
    return null;
  }
  return { pgid: pid, leaderStarttime: stat.starttime };
}

/**
 * The provider CLI among `parentPid`'s children: the one whose environment
 * carries `launchId`'s marker — how a CLI another library spawned (the Claude
 * SDK's) is found without its pid. Null when none does. Linux-only.
 */
export async function findLaunchRoot(launchId: string, parentPid: number = process.pid): Promise<RecordedProcess | null> {
  if (process.platform !== "linux" || launchId.length === 0) {
    return null;
  }
  const marker = `${AGENT_LAUNCH_ENV_VAR}=${launchId}`;
  for (const pid of (await childrenOf(parentPid)).sort((left, right) => left - right)) {
    const before = await PROC.stat(pid);
    if (!running(before) || before.ppid !== parentPid) continue;
    const environ = await PROC.environ(pid);
    if (environ === null || !environ.split("\0").includes(marker)) continue;
    const after = await PROC.stat(pid);
    if (running(after) && after.starttime === before.starttime) {
      return { pid, starttime: before.starttime };
    }
  }
  return null;
}

/**
 * The CLI's helper processes, recorded now — while the CLI lives.
 *
 * With nothing `known`, the roots are `cli`'s direct children as they are
 * now: called once the CLI's session has opened and before any of the user's
 * work ran, they are its MCP servers. With some `known`, the roots are those
 * of them still running — never a NEW child of the CLI, which is the user's
 * work (a shell, a dev server) by then. From each root, its descendants are
 * added while they stay in their parent's session (one that `setsid`s away
 * daemonized, and is no helper's), and never a shared daemon nor anything
 * under one. Answers `known` (still running) plus what was found, by pid,
 * at most {@link MAX_HELPER_PROCESSES}. A recording refreshed while the
 * helpers live catches the server a wrapper started (`bun run start` →
 * `bun server.ts`) before the wrapper's exit orphans it. Linux-only.
 */
export async function recordHelperProcesses(
  cli: RecordedProcess,
  known: readonly RecordedProcess[] = []
): Promise<RecordedProcess[]> {
  if (process.platform !== "linux") {
    return [];
  }
  const recorded = new Map<number, RecordedProcess>();
  const queue: Array<{ pid: number; sid: number }> = [];
  /** Record `pid` as a helper when it is `parent`'s child, in `parent`'s session, and no shared daemon. */
  const admit = async (pid: number, parent: { pid: number; sid: number } | null): Promise<void> => {
    if (recorded.size >= MAX_HELPER_PROCESSES || recorded.has(pid) || pid === process.pid) return;
    const before = await PROC.stat(pid);
    if (!running(before)) return;
    if (parent !== null && (before.ppid !== parent.pid || before.sid !== parent.sid)) return;
    const environ = await PROC.environ(pid);
    if (environ === null || isSharedDaemon(environ, before.comm) || (await PROC.lifeline(pid))) return;
    const after = await PROC.stat(pid);
    if (!running(after) || after.starttime !== before.starttime) return;
    recorded.set(pid, { pid, starttime: before.starttime });
    queue.push({ pid, sid: before.sid });
  };
  if (known.length === 0) {
    const current = await PROC.stat(cli.pid);
    if (!running(current) || current.starttime !== cli.starttime) return [];
    // The CLI's children are its helpers whatever session each leads.
    for (const child of await childrenOf(cli.pid)) {
      const stat = await PROC.stat(child);
      if (running(stat) && stat.ppid === cli.pid) await admit(child, { pid: cli.pid, sid: stat.sid });
    }
  } else {
    for (const entry of known) {
      const current = await PROC.stat(entry.pid);
      if (!running(current) || current.starttime !== entry.starttime) continue;
      recorded.set(entry.pid, entry);
      queue.push({ pid: entry.pid, sid: current.sid });
    }
  }
  while (queue.length > 0 && recorded.size < MAX_HELPER_PROCESSES) {
    const parent = queue.shift()!;
    for (const child of await childrenOf(parent.pid)) {
      await admit(child, parent);
    }
  }
  return [...recorded.values()].sort((left, right) => left.pid - right.pid);
}

/** `pid`'s children, by the per-thread lists or, without them, by a scan of every parent. */
async function childrenOf(pid: number): Promise<number[]> {
  const listed = await PROC.children(pid);
  if (listed !== null) return listed;
  const found: number[] = [];
  await eachLimited(await PROC.pids(), async (candidate) => {
    const stat = await PROC.stat(candidate);
    if (running(stat) && stat.ppid === pid) found.push(candidate);
  });
  return found;
}

function scopeIsEmpty(scope: LeftoverScope): boolean {
  return (scope.sessions?.length ?? 0) === 0 && scope.group === undefined && (scope.processes?.length ?? 0) === 0;
}

/**
 * Every live process in `scope` whose environment carries
 * `AGENT_LAUNCH_ENV_VAR=<launchId>` exactly and that is no shared daemon
 * ({@link isSharedDaemon}), in pid order — this process excluded. Only a
 * candidate in the scope has its environment read. A process's starttime is
 * read on both sides of the environment read, and a pid whose starttime moved
 * in between is skipped: the environment matched may have been either
 * process's. In scope means one of:
 * - in a recorded session; a session whose leader still lives must have the
 *   recorded leader (a session id is a pid, and pids are recycled); one whose
 *   leader is gone is taken on its members' marker;
 * - in the recorded group, by the same leader rule;
 * - a recorded process, still under its recorded starttime.
 */
export async function findLeftoverProcesses(launchId: string, scope: LeftoverScope): Promise<LeftoverProcess[]> {
  if (launchId.length === 0 || scopeIsEmpty(scope)) {
    return [];
  }
  const proc = PROC;
  const bySid = new Map((scope.sessions ?? []).map((session) => [session.sid, session]));
  const byPid = new Map((scope.processes ?? []).map((entry) => [entry.pid, entry]));
  const group = scope.group;
  const marker = `${AGENT_LAUNCH_ENV_VAR}=${launchId}`;
  /** A live leader must be the one recorded; a gone one leaves its members to their marker. */
  const leaderMatches = async (stat: ProcStat, pid: number, leaderPid: number, leaderStarttime: number): Promise<boolean> => {
    const leader = leaderPid === pid ? stat : await proc.stat(leaderPid);
    return !running(leader) || leader.starttime === leaderStarttime;
  };
  const inScope = async (pid: number, stat: ProcStat): Promise<boolean> => {
    const recorded = byPid.get(pid);
    if (recorded !== undefined && recorded.starttime === stat.starttime) return true;
    const session = bySid.get(stat.sid);
    if (session !== undefined && (await leaderMatches(stat, pid, stat.sid, session.leaderStarttime))) return true;
    return group !== undefined && stat.pgid === group.pgid && (await leaderMatches(stat, pid, group.pgid, group.leaderStarttime));
  };
  // Recorded processes alone are looked up by pid; a session or a group needs every pid.
  const candidates = bySid.size === 0 && group === undefined ? [...byPid.keys()] : await proc.pids();
  const found: LeftoverProcess[] = [];
  await eachLimited(candidates.filter((pid) => pid !== process.pid), async (pid) => {
    const before = await proc.stat(pid);
    if (!running(before) || !(await inScope(pid, before))) {
      return;
    }
    const environ = await proc.environ(pid);
    if (environ === null || !environ.split("\0").includes(marker) || isSharedDaemon(environ, before.comm)) {
      return;
    }
    if (await proc.lifeline(pid)) {
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

export interface StopLeftoversOptions extends LeftoverScope {
  /** The launch whose leftovers are stopped: the value its launch env gave the marker. */
  launchId: string;
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
 * Stop what `launchId` left behind in its scope (sessions, group, helper
 * processes; none, and nothing is read or signalled): SIGTERM each, wait until
 * they are gone or the grace runs out, then SIGKILL whatever a FRESH scan of
 * the same scope still finds (a dying tree may start something on its way
 * out), and wait once more, as long again, for the kernel to finish them.
 * Each signal is preceded by a starttime check against the scan that found
 * the pid. Resolves with what it did; never rejects — a process that is gone
 * or not ours to signal is not an error here.
 */
export async function stopLeftoverProcesses(options: StopLeftoversOptions): Promise<LeftoverSweepResult> {
  if (process.platform !== "linux" || scopeIsEmpty(options)) {
    return { found: 0, terminated: 0, killed: 0 };
  }
  const proc = PROC;
  const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const find = async (): Promise<LeftoverProcess[]> =>
    await findLeftoverProcesses(options.launchId, options);

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
