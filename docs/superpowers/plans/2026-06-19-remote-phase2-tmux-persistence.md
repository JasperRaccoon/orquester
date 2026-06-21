# Remote VPS — Phase 2: tmux-backed session persistence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the daemon's `SessionManager` so every terminal/agent PTY is owned by a **dedicated tmux server** that outlives the daemon process. Sessions then survive a daemon restart (and reconnect with scrollback intact); the external behavior — create / input / resize / output / lifecycle events / rename / reorder — is unchanged.

**Architecture:** A single long-lived tmux server is addressed by a **fixed socket** under the appdir (`<appdir>/daemon/tmux.sock`), used on _every_ tmux invocation. `create()` runs `tmux new-session -d -s orq-<id> …` (the command runs **inside** tmux, parented to the tmux server) and then opens a thin streaming PTY via `node-pty` that runs `tmux attach -t orq-<id>`. All existing downstream paths (`input`/`resize`/`output`/`subscribe`/broadcaster) keep talking to that attach-PTY exactly as before. A small on-disk index `<appdir>/daemon/sessions.json` records each session's metadata so the daemon can **reattach on boot**: it lists live `orq-*` tmux sessions, re-creates attach-PTYs for the survivors, and marks index entries with no live tmux session as exited. Scrollback comes from `tmux capture-pane` instead of the lost in-memory ring.

**Tech Stack:** TypeScript, Fastify (daemon), node's `events` + `node:child_process` (`execFile`), `node-pty`, Zod (config), tmux 3.2+ (installed in Phase 0).

## Global Constraints

