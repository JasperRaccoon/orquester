import type { AgentEventRequest, CreateSessionRequest, RegistryEntry, SessionActivity, SessionSummary } from "@orquester/api";
import { type SessionRecord, type SessionsConfig, createDefaultSessionsConfig, parseSessionsConfig } from "@orquester/config";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { RegistryService } from "./registry";
import {
  Tmux,
  sessionCommandShell,
  sessionEnvBase,
  sessionEnvCommand,
  sessionPath,
  tmuxAvailable,
  tmuxName,
  tmuxVersionOk
} from "./tmux";
import { renderText } from "./mcp/text.ts";
import { ActivityTracker, type ActivityCause } from "./ansi-activity.ts";
import { classifyAgentEvent } from "./agent-status.ts";

/**
 * Small live ring kept only for HOT replay between a session's creation and the
 * first client connect. The durable scrollback source of truth is tmux
 * capture-pane (survives daemon restarts); this ring does not.
 */
const MAX_BUFFER = 256 * 1024;

interface Session {
  summary: SessionSummary;
  /** Streaming PTY: `tmux attach -t orq-<id>`. Null once exited. */
  pty: IPty | null;
  buffer: string;
  tracker: ActivityTracker;
  emitter: EventEmitter;
}

export class SessionError extends Error {}

/**
 * The session backend contract the daemon (index.ts) talks to. Two
 * implementations exist: {@link SessionManager} (tmux-backed, survives a daemon
 * restart) and {@link LocalSessionManager} (direct node-pty, used where tmux is
 * unavailable — Windows, stock macOS). They are interchangeable from the
 * daemon's point of view; only persistence/reattach differs. `reattach` and
 * `shutdown` are still present on the local backend (they just don't persist).
 */
export interface ISessionManager {
  /** Emits "created" | "exited" | "updated" (SessionSummary), "closed" ({ id }), and "activity" ({ id, activity, cause, hasHookSource, kind }). */
  readonly lifecycle: EventEmitter;
  create(req: CreateSessionRequest): Promise<SessionSummary>;
  list(projectPath?: string): SessionSummary[];
  get(id: string): SessionSummary | undefined;
  /** Durable (tmux) or hot-ring (local) scrollback for a (re)connecting client. */
  scrollback(id: string): Promise<string>;
  /** Clean (no-ANSI) rendered text: current screen + last `lines` of scrollback. */
  captureText(id: string, opts?: { lines?: number }): Promise<string>;
  /** Synchronous hot-ring snapshot (kept for callers that can't await). */
  buffer(id: string): string;
  activity(id: string): SessionActivity | undefined;
  /** Apply a managed-hook event to a session's tracker. False = unknown session. */
  agentEvent(id: string, req: AgentEventRequest): boolean;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  rename(id: string, title: string): SessionSummary | undefined;
  reorder(projectPath: string, ids: string[]): void;
  close(id: string): boolean;
  /** Close every session whose project is `prefix` (exact) or under it (`prefix + sep`). */
  closeByProjectPrefix(prefix: string): void;
  subscribe(id: string, onOutput: (data: string) => void, onExit: (code: number) => void): () => void;
  /** Daemon shutdown: detach (tmux) or terminate (local) without forgetting state. */
  shutdown(): void;
  /** Kill everything (sessions included). Test/teardown helper. */
  closeAll(): void;
  /** Reattach to surviving sessions on boot (no-op for the local backend). */
  reattach(): Promise<void>;
  /** Account ids currently in use by a running session (for the idle-account refresher). */
  liveAccountIds(): Set<string>;
}

/**
 * Optional hook consulted at session-create time for extra env vars (and force-fail).
 * Return null/undefined to leave the launch alone. Throw SessionError to reject create.
 */
export type ResolveSessionExtraEnv = (
  entry: RegistryEntry,
  accountId?: string
) =>
  | Promise<{ env: Record<string, string>; unset?: string[] } | null>
  | { env: Record<string, string>; unset?: string[] } | null;

export interface SessionManagerOptions {
  resolveExtraEnv?: ResolveSessionExtraEnv;
  /** Absolute path to the daemon's unix socket, injected into agent sessions for hook delivery. */
  daemonSockPath?: string;
  /** Fire-and-forget notification that an agent session is launching (hook installers). */
  onAgentLaunch?: (entry: RegistryEntry, launchEnv: Record<string, string>) => void;
}

