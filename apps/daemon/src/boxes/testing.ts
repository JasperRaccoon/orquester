/**
 * Test doubles for the box seams (`contracts.ts`).
 *
 * {@link localBoxConnection} is a `BoxConnection` whose "box" is this machine:
 * exec runs a local child process, the fs methods use node:fs, TCP opens a
 * local socket. Modules that consume a `BoxConnection` (fs and git routing,
 * agent spawning, sync, tooling) test against it without a real box or
 * `orq-agent`. It does not model disconnects except through `setConnected`.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { arch as osArch, cpus, homedir, hostname, platform, totalmem, userInfo } from "node:os";
import { dirname } from "node:path";
import { PassThrough, Readable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  BoxDetachedProcInfo,
  BoxFsDirEntry,
  BoxFsStat,
  BoxHostToBoxMethods,
  BoxMethodName,
  BoxMethodParams,
  BoxMethodResult,
  BoxPathMap,
  BoxSysInfo
} from "@orquester/api";

import type { BoxConnection, BoxExecOptions, BoxHostForward, BoxProcess, BoxRequestOptions } from "./contracts.ts";

export function localSysInfo(overrides: Partial<BoxSysInfo> = {}): BoxSysInfo {
  const os = platform() === "win32" ? "win32" : platform() === "darwin" ? "darwin" : "linux";
  return {
    os,
    arch: osArch() === "arm64" ? "arm64" : "x64",
    libc: os === "linux" ? "glibc" : null,
    hostname: hostname(),
    osRelease: "test",
    user: userInfo().username,
    isRoot: process.getuid?.() === 0,
    canElevate: false,
    home: homedir(),
    shell: process.env.SHELL ?? "/bin/sh",
    tmux: false,
    docker: false,
    cpus: cpus().length,
    memBytes: totalmem(),
    gpus: [],
    agentPath: process.execPath,
    dataDir: "/tmp",
    container: false,
    ...overrides
  };
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): BoxFsStat["kind"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

class LocalBoxProcess extends EventEmitter implements BoxProcess {
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly procId: string | null;
  private readonly child;

  constructor(options: BoxExecOptions) {
    super();
    const env = { ...process.env, ...(options.env ?? {}) };
    for (const key of options.envUnset ?? []) delete env[key];
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env,
      shell: options.shell === true,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal
    });
    this.stdin = this.child.stdin;
    this.stdout = this.child.stdout;
    this.stderr = this.child.stderr;
    this.procId = options.detach?.procId ?? null;
    this.child.on("spawn", () => this.emit("spawn"));
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("exit", (code, signal) => this.emit("exit", code, signal));
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }
  get exitCode(): number | null {
    return this.child.exitCode;
  }
  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode;
  }
  get killed(): boolean {
    return this.child.killed;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return false;
    return this.child.kill(signal);
  }
  resize(): void {
    // No PTY in the local double.
  }
}

export interface LocalBoxConnectionOptions {
  boxId?: string;
  sys?: Partial<BoxSysInfo>;
  paths?: BoxPathMap;
  /** Extra handlers for feature-namespace requests (`sync.*`, `tooling.*`). */
  rawHandlers?: Record<string, (params: unknown) => Promise<unknown>>;
}

export interface LocalBoxConnection extends BoxConnection {
  setConnected(connected: boolean): void;
  emitEvent(name: string, data: unknown): void;
  /** Every request made, in order (method + params), for assertions. */
  readonly calls: { method: string; params: unknown }[];
}

