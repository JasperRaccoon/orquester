import type { CreateSessionRequest, SessionSummary } from "@orquester/api";
import { type SessionRecord, createDefaultSessionsConfig, parseSessionsConfig } from "@orquester/config";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { RegistryService } from "./registry";
import { Tmux, tmuxName } from "./tmux";

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
 * Owns every live session. Each session's command runs inside a DEDICATED tmux
 * server (fixed socket); the daemon talks to it through a thin `tmux attach`
 * PTY. Because the command lives in tmux (not as a child of node), it survives a
 * daemon restart — on boot we reconcile live tmux sessions against sessions.json
 * and re-create the attach PTYs. Open sessions for a project are its tabs.
 */
export class SessionManager {
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
    // Only per-session overrides go through `-e KEY=VAL` (which lands on the
    // `tmux new-session` argv, visible via `ps`). The tmux SERVER already
    // inherits the daemon's full process.env and passes it to the command, so we
    // must NOT spread `...process.env` here: that would leak the daemon's secrets
    // (ORQUESTER_HTTP_PASSWORD, agent API keys) onto the argv and would also
    // reject any multiline value (e.g. BASH_FUNC_* shell functions) at launch.
    const env = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ...entry.env
    } as Record<string, string>;

    this.tmux
      .newSession({ id, cols, rows, cwd, env, bin: entry.resolvedBin, args: entry.args ?? [] })
      .then(() => this.attach(session))
      .catch((error) => {
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
    const pty = spawn("tmux", this.tmux.attachArgs(id), {
      name: "xterm-256color",
      cwd: session.summary.cwd,
      cols: session.summary.cols,
      rows: session.summary.rows,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>
    });
    session.pty = pty;

    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.emitter.emit("output", data);
    });
    pty.onExit(({ exitCode }) => {
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
   */
  async reattach(): Promise<void> {
    const live = new Set(await this.tmux.listSessions());
    const index = await this.readIndex();
    await this.tmux.setWindowSizeLatest();

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

    // Reap orphan tmux sessions (alive but unknown to the index).
    for (const id of live) {
      if (!known.has(id)) {
        void this.tmux.killSession(id);
      }
    }

    await this.persistIndex();
  }

  /** Map a live session to its persisted record shape. */
  private recordOf(session: Session): SessionRecord {
    const { id, title, order, projectPath, refId, kind, cwd, createdAt } = session.summary;
    return { id, title, order, projectPath, refId, kind, cwd, createdAt };
  }

  /** Read-with-fallback (mirrors readRemotesFile in index.ts). */
  private async readIndex() {
    try {
      return parseSessionsConfig(JSON.parse(await readFile(this.indexPath, "utf8")));
    } catch {
      return createDefaultSessionsConfig();
    }
  }

  /** Best-effort persist of running sessions; never throws (logs and moves on). */
  private async persistIndex(): Promise<void> {
    const sessions = [...this.sessions.values()]
      .filter((s) => s.summary.status === "running")
      .map((s) => this.recordOf(s));
    try {
      await mkdir(dirname(this.indexPath), { recursive: true });
      await writeFile(this.indexPath, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, "utf8");
    } catch (error) {
      console.error("Failed to persist sessions index", error);
    }
  }
}