/**
 * Pick the session backend for this host: the tmux-backed manager only when a
 * `tmux` binary is on PATH AND it is >= 3.2 (the VPS, plus any Linux/macOS dev
 * box with a recent tmux), else the direct node-pty backend. This is what keeps
 * the desktop built-in daemon working on Windows and on a stock macOS without
 * Homebrew tmux — there every tmux invocation would ENOENT, so we never construct
 * the tmux backend at all. The version gate matters too: the tmux backend needs
 * `new-session -e KEY=VAL` and `window-size latest` (both 3.2+), so on an older
 * tmux (some Ubuntu LTS / Homebrew boxes ship 3.0/3.1) we must ALSO fall back —
 * otherwise every create would fail on the unknown `-e` flag and all terminals
 * would be unusable. Persistence/reattach (Phase 2's goal) only apply to the tmux
 * backend; the local fallback restores the prior, non-persistent direct-PTY
 * behavior.
 */
export function createSessionManager(
  registry: RegistryService,
  tmux: Tmux,
  indexPath: string,
  options: SessionManagerOptions = {}
): ISessionManager {
  if (tmuxAvailable() && tmuxVersionOk()) {
    console.log("sessions: tmux-backed backend (sessions persist across daemon restarts)");
    return new SessionManager(registry, tmux, indexPath, options);
  }
  console.log(
    "sessions: usable tmux (>= 3.2) not found on PATH — using direct node-pty backend " +
      "(sessions do NOT survive a daemon restart; install tmux >= 3.2 to enable persistence)"
  );
  return new LocalSessionManager(registry, options);
}

