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
