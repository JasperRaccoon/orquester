import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";

/** Prefix for every orquester-owned tmux session (`orq-<uuid>`). */
export const TMUX_SESSION_PREFIX = "orq-";

/** Derive the tmux session name from a session id. */
export function tmuxName(id: string): string {
  return `${TMUX_SESSION_PREFIX}${id}`;
}

/** Build the `capture-pane` argv. Pure (testable without tmux). `name` is the full orq-<id>. */
export function captureArgs(
  name: string,
  opts: { escapes?: boolean; lines?: number | "all" } = {}
): string[] {
  const { escapes = true, lines = "all" } = opts;
  const start = lines === "all" ? "-" : String(-Math.max(0, lines)); // "-" | "0" | "-N"
  const args = ["capture-pane", "-p", "-J", "-S", start, "-t", name];
  if (escapes) {
    args.splice(2, 0, "-e"); // colors only when asked
  }
  return args;
}

/**
 * True if a `tmux` binary is resolvable on PATH. The tmux-backed SessionManager
 * is the persistence backend on the VPS (and any Linux/macOS host with tmux),
 * but the desktop built-in daemon also runs on Windows (no tmux) and on a stock
 * macOS where tmux isn't preinstalled — there we fall back to a direct node-pty
 * backend (see createSessionManager). Mirrors registry.ts's resolveBin: sync
 * PATH scan, F_OK on win32 (+ PATHEXT) and X_OK elsewhere.
 */
export function tmuxAvailable(): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `tmux${ext}`);
      if (isAbsolute(candidate)) {
        try {
          accessSync(candidate, mode);
          return true;
        } catch {
          /* not here; keep scanning */
        }
      }
    }
  }
  return false;
}

/** Minimum tmux version the tmux backend needs (see comment below). */
const MIN_TMUX_MAJOR = 3;
const MIN_TMUX_MINOR = 2;

/**
 * True if `tmux -V` reports >= 3.2 — the floor the tmux backend requires:
 * `new-session -e KEY=VAL` and `set-option -g window-size latest` are both 3.2+
 * features (Phase 2 plan, Global Constraints). On an older tmux (e.g. the 3.0/3.1
 * on some Ubuntu LTS / Homebrew boxes) `tmuxAvailable()` still returns true, but
 * every create would fail on the unknown `-e` flag; createSessionManager pairs
 * this check with the binary check so such hosts fall back to LocalSessionManager
 * instead of producing unusable terminals. Sync (execFileSync) to keep the
 * startup backend selection synchronous; never throws (a missing/odd binary or
 * unparseable `-V` is treated as "not OK" → fall back). Versions like `3.2a` are
 * handled by parsing only the leading numeric part of the minor component.
 */
export function tmuxVersionOk(): boolean {
  try {
    const out = execFileSync("tmux", ["-V"], { encoding: "utf8" });
    // `tmux -V` prints e.g. "tmux 3.4", "tmux 3.2a", "tmux next-3.4".
    const match = /(\d+)\.(\d+)/.exec(out);
    if (!match) {
      return false;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > MIN_TMUX_MAJOR || (major === MIN_TMUX_MAJOR && minor >= MIN_TMUX_MINOR);
  } catch {
    return false;
  }
}

/**
 * The PATH a session's command should run with. The daemon's own PATH is
 * intentionally narrow — under systemd on the VPS it is pinned to a minimal set
 * (deploy/orquester.service) that excludes the per-user bin dirs modern dev
 * tools install into: bun → ~/.bun/bin, uv/pipx → ~/.local/bin, rust →
 * ~/.cargo/bin, deno → ~/.deno/bin, `go install` → ~/go/bin.
 *
 * IMPORTANT (the bite): a tmux pane inherits the environment of the CLIENT
 * process that ran `tmux new-session` (here, the daemon) — NOT the per-session
 * `-e KEY=VAL` vars. `-e` only populates tmux's own environment *table* (visible
 * via `show-environment`); the spawned pane process never reads it for PATH. So
 * the only place that actually changes the command's PATH is the new-session
 * client's process env (run()/newSession below) — or, for the direct node-pty
 * backend, the child's env. We prepend the user-local dirs (deduped; they win)
 * and keep the inherited PATH as the tail. PATH is not a secret, so this is safe
 * to set explicitly.
 */
export function sessionPath(): string {
  const home = homedir();
  const extras = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin")
  ];
  const inherited = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const seen = new Set(inherited);
  return [...extras.filter((dir) => !seen.has(dir)), ...inherited].join(delimiter);
}

const NON_INTERACTIVE_SHELLS = new Set(["false", "nologin"]);

