/**
 * Where a VM desktop runs: the desktop manager's `DesktopHost` over a box link
 * (Ephemeral AI VMs; Linux boxes only).
 *
 * - Its directory is `~/.orquester/desktops/<id>` of the box's working user
 *   (the socket fallback, when that is too long for sun_path, is in the box's
 *   `/tmp` under that user's uid — the same rule as on the host).
 * - The shipped scripts (`desktops/assets/`) are copied into
 *   `~/.orquester/desktop-assets/<content hash>/` before the first desktop
 *   starts and whenever they change; they run from there unchanged.
 * - tmux: a private server in the box (`BoxDesktopTmux`). Files: `fs.*`
 *   requests and the file channels. Watches: `fs.watch` + `fs.change` events,
 *   re-established after every reconnect (a watch belongs to one link) and
 *   reported as "anything may have changed" once in place. Signals and the
 *   `/proc` reads: small commands in the box, as its working user (the user the
 *   desktop's processes run as). Sockets: `unix` channels.
 *
 * Nothing here logs a command line, an env value or file contents.
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative } from "node:path";
import { PassThrough, type Duplex } from "node:stream";

import type { BoxFsChangeEvent } from "@orquester/api";

import type { DesktopAudioEncoderProcess, DesktopAudioSpawn } from "../../../desktops/audio.ts";
import type { DesktopGroupOwner, DesktopHost, DesktopScripts, DesktopWatch } from "../../../desktops/desktop-host.ts";
import { type AppEnvOptions, DESKTOP_HOST_SCRIPT, buildAppEnv, fallbackSocketDir } from "../../../desktops/host-env.ts";
import { type ProcStat, parseProcStat, type DesktopWindowTrackerOptions } from "../../../desktops/windows.ts";
import { x11SocketPath } from "../../../desktops/x11/connection.ts";
import type { BoxConnection, BoxProcess, BoxToolingProvisioner } from "../../contracts.ts";
import { boxToolingEnv, toolingFor } from "../exec/env.ts";
import { runInBox } from "../exec/run.ts";
import { errnoOf } from "../fs/errors.ts";
import { BoxProjectFs } from "../fs/project-fs.ts";
import { BoxDesktopTmux } from "./tmux.ts";

/** The shipped desktop scripts on this machine (every file under it is copied). */
const ASSETS_DIR = dirname(DESKTOP_HOST_SCRIPT);
const HOST_SCRIPT = basename(DESKTOP_HOST_SCRIPT);
const APP_SCRIPT = "app-run.sh";
/** Written last into an assets copy: the copy is complete. */
const ASSETS_COMPLETE = ".complete";

/** Status files, logs' tails and the authority file are small; a read never takes more. */
const MAX_TEXT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;

/**
 * `prepareDirs` in the box (`sh -c <this> sh <dir>…`): each dir created 0700
 * (umask 077 makes the parents 0700 too, as `mkdir -p` with mode 0700 on the
 * host), then refused unless it is a real directory owned by this user.
 */
const PREPARE_DIRS_SCRIPT = [
  "umask 077",
  "for d do",
  '  mkdir -p -- "$d" || exit 1',
  '  if [ -L "$d" ] || [ ! -d "$d" ] || [ ! -O "$d" ]; then',
  "    echo \"$d is not a directory owned by the VM's user\" >&2",
  "    exit 1",
  "  fi",
  '  chmod 700 -- "$d" || exit 1',
  "done"
].join("\n");

/**
 * The `/proc/<pid>/stat` lines of `pid` and its ancestors (`sh -c <this> sh
 * <pid>`), up to pid 1 or 128 deep. `comm` may hold spaces and parentheses:
 * the fields after the last `) ` are split, the second is the ppid.
 */
const PROC_CHAIN_SCRIPT = [
  "p=$1",
  "n=0",
  'while [ "$p" -gt 1 ] 2>/dev/null && [ "$n" -lt 128 ]; do',
  '  s=$(cat "/proc/$p/stat" 2>/dev/null) || exit 0',
  "  printf '%s\\n' \"$s\"",
  "  r=${s##*) }",
  "  set -- $r",
  "  p=$2",
  "  n=$((n + 1))",
  "done"
].join("\n");

