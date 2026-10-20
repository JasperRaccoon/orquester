/**
 * Terminals in boxes (spec §8.8, §13.3 "Watch").
 *
 * A terminal tab of a box project — or any tab created with
 * `CreateSessionRequest.boxId` (a temporary box's "Watch" terminal) — opens a
 * shell IN THE BOX. Only the PTY source moves: the session is an ordinary
 * `SessionSummary` in the daemon's one session list, and the multiplexed
 * terminal WebSocket protocol to the UI is unchanged (input → the box
 * process's stdin, resize → `BoxProcess.resize`, output → the same
 * "output" events and scrollback).
 *
 * - The shell is a DETACHED `orq-agent` process whose `procId` is the session
 *   id, so a daemon restart or a dropped link leaves it running. Inside the box
 *   it is `tmux new-session -A -s orq-<id>` on a private tmux server when the
 *   box has tmux (the shell then also survives an `orq-agent` restart: a new
 *   client attaches to the same tmux session), else the box user's login shell.
 * - `sessions.json` records the tab with its `boxId` (through the host
 *   manager's index contributor — it stays the file's only writer). On boot the
 *   record is adopted and, once the box is connected, reattached with
 *   `attach(procId, offset)`: from the last byte seen when the daemon kept
 *   running across a link drop, or from the start of the box's ring buffer
 *   after a restart (rebuilding the hot scrollback).
 * - Plain shells only. Terminal agents, IDEs and other registry launches are
 *   refused for boxes (their account env, hooks and host binaries do not apply
 *   there; agent chats run in the box through the agent host instead).
 * - Env: the box's own, plus git's host-backed auth (`boxGitEnv`) and the
 *   tooling plugins' contribution for the box. Never the host's env and never
 *   the host's NODE_OPTIONS preload.
 *
 * {@link BoxAwareSessionManager} routes the `ISessionManager` surface between
 * the host backend (tmux or direct PTY, untouched) and {@link BoxTerminalManager}.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { AgentEventRequest, CreateSessionRequest, RegistryEntry, SessionActivity, SessionSummary } from "@orquester/api";
import { hostToBoxPath } from "@orquester/api";
import type { SessionRecord } from "@orquester/config";

import { ActivityTracker } from "../../../ansi-activity.ts";
import { SessionError, type ISessionManager, type SessionIndexContributor } from "../../../sessions.ts";
import { captureArgs, tmuxName } from "../../../tmux.ts";
import type { BoxConnection, BoxHub, BoxProcess, BoxRegistry, BoxToolingProvisioner } from "../../contracts.ts";
import { boxGitEnv, boxToolingEnv, toolingFor } from "./env.ts";
import { runInBox, waitSpawned } from "./run.ts";

/** Hot replay ring, as for host sessions. */
const MAX_BUFFER = 256 * 1024;
/** The private tmux server box terminals use (`tmux -L`), apart from the box user's own. */
export const BOX_TMUX_SERVER = "orquester";
/** How long a closed terminal's process gets after SIGHUP before SIGKILL. */
const CLOSE_GRACE_MS = 5_000;
/** Recoveries in a row (a reattach that errors again) before a terminal is given up as lost. */
const MAX_RECOVERIES = 3;

interface BoxTerminal {
  summary: SessionSummary & { boxId: string };
  proc: BoxProcess | null;
  /** Bytes of output consumed so far (the attach offset). */
  offset: number;
  /** Whether `offset` is trustworthy (false after a daemon restart, until the first reattach). */
  offsetKnown: boolean;
  buffer: string;
  tracker: ActivityTracker;
  emitter: EventEmitter;
  reattaching: boolean;
  recoveries: number;
}

