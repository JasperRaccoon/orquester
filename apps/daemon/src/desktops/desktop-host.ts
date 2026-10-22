import { existsSync, watch } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import type { DesktopHostStatus } from "@orquester/api";
import { desktopRuntimeDir } from "@orquester/config";
import { sessionNodeOptions } from "../plugins/session-env.ts";
import { sessionEnvBase, sessionPath } from "../tmux.ts";
import type { DesktopAudioSpawn } from "./audio.ts";
import { type AppEnvOptions, DESKTOP_APP_SCRIPT, DESKTOP_HOST_SCRIPT, buildAppEnv, fallbackSocketDir } from "./host-env.ts";
import { hasRenderNode } from "./host-status.ts";
import type { DesktopTmux } from "./manager.ts";
import type { DesktopWindowTrackerOptions } from "./windows.ts";

// Where a desktop runs (desktop spec §5, boxes: Linux VM desktops). The
// manager does every operation on a desktop's machine — its tmux service
// session, the files of its directory, the watches on them, signals to its
// process groups — through a DesktopHost: LocalDesktopHost is this machine
// (the behaviour desktops always had), a box's host (boxes/remote/desktop)
// is the same operations over the box link.

/** A directory watch; `close()` ends it. */
export interface DesktopWatch {
  close(): void;
}

/** What marks a process group's leader as a desktop's own (see {@link DesktopHost.signalGroup}). */
export type DesktopGroupOwner = { environ: string } | { argument: string };

/** The shipped scripts, as paths on the desktop's machine. */
export interface DesktopScripts {
  host: string;
  app: string;
}

export interface DesktopHost {
  /** The box this is, null for this machine. */
  readonly boxId: string | null;
  /** The machine can be reached now (a box link can drop; this machine always can). */
  readonly connected: boolean;
  readonly tmux: DesktopTmux;
  /** Cores on that machine (the render-thread clamp). */
  readonly parallelism: number;
  /** A new desktop's directory there. */
  desktopDir(desktopId: string): string;
  /** The short socket dir for a desktop whose dir is too long for sun_path (that machine's tmp dir and uid), else null. */
  socketFallback(dir: string, desktopId: string): Promise<string | null>;
  /** desktop-host.sh and app-run.sh there. */
  scripts(): Promise<DesktopScripts>;
  /**
   * Create each directory (with parents) 0700, refusing one that is not a
   * directory owned by the desktop's user — a symlink, or one someone else made
   * in the shared tmp dir.
   */
  prepareDirs(dirs: readonly string[]): Promise<void>;
  /** The file's text, or null when there is none. */
  readText(path: string): Promise<string | null>;
  /** The last `bytes` of a file as UTF-8 ("" when it does not exist). */
  readTail(path: string, bytes: number): Promise<string>;
  /** Create (with `mode`) or overwrite a file. */
  writeFile(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  /** Remove a file (or a tree with `recursive`); a missing one is fine. */
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Names in a directory ([] when it does not exist). */
  readdir(path: string): Promise<string[]>;
  /**
   * Watch a directory's own entries: `onChange(name)` per changed entry,
   * `onChange(null)` when anything may have changed (check everything again).
   * Throws when the directory cannot be watched.
   */
  watch(dir: string, onChange: (name: string | null) => void, onError: (error: Error) => void): DesktopWatch;
  /**
   * Signal a whole process group; a gone group (or a nonsense pgid) is ignored.
   * `owner` (boxes): signal only while the group's leader is still the
   * desktop's process — its environment holds `environ` (`XAUTHORITY=…`), or
   * its arguments hold `argument` (the desktop dir) — so a pid reused while the
   * VM was out of sight (a reboot) is never hit. This machine's groups are
   * followed without a gap, and are signalled as they always were.
   */
  signalGroup(pgid: number, signal: NodeJS.Signals, owner?: DesktopGroupOwner): Promise<void>;
  /** Whether the process `pid` carries `XAUTHORITY=<xauthority>` (a desktop app's leader, not a recycled pid). */
  leaderBelongsTo(pid: number, xauthority: string): Promise<boolean>;
  /** An app's whole environment there (§5.5): that machine's base, the desktop wiring, the user's variables. */
  appEnv(options: Omit<AppEnvOptions, "base" | "renderNode">): Promise<Record<string, string>>;
  /** The window tracker's options for a display there. */
  trackerOptions(options: DesktopWindowTrackerOptions): DesktopWindowTrackerOptions;
  /** A stream to a Unix socket there (the desktop's RFB socket). Absent: this machine (connect to the path). */
  connectUnix?(path: string): Promise<Duplex>;
  /** Starts the audio encoder there. Absent: this machine's ffmpeg (the audio hub's own). */
  readonly audioSpawn?: DesktopAudioSpawn;
}

export interface LocalDesktopHostOptions {
  /** `<appdir>` — the config path helpers take it. */
  baseDir: string;
  tmux: DesktopTmux;
  /** The env apps start from (default: the session base env with the session PATH). */
  baseEnv?: () => Record<string, string>;
  /** Whether a `/dev/dri/renderD*` node exists (default: probed). */
  renderNode?: () => boolean;
  /** Where the short socket fallback dirs go (default os.tmpdir()). */
  tmpDir?: string;
}

/** This machine: node:fs, the daemon's tmux, process.kill. */
export class LocalDesktopHost implements DesktopHost {
  readonly boxId = null;
  readonly connected = true;
  readonly tmux: DesktopTmux;
  readonly parallelism = availableParallelism();

