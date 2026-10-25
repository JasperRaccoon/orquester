/**
 * Agent host — test doubles for agent CLIs in boxes (not a `*.test.ts`; typechecked with the
 * package).
 *
 * - {@link reattachableBoxConnection}: `localBoxConnection()` plus what it does not model — a
 *   detached process surviving a dropped link and a reattach from a byte offset (the protocol's
 *   own semantics, `box-protocol.ts`).
 * - {@link redirectedBoxConnection}: every box file write lands under a temp root, recorded, so
 *   a test of "copied into the box at its mapped path" never touches the real path.
 * - {@link rootedReadsBoxConnection}: the box's file reads see a temp root — the box's own files,
 *   apart from this machine's same paths (a box project's host directory is an empty stub).
 * - {@link recordingTokens} / {@link recordingSync}: the broker and the sync seams, recording.
 * - {@link writeReplayPeer}: a stdio peer that answers each request with the frames a recorded
 *   provider fixture shows after that request (`apps/daemon/test/fixtures/<provider>/`), so a box
 *   launch test is tied to observed frames.
 */

import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, type Readable } from "node:stream";

import type { AgentTokenGrant, BoxConnection, BoxExecOptions, BoxProcess, BoxRequestOptions } from "../../boxes/contracts.ts";
import { localBoxConnection, type LocalBoxConnection, type LocalBoxConnectionOptions } from "../../boxes/testing.ts";
import type { BoxTokenRequest } from "../host-protocol.ts";
import type { BoxSyncClient, BoxTokenSource } from "./daemon-client.ts";

// ---------------------------------------------------------------------------
// Detach and reattach
// ---------------------------------------------------------------------------

interface DetachedRecord {
  real: BoxProcess;
  /** Every output byte so far, stdout and stderr in emission order. */
  chunks: { stream: "out" | "err"; data: Buffer }[];
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  /** The proxy currently attached, if any. */
  proxy: ProxyProcess | null;
  /** Set by {@link ReattachableBoxConnection.restartAgent} (`"lose"`): the box's `lost` reason. */
  lost?: string;
}

class ProxyProcess extends EventEmitter implements BoxProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(private readonly record: DetachedRecord, readonly procId: string) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      if (this.record.proxy === this) this.record.real.stdin.write(chunk);
    });
    this.stdin.on("end", () => {
      if (this.record.proxy === this) this.record.real.stdin.end();
    });
  }
  get pid(): number | null {
    return this.record.real.pid;
  }
  get exitCode(): number | null {
    return this.record.exit?.code ?? null;
  }
  get signalCode(): NodeJS.Signals | null {
    return this.record.exit?.signal ?? null;
  }
  get killed(): boolean {
    return this.record.real.killed;
  }
  kill(signal?: NodeJS.Signals): boolean {
    return this.record.real.kill(signal);
  }
  resize(): void {
    // No PTY here.
  }
}

export interface ReattachableBoxConnection extends LocalBoxConnection {
  /** The link drops: every attached detached process emits `detached`; the processes run on. */
  dropLink(): void;
  /** The link is back. */
  restoreLink(): void;
  /** `attach` calls made, for assertions. */
  readonly attaches: { procId: string; fromOffset: number }[];
  /** Detached processes released (`proc.release` of an ended one), in order. */
  readonly releases: string[];
  /** Resolves once a detached process's whole output so far satisfies `predicate` (attached or not). */
  outputSeen(procId: string, predicate: (text: string) => boolean): Promise<void>;
  /** SIGKILL every process this double started (a test's cleanup). */
  killAll(): Promise<void>;
  /**
   * `orq-agent` restarts in the box while the link is down; its detached processes end. `"lose"`:
   * as an `orq-agent` that records them (`procstate.go`) — listed as ended and `lost` with
   * `reason`, an attach refused with `LOST`. `"forget"`: as one that does not — no trace of them.
   * `"unrecorded"`: listed as ended with neither an exit code nor a signal (an `orq-agent` that
   * could not tell how it ended), and an attach replays that.
   */
  restartAgent(mode: "lose" | "forget" | "unrecorded", reason?: string): Promise<void>;
}