- **tmux 3.2+ is assumed** — Phase 0 installs it (`apt-get install tmux`; `tmux -V` ≥ 3.2). The `-e KEY=VAL` flag on `new-session` and `set-option -g window-size latest` both require 3.2+.
- **All tmux invocations go through `node:child_process` `execFile` with an args array — never a shell string.** Session ids, cwds and env values are derived from client input; a shell string would be injectable. (Contrast `registry.ts`'s `run()` which uses `exec(command)` for static, trusted install/update strings — do **not** reuse it here.)
- **Every tmux call carries `-S <socket>`** so we never touch the user's default tmux server and always have a stable reattach point.
- **No systemd changes in this phase.** `KillMode=process` and `PrivateTmp=false` are already in Phase 0's `deploy/orquester.service` (§0.4 of the spec) and are what make reattach work — this plan only _references_ them and verifies the survival behavior. (See "Notes for the implementer".)
- **Default cleanup policy:** on boot, stale `orq-*` tmux sessions that have **no** matching `sessions.json` entry are **killed** (orphan reaping). State this in code comments.
- The streaming PTY's downstream contract is unchanged: `input(id, data)` → `pty.write`, `resize(id, cols, rows)` → `pty.resize`, output via `session.emitter`, lifecycle via `this.lifecycle` (`created`/`exited`/`closed`/`updated`). The Fastify routes, the `/ws` handler, and the broadcaster are **not** modified by this phase.
- Persist the index on **create / rename / reorder / close** (mirroring `remotes.json`'s read-with-fallback + `writeJsonFile` style). Writes are best-effort fire-and-forget (a failed write must never crash a session op).
- Verification is `pnpm check` (typecheck) + curl against a running daemon + a concrete restart-survival check + a `tmux -S … ls` inspection. **The repo has no test runner — do not add one.**
- Match existing code style (comment density, naming, `private readonly` fields, `[...map.values()]` spreads).

### Auth bearer for the curl checks (read once)

- **Dev (local):** `pnpm dev:daemon` runs on `127.0.0.1:47831` with appdir `./.stage`. The stage password is `123456`; its bcrypt hash (the bearer) is
  `$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe`.
- **Post-Phase-1** the bearer becomes `base64("mapacho:" + passwordHash)` (e.g. `TOKEN=$(printf 'mapacho:%s' "$HASH" | base64 | tr -d '\n')`). **If Phase 1 is not yet applied, use the bare `passwordHash`** as above. Each curl block below defines `TOKEN` once at the top — set it to whichever form matches your deployment.
- **Important about `tsx watch`:** `pnpm dev:daemon` hot-reloads on file save, which is fine for the per-task curl checks. But the **restart-survival** check (Task 5) needs a real process kill+restart, and `tsx watch` would re-exec inside the same shell. For that one check, run the daemon via `pnpm dev:daemon:bare` (no `--appdir`, no watch) **or** point a one-off `tsx apps/daemon/src/cli.ts --appdir ./.stage` at the stage dir, then Ctrl-C and relaunch. On the VPS the equivalent is `systemctl restart orquester`.

---

### Task 1: Config — tmux socket + sessions-index paths

**Files:**
- Modify: `packages/config/src/index.ts` (path helpers near `defaultSocketPath`, ~line 91-97)

**Interfaces:**
- Produces: `tmuxSocketPath(baseDir): string` → `<baseDir>/daemon/tmux.sock`; `sessionsIndexPath(baseDir): string` → `<baseDir>/daemon/sessions.json`. Both live under `daemonConfigDir` (the appdir's `daemon/` dir), beside `daemon.sock`/`daemon.json`.

- [ ] **Step 1: Add the two path helpers** — insert immediately after `defaultSocketPath` (~line 97), before `localDateStamp`:

```ts
/**
 * Unix socket of the dedicated tmux server that owns session PTYs. Lives beside
 * the daemon socket under <appdir>/daemon so it inherits the same perms/backup
 * and (per Phase 0's PrivateTmp=false) is reachable across daemon restarts.
 */
export function tmuxSocketPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "tmux.sock");
}

/** On-disk index of sessions (for reattach on boot); see SessionManager. */
export function sessionsIndexPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "sessions.json");
}
```

(`tmux.sock` is a path, not a real file we create — tmux creates it on first `new-session`. We only need the path string.)

- [ ] **Step 2: Add the persisted-index schema** — mirror `remotesConfigSchema` (~line 249-262). Insert after the remotes block:

```ts
// sessions.json — the daemon's index of live tmux-backed sessions, used to
// reattach PTYs after a restart. The tmux server is the source of truth for
// "is the command still running?"; this file remembers tab metadata (title /
// order / project) that tmux doesn't track.

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  order: z.number().int(),
  projectPath: z.string(),
  refId: z.string(),
  kind: z.enum(["shell", "agent", "ide", "file-explorer", "browser"]),
  cwd: z.string(),
  createdAt: z.string()
});

export const sessionsConfigSchema = z.object({
  version: z.literal(1).default(1),
  sessions: z.array(sessionRecordSchema).default([])
});

export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionsConfig = z.infer<typeof sessionsConfigSchema>;

export function createDefaultSessionsConfig(): SessionsConfig {
  return sessionsConfigSchema.parse({ sessions: [] });
}

export function parseSessionsConfig(value: unknown): SessionsConfig {
  return sessionsConfigSchema.parse(value);
}
```

(The `kind` enum mirrors `RegistryKind` in `@orquester/api`; config can't import the api package, so it's restated — same pattern the api/registry split already uses.)

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS. This task only adds exports; nothing consumes them yet.

- [ ] **Step 4: Commit**

```bash
git add packages/config/src/index.ts
git commit -m "feat(config): tmux socket + sessions.json index path/schema helpers"
```

---

### Task 2: tmux helper module

**Files:**
- Create: `apps/daemon/src/tmux.ts`

**Interfaces:**
- Produces: a `Tmux` class bound to one socket, exposing `newSession`, `attachArgs`, `capturePane`, `hasSession`, `listSessions`, `setWindowSizeLatest`, `killSession`. Every method shells out via `execFile` with `-S <socket>` prepended. Consumed by `SessionManager` (Task 3).

- [ ] **Step 1: Create the file** with the complete contents:

```ts
import { execFile } from "node:child_process";

/** Prefix for every orquester-owned tmux session (`orq-<uuid>`). */
export const TMUX_SESSION_PREFIX = "orq-";

/** Derive the tmux session name from a session id. */
export function tmuxName(id: string): string {
  return `${TMUX_SESSION_PREFIX}${id}`;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Thin wrapper over a dedicated tmux server addressed by a fixed `-S <socket>`.
 * All calls use execFile with an args array (never a shell string) because
 * session ids, cwds and env values originate from client input.
 */
export class Tmux {
  constructor(private readonly socket: string) {}

  /** Run `tmux -S <socket> <args...>`; never rejects (returns the exit code). */
  private run(args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        "tmux",
        ["-S", this.socket, ...args],
        { maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: number }) | null;
          const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        }
      );
    });
  }

  /**
   * Create a detached session that runs `bin args...` inside tmux. `-x/-y` seed
   * the pane size; `window-size latest` (set once on the server) then lets the
   * attaching client drive resizes. Env is passed per-session via `-e KEY=VAL`.
   */
  async newSession(opts: {
    id: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
    bin: string;
    args: string[];
  }): Promise<void> {
    const envArgs = Object.entries(opts.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const result = await this.run([
      "new-session",
      "-d",
      "-s",
      tmuxName(opts.id),
      "-x",
      String(opts.cols),
      "-y",
      String(opts.rows),
      "-c",
      opts.cwd,
      ...envArgs,
      "--",
      opts.bin,
      ...opts.args
    ]);
    if (result.code !== 0) {
      throw new Error(`tmux new-session failed (${result.code}): ${result.stderr.trim()}`);
    }
  }

  /** The argv for a streaming attach PTY: `tmux -S <socket> attach -t orq-<id>`. */
  attachArgs(id: string): string[] {
    return ["-S", this.socket, "attach", "-t", tmuxName(id)];
  }

  /** Full visible + scrollback history of a session's pane (empty if gone). */
  async capturePane(id: string): Promise<string> {
    // -p print to stdout, -e keep escape sequences (colors), -S - from the very
    // start of history, -J join wrapped lines back into logical lines.
    const result = await this.run(["capture-pane", "-p", "-e", "-J", "-S", "-", "-t", tmuxName(id)]);
    return result.code === 0 ? result.stdout : "";
  }

  /** True if a live session named orq-<id> exists on this server. */
  async hasSession(id: string): Promise<boolean> {
    const result = await this.run(["has-session", "-t", tmuxName(id)]);
    return result.code === 0;
  }

  /** Ids (the `<id>` part of `orq-<id>`) of every live orquester session. */
  async listSessions(): Promise<string[]> {
    const result = await this.run(["list-sessions", "-F", "#{session_name}"]);
    if (result.code !== 0) {
      // No server running yet (nothing to reattach) → empty list.
      return [];
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.startsWith(TMUX_SESSION_PREFIX))
      .map((name) => name.slice(TMUX_SESSION_PREFIX.length));
  }

  /** Make every session follow the most-recent attached client's size. */
  async setWindowSizeLatest(): Promise<void> {
    await this.run(["set-option", "-g", "window-size", "latest"]);
  }

  /** Kill a session (used to reap orphans / forget on close). */
  async killSession(id: string): Promise<void> {
    await this.run(["kill-session", "-t", tmuxName(id)]);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. The module is standalone; nothing imports it yet.

- [ ] **Step 3: Sanity-check the helper against a real tmux** (proves the args array is correct before wiring it in):

```bash
SOCK=/tmp/orq-tmux-probe.sock
tmux -S "$SOCK" new-session -d -s orq-probe -x 100 -y 30 -c /tmp -e FOO=bar -- bash -lc 'echo hello-$FOO; sleep 30'
tmux -S "$SOCK" list-sessions -F '#{session_name}'              # expect: orq-probe
sleep 0.3
tmux -S "$SOCK" capture-pane -p -e -J -S - -t orq-probe         # expect a line: hello-bar
tmux -S "$SOCK" kill-server
```
Expected: `list-sessions` prints `orq-probe`; `capture-pane` shows `hello-bar`. (This mirrors `Tmux.newSession`/`listSessions`/`capturePane` exactly.)

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/tmux.ts
git commit -m "feat(daemon): Tmux helper (execFile args array, fixed -S socket)"
```

---

### Task 3: `SessionManager` — tmux-backed create/close + index persistence

**Files:**
- Modify: `apps/daemon/src/sessions.ts`

**Interfaces:**
- Consumes: `Tmux` (Task 2); `tmuxName` (Task 2); `SessionRecord`/`SessionsConfig` + `parseSessionsConfig`/`createDefaultSessionsConfig` (Task 1).
- Produces: a `SessionManager` whose constructor takes `(registry, tmux, indexPath)`; `create()` launches via tmux + attach-PTY; `close()` kills the tmux session; an internal `persistIndex()` + `recordOf()`; `rename`/`reorder` re-persist. **Public method signatures are otherwise unchanged.**

- [ ] **Step 1: Rewrite the file** with the complete contents (changes are isolated to constructor, `create`, `close`, plus three new private helpers and the index plumbing; `list`/`get`/`buffer`/`input`/`resize`/`subscribe`/`closeAll` are preserved):

```ts
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
    const env = {
      ...process.env,
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
```

> **Note on `tmuxName` import:** it is imported for symmetry/use in follow-on work; if `pnpm check` flags it as unused under the repo's `noUnusedLocals`, drop it from the import (the `Tmux` methods already build session names internally).

- [ ] **Step 2: Typecheck the daemon**

Run: `pnpm check`
Expected: FAILS in `apps/daemon/src/index.ts` only — `new SessionManager(registry)` now needs 3 args, `sessions.closeAll()` on shutdown should become `sessions.shutdown()`, and the `/output` + `/ws` handlers still call the sync `buffer()` (fine) but we want them to use `scrollback()`. Those are fixed in Task 4. The `@orquester/config` and `tmux.ts` imports must resolve. This is expected transient breakage — proceed to Task 4.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/sessions.ts
git commit -m "feat(daemon): tmux-backed SessionManager (attach PTY, reattach, sessions.json)"
```

---

### Task 4: Wire the daemon — construct `SessionManager`, reattach on boot, scrollback on connect

**Files:**
- Modify: `apps/daemon/src/index.ts` (imports ~line 27-47; `ResolvedPaths` ~line 62-72 + build ~106-114; `SessionManager` construction ~line 122-123; shutdown ~line 197; `/api/sessions/:id/output` ~line 622-650; `/ws` `sub` handler ~line 720-739; `prepareDirs` ~line 966-970)

**Interfaces:**
- Consumes: `Tmux` (Task 2); `tmuxSocketPath`/`sessionsIndexPath` (Task 1); `SessionManager(registry, tmux, indexPath)` + `reattach()`/`scrollback()`/`shutdown()` (Task 3).
- Produces: a daemon that reattaches surviving sessions at startup and seeds (re)connecting clients from tmux scrollback. No route signatures change.

- [ ] **Step 1: Import the tmux helpers + config paths** — add `Tmux` to the local imports and the two path helpers to the `@orquester/config` import block:

Add after `import { Broadcaster } from "./broadcaster";` (~line 26):

```ts
import { Tmux } from "./tmux";
```

Add to the `@orquester/config` named import (alongside `remotesConfigPath`, `resolveDaemonPaths`):

```ts
  sessionsIndexPath,
  tmuxSocketPath,
```

- [ ] **Step 2: Add the two paths to `ResolvedPaths`** — extend the interface (~line 62-72):

```ts
/** Filesystem locations resolved (variables expanded) for this run. */
interface ResolvedPaths {
  daemonDir: string;
  configPath: string;
  /** app.json + remotes.json live under <appdir>/app and are shared by clients. */
  appConfigFile: string;
  remotesFile: string;
  /** Fixed socket of the dedicated tmux server that owns session PTYs. */
  tmuxSocket: string;
  /** <appdir>/daemon/sessions.json — the reattach index. */
  sessionsIndexFile: string;
  workspacesDir: string;
  logsDir: string;
  vars: ConfigVars;
}
```

- [ ] **Step 3: Populate them where `resolved` is built** (~line 106-114):

```ts
  const resolved: ResolvedPaths = {
    daemonDir: paths.daemonDir,
    configPath: paths.configPath,
    appConfigFile: appConfigPath(paths.baseDir),
    remotesFile: remotesConfigPath(paths.baseDir),
    tmuxSocket: tmuxSocketPath(paths.baseDir),
    sessionsIndexFile: sessionsIndexPath(paths.baseDir),
    workspacesDir: expandVars(config.workspacesDir, paths.vars),
    logsDir: expandVars(config.logsDir, paths.vars),
    vars: paths.vars
  };
```

- [ ] **Step 4: Construct the tmux-backed `SessionManager` and reattach on boot** — replace the construction line (~line 122-123):

```ts
  const registry = new RegistryService(resolved.daemonDir);
  const tmux = new Tmux(resolved.tmuxSocket);
  const sessions = new SessionManager(registry, tmux, resolved.sessionsIndexFile);
  const broadcaster = new Broadcaster();
```

Then, after `await registry.init();` (~line 127) and before the `sessions.lifecycle.on(...)` wiring, add the boot-time reattach (registry must be initialised first so survivors can resolve their default name on rename):

```ts
  // Reattach to any tmux sessions that outlived a previous daemon process
  // (KillMode=process keeps the tmux server alive across restarts). Best-effort:
  // a tmux/socket error must not block daemon startup.
  await sessions.reattach().catch((error) => console.error("Session reattach failed", error));
```

- [ ] **Step 5: Detach (don't kill) sessions on daemon stop** — in the `stop` closure (~line 196-200) replace `sessions.closeAll();` with `sessions.shutdown();`:

```ts
  const stop = async () => {
    sessions.shutdown();
    await stopHttp();
    await unixServer.close().catch(() => undefined);
  };
```

(This is the key behavioral change: shutting the daemon down now **leaves** the tmux sessions running so the next boot reattaches. `closeAll()` still exists for explicit teardown.)

- [ ] **Step 6: Seed the streaming HTTP output route from tmux scrollback** — replace the body of `/api/sessions/:id/output` (~line 622-650). It becomes `async` and awaits `scrollback()` instead of the sync `buffer()`:

```ts
  app.get<{ Params: { id: string } }>("/api/sessions/:id/output", async (request, reply) => {
    const { id } = request.params;
    const summary = sessions.get(id);
    if (!summary) {
      void reply.code(404).send();
      return;
    }

    // Capture scrollback BEFORE hijacking so an await can't race the raw stream.
    const replay = await sessions.scrollback(id);

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      ...corsHeaders
    });
    reply.raw.write(replay);

    if (summary.status === "exited") {
      reply.raw.end();
      return;
    }

    const unsubscribe = sessions.subscribe(
      id,
      (data) => reply.raw.write(data),
      () => reply.raw.end()
    );
    request.raw.on("close", unsubscribe);
  });
```

- [ ] **Step 7: Seed the WebSocket `sub` replay from tmux scrollback** — the `socket.on("message", ...)` callback is currently synchronous. Make it `async` and await `scrollback()` in the `sub` branch (~line 709-748). Replace the whole handler:

```ts
      socket.on("message", async (raw) => {
        let msg: { t?: string; id?: string; data?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const id = msg.id;
        if (!id) {
          return;
        }
        if (msg.t === "sub") {
          const summary = sessions.get(id);
          if (!summary) {
            send({ t: "end", id });
            return;
          }
          send({ t: "out", id, data: await sessions.scrollback(id) });
          if (summary.status === "exited") {
            send({ t: "end", id });
            return;
          }
          subs.get(id)?.();
          subs.set(
            id,
            sessions.subscribe(
              id,
              (data) => send({ t: "out", id, data }),
              () => send({ t: "end", id })
            )
          );
        } else if (msg.t === "unsub") {
          subs.get(id)?.();
          subs.delete(id);
        } else if (msg.t === "input" && typeof msg.data === "string") {
          sessions.input(id, msg.data);
        } else if (msg.t === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          sessions.resize(id, msg.cols, msg.rows);
        }
      });
```

- [ ] **Step 8: Note on `prepareDirs`** — no change required: tmux creates `tmux.sock` on first `new-session`, and `persistIndex()` does its own `mkdir(dirname(indexPath))`. `prepareDirs` (~line 966-970) already creates `resolved.daemonDir`, which is the parent of both. Leave it as-is. (If you prefer an explicit comment, that's optional; do not add a `mkdir` for the socket — tmux owns it.)

- [ ] **Step 9: Typecheck**

Run: `pnpm check`
Expected: PASS across the whole workspace (config, daemon, ui all clean).

- [ ] **Step 10: Runtime verify against a running daemon** (dev: `pnpm dev:daemon`, hot-reloads). Confirms create → tmux session exists → I/O flows → exit detection → close kills tmux:

```bash
TOKEN='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'   # dev: bare passwordHash (Phase 1: base64("mapacho:"+hash))
SOCK=$PWD/.stage/daemon/tmux.sock
BASE=http://127.0.0.1:47831
P=/tmp/orq-p2-verify; mkdir -p "$P"

# 1) create a bash session bound to project P
ID=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"kind\":\"shell\",\"refId\":\"bash\",\"projectPath\":\"$P\",\"cwd\":\"$P\",\"cols\":100,\"rows\":30}" \
  "$BASE/api/sessions" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "session id: $ID"
sleep 0.5

# 2) a live tmux session orq-<id> exists on OUR socket
tmux -S "$SOCK" list-sessions -F '#{session_name}'        # expect a line: orq-<ID>

# 3) sessions.json index has the record
python3 -c "import json;d=json.load(open('$PWD/.stage/daemon/sessions.json'));print([s['id'] for s in d['sessions']])"   # expect ['<ID>']

# 4) send input, then read scrollback back via capture-pane (output route)
curl -sS -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":"echo ORQ_MARKER_42\n"}' "$BASE/api/sessions/$ID/input"
sleep 0.4
curl -sS --max-time 2 -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$ID/output" | tr -d '\r' | grep ORQ_MARKER_42   # expect the echoed marker line

# 5) exit detection: run `exit` in the pane → tmux session ends → status exited
curl -sS -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":"exit\n"}' "$BASE/api/sessions/$ID/input"
sleep 0.6
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions?projectPath=$P" | python3 -c 'import sys,json;[print(s["id"][:8],s["status"],s.get("exitCode")) for s in json.load(sys.stdin)]'   # expect: <id> exited 0
tmux -S "$SOCK" has-session -t "orq-$ID" 2>/dev/null && echo "STILL ALIVE (bad)" || echo "tmux session gone (good)"

# 6) close removes it from the list + index
curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$ID"
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions?projectPath=$P" | python3 -c 'import sys,json;print("count:",len(json.load(sys.stdin)))'   # expect count: 0
```
Expected: step 2 prints `orq-<ID>`; step 3 prints `['<ID>']`; step 4 prints the `ORQ_MARKER_42` line (proves create-in-tmux + attach-PTY input + capture-pane scrollback); step 5 shows `exited 0` and `tmux session gone (good)`; step 6 prints `count: 0`.

- [ ] **Step 11: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): construct tmux SessionManager, reattach on boot, tmux scrollback on connect"
```

---

### Task 5: Restart-survival verification (the whole point of the phase)

**Files:**
- (No code changes — this task is a verification gate plus a doc note.)
- Modify: `apps/daemon/src/sessions.ts` (one clarifying comment only, optional — see Step 4)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: documented proof that a long-running command survives a daemon restart and reconnects with scrollback.

- [ ] **Step 1: Start a restart-safe dev daemon** (NOT `tsx watch`, which re-execs in place). In a dedicated terminal:

```bash
# Stop any `pnpm dev:daemon` first (its tsx-watch would interfere).
ORQUESTER_APPDIR=./.stage npx tsx apps/daemon/src/cli.ts --appdir ./.stage
```
Leave it running. In a second terminal, set:

```bash
TOKEN='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'   # bare hash (Phase 1: base64 form)
SOCK=$PWD/.stage/daemon/tmux.sock
BASE=http://127.0.0.1:47831
P=/tmp/orq-p2-survive; mkdir -p "$P"
```

- [ ] **Step 2: Launch a long-running command and capture the in-tmux PID** (so we can prove the *same* process survived):

```bash
ID=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"kind\":\"shell\",\"refId\":\"bash\",\"projectPath\":\"$P\",\"cwd\":\"$P\"}" \
  "$BASE/api/sessions" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# start a counter that writes a marker every second
curl -sS -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":"echo BOOT_BEFORE_RESTART; for i in $(seq 1 600); do echo tick-$i; sleep 1; done\n"}' \
  "$BASE/api/sessions/$ID/input"
sleep 2
# the shell PID running inside tmux (the process that must survive):
PANE_PID=$(tmux -S "$SOCK" list-panes -t "orq-$ID" -F '#{pane_pid}')
echo "pane pid before: $PANE_PID"
ps -o pid=,command= -p "$PANE_PID"     # expect: the bash running our loop
```

- [ ] **Step 3: Kill + restart the daemon, then confirm survival + reattach + scrollback**

```bash
# In the daemon terminal: Ctrl-C (or `kill <pid>`), then relaunch the SAME command:
#   ORQUESTER_APPDIR=./.stage npx tsx apps/daemon/src/cli.ts --appdir ./.stage
# (On the VPS the equivalent is: sudo systemctl restart orquester)
sleep 2   # give it a moment to boot + reattach

# a) the in-tmux process is the SAME pid (it never died):
tmux -S "$SOCK" list-panes -t "orq-$ID" -F '#{pane_pid}'    # expect: SAME number as "pane pid before"
ps -o pid=,command= -p "$PANE_PID"                          # expect: still our loop

# b) the daemon reattached: the session is back in the list as running:
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions?projectPath=$P" \
  | python3 -c 'import sys,json;[print(s["id"][:8],s["status"]) for s in json.load(sys.stdin)]'   # expect: <id> running

# c) scrollback survived: the output stream replays ticks from BEFORE the restart:
curl -sS --max-time 2 -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$ID/output" | tr -d '\r' > /tmp/orq-replay.txt
grep -q BOOT_BEFORE_RESTART /tmp/orq-replay.txt && echo "scrollback survived (good)" || echo "MISSING pre-restart scrollback (bad)"
grep -c '^tick-' /tmp/orq-replay.txt   # expect a non-zero count of pre-restart ticks

# cleanup
curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$ID"
tmux -S "$SOCK" has-session -t "orq-$ID" 2>/dev/null && echo "still alive (bad)" || echo "killed on close (good)"
```
Expected: (a) the pane PID is **unchanged** across the restart (the process survived); (b) the session lists as `running` (the daemon reattached from `sessions.json` + `tmux ls`); (c) `scrollback survived (good)` and a non-zero `tick-` count (tmux `capture-pane` replayed pre-restart history). This is the §2.7 `KillMode=process` behavior — see Notes.

- [ ] **Step 4 (optional doc note):** add a one-line comment above `reattach()` in `sessions.ts` pointing at the systemd requirement, then commit only if you changed a file:

```ts
  // Requires Phase 0's `KillMode=process` + `PrivateTmp=false` (deploy/orquester.service)
  // so the tmux server + its socket outlive a daemon restart.
```

```bash
git add apps/daemon/src/sessions.ts
git commit -m "docs(daemon): note KillMode=process requirement for session reattach"
```

(If you made no file change in Step 4, skip the commit — this task's deliverable is the verified survival, recorded here.)

---

## Notes for the implementer

- **Phase ordering / `pnpm check` staging:** after Task 3, `pnpm check` is **expected to fail** in `apps/daemon/src/index.ts` (the `SessionManager` constructor arity + `shutdown`/`scrollback` wiring) until Task 4 lands. That is intentional staging, not a regression — the same pattern the tab-reorder plan used.
- **`KillMode=process` is load-bearing and already shipped (Phase 0).** `deploy/orquester.service` sets `KillMode=process` and `PrivateTmp=false`. Do **not** modify systemd in this phase. The reasoning (spec §2.7): `tmux new-session -d` daemonizes the tmux *server* but it stays in the service cgroup; the default `KillMode=control-group` would kill it (and every pane) on `systemctl restart`. `KillMode=process` signals only the node process — when node dies, its PTY masters hang up, the `tmux attach` clients get SIGHUP and exit on their own, the tmux **server survives**, and the restarted daemon reattaches via the fixed `-S` socket. `PrivateTmp=false` is why the socket can live under `/var/lib/orquester/daemon/` (not a per-process `/tmp`). Task 5 verifies exactly this.
- **`tsx watch` vs real restart:** the per-task curl checks run fine against `pnpm dev:daemon` (hot reload). The Task 5 survival check needs a genuine process kill+restart, so run the daemon via a plain `npx tsx … cli.ts --appdir ./.stage` (or `pnpm dev:daemon:bare`) for that check, or test it on the VPS with `systemctl restart orquester`.
- **tmux 3.2+ only.** `-e KEY=VAL` on `new-session` and `set-option -g window-size latest` require 3.2+. Phase 0 installs it; `tmux -V` should print ≥ 3.2.
- **Why the attach-PTY's `onExit` checks `hasSession`:** that PTY exits in two distinct cases — (1) the command finished and the tmux session ended (real exit → mark `exited`), and (2) the daemon is shutting down and the master hung up while the tmux session is still alive (just detached → leave it for the next boot). `hasSession(id)` disambiguates so we don't falsely mark survivors as exited.
- **Scrollback source of truth flipped:** the durable replay is now `tmux capture-pane -p -e -J -S -` (full history, colors, unwrapped). The 256 KB in-memory ring is retained only for hot replay between create and the first connect, and as a fallback for an already-exited session whose pane is gone. `buffer()` (sync) stays for any caller that can't await; the streaming routes use the async `scrollback()`.
- **Env via `-e`:** `new-session` receives one `-e KEY=VAL` per entry for the same keys `create()` set before (`TERM`, `COLORTERM`, plus the registry entry's `env`). The attach-PTY itself only needs `TERM`/`COLORTERM` (it's just a tmux client). Note `process.env` keys with `undefined` values are skipped by the typed `Record<string,string>` cast + `Object.entries`; if you hit an env value containing a newline it is rejected by tmux — acceptable for our controlled env.
- **`window-size latest`** is set once in `reattach()` (which runs on every boot, before any attach). New sessions seed `-x/-y` at create and then follow the attaching client. If you prefer per-session control, `set-option -t orq-<id> window-size latest` works too, but the global form is simpler and sufficient for single-user.
- **Orphan reaping default:** `reattach()` kills any live `orq-*` session not present in `sessions.json`. This keeps a crashed/old daemon's sessions from accumulating. If you ever want to *adopt* orphans instead, that's a future toggle — the default here is cleanup, as specified.
- **Security:** ids are UUIDs and all tmux calls use `execFile` with an args array, so session names/cwd/env are never shell-interpreted. Keep it that way for any future tmux call.