export function localBoxConnection(options: LocalBoxConnectionOptions = {}): LocalBoxConnection {
  const events = new EventEmitter();
  const status = new EventEmitter();
  let connected = true;
  const calls: { method: string; params: unknown }[] = [];
  const sys = localSysInfo(options.sys);

  const handlers: { [K in BoxMethodName<BoxHostToBoxMethods>]?: (params: BoxMethodParams<BoxHostToBoxMethods, K>) => Promise<BoxMethodResult<BoxHostToBoxMethods, K>> } = {
    "fs.stat": async ({ path, followSymlinks }) => {
      try {
        const s = followSymlinks === false ? await lstat(path) : await stat(path);
        return { path, kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, identity: `${s.dev}:${s.ino}` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    "fs.readdir": async ({ path }) => {
      const entries = await readdir(path, { withFileTypes: true });
      const out: BoxFsDirEntry[] = [];
      for (const entry of entries) {
        const s = await lstat(`${path}/${entry.name}`).catch(() => null);
        out.push({ name: entry.name, kind: kindOf(entry), size: s?.size ?? 0, mtimeMs: s?.mtimeMs ?? 0 });
      }
      return out;
    },
    "fs.realpath": async ({ path }) => realpath(path),
    "fs.mkdir": async ({ path, recursive, mode }) => {
      await mkdir(path, { recursive: recursive ?? false, mode });
    },
    "fs.rename": async ({ from, to }) => rename(from, to),
    "fs.rm": async ({ path, recursive, force }) => rm(path, { recursive, force }),
    "fs.chmod": async ({ path, mode }) => chmod(path, mode),
    "fs.symlink": async ({ target, path }) => symlink(target, path),
    "fs.watch": async () => undefined,
    "fs.unwatch": async () => undefined,
    "sys.info": async () => sys,
    "sys.ports": async () => [],
    "sys.stats": async () => ({ cpuPercent: 0, memUsedBytes: 0, memTotalBytes: totalmem(), diskUsedBytes: 0, diskTotalBytes: 0, uptimeSeconds: 0 }),
    "proc.list": async () => [],
    "proc.signal": async () => undefined,
    "proc.release": async () => undefined,
    "forward.listen": async () => undefined,
    "forward.unlisten": async () => undefined,
    "agent.ensurePaths": async ({ paths }) => {
      for (const path of paths) await mkdir(path, { recursive: true });
    },
    "agent.update": async () => undefined,
    "agent.shutdown": async () => undefined
  };

  const requireConnected = (): void => {
    if (!connected) throw Object.assign(new Error("Box is not connected"), { code: "BOX_NOT_CONNECTED" });
  };

  const connection: LocalBoxConnection = {
    boxId: options.boxId ?? "local-test-box",
    sys,
    paths: options.paths ?? { kind: "identity" },
    get connected() {
      return connected;
    },
    agentVersion: "test",
    calls,
    detachedProcs: (): BoxDetachedProcInfo[] => [],
    async request<K extends BoxMethodName<BoxHostToBoxMethods>>(
      method: K,
      params: BoxMethodParams<BoxHostToBoxMethods, K>,
      _options?: BoxRequestOptions
    ): Promise<BoxMethodResult<BoxHostToBoxMethods, K>> {
      requireConnected();
      calls.push({ method, params });
      const handler = handlers[method] as ((p: typeof params) => Promise<BoxMethodResult<BoxHostToBoxMethods, K>>) | undefined;
      if (!handler) throw new Error(`UNKNOWN_METHOD ${method}`);
      return handler(params);
    },
    async requestRaw(method: string, params: unknown): Promise<unknown> {
      requireConnected();
      calls.push({ method, params });
      const handler = options.rawHandlers?.[method];
      if (!handler) throw new Error(`UNKNOWN_METHOD ${method}`);
      return handler(params);
    },
    exec(execOptions: BoxExecOptions): BoxProcess {
      requireConnected();
      return new LocalBoxProcess(execOptions);
    },
    attach(): BoxProcess {
      throw new Error("attach is not supported by the local box double");
    },
    async openTcp(port: number, host = "127.0.0.1"): Promise<Duplex> {
      requireConnected();
      return await new Promise((resolve, reject) => {
        const socket = createConnection({ port, host }, () => resolve(socket));
        socket.once("error", reject);
      });
    },
    async forwardToHost(boxPort: number, forwardOptions?: { hostPort?: number }): Promise<BoxHostForward> {
      const server = createServer((client) => {
        const upstream = createConnection({ port: boxPort, host: "127.0.0.1" });
        client.pipe(upstream).pipe(client);
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
      });
      // A taken host port (EADDRINUSE) rejects, as the hub's forward does.
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(forwardOptions?.hostPort ?? 0, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
      return {
        hostPort: (server.address() as AddressInfo).port,
        boxPort,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
      };
    },
    async openChannel(): Promise<Duplex> {
      throw new Error("openChannel is not supported by the local box double");
    },
    async readFile(path: string, readOptions?: { offset?: number; length?: number }): Promise<Readable> {
      requireConnected();
      const start = readOptions?.offset ?? 0;
      const end = readOptions?.length !== undefined ? start + readOptions.length - 1 : undefined;
      return createReadStream(path, { start, end });
    },
    async writeFile(path: string, data: Readable | Uint8Array | string, writeOptions?: { mode?: number; mkdirs?: boolean }): Promise<void> {
      requireConnected();
      if (writeOptions?.mkdirs) await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.orq-tmp-${process.pid}-${Date.now()}`;
      const source = typeof data === "string" || data instanceof Uint8Array ? Readable.from([data]) : data;
      await pipeline(source, createWriteStream(tmp, { mode: writeOptions?.mode }));
      await rename(tmp, path);
    },
    async readTar(path: string): Promise<Readable> {
      requireConnected();
      const child = spawn("tar", ["-cf", "-", "-C", dirname(path), path.split("/").pop() ?? "."], { stdio: ["ignore", "pipe", "ignore"] });
      const out = new PassThrough();
      child.stdout.pipe(out);
      return out;
    },
    async writeTar(path: string, tar: Readable): Promise<void> {
      requireConnected();
      await mkdir(path, { recursive: true });
      const child = spawn("tar", ["-xf", "-", "-C", path], { stdio: ["pipe", "ignore", "ignore"] });
      // Listened for before the pipeline: a tar that exits as soon as its input ends is not missed.
      const exited = new Promise<void>((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))));
      await pipeline(tar, child.stdin);
      await exited;
    },
    onEvent(name: string, listener: (data: unknown) => void): () => void {
      events.on(name, listener);
      return () => events.off(name, listener);
    },
    onStatus(listener: (isConnected: boolean) => void): () => void {
      status.on("status", listener);
      return () => status.off("status", listener);
    },
    setConnected(next: boolean): void {
      if (next === connected) return;
      connected = next;
      status.emit("status", next);
    },
    emitEvent(name: string, data: unknown): void {
      events.emit(name, data);
    }
  };
  return connection;
}
