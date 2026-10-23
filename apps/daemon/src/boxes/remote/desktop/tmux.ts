/**
 * The tmux service sessions of VM desktops: the same calls the daemon's `Tmux`
 * makes for host desktops (`DesktopTmux`), run in the box on a private tmux
 * server (`tmux -L`), apart from the box user's own and from box terminals'.
 * Argv only, never a shell string; nothing secret is ever in it (an app's
 * command and env travel in its env file).
 */

import type { DesktopTmux } from "../../../desktops/manager.ts";
import { TMUX_NO_SERVER } from "../../../tmux.ts";
import type { BoxConnection } from "../../contracts.ts";
import { BoxRunError, runInBox } from "../exec/run.ts";

/** The private tmux server VM desktops run on. */
export const BOX_DESKTOP_TMUX_SERVER = "orquester-desktops";

const SERVICE_SESSION_PREFIX = "orqsvc-";
const TMUX_TIMEOUT_MS = 15_000;
/** A listing's output is the box's to say: never more than this. */
const TMUX_OUTPUT_BYTES = 1024 * 1024;

/** Throws unless `name` is in the service namespace, as the host's `Tmux` does. */
function assertServiceName(name: string): void {
  if (!name.startsWith(SERVICE_SESSION_PREFIX)) {
    throw new Error(`service session name must start with "${SERVICE_SESSION_PREFIX}" (got "${name}")`);
  }
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([, value]) => !value.includes("\n"))
    .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/** A tmux failure's stderr ("" for one that never ran: the link, a missing binary). */
function stderrOf(error: unknown): string {
  return error instanceof BoxRunError ? error.stderr : "";
}

/**
 * tmux could not be run at all in the box (not installed yet): no server, so
 * no sessions. A dropped link is NOT this (it must never read as "none").
 */
function tmuxMissing(error: unknown): boolean {
  if (error instanceof BoxRunError) return error.code === 127 || error.code === "ENOENT";
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

export class BoxDesktopTmux implements DesktopTmux {
  constructor(
    private readonly connection: () => BoxConnection,
    private readonly server: string = BOX_DESKTOP_TMUX_SERVER
  ) {}

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return runInBox(this.connection(), "tmux", ["-L", this.server, ...args], { timeout: TMUX_TIMEOUT_MS, maxBuffer: TMUX_OUTPUT_BYTES });
  }

  async newServiceSession(opts: Parameters<DesktopTmux["newServiceSession"]>[0]): Promise<void> {
    assertServiceName(opts.name);
    try {
      await this.run([
        "new-session",
        "-d",
        "-s",
        opts.name,
        ...(opts.windowName ? ["-n", opts.windowName] : []),
        "-c",
        opts.cwd,
        ...envArgs(opts.env),
        "--",
        opts.bin,
        ...opts.args
      ]);
    } catch (error) {
      throw new Error(`tmux new-session (service) failed in the VM: ${stderrOf(error).trim() || (error as Error).message}`);
    }
  }

  async newServiceWindow(opts: Parameters<DesktopTmux["newServiceWindow"]>[0]): Promise<void> {
    assertServiceName(opts.session);
    try {
      await this.run([
        "new-window",
        "-d",
        "-t",
        `=${opts.session}:`,
        "-n",
        opts.name,
        "-c",
        opts.cwd,
        ...envArgs(opts.env),
        "--",
        opts.bin,
        ...opts.args
      ]);
    } catch (error) {
      throw new Error(`tmux new-window (service) failed in the VM: ${stderrOf(error).trim() || (error as Error).message}`);
    }
  }

  /** Live service sessions named `prefix…`; [] without a server. Any other failure (the link) throws. */
  async listServiceSessions(prefix: string): Promise<string[]> {
    assertServiceName(prefix);
    let stdout: string;
    try {
      ({ stdout } = await this.run(["list-sessions", "-F", "#{session_name}"]));
    } catch (error) {
      if (TMUX_NO_SERVER.test(stderrOf(error)) || tmuxMissing(error)) return [];
      throw error;
    }
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.startsWith(prefix));
  }

  /** Windows of a service session; [] when the session (or server) is gone, throws on any other failure. */
  async listServiceWindows(session: string): Promise<Array<{ name: string; panePid: number }>> {
    assertServiceName(session);
    let stdout: string;
    try {
      ({ stdout } = await this.run(["list-windows", "-t", `=${session}`, "-F", "#{pane_pid} #{window_name}"]));
    } catch (error) {
      const stderr = stderrOf(error);
      if (TMUX_NO_SERVER.test(stderr) || /can't find session/i.test(stderr) || tmuxMissing(error)) return [];
      throw error;
    }
    const windows: Array<{ name: string; panePid: number }> = [];
    for (const line of stdout.split("\n")) {
      const space = line.indexOf(" ");
      if (space <= 0) continue;
      const panePid = Number(line.slice(0, space));
      // pid > 1: a garbled line must never make init look like a pane.
      if (Number.isInteger(panePid) && panePid > 1) windows.push({ name: line.slice(space + 1), panePid });
    }
    return windows;
  }

  /** Kill a session by its exact name; a gone one (or a link that dropped) is no error, as on the host. */
  async killServiceSession(name: string): Promise<void> {
    await this.run(["kill-session", "-t", `=${name}`]).catch(() => undefined);
  }
}