export function buildLaunchCommand(entry: RegistryEntry, opts: { tmux: boolean }): { bin: string; args: string[] } {
  const bin = entry.resolvedBin ?? "";
  const baseArgs = entry.args ?? [];

  if (entry.kind === "shell") {
    return {
      bin,
      args: opts.tmux && !baseArgs.includes("-l") && !baseArgs.includes("--login") ? [...baseArgs, "-l"] : baseArgs
    };
  }

  if (entry.launchViaShell) {
    const shell = sessionCommandShell();
    if (shell) {
      const commandFlag = basename(shell) === "bash" ? "-lc" : "-c";
      const envCommand = sessionEnvCommand();
      if (envCommand) {
        return {
          bin: envCommand,
          args: [`SHELL=${shell}`, shell, commandFlag, '"$@"', "orquester-launch", bin, ...baseArgs]
        };
      }
      return {
        bin: shell,
        args: [commandFlag, '"$@"', "orquester-launch", bin, ...baseArgs]
      };
    }
  }

  return { bin, args: baseArgs };
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function writeAddonEnvLaunchScript(
  launch: { bin: string; args: string[] },
  env: Record<string, string>,
  unset: string[] = []
): Promise<{ bin: string; args: string[]; cleanup: () => Promise<void> }> {
  const entries = Object.entries(env).filter(
    ([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !value.includes("\0")
  );
  const unsets = unset.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  if (entries.length === 0 && unsets.length === 0) {
    return { ...launch, cleanup: async () => undefined };
  }

  const shell = sessionCommandShell();
  if (!shell) {
    throw new SessionError("No usable shell found to prepare addon launch environment.");
  }

  const dir = await mkdtemp(join(tmpdir(), "orquester-launch-"));
  const script = join(dir, "launch.sh");
  const exports = entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  const unsetLines = unsets.map((key) => `unset ${key}`);
  const command = [shellQuote(launch.bin), ...launch.args.map(shellQuote)].join(" ");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      'script_dir=${0%/*}',
      'rm -f -- "$0"',
      'rmdir "$script_dir" 2>/dev/null || true',
      ...unsetLines,
      ...exports,
      `exec ${command}`,
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 }
  );
  return {
    bin: shell,
    args: [script],
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

/**
 * Owns every live session. Each session's command runs inside a DEDICATED tmux
 * server (fixed socket); the daemon talks to it through a thin `tmux attach`
 * PTY. Because the command lives in tmux (not as a child of node), it survives a
 * daemon restart — on boot we reconcile live tmux sessions against sessions.json
 * and re-create the attach PTYs. Open sessions for a project are its tabs.
 */
export class SessionManager implements ISessionManager {
  private sessions = new Map<string, Session>();
  /** Coalesces resize-driven index writes (≤ one per second) so the latest size persists. */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Emits "created" | "exited" | "updated" (SessionSummary), "closed" ({ id }), and "activity" ({ id, activity, cause, hasHookSource, kind }). */
  readonly lifecycle = new EventEmitter();

  constructor(
    private readonly registry: RegistryService,
    private readonly tmux: Tmux,
    /** <appdir>/daemon/sessions.json — the reattach index. */
    private readonly indexPath: string,
    private readonly options: SessionManagerOptions = {}
  ) {}

  async create(req: CreateSessionRequest): Promise<SessionSummary> {
    const entry = this.registry.get(req.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new SessionError(`Registry entry "${req.refId}" is not available.`);
    }

    let extraEnv: Record<string, string> = {};
    let unsetEnv: string[] = [];
    try {
      const resolved = await this.options.resolveExtraEnv?.(entry, req.accountId);
      if (resolved) {
        extraEnv = resolved.env;
        unsetEnv = resolved.unset ?? [];
      }
    } catch (error) {
      throw error instanceof SessionError
        ? error
        : new SessionError(error instanceof Error ? error.message : String(error));
    }

    const cols = req.cols && req.cols > 0 ? req.cols : 80;
    const rows = req.rows && req.rows > 0 ? req.rows : 24;
    const cwd = req.cwd || req.projectPath || homedir();
    const id = randomUUID();
    const projectPath = req.projectPath ?? "";
    // Append to the end of this project's tab strip.
    const maxOrder = [...this.sessions.values()]
      .filter((s) => s.summary.projectPath === projectPath)
      .reduce((max, s) => Math.max(max, s.summary.order), -1);

    const summary: SessionSummary = {
      id,
      kind: entry.kind,
      refId: entry.id,
      accountId: req.accountId,
      title: req.title || entry.name,
      projectPath,
      cwd,
      cols,
      rows,
      status: "running",
      order: maxOrder + 1,
      createdAt: new Date().toISOString()
    };

    const tracker = new ActivityTracker((activity, cause) => {
      this.lifecycle.emit("activity", {
        id,
        activity,
        cause,
        hasHookSource: tracker.hasHookSource,
        kind: summary.kind
      });
    });
    const session: Session = { summary, pty: null, buffer: "", tracker, emitter: new EventEmitter() };
    this.sessions.set(id, session);

    // 1) Spawn the command INSIDE tmux (detached), 2) attach a streaming PTY to
    // it. tmux owns the process group, so a daemon restart leaves it running.
    // The pane inherits the new-session CLIENT's environment (Tmux.run uses
    // sessionEnvBase() — the daemon's env minus ORQUESTER_* secrets — and sets
    // the session PATH there). Registry env is non-secret and can use tmux -e;
    // addon env may contain launch credentials, so the tmux backend injects it
    // through a private one-shot wrapper script instead of argv-visible -e.
    const env = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ...entry.env
    } as Record<string, string>;

    if (entry.kind === "agent") {
      env.ORQUESTER_SESSION_ID = id;
      if (this.options.daemonSockPath) {
        env.ORQUESTER_DAEMON_SOCK = this.options.daemonSockPath;
      }
      try {
        this.options.onAgentLaunch?.(entry, extraEnv);
      } catch {
        // hook installation is best-effort; never blocks a session launch
      }
    }

    // A bare shell launched via `tmux new-session -- bash` runs non-interactively
    // and exits immediately (status 1) — unlike LocalSessionManager's node-pty,
    // which gives the shell an interactive controlling terminal so bare `bash`
    // works. Launch shell-kind entries as LOGIN shells (`-l`, what a terminal
    // emulator does), so they behave as a real interactive terminal shell and
    // persist. Some agents (OpenCode on locked service users) also need to be
    // spawned as a child of a real shell, matching the path that works from a
    // Bash tab while preserving direct binary resolution/version checks.
    const baseLaunch = buildLaunchCommand(entry, { tmux: true });
    const wrapped = await writeAddonEnvLaunchScript(baseLaunch, extraEnv, unsetEnv);
    try {
      await this.tmux.newSession({ id, cols, rows, cwd, env, bin: wrapped.bin, args: wrapped.args });
    } catch (error) {
      this.sessions.delete(id);
      await wrapped.cleanup();
      throw new SessionError(error instanceof Error ? error.message : String(error));
    }
    const cleanupTimer = setTimeout(() => {
      void wrapped.cleanup();
    }, 30_000);
    cleanupTimer.unref?.();

    if (this.sessions.get(id) !== session) {
      void this.tmux.killSession(id);
      throw new SessionError("Session was closed before launch completed.");
    }
    this.attach(session);

    this.lifecycle.emit("created", this.withActivity(session));
    void this.persistIndex();
    return this.withActivity(session);
  }

  /**
   * Open (or re-open, after restart) the streaming `tmux attach` PTY for a
   * session and wire its data/exit into the session's emitter + lifecycle.
   */
  private attach(session: Session): void {
    const { id } = session.summary;
    // Strip the multiplexer vars before spawning: when the daemon itself was
    // launched from inside a tmux pane (the common dev case — `pnpm dev:daemon`
    // / `dev:daemon:bare` / `tsx cli.ts` run in tmux, exactly the Task 5
    // restart-survival path), `$TMUX`/`$TMUX_PANE` are in process.env and
    // node-pty passes them straight through to the child. tmux applies its
    // nesting guard to `attach` REGARDLESS of the `-S` socket and refuses
    // ("sessions should be nested with care, unset $TMUX to force"), so the
    // attach client would exit immediately and the tab would stay silently
    // blank/frozen. (`new-session -d` is not subject to the check, so the
    // headless session is created fine — making the failure invisible.)
    const cleanEnv = sessionEnvBase();
    const pty = spawn("tmux", this.tmux.attachArgs(id), {
      name: "xterm-256color",
      cwd: session.summary.cwd,
      cols: session.summary.cols,
      rows: session.summary.rows,
      env: { ...cleanEnv, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>
    });
    session.pty = pty;

    pty.onData((data) => {
      if (this.sessions.get(id) !== session) {
        return;
      }
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.tracker.noteOutput(data);
      session.emitter.emit("output", data);
      this.lifecycle.emit("output", { id, data });
    });
    pty.onExit(({ exitCode }) => {
      // If close()/closeAll() already removed (or replaced) this session, the PTY
      // death is the side effect of our own kill — not a real command exit. Bail
      // so we don't emit a trailing "exited" AFTER "closed" (which would
      // resurrect a ghost tab in the UI via upsertSession).
      if (this.sessions.get(id) !== session) {
        session.pty = null;
        return;
      }
      // The attach PTY exits when the tmux SESSION ends (command exited, default
      // remain-on-exit off) OR when the daemon dies and the master hangs up. We
      // disambiguate via tmux: if the session is still alive the daemon is just
      // shutting down — leave status running so the next boot reattaches.
      void this.tmux.hasSession(id).then((alive) => {
        if (alive) {
          session.pty = null;
          return;
        }
        session.summary.status = "exited";
        session.summary.exitCode = exitCode;
        session.pty = null;
        session.tracker.dispose();
        session.emitter.emit("exit", exitCode);
        this.lifecycle.emit("exited", this.withActivity(session));
        void this.persistIndex();
      });
    });
  }

  list(projectPath?: string): SessionSummary[] {
    const all = [...this.sessions.values()]
      .map((s) => this.withActivity(s))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    return projectPath === undefined ? all : all.filter((s) => s.projectPath === projectPath);
  }

  get(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    return session ? this.withActivity(session) : undefined;
  }

  liveAccountIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.summary.status === "running" && s.summary.accountId) ids.add(s.summary.accountId);
    }
    return ids;
  }

  /**
   * Durable scrollback for a (re)connecting client: tmux capture-pane (survives
   * restarts), falling back to the hot in-memory ring if tmux returns nothing
   * (e.g. an already-exited session whose tmux pane is gone).
   */
  async scrollback(id: string): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) {
      return "";
    }
    if (session.summary.status === "running") {
      const captured = await this.tmux.capturePane(id);
      if (captured) {
        return captured;
      }
    }
    return session.buffer;
  }

  /**
   * Clean rendered text for an agent read. A running tmux pane is captured WITH color
   * (captureAnsi) so renderText can drop faint ghost/placeholder text before stripping
   * ANSI; an exited pane is destroyed (remain-on-exit off) and a running capture can
   * transiently return "" — both fall back to the cleaned hot ring, bounded by `lines`.
   * Mirrors scrollback()'s !session guard so a close() mid-call returns "" not throws.
   */
  async captureText(id: string, opts?: { lines?: number }): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) {
      return "";
    }
    const captured =
      session.summary.status === "running"
        ? await this.tmux.captureAnsi(id, opts?.lines ?? 0)
        : "";
    return renderText(captured, session.buffer, opts);
  }

  /** Synchronous hot-ring snapshot (kept for callers that can't await). */
  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? "";
  }

  activity(id: string): SessionActivity | undefined {
    return this.sessions.get(id)?.tracker.snapshot();
  }

  agentEvent(id: string, req: AgentEventRequest): boolean {
    const session = this.sessions.get(id);
    if (!session || session.summary.status !== "running") {
      return false;
    }
    const cls = classifyAgentEvent(req.source, req.event, req.payload);
    if (cls !== null) {
      session.tracker.applyHookEvent(cls);
    }
    return true;
  }

  /**
   * Boundary summary carrying live activity for a running session (never
   * persisted). Exited sessions return the bare summary — no activity.
   */
  private withActivity(session: Session): SessionSummary {
    return session.summary.status === "running"
      ? { ...session.summary, activity: session.tracker.snapshot() }
      : { ...session.summary };
  }

  input(id: string, data: string): void {
    const session = this.sessions.get(id);
    session?.tracker.noteInput();
    session?.pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session?.pty && cols > 0 && rows > 0) {
      // Resizing the attach PTY drives tmux (window-size latest); tmux then
      // resizes the pane the command sees.
      session.pty.resize(cols, rows);
      if (session.summary.cols !== cols || session.summary.rows !== rows) {
        session.summary.cols = cols;
        session.summary.rows = rows;
        // Persist the new size (coalesced) so a daemon restart reattaches at it
        // rather than the 80×24 default — see reattach().
        this.schedulePersist();
      }
    }
  }

  /** Persist the index ≤ once/second; coalesces a burst of resizes into one write. */
  private schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistIndex();
    }, 1000);
  }

  /** Rename a session's tab; empty title reverts to the registry default name. */
  rename(id: string, title: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    const trimmed = title.trim();
    const fallback = this.registry.get(session.summary.refId)?.name ?? session.summary.refId;
    session.summary.title = trimmed || fallback;
    this.lifecycle.emit("updated", this.withActivity(session));
    void this.persistIndex();
    return this.withActivity(session);
  }

  /** Reassign per-project tab order from an ordered id list (unknown ids ignored). */
  reorder(projectPath: string, ids: string[]): void {
    let changed = false;
    ids.forEach((id, index) => {
      const session = this.sessions.get(id);
      if (session && session.summary.projectPath === projectPath && session.summary.order !== index) {
        session.summary.order = index;
        this.lifecycle.emit("updated", this.withActivity(session));
        changed = true;
      }
    });
    if (changed) {
      void this.persistIndex();
    }
  }

  /** Kill the tmux session (if running) and forget it. Returns false if unknown. */
  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    try {
      session.pty?.kill();
    } catch {
      /* attach client already gone */
    }
    // Kill the tmux session too — otherwise the command keeps running headless
    // and would be re-adopted on the next boot.
    void this.tmux.killSession(id);
    session.tracker.dispose();
    this.sessions.delete(id);
    this.lifecycle.emit("closed", { id });
    void this.persistIndex();
    return true;
  }

  /**
   * Close every session whose project is `prefix` (exact, e.g. delete-project)
   * or lives under it (`prefix + sep`, e.g. delete-workspace). Reuses close(),
   * so each emits "closed" (clients drop the tab).
   */
  closeByProjectPrefix(prefix: string): void {
    for (const [id, session] of [...this.sessions]) {
      const project = session.summary.projectPath;
      if (project === prefix || project.startsWith(prefix + sep)) {
        this.close(id);
      }
    }
  }

  /** Stream a session's output/exit to one client. Returns an unsubscribe fn. */
  subscribe(
    id: string,
    onOutput: (data: string) => void,
    onExit: (code: number) => void
  ): () => void {
    const session = this.sessions.get(id);
    if (!session) {
      return () => undefined;
    }
    session.emitter.on("output", onOutput);
    session.emitter.on("exit", onExit);
    return () => {
      session.emitter.off("output", onOutput);
      session.emitter.off("exit", onExit);
    };
  }

  /**
   * Detach every attach PTY WITHOUT killing the tmux sessions (daemon shutdown).
   * The commands keep running in tmux; the next boot reattaches. Use close()/
   * closeByProjectPrefix to actually terminate a session.
   */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      try {
        session.pty?.kill();
      } catch {
        /* already gone */
      }
      session.pty = null;
    }
  }

  /** Kill everything (tmux sessions included). Test/teardown helper. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
  }

  /**
   * Reattach to surviving tmux sessions on boot. Reconciles live `orq-*`
   * sessions against the on-disk index:
   *   - in index AND alive   → re-create the attach PTY (resume the tab)
   *   - in index NOT alive    → drop (its command exited while we were down)
   *   - alive NOT in index    → reap the orphan (default cleanup policy)
   *
   * If the index could not be read (corrupt/unreadable, not merely absent) we
   * have no trustworthy "known" set, so we SKIP the orphan-reap pass entirely —
   * a single bad sessions.json must never destroy every persisted session, which
   * is the exact failure this phase exists to prevent.
   */
  async reattach(): Promise<void> {
    const live = new Set(await this.tmux.listSessions());
    const { loaded: indexLoaded, config: index } = await this.readIndex();
    // Fallback sizes for records that predate persisted cols/rows (read before
    // we attach any client, so the windows still hold their pre-restart size).
    const liveSizes = await this.tmux.windowSizes();
    await this.tmux.setWindowSizeLatest();
    // The server's global env is captured from whoever first started it; a
    // pre-sessionEnvBase() daemon seeded it with ORQUESTER_* secrets, and a new
    // session copies the global env — so scrub it when reattaching to a
    // surviving server (new panes then never inherit the leaked credentials).
    await this.tmux.scrubGlobalSecrets();

    const known = new Set<string>();
    for (const record of index.sessions) {
      known.add(record.id);
      if (!live.has(record.id)) {
        continue; // command exited while the daemon was down → forget it.
      }
      const summary: SessionSummary = {
        id: record.id,
        kind: record.kind,
        refId: record.refId,
        title: record.title,
        projectPath: record.projectPath,
        cwd: record.cwd,
        // Restore the persisted size so the reattached PTY (and tmux window via
        // window-size latest) match what the agent last drew at. Records from
        // before cols/rows were persisted fall back to the live tmux window size
        // (the window survived the restart), and only to 80×24 if even that is
        // gone. Any imprecision self-heals the first time the tab is viewed (the
        // client re-sends a resize, which schedulePersist() then saves).
        cols: record.cols ?? liveSizes.get(record.id)?.cols ?? 80,
        rows: record.rows ?? liveSizes.get(record.id)?.rows ?? 24,
        status: "running",
        order: record.order,
        createdAt: record.createdAt
      };
      const tracker = new ActivityTracker((activity, cause) => {
        this.lifecycle.emit("activity", {
          id: record.id,
          activity,
          cause,
          hasHookSource: tracker.hasHookSource,
          kind: summary.kind
        });
      });
      const session: Session = { summary, pty: null, buffer: "", tracker, emitter: new EventEmitter() };
      this.sessions.set(record.id, session);
      this.attach(session);
    }

    // Reap orphan tmux sessions (alive but unknown to the index) — but only when
    // the index was read successfully. With an unreadable index every live
    // session looks "unknown", so reaping would wipe them all; stay hands-off.
    if (indexLoaded) {
      for (const id of live) {
        if (!known.has(id)) {
          void this.tmux.killSession(id);
        }
      }
    }

    await this.persistIndex();
  }

  /** Map a live session to its persisted record shape. */
  private recordOf(session: Session): SessionRecord {
    const { id, title, order, projectPath, refId, kind, cwd, createdAt, cols, rows } = session.summary;
    return { id, title, order, projectPath, refId, kind, cwd, createdAt, cols, rows };
  }

  /**
   * Read the reattach index, distinguishing "file is absent/empty" (clean — the
   * daemon has never persisted, treat as no known sessions) from "file exists
   * but is unreadable/corrupt" (UNRELIABLE — we must not trust an empty result,
   * or reattach() would reap every surviving session as an orphan). Returns
   * `loaded: false` on the latter so the caller can stay conservative.
   */
  private async readIndex(): Promise<{ loaded: boolean; config: SessionsConfig }> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // No index yet (first run / cleared) — genuinely no known sessions.
        return { loaded: true, config: createDefaultSessionsConfig() };
      }
      // Exists but unreadable (permissions, I/O error): do NOT assume empty.
      console.error("Failed to read sessions index; skipping orphan reap", error);
      return { loaded: false, config: createDefaultSessionsConfig() };
    }
    try {
      return { loaded: true, config: parseSessionsConfig(JSON.parse(raw)) };
    } catch (error) {
      // Corrupt/partial JSON (e.g. an interrupted write): same caution as above.
      console.error("Failed to parse sessions index; skipping orphan reap", error);
      return { loaded: false, config: createDefaultSessionsConfig() };
    }
  }

  /**
   * Best-effort persist of running sessions; never throws (logs and moves on).
   * Writes atomically (tmp file + rename) so an interrupted or concurrent write
   * can never leave a half-written/corrupt sessions.json — readIndex() would
   * otherwise see truncated JSON and reattach() would refuse to reap orphans.
   */
  private async persistIndex(): Promise<void> {
    const sessions = [...this.sessions.values()]
      .filter((s) => s.summary.status === "running")
      .map((s) => this.recordOf(s));
    const tmpPath = `${this.indexPath}.tmp`;
    try {
      await mkdir(dirname(this.indexPath), { recursive: true });
      await writeFile(tmpPath, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, "utf8");
      await rename(tmpPath, this.indexPath);
    } catch (error) {
      console.error("Failed to persist sessions index", error);
    }
  }
}