export interface BoxTerminalDeps {
  registry: Pick<BoxRegistry, "get" | "locate" | "onChange">;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  tooling?: Pick<BoxToolingProvisioner, "contribution">;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

/** A terminal's cwd in the box: a host-form path is mapped, a box path (the home default) kept. */
function boxCwd(connection: BoxConnection, cwd: string): string {
  return cwd.startsWith("/") ? hostToBoxPath(connection.paths, cwd) : cwd;
}

/** argv of a terminal's process in the box. */
export function boxShellCommand(
  connection: Pick<BoxConnection, "sys">,
  options: { id: string; cwd: string; cols: number; rows: number; env: Record<string, string> }
): { command: string; args: string[] } {
  const { sys } = connection;
  if (sys.tmux) {
    // On a running tmux server a NEW session gets the server's global env plus `-e`, not the
    // client's env, so the launch env goes in as `-e` too (none of it is secret; SSH_AUTH_SOCK
    // reaches the session through tmux's default `update-environment`). `-A` attaches instead
    // when the session already exists (a client restarted after `orq-agent` came back).
    const envArgs = Object.entries(options.env)
      .filter(([, value]) => !value.includes("\n"))
      .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return {
      command: "tmux",
      args: ["-L", BOX_TMUX_SERVER, "new-session", "-A", "-s", tmuxName(options.id), "-x", String(options.cols), "-y", String(options.rows), "-c", options.cwd, ...envArgs]
    };
  }
  if (sys.os === "win32") return { command: sys.shell, args: ["-NoLogo"] };
  return { command: sys.shell, args: ["-l"] };
}

/** Owns every terminal whose shell runs in a box. */
export class BoxTerminalManager {
  /** Emits "created" | "exited" | "updated" (SessionSummary), "closed" ({ id }), "activity" and "output" like the host backends. */
  readonly lifecycle = new EventEmitter();
  private readonly sessions = new Map<string, BoxTerminal>();
  /** Terminals closed while their box was away: their processes are ended on reconnect. */
  private readonly closedAway = new Map<string, Set<string>>();
  private persist: () => void = () => undefined;
  private shuttingDown = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly deps: BoxTerminalDeps) {
    this.unsubscribe.push(
      deps.hub.onConnectionChange((boxId, connected) => {
        if (connected) void this.onBoxConnected(boxId);
        else this.onBoxDisconnected(boxId);
      }),
      deps.registry.onChange((boxId) => this.onBoxChanged(boxId))
    );
  }

  /** The host manager's immediate index write (it owns `sessions.json`). */
  setPersist(persist: () => void): void {
    this.persist = persist;
  }

  /** Stop listening to the hub and registry (tests, teardown). */
  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** The box a create request targets: its explicit `boxId`, else its project's box; null = this host. */
  targetBox(req: CreateSessionRequest): string | null {
    if (typeof req.boxId === "string" && req.boxId.length > 0) return req.boxId;
    const path = req.projectPath || req.cwd;
    if (!path) return null;
    const location = this.deps.registry.locate(path);
    return location.kind === "box" ? location.boxId : null;
  }