export function reattachableBoxConnection(options: LocalBoxConnectionOptions = {}): ReattachableBoxConnection {
  const base = localBoxConnection(options);
  const detached = new Map<string, DetachedRecord>();
  const started: BoxProcess[] = [];
  const attaches: { procId: string; fromOffset: number }[] = [];
  const releases: string[] = [];
  const output = new EventEmitter();
  const textOf = (record: DetachedRecord): string => Buffer.concat(record.chunks.map((chunk) => chunk.data)).toString("utf8");

  const feed = (record: DetachedRecord, proxy: ProxyProcess, fromOffset: number): void => {
    let offset = 0;
    for (const chunk of record.chunks) {
      const end = offset + chunk.data.length;
      if (end > fromOffset) {
        const slice = chunk.data.subarray(Math.max(0, fromOffset - offset));
        (chunk.stream === "out" ? proxy.stdout : proxy.stderr).write(slice);
      }
      offset = end;
    }
    if (record.exit !== null) {
      proxy.stdout.end();
      proxy.stderr.end();
      queueMicrotask(() => proxy.emit("exit", record.exit!.code, record.exit!.signal));
    }
  };

  const connection: ReattachableBoxConnection = Object.assign(Object.create(base) as object, {
    attaches,
    releases,
    exec(execOptions: BoxExecOptions): BoxProcess {
      const real = base.exec(execOptions);
      started.push(real);
      const procId = execOptions.detach?.procId;
      if (procId === undefined) return real;
      const record: DetachedRecord = { real, chunks: [], exit: null, proxy: null };
      const proxy = new ProxyProcess(record, procId);
      record.proxy = proxy;
      detached.set(procId, record);
      real.stdout.on("data", (data: Buffer) => {
        record.chunks.push({ stream: "out", data });
        if (record.proxy !== null) record.proxy.stdout.write(data);
        output.emit(procId, textOf(record));
      });
      real.stderr.on("data", (data: Buffer) => {
        record.chunks.push({ stream: "err", data });
        if (record.proxy !== null) record.proxy.stderr.write(data);
        output.emit(procId, textOf(record));
      });
      real.on("spawn", () => record.proxy?.emit("spawn"));
      real.on("error", (error: Error) => record.proxy?.emit("error", error));
      real.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        record.exit = { code, signal };
        const current = record.proxy;
        if (current !== null) {
          current.stdout.end();
          current.stderr.end();
          current.emit("exit", code, signal);
        }
      });
      return proxy;
    },
    attach(procId: string, fromOffset: number): BoxProcess {
      attaches.push({ procId, fromOffset });
      if (!base.connected) throw Object.assign(new Error("Box is not connected"), { code: "BOX_NOT_CONNECTED" });
      const record = detached.get(procId);
      const proxy = new ProxyProcess(record ?? { real: null as never, chunks: [], exit: null, proxy: null }, procId);
      if (record === undefined) {
        queueMicrotask(() => proxy.emit("error", Object.assign(new Error(`no detached process ${procId}`), { code: "NOT_FOUND" })));
        return proxy;
      }
      if (record.lost !== undefined) {
        const lost = record.lost;
        queueMicrotask(() => proxy.emit("error", Object.assign(new Error(lost), { code: "LOST" })));
        return proxy;
      }
      record.proxy = proxy;
      queueMicrotask(() => {
        proxy.emit("spawn");
        feed(record, proxy, fromOffset);
      });
      return proxy;
    },
    async request(method: string, params: unknown, requestOptions?: unknown): Promise<unknown> {
      if (method === "proc.list") {
        return [...detached.entries()].map(([procId, record]) => ({
          procId,
          pid: record.real.pid,
          running: record.exit === null,
          exitCode: record.exit?.code ?? null,
          signal: record.exit?.signal ?? null,
          outputBytes: record.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0),
          bufferStart: 0,
          ...(record.lost !== undefined ? { lost: record.lost } : {})
        }));
      }
      if (method === "proc.signal") {
        const { procId, signal } = params as { procId: string; signal: NodeJS.Signals };
        detached.get(procId)?.real.kill(signal);
        return undefined;
      }
      if (method === "proc.release") {
        const procId = (params as { procId: string }).procId;
        // As the box agent (`procs.go`): a process that still runs is not released.
        if (detached.get(procId)?.exit === null) {
          throw Object.assign(new Error("the process is still running; signal it first"), { code: "BUSY" });
        }
        detached.delete(procId);
        releases.push(procId);
        return undefined;
      }
      return (base.request as (m: string, p: unknown, o?: unknown) => Promise<unknown>)(method, params, requestOptions);
    },
    dropLink(): void {
      base.setConnected(false);
      for (const record of detached.values()) {
        const proxy = record.proxy;
        if (proxy !== null && record.exit === null) {
          record.proxy = null;
          proxy.emit("detached");
        }
      }
    },
    restoreLink(): void {
      base.setConnected(true);
    },
    async restartAgent(mode: "lose" | "forget" | "unrecorded", reason = "orq-agent restarted in the box; it was stopped"): Promise<void> {
      for (const [procId, record] of [...detached]) {
        if (record.exit === null) {
          const exited = new Promise<void>((resolve) => record.real.once("exit", () => resolve()));
          record.real.kill("SIGTERM");
          await exited;
        }
        if (mode === "forget") {
          detached.delete(procId);
        } else if (mode === "unrecorded") {
          detached.set(procId, { real: record.real, chunks: record.chunks, exit: { code: null, signal: null }, proxy: null });
        } else {
          // Its output went with the old orq-agent: nothing to replay.
          detached.set(procId, { real: record.real, chunks: [], exit: { code: null, signal: "SIGTERM" }, proxy: null, lost: reason });
        }
      }
    },
    outputSeen(procId: string, predicate: (text: string) => boolean): Promise<void> {
      const record = detached.get(procId);
      if (record !== undefined && predicate(textOf(record))) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const listener = (text: string): void => {
          if (!predicate(text)) return;
          output.off(procId, listener);
          resolve();
        };
        output.on(procId, listener);
      });
    },
    async killAll(): Promise<void> {
      await Promise.all(
        started.map(async (proc) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return;
          const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
          proc.kill("SIGKILL");
          await exited;
        })
      );
    }
  }) as ReattachableBoxConnection;
  return connection;
}