/**
 * Direct node-pty backend used where tmux is unavailable (Windows, stock macOS
 * without Homebrew tmux). Each session's command is a CHILD of the daemon
 * process — so, unlike {@link SessionManager}, these sessions do NOT survive a
 * daemon restart (Phase 2 persistence requires tmux). This is the prior,
 * pre-tmux behavior, preserved so the desktop built-in daemon keeps working on
 * hosts with no tmux. Scrollback comes from the in-memory ring; reattach is a
 * no-op (there is nothing to reattach to). The public surface is identical to
 * the tmux backend so the daemon can use either interchangeably.
 */
export class LocalSessionManager implements ISessionManager {
  private sessions = new Map<string, Session>();
  /** Emits "created" | "exited" | "updated" (SessionSummary), "closed" ({ id }), and "activity" ({ id, activity, cause, hasHookSource, kind }). */
  readonly lifecycle = new EventEmitter();

  constructor(
    private readonly registry: RegistryService,
    private readonly options: SessionManagerOptions = {}
  ) {}

  async create(req: CreateSessionRequest): Promise<SessionSummary> {
    const entry = this.registry.get(req.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new SessionError(`Registry entry "${req.refId}" is not available.`);
    }

    let extraEnv: Record<string, string> = {};
    let unsetEnv: string[] = [];
    try {
      const resolved = await this.options.resolveExtraEnv?.(entry, req.accountId);
      if (resolved) {
        extraEnv = resolved.env;
        unsetEnv = resolved.unset ?? [];
      }
    } catch (error) {
      throw error instanceof SessionError
        ? error
        : new SessionError(error instanceof Error ? error.message : String(error));
    }

    const cols = req.cols && req.cols > 0 ? req.cols : 80;
    const rows = req.rows && req.rows > 0 ? req.rows : 24;
    const cwd = req.cwd || req.projectPath || homedir();
    const id = randomUUID();
    const projectPath = req.projectPath ?? "";
    // Append to the end of this project's tab strip.
    const maxOrder = [...this.sessions.values()]
      .filter((s) => s.summary.projectPath === projectPath)
      .reduce((max, s) => Math.max(max, s.summary.order), -1);

    const launch = buildLaunchCommand(entry, { tmux: false });
    const env = {
      ...sessionEnvBase(),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PATH: sessionPath(),
      ...entry.env,
      ...extraEnv
    } as Record<string, string>;
    // The direct node-pty backend has no launch wrapper, so honor `unset` by
    // removing those keys from the child's environment before spawning.
    for (const key of unsetEnv) delete env[key];

    if (entry.kind === "agent") {
      env.ORQUESTER_SESSION_ID = id;
      if (this.options.daemonSockPath) {
        env.ORQUESTER_DAEMON_SOCK = this.options.daemonSockPath;
      }
      try {
        this.options.onAgentLaunch?.(entry, extraEnv);
      } catch {
        // hook installation is best-effort; never blocks a session launch
      }
    }

    const pty = spawn(launch.bin, launch.args, {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
      env
    });

    const summary: SessionSummary = {
      id,
      kind: entry.kind,
      refId: entry.id,
      accountId: req.accountId,
      title: req.title || entry.name,
      projectPath,
      cwd,
      cols,
      rows,
      status: "running",
      order: maxOrder + 1,
      createdAt: new Date().toISOString()
    };

    const tracker = new ActivityTracker((activity, cause) => {
      this.lifecycle.emit("activity", {
        id,
        activity,
        cause,
        hasHookSource: tracker.hasHookSource,
        kind: summary.kind
      });
    });
    const session: Session = { summary, pty, buffer: "", tracker, emitter: new EventEmitter() };
    this.sessions.set(id, session);

    pty.onData((data) => {
      if (this.sessions.get(id) !== session) {
        return;
      }
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.tracker.noteOutput(data);
      session.emitter.emit("output", data);
      this.lifecycle.emit("output", { id, data });
    });
    pty.onExit(({ exitCode }) => {
      // If close()/closeAll() already removed (or replaced) this session, the PTY
      // death is the side effect of our own kill — not a real command exit. Bail
      // so we don't emit a trailing "exited" AFTER "closed" (which would
      // resurrect a ghost tab in the UI via upsertSession).
      if (this.sessions.get(id) !== session) {
        session.pty = null;
        return;
      }
      session.summary.status = "exited";
      session.summary.exitCode = exitCode;
      session.pty = null;
      session.tracker.dispose();
      session.emitter.emit("exit", exitCode);
      this.lifecycle.emit("exited", this.withActivity(session));
    });

    this.lifecycle.emit("created", this.withActivity(session));
    return this.withActivity(session);
  }