  async create(req: CreateSessionRequest, entry: RegistryEntry | undefined, order: number, boxId: string): Promise<SessionSummary> {
    const record = this.deps.registry.get(boxId);
    if (!record) throw new SessionError(`There is no box "${boxId}".`);
    if (record.state === "destroyed") throw new SessionError("This box was destroyed; it has no terminal to open.");
    if (!entry || !entry.enabled) throw new SessionError(`Registry entry "${req.refId}" is not available.`);
    if (entry.kind !== "shell") {
      throw new SessionError(
        `${entry.name} can't run in a box. Box projects offer plain shells and agent chats; terminal agents, IDEs and other launchers run on this host only.`
      );
    }
    const connection = this.deps.hub.get(boxId);
    if (!connection?.connected) throw new SessionError("The box is not connected right now. Try again once it is back.");

    const id = randomUUID();
    const cols = req.cols && req.cols > 0 ? req.cols : 80;
    const rows = req.rows && req.rows > 0 ? req.rows : 24;
    // An explicit box (a temporary box's "Watch") starts in the box user's home; a project
    // terminal in its project, as on the host.
    const cwd = req.cwd || (req.boxId ? connection.sys.home : req.projectPath) || connection.sys.home;
    const summary: BoxTerminal["summary"] = {
      id,
      kind: "shell",
      refId: entry.id,
      title: req.title || entry.name,
      projectPath: req.projectPath ?? "",
      cwd,
      cols,
      rows,
      status: "running",
      order,
      createdAt: new Date().toISOString(),
      boxId
    };
    const session = this.newTerminal(summary);
    session.offsetKnown = true;
    this.sessions.set(id, session);
    try {
      await this.spawn(session, connection);
    } catch (error) {
      this.sessions.delete(id);
      session.tracker.dispose();
      throw new SessionError(`Could not start a shell in the box: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Typed like a keystroke, as on the host: it queues in the box PTY until the shell reads.
    const initial = req.initialCommand?.trim();
    if (initial) this.input(id, `${initial}\n`);
    this.lifecycle.emit("created", this.withActivity(session));
    this.persist();
    return this.withActivity(session);
  }

  private newTerminal(summary: BoxTerminal["summary"]): BoxTerminal {
    const tracker = new ActivityTracker((activity, cause) => {
      this.lifecycle.emit("activity", { id: summary.id, activity, cause, hasHookSource: tracker.hasHookSource, kind: summary.kind });
    });
    return { summary, proc: null, offset: 0, offsetKnown: false, buffer: "", tracker, emitter: new EventEmitter(), reattaching: false, recoveries: 0 };
  }

  /** Start (or, for tmux, re-join) the terminal's process under its procId. */
  private async spawn(session: BoxTerminal, connection: BoxConnection): Promise<void> {
    const { id, cols, rows, boxId } = session.summary;
    const env: Record<string, string> = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ...boxGitEnv(connection.sys),
      ...(await boxToolingEnv(connection, toolingFor(this.deps.tooling, boxId)))
    };
    const cwd = boxCwd(connection, session.summary.cwd);
    const { command, args } = boxShellCommand(connection, { id, cwd, cols, rows, env });
    const proc = connection.exec({ command, args, cwd, env, pty: { cols, rows, term: "xterm-256color" }, detach: { procId: id } });
    await waitSpawned(proc);
    this.wire(session, proc, 0);
  }

  private wire(session: BoxTerminal, proc: BoxProcess, startOffset: number): void {
    const { id } = session.summary;
    session.proc = proc;
    session.offset = startOffset;
    const decoder = new StringDecoder("utf8");
    const onData = (chunk: Buffer): void => {
      if (this.sessions.get(id) !== session || session.proc !== proc) return;
      session.offset += chunk.length;
      session.recoveries = 0;
      const data = decoder.write(Buffer.from(chunk));
      if (!data) return;
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.tracker.noteOutput(data);
      session.emitter.emit("output", data);
      // The merged "output" feeds the project's dev-server URL suggestions: only a shell in the
      // project's OWN box speaks for it (a temporary box's "Watch" tab sits in a host project).
      if (this.isProjectBox(session)) this.lifecycle.emit("output", { id, data });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.stdin.on("error", () => {
      // A write racing the process's end; the exit (or detach) says what happened.
    });
    proc.on("exit", (code) => void this.onProcessExit(session, proc, code));
    proc.on("detached", () => {
      // The link dropped; the process keeps running in the box. Reattached on reconnect.
      if (session.proc === proc) session.proc = null;
    });
    proc.on("error", (error: Error) => {
      if (session.proc !== proc) return;
      session.proc = null;
      this.deps.logger?.warn("box terminal stream failed", { sessionId: id, boxId: session.summary.boxId, error: error.message });
      if (this.sessions.get(id) !== session || this.shuttingDown) return;
      session.recoveries += 1;
      if (session.recoveries > MAX_RECOVERIES) {
        this.markExited(session, null);
        return;
      }
      void this.reattach(session);
    });
  }

  private isProjectBox(session: BoxTerminal): boolean {
    if (!session.summary.projectPath) return false;
    const location = this.deps.registry.locate(session.summary.projectPath);
    return location.kind === "box" && location.boxId === session.summary.boxId;
  }

  private async onProcessExit(session: BoxTerminal, proc: BoxProcess, code: number | null): Promise<void> {
    if (session.proc !== proc) return;
    session.proc = null;
    if (this.sessions.get(session.summary.id) !== session || this.shuttingDown) return;
    const connection = this.deps.hub.get(session.summary.boxId);
    // A tmux client ending while its tmux session lives (detached with prefix-d, killed) is not
    // the shell ending: a new client re-joins it, as the tab still shows that shell.
    if (connection?.connected && connection.sys.tmux && (await this.tmuxAlive(connection, session.summary.id))) {
      await connection.request("proc.release", { procId: session.summary.id }).catch(() => undefined);
      try {
        await this.spawn(session, connection);
        return;
      } catch (error) {
        this.deps.logger?.warn("box terminal could not re-join its tmux session", { sessionId: session.summary.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.markExited(session, code);
  }

  private async tmuxAlive(connection: BoxConnection, id: string): Promise<boolean> {
    try {
      await runInBox(connection, "tmux", ["-L", BOX_TMUX_SERVER, "has-session", "-t", tmuxName(id)], { timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  private markExited(session: BoxTerminal, code: number | null): void {
    if (session.summary.status !== "running") return;
    const exitCode = code ?? 1;
    session.summary.status = "exited";
    session.summary.exitCode = exitCode;
    session.proc = null;
    session.emitter.emit("exit", exitCode);
    this.lifecycle.emit("exited", this.withActivity(session));
    session.tracker.noteExit();
    session.tracker.dispose();
    this.persist();
    const connection = this.deps.hub.get(session.summary.boxId);
    if (connection?.connected) void connection.request("proc.release", { procId: session.summary.id }).catch(() => undefined);
  }

  /** Re-establish a running terminal's stream after a reconnect or a restart (see the module doc). */
  private async reattach(session: BoxTerminal): Promise<void> {
    if (session.reattaching || session.proc !== null || session.summary.status !== "running") return;
    const { id, boxId } = session.summary;
    const connection = this.deps.hub.get(boxId);
    if (!connection?.connected) return;
    session.reattaching = true;
    try {
      const procs = await connection.request("proc.list", {}).catch(() => connection.detachedProcs());
      if (this.sessions.get(id) !== session) return;
      const info = procs.find((proc) => proc.procId === id);
      if (info) {
        const start = Math.max(session.offsetKnown ? session.offset : info.bufferStart, info.bufferStart);
        // After a restart the hot ring is rebuilt from the box's buffer.
        if (!session.offsetKnown) session.buffer = "";
        const proc = connection.attach(id, start);
        await waitSpawned(proc);
        if (this.sessions.get(id) !== session) {
          proc.kill("SIGHUP");
          return;
        }
        session.offsetKnown = true;
        this.wire(session, proc, start);
        return;
      }
      if (connection.sys.tmux && (await this.tmuxAlive(connection, id))) {
        await this.spawn(session, connection);
        return;
      }
      // Its shell ended while nobody watched (or the box restarted without tmux).
      this.markExited(session, null);
    } catch (error) {
      // Stays running; the next connect tries again.
      this.deps.logger?.warn("box terminal reattach failed", { sessionId: id, boxId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      session.reattaching = false;
    }
  }

  private async onBoxConnected(boxId: string): Promise<void> {
    const away = this.closedAway.get(boxId);
    if (away) {
      this.closedAway.delete(boxId);
      const connection = this.deps.hub.get(boxId);
      if (connection) for (const procId of away) void this.terminate(connection, procId, null);
    }
    for (const session of [...this.sessions.values()]) {
      if (session.summary.boxId === boxId) await this.reattach(session);
    }
  }

  /** The link dropped: every stream of that box is gone (its processes are not). */
  private onBoxDisconnected(boxId: string): void {
    for (const session of this.sessions.values()) {
      if (session.summary.boxId === boxId) session.proc = null;
    }
  }

  private onBoxChanged(boxId: string): void {
    const record = this.deps.registry.get(boxId);
    if (record && record.state !== "destroyed") return;
    // A destroyed box takes its shells with it: the tabs show them as ended.
    for (const session of [...this.sessions.values()]) {
      if (session.summary.boxId === boxId) this.markExited(session, null);
    }
    this.closedAway.delete(boxId);
  }

  /** End a terminal's processes in the box: its tmux session, then the process (SIGHUP, SIGKILL after a grace). */
  private async terminate(connection: BoxConnection, procId: string, proc: BoxProcess | null): Promise<void> {
    try {
      if (connection.sys.tmux) {
        await runInBox(connection, "tmux", ["-L", BOX_TMUX_SERVER, "kill-session", "-t", tmuxName(procId)], { timeout: 15_000 }).catch(() => undefined);
      }
      let handle = proc;
      if (handle === null) {
        const info = (await connection.request("proc.list", {})).find((entry) => entry.procId === procId);
        if (!info) return;
        if (!info.running) {
          await connection.request("proc.release", { procId });
          return;
        }
        handle = connection.attach(procId, info.outputBytes);
      }
      const ended = new Promise<void>((resolve) => {
        if (handle.exitCode !== null || handle.signalCode !== null) {
          resolve();
          return;
        }
        handle.once("exit", () => resolve());
        handle.on("detached", () => resolve());
        handle.once("error", () => resolve());
      });
      handle.kill("SIGHUP");
      const grace = setTimeout(() => handle.kill("SIGKILL"), CLOSE_GRACE_MS);
      grace.unref?.();
      await ended;
      clearTimeout(grace);
      await connection.request("proc.release", { procId });
    } catch (error) {
      this.deps.logger?.warn("box terminal close did not finish", { procId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  list(projectPath?: string): SessionSummary[] {
    const all = [...this.sessions.values()].map((s) => this.withActivity(s));
    return projectPath === undefined ? all : all.filter((s) => s.projectPath === projectPath);
  }

  get(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    return session ? this.withActivity(session) : undefined;
  }

  private withActivity(session: BoxTerminal): SessionSummary {
    return session.summary.status === "running" ? { ...session.summary, activity: session.tracker.snapshot() } : { ...session.summary };
  }

  /** Durable scrollback: the in-box tmux pane when there is one, else the hot ring. */
  async scrollback(id: string): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) return "";
    const connection = this.deps.hub.get(session.summary.boxId);
    if (session.summary.status === "running" && connection?.connected && connection.sys.tmux) {
      const name = tmuxName(id);
      const tmux = (args: string[]) => runInBox(connection, "tmux", ["-L", BOX_TMUX_SERVER, ...args], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
      try {
        // Same alt-screen framing as the host's capturePane (tmux.ts).
        const alt = (await tmux(["display-message", "-p", "-t", name, "#{alternate_on}"])).stdout.trim() === "1";
        if (alt) return `\x1b[?1049h\x1b[H${(await tmux(["capture-pane", "-p", "-e", "-t", name])).stdout}`;
        const captured = (await tmux(captureArgs(name))).stdout;
        if (captured) return captured;
      } catch {
        // fall back to the hot ring
      }
    }
    return session.buffer;
  }

  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? "";
  }

  activity(id: string): SessionActivity | undefined {
    return this.sessions.get(id)?.tracker.snapshot();
  }

  input(id: string, data: string): void {
    const session = this.sessions.get(id);
    session?.tracker.noteInput(Date.now());
    try {
      session?.proc?.stdin.write(data);
    } catch {
      // Best effort, as on the host: the stream can be freshly gone.
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || cols <= 0 || rows <= 0) return;
    try {
      session.proc?.resize(cols, rows);
    } catch {
      return;
    }
    if (session.summary.cols !== cols || session.summary.rows !== rows) {
      session.summary.cols = cols;
      session.summary.rows = rows;
      this.persist();
    }
  }

  rename(id: string, title: string, fallback: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.summary.title = title.trim() || fallback;
    this.lifecycle.emit("updated", this.withActivity(session));
    this.persist();
    return this.withActivity(session);
  }

  /** Apply the tab order of the ids this manager owns; true when one moved. */
  reorder(projectPath: string, ids: string[]): boolean {
    let changed = false;
    ids.forEach((id, index) => {
      const session = this.sessions.get(id);
      if (session && session.summary.projectPath === projectPath && session.summary.order !== index) {
        session.summary.order = index;
        this.lifecycle.emit("updated", this.withActivity(session));
        changed = true;
      }
    });
    if (changed) this.persist();
    return changed;
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.tracker.dispose();
    this.lifecycle.emit("closed", { id });
    this.persist();
    const proc = session.proc;
    session.proc = null;
    if (session.summary.status === "running") {
      const connection = this.deps.hub.get(session.summary.boxId);
      if (connection?.connected) {
        void this.terminate(connection, id, proc);
      } else {
        const away = this.closedAway.get(session.summary.boxId) ?? new Set<string>();
        away.add(id);
        this.closedAway.set(session.summary.boxId, away);
      }
    }
    return true;
  }

  closeByProjectPrefix(prefix: string): void {
    for (const [id, session] of [...this.sessions]) {
      const project = session.summary.projectPath;
      if (project === prefix || project.startsWith(prefix + sep)) this.close(id);
    }
  }

  subscribe(id: string, onOutput: (data: string) => void, onExit: (code: number) => void): () => void {
    const session = this.sessions.get(id);
    if (!session) return () => undefined;
    session.emitter.on("output", onOutput);
    session.emitter.on("exit", onExit);
    return () => {
      session.emitter.off("output", onOutput);
      session.emitter.off("exit", onExit);
    };
  }

  /** Daemon shutdown: leave every shell running in its box (the next boot reattaches). */
  shutdown(): void {
    this.shuttingDown = true;
    for (const session of this.sessions.values()) session.proc = null;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  /** `sessions.json` records of the running box terminals. */
  records(): SessionRecord[] {
    return [...this.sessions.values()]
      .filter((session) => session.summary.status === "running")
      .map(({ summary }) => ({
        id: summary.id,
        title: summary.title,
        order: summary.order,
        projectPath: summary.projectPath,
        refId: summary.refId,
        kind: summary.kind as SessionRecord["kind"],
        cwd: summary.cwd,
        createdAt: summary.createdAt,
        cols: summary.cols,
        rows: summary.rows,
        boxId: summary.boxId
      }));
  }

  /** Take over the box terminals read from `sessions.json` on boot; reattach the connected ones. */
  adopt(records: readonly SessionRecord[]): void {
    for (const record of records) {
      if (!record.boxId || this.sessions.has(record.id)) continue;
      const state = this.deps.registry.get(record.boxId)?.state;
      if (state === undefined || state === "destroyed") continue;
      const session = this.newTerminal({
        id: record.id,
        kind: "shell",
        refId: record.refId,
        title: record.title,
        projectPath: record.projectPath,
        cwd: record.cwd,
        cols: record.cols ?? 80,
        rows: record.rows ?? 24,
        status: "running",
        order: record.order,
        createdAt: record.createdAt,
        boxId: record.boxId
      });
      this.sessions.set(record.id, session);
      void this.reattach(session);
    }
  }

  /** This manager's share of `sessions.json`, for {@link composeIndexContributors}. */
  indexContributor(): SessionIndexContributor {
    return {
      records: () => this.records(),
      adopt: (records) => this.adopt(records),
      owns: (record) => typeof record.boxId === "string" && record.boxId.length > 0
    };
  }
}

/**
 * Several contributors to `sessions.json` as one (the host manager takes a
 * single one): records concatenated, each adopting the records it owns, the
 * pending-delete side table handed to those that keep one.
 */
export function composeIndexContributors(...contributors: SessionIndexContributor[]): SessionIndexContributor {
  return {
    records: () => contributors.flatMap((contributor) => contributor.records()),
    adopt: (records) => {
      for (const contributor of contributors) {
        const own = records.filter((record) => contributor.owns(record));
        if (own.length > 0) contributor.adopt(own);
      }
    },
    owns: (record) => contributors.some((contributor) => contributor.owns(record)),
    pendingThreadDeletes: () => contributors.flatMap((contributor) => contributor.pendingThreadDeletes?.() ?? []),
    adoptPendingThreadDeletes: (ids) => {
      for (const contributor of contributors) contributor.adoptPendingThreadDeletes?.(ids);
    }
  };
}

/**
 * One `ISessionManager` over the host backend and the box terminals. Every
 * surface keeps reading one session list; a create goes to the box when the
 * request names one or its project lives in one, else to the host backend,
 * which stays the only writer of `sessions.json` (the box terminals reach it
 * through {@link BoxTerminalManager.indexContributor}).
 */
export class BoxAwareSessionManager implements ISessionManager {
  readonly lifecycle = new EventEmitter();

  constructor(
    private readonly host: ISessionManager,
    private readonly box: BoxTerminalManager,
    private readonly entries: { get(id: string): RegistryEntry | undefined }
  ) {
    for (const event of ["created", "exited", "updated", "closed", "activity", "output"] as const) {
      this.host.lifecycle.on(event, (payload: unknown) => this.lifecycle.emit(event, payload));
      this.box.lifecycle.on(event, (payload: unknown) => this.lifecycle.emit(event, payload));
    }
    this.box.setPersist(() => this.host.persistIndexNow());
  }

  async create(req: CreateSessionRequest): Promise<SessionSummary> {
    const boxId = this.box.targetBox(req);
    if (boxId === null) return this.host.create(req);
    const order = this.list(req.projectPath ?? "").reduce((max, s) => Math.max(max, s.order), -1) + 1;
    return this.box.create(req, this.entries.get(req.refId), order, boxId);
  }

  list(projectPath?: string): SessionSummary[] {
    return [...this.host.list(projectPath), ...this.box.list(projectPath)].sort(
      (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)
    );
  }

  get(id: string): SessionSummary | undefined {
    return this.box.get(id) ?? this.host.get(id);
  }

  scrollback(id: string): Promise<string> {
    return this.box.has(id) ? this.box.scrollback(id) : this.host.scrollback(id);
  }

  buffer(id: string): string {
    return this.box.has(id) ? this.box.buffer(id) : this.host.buffer(id);
  }

  activity(id: string): SessionActivity | undefined {
    return this.box.has(id) ? this.box.activity(id) : this.host.activity(id);
  }

  agentEvent(id: string, req: AgentEventRequest): boolean {
    // A box terminal is a plain shell: no managed hooks report for it.
    return this.box.has(id) ? false : this.host.agentEvent(id, req);
  }

  input(id: string, data: string): void {
    if (this.box.has(id)) this.box.input(id, data);
    else this.host.input(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (this.box.has(id)) this.box.resize(id, cols, rows);
    else this.host.resize(id, cols, rows);
  }

  rename(id: string, title: string, opts?: { seed?: boolean }): SessionSummary | undefined {
    if (!this.box.has(id)) return this.host.rename(id, title, opts);
    const refId = this.box.get(id)?.refId ?? "";
    return this.box.rename(id, title, this.entries.get(refId)?.name ?? refId);
  }

  reorder(projectPath: string, ids: string[]): void {
    this.box.reorder(projectPath, ids);
    this.host.reorder(projectPath, ids);
  }

  close(id: string): boolean {
    return this.box.has(id) ? this.box.close(id) : this.host.close(id);
  }

  closeByProjectPrefix(prefix: string): void {
    this.box.closeByProjectPrefix(prefix);
    this.host.closeByProjectPrefix(prefix);
  }

  subscribe(id: string, onOutput: (data: string) => void, onExit: (code: number) => void): () => void {
    return this.box.has(id) ? this.box.subscribe(id, onOutput, onExit) : this.host.subscribe(id, onOutput, onExit);
  }

  shutdown(): void {
    this.box.shutdown();
    this.host.shutdown();
  }

  closeAll(): void {
    this.box.closeAll();
    this.host.closeAll();
  }

  /** Box records come back through the host's reattach (the composed index contributor). */
  reattach(): Promise<void> {
    return this.host.reattach();
  }

  liveAccountIds(): Set<string> {
    // Box terminals are plain shells: they hold no account (and box sessions never refresh).
    return this.host.liveAccountIds();
  }

  persistIndexNow(): void {
    this.host.persistIndexNow();
  }
}