// ---------------------------------------------------------------------------
// File writes into the "box", redirected
// ---------------------------------------------------------------------------

export interface RedirectedBoxConnection extends BoxConnection {
  /** Every box path written, in order. */
  readonly writes: string[];
  /** Where a box path's bytes landed. */
  localPathOf(boxPath: string): string;
}

/** A connection whose file writes land under `root` (box path → `root` + the path, separators normalised). */
export function redirectedBoxConnection(base: BoxConnection, root: string): RedirectedBoxConnection {
  const writes: string[] = [];
  const localPathOf = (boxPath: string): string => join(root, boxPath.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/"));
  // The prototype is the base connection, so its getters (`connected`) stay live.
  return Object.assign(Object.create(base) as object, {
    writes,
    localPathOf,
    async writeFile(path: string, data: Readable | Uint8Array | string, options?: { mode?: number; mkdirs?: boolean }): Promise<void> {
      writes.push(path);
      const target = localPathOf(path);
      await mkdir(dirname(target), { recursive: true });
      await base.writeFile(target, data, { ...options, mkdirs: true });
    }
  }) as RedirectedBoxConnection;
}

/** A connection whose file reads (`fs.stat`, `fs.readdir`, `readFile`) see `root` + the box path. */
export function rootedReadsBoxConnection(base: BoxConnection, root: string): BoxConnection {
  const local = (boxPath: string): string => join(root, boxPath.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/"));
  const request = base.request.bind(base) as (method: string, params: unknown, options?: BoxRequestOptions) => Promise<unknown>;
  // The prototype is the base connection, so its getters (`connected`) stay live.
  return Object.assign(Object.create(base) as object, {
    request: (method: string, params: unknown, options?: BoxRequestOptions) => {
      const path = typeof params === "object" && params !== null ? (params as { path?: unknown }).path : undefined;
      if ((method === "fs.stat" || method === "fs.readdir") && typeof path === "string") {
        return request(method, { ...(params as object), path: local(path) }, options);
      }
      return request(method, params, options);
    },
    readFile: (path: string, options?: Parameters<BoxConnection["readFile"]>[1]) => base.readFile(local(path), options)
  }) as BoxConnection;
}

// ---------------------------------------------------------------------------
// The broker and the sync seams
// ---------------------------------------------------------------------------

export interface RecordingTokens extends BoxTokenSource {
  readonly requests: BoxTokenRequest[];
  /** The grant the next requests answer. */
  grant: AgentTokenGrant;
}

export function recordingTokens(grant: AgentTokenGrant): RecordingTokens {
  const requests: BoxTokenRequest[] = [];
  const tokens: RecordingTokens = {
    requests,
    grant,
    getToken: async (request) => {
      requests.push(request);
      return tokens.grant;
    }
  };
  return tokens;
}

export interface RecordingSync extends BoxSyncClient {
  readonly calls: { op: string; boxId: string; detail: unknown }[];
}

export function recordingSync(): RecordingSync {
  const calls: RecordingSync["calls"] = [];
  return {
    calls,
    ensureSynced: async (boxId, scope) => {
      calls.push({ op: "ensureSynced", boxId, detail: scope });
    },
    pushForResume: async (boxId, request) => {
      calls.push({ op: "pushForResume", boxId, detail: request });
    },
    pullAfterTurn: async (boxId, request) => {
      calls.push({ op: "pullAfterTurn", boxId, detail: request });
    },
    turnEnded: async (boxId, threadId) => {
      calls.push({ op: "turnEnded", boxId, detail: threadId });
    },
    turnStarted: async (boxId, threadId) => {
      calls.push({ op: "turnStarted", boxId, detail: threadId });
    }
  };
}

// ---------------------------------------------------------------------------
// A fixture replay peer
// ---------------------------------------------------------------------------

export interface ReplayPeerExtras {
  /** Answers for methods the fixture never shows (`account/login/start` …), by method. */
  results?: Record<string, unknown>;
  /** Frames to send right after answering `method` (server requests or notifications). */
  after?: Record<string, unknown[]>;
  /** What `<peer> --version` prints (a launch's version probe). */
  version?: string;
  /** What `<peer> inspect --json` prints (Grok's own inventory). */
  inspect?: unknown;
}

const REPLAY_PEER_SOURCE = `#!/usr/bin/env node
// Generated by agent-host/boxes/testing.ts: answers each request with the frames a recorded
// fixture shows after the same request; logs everything it receives.
import { appendFileSync, readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
if (process.argv.includes("--version")) {
  process.stdout.write((config.version ?? "replay-peer 0.0.0") + "\\n");
  process.exit(0);
}
if (process.argv[2] === "inspect") {
  process.stdout.write(JSON.stringify(config.inspect ?? {}) + "\\n");
  process.exit(0);
}
const frames = readFileSync(config.fixture, "utf8").split("\\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
const log = (record) => { try { appendFileSync(config.logPath, JSON.stringify(record) + "\\n"); } catch {} };
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let cursor = 0;
let serverId = 1000;
const answer = (frame) => {
  for (let i = cursor; i < frames.length; i += 1) {
    const f = frames[i];
    if (f.dir !== "send" || f.frame.method !== frame.method) continue;
    cursor = i + 1;
    for (let j = cursor; j < frames.length && frames[j].dir !== "send"; j += 1) {
      if (frames[j].dir !== "recv") continue;
      const out = { ...frames[j].frame };
      if (out.id !== undefined && out.method === undefined && out.id === f.frame.id) out.id = frame.id;
      send(out);
    }
    return true;
  }
  return false;
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    const frame = JSON.parse(line);
    log(frame);
    if (frame.method === undefined) continue;
    if (!answer(frame) && frame.id !== undefined) {
      if (config.results && Object.prototype.hasOwnProperty.call(config.results, frame.method)) {
        send({ id: frame.id, result: config.results[frame.method] });
      } else {
        send({ id: frame.id, error: { code: -32601, message: "Method not found: " + frame.method } });
      }
    }
    for (const extra of (config.after && config.after[frame.method]) || []) {
      send(extra.method !== undefined && extra.id === "next" ? { ...extra, id: serverId++ } : extra);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/**
 * Write the replay peer for `fixture` as an executable (`bin`, any argv — it reads the config
 * beside itself). `logPath` collects every frame it received (one JSON per line).
 */
export function writeReplayPeer(fixture: string, extras: ReplayPeerExtras = {}): { bin: string; logPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "box-replay-peer-"));
  const logPath = join(dir, "received.ndjson");
  writeFileSync(logPath, "", "utf8");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ fixture, logPath, ...extras }), "utf8");
  const bin = join(dir, "peer.mjs");
  writeFileSync(bin, REPLAY_PEER_SOURCE, "utf8");
  chmodSync(bin, 0o755);
  return { bin, logPath, dir };
}