function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function usableShell(path: string | undefined): path is string {
  if (!path || !isAbsolute(path)) {
    return false;
  }
  if (NON_INTERACTIVE_SHELLS.has(basename(path))) {
    return false;
  }
  return executable(path);
}

/**
 * The daemon often runs as a locked-down service user whose account shell is
 * `/usr/sbin/nologin`. That is correct for SSH/login security, but child TUIs
 * such as opencode consult `$SHELL` when spawning subprocesses; pointing them at
 * nologin makes the session exit immediately. Keep the account locked down while
 * advertising a real shell inside Orquester-managed PTYs.
 */
export function sessionShell(): string | undefined {
  if (usableShell(process.env.SHELL)) {
    return process.env.SHELL;
  }
  if (process.platform === "win32") {
    return process.env.ComSpec || process.env.COMSPEC || process.env.SHELL;
  }
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/sh", "/usr/bin/sh"]) {
    if (usableShell(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** POSIX-compatible shell used to run shell-wrapped launch commands. */
export function sessionCommandShell(): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
    if (usableShell(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * The daemon's environment with everything a user session must NOT inherit
 * removed: tmux's own $TMUX/$TMUX_PANE (which would trip tmux's nesting guard
 * when the daemon itself runs inside a tmux pane) and the daemon's ORQUESTER_*
 * configuration — notably ORQUESTER_HTTP_PASSWORD/ORQUESTER_HTTP_USERNAME loaded
 * from the systemd EnvironmentFile. A tmux pane inherits the new-session
 * client's environment, and the node-pty backend spawns the command straight
 * from the daemon's env, so without this scrub every terminal/agent could read
 * the web credentials out of its own environment. The daemon's own process.env
 * is untouched (it still reads its config); this only shapes what children get.
 */
export function sessionEnvBase(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "TMUX" || key === "TMUX_PANE") continue;
    if (key.startsWith("ORQUESTER_")) continue;
    env[key] = value;
  }
  const shell = sessionShell();
  if (shell) {
    env.SHELL = shell;
  }
  return env;
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
  private run(args: string[], envOverride?: Record<string, string>): Promise<ExecResult> {
    // sessionEnvBase() strips $TMUX/$TMUX_PANE (so control commands and the
    // new-session client are immune to tmux's nesting guard when the daemon was
    // itself launched inside a tmux pane — the attach PTY does the same) AND the
    // daemon's ORQUESTER_* secrets, since the new-session client's env is what a
    // pane inherits.
    const cleanEnv = sessionEnvBase();
    return new Promise((resolve) => {
      execFile(
        "tmux",
        ["-S", this.socket, ...args],
        { maxBuffer: 16 * 1024 * 1024, env: { ...cleanEnv, ...envOverride } as NodeJS.ProcessEnv },
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
    // A value containing a newline is rejected by `tmux new-session` and would
    // fail the whole launch, so drop those defensively (env here is small and
    // controlled — TERM/COLORTERM plus the registry entry's overrides).
    const envArgs = Object.entries(opts.env)
      .filter(([, value]) => !value.includes("\n"))
      .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
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
      // The pane inherits THIS new-session client's env (not the `-e` vars
      // above), so the session PATH must be set here to expose user-local tools.
    ], { PATH: sessionPath() });
    if (result.code !== 0) {
      throw new Error(`tmux new-session failed (${result.code}): ${result.stderr.trim()}`);
    }
  }

  /** The argv for a streaming attach PTY: `tmux -S <socket> attach -t orq-<id>`. */
  attachArgs(id: string): string[] {
    return ["-S", this.socket, "attach", "-t", tmuxName(id)];
  }

  /**
   * Visible + scrollback text of a session's pane (empty if gone). Defaults
   * preserve the xterm replay path: colors (-e) + full history (-S -), with
   * alt-screen-aware framing for full-screen TUIs. For agent reads pass
   * { escapes:false } (plain text) and { lines } to bound the range: lines:0 ⇒
   * current screen (-S 0), lines:N ⇒ last N rows (-S -N).
   */
  async capturePane(
    id: string,
    opts: { escapes?: boolean; lines?: number | "all" } = {}
  ): Promise<string> {
    // A full-screen TUI (e.g. an agent like Claude Code) runs in the terminal's
    // ALTERNATE screen. capture-pane records the cells but NOT the DEC private mode
    // that put the pane there — so replaying it verbatim drops the captured TUI into
    // a (re)connecting client's NORMAL buffer, the wrong one. Every later agent
    // redraw (including our resize-nudge) then paints into a buffer that doesn't
    // match the snapshot and can't cleanly overwrite it → garbled until the agent
    // does a full clear (a working agent's animation does; an idle one never does).
    // For an alt-screen pane, prefix the enter-alt-screen sequence so the browser is
    // in the SAME buffer, and capture the visible grid faithfully: no -J (it would
    // merge full-width TUI rows) and no -S (the alt screen has no scrollback).
    // This replay framing emits escape sequences, so it applies only to the colored
    // default path; agent reads ({ escapes:false }) want plain, alt-mode-agnostic
    // text and fall through to the bounded capture below.
    if (opts.escapes !== false) {
      const alt =
        (await this.run(["display-message", "-p", "-t", tmuxName(id), "#{alternate_on}"])).stdout.trim() === "1";
      if (alt) {
        const result = await this.run(["capture-pane", "-p", "-e", "-t", tmuxName(id)]);
        // \x1b[?1049h enters the alt screen (and clears it); \x1b[H homes the cursor
        // so the captured grid lands top-aligned. Always emit the mode switch (even if
        // the capture is empty) so the live redraws that follow land in the right buffer.
        return `\x1b[?1049h\x1b[H${result.code === 0 ? result.stdout : ""}`;
      }
    }
    // Normal buffer / bounded read: argv from captureArgs (default = -p -e -J -S -,
    // the exact back-compatible replay capture; agent reads drop -e and bound -S).
    const result = await this.run(captureArgs(tmuxName(id), opts));
    return result.code === 0 ? result.stdout : "";
  }

  /**
   * Colored + bounded capture for AGENT reads: capture-pane -e via captureArgs,
   * deliberately WITHOUT the alt-screen replay framing capturePane() adds (that framing
   * exists only to replay scrollback into a reconnecting client's buffer). text.ts then
   * drops faint (ghost/placeholder) text and strips the remaining ANSI — keeping color is
   * what lets a read tell a greyed placeholder from real typed input. lines:0 ⇒ current
   * screen (-S 0), lines:N ⇒ last N rows (-S -N).
   */
  async captureAnsi(id: string, lines: number | "all" = 0): Promise<string> {
    const result = await this.run(captureArgs(tmuxName(id), { escapes: true, lines }));
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

  /**
   * Current window size (cols×rows) of every live orquester session, by id. Used
   * by reattach() to restore a session's size after a restart when its on-disk
   * record predates persisted cols/rows: the tmux window kept its real size while
   * the daemon was gone, so it's a faithful fallback. (window_height is the pane
   * area — already minus the status line — so reattaching at it leaves the pane at
   * most a row shorter; imperceptible, and the next client resize corrects it.)
   */
  async windowSizes(): Promise<Map<string, { cols: number; rows: number }>> {
    const sizes = new Map<string, { cols: number; rows: number }>();
    const result = await this.run([
      "list-windows",
      "-a",
      "-F",
      "#{session_name} #{window_width} #{window_height}"
    ]);
    if (result.code !== 0) {
      return sizes;
    }
    for (const line of result.stdout.split("\n")) {
      const [name, w, h] = line.trim().split(" ");
      const cols = Number(w);
      const rows = Number(h);
      if (name?.startsWith(TMUX_SESSION_PREFIX) && cols > 0 && rows > 0) {
        sizes.set(name.slice(TMUX_SESSION_PREFIX.length), { cols, rows });
      }
    }
    return sizes;
  }

  /** Make every session follow the most-recent attached client's size. */
  async setWindowSizeLatest(): Promise<void> {
    await this.run(["set-option", "-g", "window-size", "latest"]);
  }

  /**
   * Unset any leftover secret vars from the tmux SERVER's global environment.
   * The global env is captured from whichever client first started the server;
   * a daemon from before sessionEnvBase() existed seeded it with ORQUESTER_*
   * (incl. the HTTP password). A new session COPIES the server's global env, so
   * scrubbing the new-session client's env alone is not enough — on reattach to
   * a surviving server we strip the matching keys here, after which new panes
   * never inherit the leaked credentials even though the server outlived the
   * daemon that leaked them. Idempotent: a server already started clean has none.
   */
  async scrubGlobalSecrets(prefix = "ORQUESTER_"): Promise<void> {
    const result = await this.run(["show-environment", "-g"]);
    if (result.code !== 0) {
      return;
    }
    const keys = result.stdout
      .split("\n")
      // show-environment prints `VAR=value`, or `-VAR` for an already-unset var.
      .map((line) => line.split("=", 1)[0].replace(/^-/, ""))
      .filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      await this.run(["set-environment", "-g", "-u", key]);
    }
  }

  /** Kill a session (used to reap orphans / forget on close). */
  async killSession(id: string): Promise<void> {
    await this.run(["kill-session", "-t", tmuxName(id)]);
  }
}