  constructor(private readonly options: LocalDesktopHostOptions) {
    this.tmux = options.tmux;
  }

  desktopDir(desktopId: string): string {
    return desktopRuntimeDir(this.options.baseDir, desktopId);
  }

  async socketFallback(dir: string, desktopId: string): Promise<string | null> {
    return fallbackSocketDir(dir, desktopId, { tmpDir: this.options.tmpDir ?? tmpdir(), uid: process.getuid?.() ?? 0 });
  }

  async scripts(): Promise<DesktopScripts> {
    return { host: DESKTOP_HOST_SCRIPT, app: DESKTOP_APP_SCRIPT };
  }

  async prepareDirs(dirs: readonly string[]): Promise<void> {
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // The socket fallback lives in the shared tmp dir under a recorded name: refuse
      // one someone else created (or a symlink) rather than put our sockets in it.
      const info = await lstat(dir);
      if (!info.isDirectory() || info.uid !== process.getuid?.()) {
        throw new Error(`${dir} is not a directory owned by the daemon's user`);
      }
      await chmod(dir, 0o700);
    }
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  async readTail(path: string, bytes: number): Promise<string> {
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return "";
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async writeFile(path: string, data: string | Uint8Array, mode: number): Promise<void> {
    await writeFile(path, data, { mode });
  }

  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await rm(path, { recursive: options.recursive ?? false, force: true });
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }

  async readdir(path: string): Promise<string[]> {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  }

  watch(dir: string, onChange: (name: string | null) => void, onError: (error: Error) => void): DesktopWatch {
    const watcher = watch(dir, (_event, name) => onChange(name));
    watcher.on("error", onError);
    return watcher;
  }

  async signalGroup(pgid: number, signal: NodeJS.Signals): Promise<void> {
    // > 1: never the caller's own group (0) or init's.
    if (!Number.isInteger(pgid) || pgid <= 1) return;
    try {
      process.kill(-pgid, signal);
    } catch {
      /* already gone */
    }
  }

  async leaderBelongsTo(pid: number, xauthority: string): Promise<boolean> {
    try {
      const environ = await readFile(`/proc/${pid}/environ`, "utf8");
      return environ.split("\0").includes(`XAUTHORITY=${xauthority}`);
    } catch {
      return false;
    }
  }

  async appEnv(options: Omit<AppEnvOptions, "base" | "renderNode">): Promise<Record<string, string>> {
    const env = buildAppEnv({
      ...options,
      base: this.options.baseEnv?.() ?? { ...sessionEnvBase(), PATH: sessionPath() },
      renderNode: this.options.renderNode?.() ?? hasRenderNode()
    });
    // An app is a user command like a terminal's: the plugins' NODE_OPTIONS
    // preload (plugins spec §3.3) goes after the app's own NODE_OPTIONS.
    const nodeOptions = sessionNodeOptions(env.NODE_OPTIONS);
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    return env;
  }

  trackerOptions(options: DesktopWindowTrackerOptions): DesktopWindowTrackerOptions {
    return options;
  }
}

/**
 * What the manager needs from Ephemeral AI VMs to run desktops in Linux boxes
 * (implemented in boxes/remote/desktop; absent: every desktop is this machine's).
 */
export interface DesktopBoxes {
  /** The box's desktop host, or null when the box is gone for good (destroyed, unknown). */
  host(boxId: string): DesktopHost | null;
  /** The desktop stack in the box as it is now (never installs). */
  status(boxId: string): Promise<DesktopHostStatus>;
  /**
   * Install what the box is missing (once per box), then its status. Throws a
   * `DesktopError` (409 DESKTOP_UNAVAILABLE, with a hint) when it cannot.
   */
  ensure(boxId: string, onProgress: (line: string) => void): Promise<DesktopHostStatus>;
  /** A box connected, dropped its link, or changed state (destroyed included). Returns the unsubscribe. */
  onChange(listener: (boxId: string) => void): () => void;
}
