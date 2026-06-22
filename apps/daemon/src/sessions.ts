import type { CreateSessionRequest, SessionSummary } from "@orquester/api";
import { type SessionRecord, type SessionsConfig, createDefaultSessionsConfig, parseSessionsConfig } from "@orquester/config";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { RegistryService } from "./registry";
import { Tmux, sessionEnvBase, sessionPath, tmuxAvailable, tmuxName, tmuxVersionOk } from "./tmux";

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
  /** Emits "created" | "exited" | "updated" (SessionSummary) and "closed" ({ id }). */
  readonly lifecycle: EventEmitter;
  create(req: CreateSessionRequest): SessionSummary;
  list(projectPath?: string): SessionSummary[];
  get(id: string): SessionSummary | undefined;
  /** Durable (tmux) or hot-ring (local) scrollback for a (re)connecting client. */
  scrollback(id: string): Promise<string>;
  /** Synchronous hot-ring snapshot (kept for callers that can't await). */
  buffer(id: string): string;
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
  indexPath: string
): ISessionManager {
  if (tmuxAvailable() && tmuxVersionOk()) {
    console.log("sessions: tmux-backed backend (sessions persist across daemon restarts)");
    return new SessionManager(registry, tmux, indexPath);
  }
  console.log(
    "sessions: usable tmux (>= 3.2) not found on PATH — using direct node-pty backend " +
      "(sessions do NOT survive a daemon restart; install tmux >= 3.2 to enable persistence)"
  );
  return new LocalSessionManager(registry);
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
  /** Emits "created" | "exited" | "updated" (SessionSummary) and "closed" ({ id }). */
  readonly lifecycle = new EventEmitter();

  constructor(
    private readonly registry: RegistryService,
    private readonly tmux: Tmux,
    /** <appdir>/daemon/sessions.json — the reattach index. */
    private readonly indexPath: string
  ) {}

  create(req: CreateSessionRequest): SessionSummary {
    const entry = this.registry.get(req.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new SessionError(`Registry entry "${req.refId}" is not available.`);
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
      title: req.title || entry.name,
      projectPath,
      cwd,
      cols,
      rows,
      status: "running",
      order: maxOrder + 1,
      createdAt: new Date().toISOString()
    };

    const session: Session = { summary, pty: null, buffer: "", emitter: new EventEmitter() };
    this.sessions.set(id, session);

    // 1) Spawn the command INSIDE tmux (detached), 2) attach a streaming PTY to
    // it. tmux owns the process group, so a daemon restart leaves it running.
    // The pane inherits the new-session CLIENT's environment (Tmux.run uses
    // sessionEnvBase() — the daemon's env minus ORQUESTER_* secrets — and sets
    // the session PATH there); these `-e KEY=VAL` entries are only small
    // per-session overrides. We deliberately do NOT spread `...process.env` onto
    // `-e`: it lands on the `tmux new-session` argv (visible via `ps`), would
    // leak secrets there, and would reject any multiline value (e.g. BASH_FUNC_*
    // shell functions) at launch.
    const env = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ...entry.env
    } as Record<string, string>;

    // A bare shell launched via `tmux new-session -- bash` runs non-interactively
    // and exits immediately (status 1) — unlike LocalSessionManager's node-pty,
    // which gives the shell an interactive controlling terminal so bare `bash`
    // works. Launch shell-kind entries as LOGIN shells (`-l`, what a terminal
    // emulator does), so they behave as a real interactive terminal shell and
    // persist. Agents/IDEs and shells that already specify a login flag are left
    // as-is. (POSIX shells used on tmux-backend hosts — bash/zsh/sh/fish/nu — all
    // accept `-l`.)
    const baseArgs = entry.args ?? [];
    const args =
      entry.kind === "shell" && !baseArgs.includes("-l") && !baseArgs.includes("--login")
        ? [...baseArgs, "-l"]
        : baseArgs;

    this.tmux
      .newSession({ id, cols, rows, cwd, env, bin: entry.resolvedBin, args })
      .then(() => {
        // newSession is async (an execFile of `tmux new-session` takes several
        // ms) but create() has already returned. If close()/closeAll() ran in
        // that window it killed a tmux session that did NOT exist yet (silent
        // no-op) and dropped us from `this.sessions`. Now that the LIVE
        // orq-<id> session finally exists, kill it instead of attaching —
        // otherwise its command (possibly a `claude`/agent) keeps running
        // headless, invisible to the UI and sessions.json, until the next
        // daemon restart reaps it as an orphan. (LocalSessionManager spawns its
        // PTY synchronously in create(), so it never opens this window.)
        if (this.sessions.get(id) !== session) {
          void this.tmux.killSession(id);
          return;
        }
        this.attach(session);
      })
      .catch((error) => {
        // Same close()/closeAll() race as the .then branch: if that window
        // removed (or replaced) this session, it is already gone from
        // this.sessions and the UI emitted "closed". Bail before emitting a
        // trailing "exited" — otherwise upsertSession would resurrect a ghost
        // tab. (A failed new-session usually left no tmux session to kill.)
        if (this.sessions.get(id) !== session) {
          return;
        }
        // Failed to launch under tmux: surface as an immediate exit so the tab
        // resolves the same way a crashed PTY would.
        session.summary.status = "exited";
        session.summary.exitCode = 1;
        session.emitter.emit("output", `\r\n[orquester] failed to start session: ${String(error)}\r\n`);
        session.emitter.emit("exit", 1);
        this.lifecycle.emit("exited", { ...session.summary });
      });

    this.lifecycle.emit("created", { ...summary });
    void this.persistIndex();
    return { ...summary };
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
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.emitter.emit("output", data);
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
        session.emitter.emit("exit", exitCode);
        this.lifecycle.emit("exited", { ...session.summary });
        void this.persistIndex();
      });
    });
  }

  list(projectPath?: string): SessionSummary[] {
    const all = [...this.sessions.values()]
      .map((s) => ({ ...s.summary }))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    return projectPath === undefined ? all : all.filter((s) => s.projectPath === projectPath);
  }

  get(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.summary } : undefined;
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

  /** Synchronous hot-ring snapshot (kept for callers that can't await). */
  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? "";
  }

  input(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session?.pty && cols > 0 && rows > 0) {
      // Resizing the attach PTY drives tmux (window-size latest); tmux then
      // resizes the pane the command sees.
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
    this.lifecycle.emit("updated", { ...session.summary });
    void this.persistIndex();
    return { ...session.summary };
  }

  /** Reassign per-project tab order from an ordered id list (unknown ids ignored). */
  reorder(projectPath: string, ids: string[]): void {
    let changed = false;
    ids.forEach((id, index) => {
      const session = this.sessions.get(id);
      if (session && session.summary.projectPath === projectPath && session.summary.order !== index) {
        session.summary.order = index;
        this.lifecycle.emit("updated", { ...session.summary });
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
        cols: 80,
        rows: 24,
        status: "running",
        order: record.order,
        createdAt: record.createdAt
      };
      const session: Session = { summary, pty: null, buffer: "", emitter: new EventEmitter() };
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
    const { id, title, order, projectPath, refId, kind, cwd, createdAt } = session.summary;
    return { id, title, order, projectPath, refId, kind, cwd, createdAt };
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
  /** Emits "created" | "exited" | "updated" (SessionSummary) and "closed" ({ id }). */
  readonly lifecycle = new EventEmitter();

  constructor(private readonly registry: RegistryService) {}

  create(req: CreateSessionRequest): SessionSummary {
    const entry = this.registry.get(req.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new SessionError(`Registry entry "${req.refId}" is not available.`);
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

    const pty = spawn(entry.resolvedBin, entry.args ?? [], {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
      env: { ...sessionEnvBase(), TERM: "xterm-256color", COLORTERM: "truecolor", PATH: sessionPath(), ...entry.env } as Record<string, string>
    });

    const summary: SessionSummary = {
      id,
      kind: entry.kind,
      refId: entry.id,
      title: req.title || entry.name,
      projectPath,
      cwd,
      cols,
      rows,
      status: "running",
      order: maxOrder + 1,
      createdAt: new Date().toISOString()
    };

    const session: Session = { summary, pty, buffer: "", emitter: new EventEmitter() };
    this.sessions.set(id, session);

    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.emitter.emit("output", data);
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
      session.emitter.emit("exit", exitCode);
      this.lifecycle.emit("exited", { ...session.summary });
    });

    this.lifecycle.emit("created", { ...summary });
    return { ...summary };
  }

  list(projectPath?: string): SessionSummary[] {
    const all = [...this.sessions.values()]
      .map((s) => ({ ...s.summary }))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    return projectPath === undefined ? all : all.filter((s) => s.projectPath === projectPath);
  }

  get(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.summary } : undefined;
  }

  /** No durable store here; the hot in-memory ring is the only scrollback. */
  async scrollback(id: string): Promise<string> {
    return this.buffer(id);
  }

  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? "";
  }

  input(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data);
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
    this.lifecycle.emit("updated", { ...session.summary });
    return { ...session.summary };
  }

  /** Reassign per-project tab order from an ordered id list (unknown ids ignored). */
  reorder(projectPath: string, ids: string[]): void {
    ids.forEach((id, index) => {
      const session = this.sessions.get(id);
      if (session && session.summary.projectPath === projectPath && session.summary.order !== index) {
        session.summary.order = index;
        this.lifecycle.emit("updated", { ...session.summary });
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