/**
 * Signal a group only while its leader is the desktop's (`sh -c <this> sh <pgid> <SIG>
 * <environ|cmdline> <marker>`): one NUL-separated entry of the leader's environment or
 * arguments must be exactly `marker`. A gone leader, or one that is someone else's, is left alone.
 */
const SIGNAL_OWNED_GROUP_SCRIPT = [
  'tr "\\000" "\\n" <"/proc/$1/$3" 2>/dev/null | grep -qxF -- "$4" || exit 0',
  'kill -s "$2" -- "-$1" 2>/dev/null',
  "exit 0"
].join("\n");

/** Where the `unix` channel probe points: no socket is ever there. */
const UNIX_PROBE_PATH = "/nonexistent/.orquester-desktop-probe.sock";

/** Output cap of the small commands (an id, a kill): the box's answer is never trusted to be small. */
const SMALL_OUTPUT_BYTES = 64 * 1024;

/** One file of the shipped assets: its path relative to the assets dir, its bytes and mode. */
interface AssetFile {
  path: string;
  data: Buffer;
  mode: number;
}

let assetsOnHost: Promise<{ hash: string; files: AssetFile[] }> | null = null;

/** Every file under the assets dir, and their content hash (read once per daemon run). */
function shippedAssets(): Promise<{ hash: string; files: AssetFile[] }> {
  assetsOnHost ??= (async () => {
    const files: AssetFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          files.push({ path: relative(ASSETS_DIR, full).split("\\").join("/"), data: await readFile(full), mode: (await stat(full)).mode & 0o777 });
        }
      }
    };
    await walk(ASSETS_DIR);
    const hash = createHash("sha256");
    for (const file of files) hash.update(`${file.path}\0${file.mode}\0${file.data.length}\0`).update(file.data);
    return { hash: hash.digest("hex").slice(0, 16), files };
  })().catch((error: unknown) => {
    assetsOnHost = null;
    throw error;
  });
  return assetsOnHost;
}

export interface BoxDesktopHostOptions {
  boxId: string;
  /** The box's live connection object (undefined until it first connected since the daemon started). */
  connection: () => BoxConnection | undefined;
  tooling?: Pick<BoxToolingProvisioner, "contribution">;
  /** The private tmux server in the box (tests use their own). */
  tmuxServer?: string;
}

/** A VM desktop's machine: see the module doc. */
export class BoxDesktopHost implements DesktopHost {
  readonly boxId: string;
  readonly tmux: BoxDesktopTmux;
  private uidRead: { connection: BoxConnection; uid: Promise<number> } | null = null;
  private renderNodeRead: { connection: BoxConnection; present: Promise<boolean> } | null = null;
  private scriptsCopied: { connection: BoxConnection; scripts: Promise<DesktopScripts> } | null = null;
  private unixProbe: { connection: BoxConnection; key: string; supported: Promise<boolean> } | null = null;

  constructor(private readonly options: BoxDesktopHostOptions) {
    this.boxId = options.boxId;
    this.tmux = new BoxDesktopTmux(() => this.link(), options.tmuxServer);
  }

  get connected(): boolean {
    return this.options.connection()?.connected === true;
  }

  get parallelism(): number {
    return Math.max(1, this.options.connection()?.sys.cpus ?? 1);
  }

  /** The connection, which must be up (every box call below refuses at once otherwise). */
  private link(): BoxConnection {
    const connection = this.options.connection();
    if (!connection?.connected) {
      throw Object.assign(new Error("The VM is not connected right now."), { code: "BOX_NOT_CONNECTED" });
    }
    return connection;
  }

  private fs(): BoxProjectFs {
    return new BoxProjectFs(this.link());
  }

  /** `~/.orquester` of the box's working user. */
  private stateDir(): string {
    return posix.join(this.link().sys.home, ".orquester");
  }

  desktopDir(desktopId: string): string {
    return posix.join(this.stateDir(), "desktops", desktopId);
  }