  list(projectPath?: string): SessionSummary[] {
    const all = [...this.sessions.values()]
      .map((s) => this.withActivity(s))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    return projectPath === undefined ? all : all.filter((s) => s.projectPath === projectPath);
  }

  get(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    return session ? this.withActivity(session) : undefined;
  }

  liveAccountIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.summary.status === "running" && s.summary.accountId) ids.add(s.summary.accountId);
    }
    return ids;
  }

  /** No durable store here; the hot in-memory ring is the only scrollback. */
  async scrollback(id: string): Promise<string> {
    return this.buffer(id);
  }

  /** No tmux here — always the ANSI-stripped hot ring (bounded by `lines`). */
  async captureText(id: string, opts?: { lines?: number }): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) {
      return "";
    }
    return renderText("", session.buffer, opts);
  }

  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? "";
  }

  activity(id: string): SessionActivity | undefined {
    return this.sessions.get(id)?.tracker.snapshot();
  }

  agentEvent(id: string, req: AgentEventRequest): boolean {
    const session = this.sessions.get(id);
    if (!session || session.summary.status !== "running") {
      return false;
    }
    const cls = classifyAgentEvent(req.source, req.event, req.payload);
    if (cls !== null) {
      session.tracker.applyHookEvent(cls);
    }
    return true;
  }

  /**
   * Boundary summary carrying live activity for a running session (never
   * persisted). Exited sessions return the bare summary — no activity.
   */
  private withActivity(session: Session): SessionSummary {
    return session.summary.status === "running"
      ? { ...session.summary, activity: session.tracker.snapshot() }
      : { ...session.summary };
  }

  input(id: string, data: string): void {
    const session = this.sessions.get(id);
    session?.tracker.noteInput();
    session?.pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session?.pty && cols > 0 && rows > 0) {
      session.pty.resize(cols, rows);
      session.summary.cols = cols;
      session.summary.rows = rows;
    }
  }

  /** Rename a session's tab; empty title reverts to the registry default name. */
  rename(id: string, title: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    const trimmed = title.trim();
    const fallback = this.registry.get(session.summary.refId)?.name ?? session.summary.refId;
    session.summary.title = trimmed || fallback;
    this.lifecycle.emit("updated", this.withActivity(session));
    return this.withActivity(session);
  }

  /** Reassign per-project tab order from an ordered id list (unknown ids ignored). */
  reorder(projectPath: string, ids: string[]): void {
    ids.forEach((id, index) => {
      const session = this.sessions.get(id);
      if (session && session.summary.projectPath === projectPath && session.summary.order !== index) {
        session.summary.order = index;
        this.lifecycle.emit("updated", this.withActivity(session));
      }
    });
  }

  /** Kill (if running) and forget a session. Returns false if unknown. */
  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    try {
      session.pty?.kill();
    } catch {
      /* already gone */
    }
    session.tracker.dispose();
    this.sessions.delete(id);
    this.lifecycle.emit("closed", { id });
    return true;
  }

  /**
   * Close every session whose project is `prefix` (exact, e.g. delete-project)
   * or lives under it (`prefix + sep`, e.g. delete-workspace). Reuses close(),
   * so each emits "closed" (clients drop the tab).
   */
  closeByProjectPrefix(prefix: string): void {
    for (const [id, session] of [...this.sessions]) {
      const project = session.summary.projectPath;
      if (project === prefix || project.startsWith(prefix + sep)) {
        this.close(id);
      }
    }
  }

  /** Stream a session's output/exit to one client. Returns an unsubscribe fn. */
  subscribe(
    id: string,
    onOutput: (data: string) => void,
    onExit: (code: number) => void
  ): () => void {
    const session = this.sessions.get(id);
    if (!session) {
      return () => undefined;
    }
    session.emitter.on("output", onOutput);
    session.emitter.on("exit", onExit);
    return () => {
      session.emitter.off("output", onOutput);
      session.emitter.off("exit", onExit);
    };
  }

  /**
   * Daemon shutdown. These PTYs are children of the daemon, so they die with it
   * regardless; kill them explicitly and forget so we leave nothing headless.
   * (There is no tmux server to detach from and reattach to here.)
   */
  shutdown(): void {
    this.closeAll();
  }

  /** Kill everything (daemon shutdown / teardown). */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
  }

  /** Nothing persists across a restart in this backend → nothing to reattach. */
  async reattach(): Promise<void> {
    /* no-op: direct PTYs do not outlive the daemon */
  }
}