  async socketFallback(dir: string, desktopId: string): Promise<string | null> {
    // The uid is only asked for when the dir is too long (the fallback is then named after it).
    if (fallbackSocketDir(dir, desktopId, { tmpDir: "/tmp", uid: 0 }) === null) return null;
    return fallbackSocketDir(dir, desktopId, { tmpDir: "/tmp", uid: await this.uid() });
  }

  private uid(): Promise<number> {
    const connection = this.link();
    if (this.uidRead?.connection !== connection) {
      const uid = runInBox(connection, "id", ["-u"], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: SMALL_OUTPUT_BYTES }).then(({ stdout }) => {
        const value = Number(stdout.trim());
        if (!Number.isInteger(value) || value < 0) throw new Error("The VM did not report its user id.");
        return value;
      });
      uid.catch(() => {
        if (this.uidRead?.uid === uid) this.uidRead = null;
      });
      this.uidRead = { connection, uid };
    }
    return this.uidRead.uid;
  }

  /** The scripts' copy in the box for the current assets (copied once per connection and content). */
  scripts(): Promise<DesktopScripts> {
    const connection = this.link();
    if (this.scriptsCopied?.connection !== connection) {
      const scripts = this.copyScripts(connection);
      scripts.catch(() => {
        if (this.scriptsCopied?.scripts === scripts) this.scriptsCopied = null;
      });
      this.scriptsCopied = { connection, scripts };
    }
    return this.scriptsCopied.scripts;
  }

  private async copyScripts(connection: BoxConnection): Promise<DesktopScripts> {
    const { hash, files } = await shippedAssets();
    const fs = new BoxProjectFs(connection);
    const root = posix.join(posix.join(connection.sys.home, ".orquester"), "desktop-assets");
    const dir = posix.join(root, hash);
    if ((await fs.stat(posix.join(dir, ASSETS_COMPLETE))) === null) {
      for (const file of files) {
        await fs.writeFile(posix.join(dir, file.path), file.data, { mode: file.mode, mkdirs: true });
      }
      await fs.writeFile(posix.join(dir, ASSETS_COMPLETE), `${hash}\n`, { mode: 0o644, mkdirs: true });
      // Older copies go; a running host keeps the script it already has open.
      for (const entry of await fs.readdir(root)) {
        if (entry.name !== hash && entry.kind === "dir") await fs.rm(posix.join(root, entry.name), { recursive: true, force: true });
      }
    }
    return { host: posix.join(dir, HOST_SCRIPT), app: posix.join(dir, APP_SCRIPT) };
  }

  async prepareDirs(dirs: readonly string[]): Promise<void> {
    try {
      await runInBox(this.link(), "/bin/sh", ["-c", PREPARE_DIRS_SCRIPT, "sh", ...dirs], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: SMALL_OUTPUT_BYTES });
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      throw new Error(typeof stderr === "string" && stderr.trim() ? stderr.trim() : (error as Error).message);
    }
  }

  async readText(path: string): Promise<string | null> {
    try {
      return (await this.fs().read(path, { length: MAX_TEXT_BYTES })).toString("utf8");
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return null;
      throw error;
    }
  }

  async readTail(path: string, bytes: number): Promise<string> {
    const fs = this.fs();
    const info = await fs.stat(path);
    if (info === null || info.kind !== "file") return "";
    const length = Math.min(info.size, bytes);
    if (length === 0) return "";
    try {
      return (await fs.read(path, { offset: info.size - length, length })).toString("utf8");
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return "";
      throw error;
    }
  }

  async writeFile(path: string, data: string | Uint8Array, mode: number): Promise<void> {
    await this.fs().writeFile(path, data, { mode });
  }

  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.fs().rm(path, { recursive: options.recursive ?? false, force: true });
  }

  async exists(path: string): Promise<boolean> {
    return (await this.fs().stat(path)) !== null;
  }

  async readdir(path: string): Promise<string[]> {
    try {
      return (await this.fs().readdir(path)).map((entry) => entry.name);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return [];
      throw error;
    }
  }

  watch(dir: string, onChange: (name: string | null) => void, onError: (error: Error) => void): DesktopWatch {
    const watchId = `desktop-${randomUUID()}`;
    let closed = false;
    let connection: BoxConnection | undefined;
    let offEvent: (() => void) | null = null;
    let offStatus: (() => void) | null = null;
    const start = (): void => {
      if (closed || !connection?.connected) return;
      connection.request("fs.watch", { watchId, path: dir, recursive: false }).then(
        // In place: whatever happened before (or while the link was down) is checked again.
        () => {
          if (!closed) onChange(null);
        },
        (error: unknown) => {
          if (!closed && connection?.connected) onError(error instanceof Error ? error : new Error(String(error)));
        }
      );
    };
    const attach = (): void => {
      const current = this.options.connection();
      if (!current || current === connection) return;
      offEvent?.();
      offStatus?.();
      connection = current;
      offEvent = current.onEvent("fs.change", (data) => {
        const event = data as BoxFsChangeEvent | null;
        if (closed || event?.watchId !== watchId || !Array.isArray(event.changes)) return;
        for (const change of event.changes) {
          if (change.path === dir) onChange(null);
          else if (posix.dirname(change.path) === dir) onChange(posix.basename(change.path));
        }
      });
      // A watch ends with its link: put it back on every reconnect.
      offStatus = current.onStatus((up) => {
        if (up) start();
      });
    };
    attach();
    start();
    return {
      close: () => {
        if (closed) return;
        closed = true;
        offEvent?.();
        offStatus?.();
        // Always asked, also while the link is down: a connection that replays watches on
        // reconnect forgets this one at once, and the box ends it once the request gets there.
        void connection?.request("fs.unwatch", { watchId }).catch(() => undefined);
      }
    };
  }

  async signalGroup(pgid: number, signal: NodeJS.Signals, owner?: DesktopGroupOwner): Promise<void> {
    // > 1: never a caller's own group (0) or init's.
    if (!Number.isInteger(pgid) || pgid <= 1) return;
    const name = signal.replace(/^SIG/, "");
    try {
      if (owner) {
        // The check and the kill in one command: no round trip between them.
        const [file, marker] = "environ" in owner ? ["environ", owner.environ] : ["cmdline", owner.argument];
        await runInBox(this.link(), "/bin/sh", ["-c", SIGNAL_OWNED_GROUP_SCRIPT, "sh", String(pgid), name, file, marker], {
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: SMALL_OUTPUT_BYTES
        });
      } else {
        await runInBox(this.link(), "kill", ["-s", name, "--", `-${pgid}`], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: SMALL_OUTPUT_BYTES });
      }
    } catch {
      /* already gone, or the link dropped (the next connect reaps or reattaches) */
    }
  }

  async leaderBelongsTo(pid: number, xauthority: string): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
      const { stdout } = await runInBox(this.link(), "cat", [`/proc/${pid}/environ`], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_TEXT_BYTES });
      return stdout.split("\0").includes(`XAUTHORITY=${xauthority}`);
    } catch {
      return false;
    }
  }

  /**
   * The box's processes start from `orq-agent`'s own environment (the tmux
   * server's, there), never the host's: the env file carries only the
   * desktop's wiring, the tooling plugins' contribution and the user's
   * variables. No host NODE_OPTIONS preload (its path is the host's).
   */
  async appEnv(options: Omit<AppEnvOptions, "base" | "renderNode">): Promise<Record<string, string>> {
    const connection = this.link();
    const base = await boxToolingEnv(connection, toolingFor(this.options.tooling, this.boxId));
    return buildAppEnv({ ...options, base, renderNode: await this.renderNode(connection) });
  }

  private renderNode(connection: BoxConnection): Promise<boolean> {
    if (this.renderNodeRead?.connection !== connection) {
      const present = new BoxProjectFs(connection)
        .readdir("/dev/dri")
        .then((entries) => entries.some((entry) => entry.name.startsWith("renderD")))
        .catch(() => false);
      this.renderNodeRead = { connection, present };
    }
    return this.renderNodeRead.present;
  }

  trackerOptions(options: DesktopWindowTrackerOptions): DesktopWindowTrackerOptions {
    return {
      ...options,
      remote: {
        connect: () => this.connectUnix(x11SocketPath(options.display)),
        readAuthority: () => this.fs().read(options.xauthorityPath, { length: 64 * 1024 }),
        procChain: (pid) => this.procChain(pid)
      }
    };
  }

  private async procChain(pid: number): Promise<ProcStat[]> {
    const { stdout } = await runInBox(this.link(), "/bin/sh", ["-c", PROC_CHAIN_SCRIPT, "sh", String(pid)], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_TEXT_BYTES
    });
    return stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map(parseProcStat)
      .filter((entry): entry is ProcStat => entry !== null);
  }

  /**
   * Whether this box's `orq-agent` opens `unix` channels (the VNC, X11 and
   * PulseAudio sockets go through them); an older one answers UNKNOWN_CHANNEL.
   * Asked once per connection and agent version, by opening one to a path that
   * is not there. Throws when the box cannot be asked (the link dropped).
   */
  unixChannels(): Promise<boolean> {
    const connection = this.link();
    const key = `${connection.agentVersion}`;
    if (this.unixProbe?.connection !== connection || this.unixProbe.key !== key) {
      const supported = connection.openChannel({ kind: "unix", path: UNIX_PROBE_PATH }).then(
        (stream) => {
          stream.destroy();
          return true;
        },
        (error: unknown) => {
          if (errnoOf(error) === "UNKNOWN_CHANNEL") return false;
          if (!connection.connected) throw error;
          return true;
        }
      );
      supported.catch(() => {
        if (this.unixProbe?.supported === supported) this.unixProbe = null;
      });
      this.unixProbe = { connection, key, supported };
    }
    return this.unixProbe.supported;
  }

  connectUnix(path: string): Promise<Duplex> {
    try {
      return this.link().openChannel({ kind: "unix", path });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** ffmpeg in the box: the same arguments as the host's, its Ogg/Opus stream on stdout. */
  readonly audioSpawn: DesktopAudioSpawn = (args) => boxAudioEncoder(this.options.connection(), args);
}

/** The `once` of an encoder process, over the emitter its `error` and `close` come from. */
function onceOn(events: EventEmitter): DesktopAudioEncoderProcess["once"] {
  return ((event: "error" | "close", listener: (...args: unknown[]) => void) => events.once(event, listener)) as DesktopAudioEncoderProcess["once"];
}

/** An encoder process in the box, shaped as the audio hub reads it (`close` after stdout ended and the exit). */
export function boxAudioEncoder(connection: BoxConnection | undefined, args: string[]): DesktopAudioEncoderProcess {
  const events = new EventEmitter();
  let proc: BoxProcess;
  try {
    if (!connection?.connected) throw new Error("The VM is not connected right now.");
    // The pulse server is explicit (`-server unix:…`): no PULSE_SERVER from the box's own env.
    proc = connection.exec({ command: "ffmpeg", args, env: { LANG: "C.UTF-8" }, envUnset: ["PULSE_SERVER"] });
  } catch (error) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.end();
    stderr.end();
    setImmediate(() => events.emit("error", error instanceof Error ? error : new Error(String(error))));
    return { pid: null, stdout, stderr, kill: () => false, once: onceOn(events) };
  }
  let exit: [number | null, NodeJS.Signals | null] | null = null;
  let drained = false;
  let closed = false;
  const maybeClose = (): void => {
    if (closed || exit === null || !drained) return;
    closed = true;
    events.emit("close", ...exit);
  };
  const onDrained = (): void => {
    drained = true;
    maybeClose();
  };
  proc.stdout.once("end", onDrained);
  proc.stdout.once("close", onDrained);
  proc.once("exit", (code, signal) => {
    exit = [code, signal];
    if (proc.stdout.readableEnded || proc.stdout.destroyed) drained = true;
    maybeClose();
  });
  proc.once("error", (error) => events.emit("error", error));
  return {
    get pid() {
      return proc.pid;
    },
    stdout: proc.stdout,
    stderr: proc.stderr,
    kill: (signal) => proc.kill(signal),
    once: onceOn(events)
  };
}
