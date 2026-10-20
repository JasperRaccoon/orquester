/**
 * Test doubles for the remote-exec tests: a `BoxRegistry` + hub pair over a
 * set of box connections, where any path under a registered project root is in
 * that box. Not used by production code.
 */

import { EventEmitter } from "node:events";
import { sep } from "node:path";
import { PassThrough } from "node:stream";

import type { BoxDetachedProcInfo, BoxSummary, BoxSysInfo } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxConnection, BoxExecOptions, BoxHub, BoxProcess, BoxRegistry, ProjectLocation } from "../../contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../../testing.ts";

export function boxRecord(id: string, overrides: Partial<StoredBox> = {}): StoredBox {
  return {
    id,
    purpose: "project",
    kind: "linux",
    provider: "hetzner",
    region: "fsn1",
    size: "cx22",
    name: `orq-${id}`,
    createdAt: "2026-10-20T00:00:00.000Z",
    state: "ready",
    project: null,
    ...overrides
  };
}

export interface FakeBoxes {
  registry: BoxRegistry;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  /** Register a box; `projectPath` makes paths under it box paths. */
  add(record: StoredBox, connection: BoxConnection | undefined): void;
  setConnection(boxId: string, connection: BoxConnection | undefined): void;
  /** Update a record (state changes) and fire `onChange`. */
  update(boxId: string, patch: Partial<StoredBox>): void;
  /** Fire the hub's connection-change listeners. */
  emitConnection(boxId: string, connected: boolean): void;
}

export function fakeBoxes(): FakeBoxes {
  const records = new Map<string, StoredBox>();
  const connections = new Map<string, BoxConnection | undefined>();
  const changes = new EventEmitter();
  const connectionChanges = new EventEmitter();

  const locate = (path: string): ProjectLocation => {
    for (const record of records.values()) {
      const root = record.project?.path;
      if (!root || record.purpose !== "project") continue;
      if (path === root || path.startsWith(root + sep)) {
        return { kind: "box", boxId: record.id, record, connection: connections.get(record.id) };
      }
    }
    return { kind: "host" };
  };

  const registry: BoxRegistry = {
    list: () => [...records.values()],
    get: (boxId) => records.get(boxId),
    summary: (): BoxSummary | undefined => undefined,
    locate,
    async requireConnected(path) {
      const location = locate(path);
      if (location.kind === "host") return null;
      if (!location.connection?.connected || location.record.state !== "ready") {
        throw Object.assign(new Error("The project's box is not connected."), { status: 409, code: "BOX_NOT_READY" });
      }
      return location.connection;
    },
    onChange(listener) {
      changes.on("change", listener);
      return () => changes.off("change", listener);
    }
  };

  const hub: FakeBoxes["hub"] = {
    get: (boxId) => connections.get(boxId),
    onConnectionChange(listener) {
      connectionChanges.on("change", listener);
      return () => connectionChanges.off("change", listener);
    }
  };

  return {
    registry,
    hub,
    add(record, connection) {
      records.set(record.id, record);
      connections.set(record.id, connection);
      // Like the hub: a connection's link changes are announced per box.
      connection?.onStatus((connected) => connectionChanges.emit("change", record.id, connected));
    },
    setConnection(boxId, connection) {
      connections.set(boxId, connection);
    },
    update(boxId, patch) {
      const record = records.get(boxId);
      if (!record) return;
      records.set(boxId, { ...record, ...patch });
      changes.emit("change", boxId);
    },
    emitConnection(boxId, connected) {
      connectionChanges.emit("change", boxId, connected);
    }
  };
}

// ---------------------------------------------------------------------------
// A connection with orq-agent's detached-process semantics
// ---------------------------------------------------------------------------

/** What a test scripts a detached process to do. */
export interface FakeProcControl {
  readonly spec: BoxExecOptions;
  /** Emit output (stream 1 = stdout, 2 = stderr), counted toward the attach offset. */
  write(data: string | Buffer, stream?: 1 | 2): void;
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  readonly input: string[];
  readonly resizes: { cols: number; rows: number }[];
  readonly signals: string[];
}

export type FakeProcBehavior = (control: FakeProcControl) => {
  onInput?(data: string): void;
  /** Default: exit with the signal. */
  onSignal?(signal: string): void;
} | void;

/** Non-detached commands (runInBox): answer them, or `undefined` to run them on this machine. */
export type FakeRunHandler = (spec: BoxExecOptions) => { code: number; stdout?: string; stderr?: string } | undefined;

interface FakeProc {
  procId: string;
  pid: number;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  /** Output kept for reattach, from `bufferStart`, in emission order. */
  buffer: { stream: 1 | 2; data: Buffer }[];
  bufferStart: number;
  outputBytes: number;
  handles: Set<FakeHandle>;
  control: FakeProcControl | null;
  behavior: ReturnType<FakeProcBehavior> | undefined;
}

class FakeHandle extends EventEmitter implements BoxProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  ended = false;

  constructor(
    private readonly proc: FakeProc,
    private readonly onSignal: (signal: string) => void
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      const data = String(chunk);
      proc.control?.input.push(data);
      proc.behavior?.onInput?.(data);
    });
  }

  get pid(): number | null {
    return this.proc.pid;
  }
  get procId(): string {
    return this.proc.procId;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!this.proc.running) return false;
    this.killed = true;
    this.onSignal(signal);
    return true;
  }
  resize(cols: number, rows: number): void {
    this.proc.control?.resizes.push({ cols, rows });
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("exit", code, signal));
  }

  detach(): void {
    if (this.ended) return;
    this.ended = true;
    setImmediate(() => this.emit("detached"));
  }
}

export interface FakeAgentConnection extends LocalBoxConnection {
  /** Every exec, detached or not, in order. */
  readonly execs: BoxExecOptions[];
  /** A detached process by procId. */
  proc(procId: string): FakeProcControl | undefined;
  /** Drop the link: detached handles emit "detached", others end with SIGHUP. */
  dropLink(): void;
  restoreLink(): void;
  /** Forget every process (an orq-agent restart). */
  restartAgent(): void;
  /** Resolves with the params of the next request of `method`. */
  nextCall(method: string): Promise<unknown>;
  /** Resolves with the next exec matching `predicate`. */
  nextExec(predicate: (spec: BoxExecOptions) => boolean): Promise<BoxExecOptions>;
}

/**
 * A `BoxConnection` that keeps detached processes like `orq-agent` does: their
 * output is buffered with offsets, `attach(procId, from)` replays it and
 * continues live, a link drop detaches instead of killing, and `proc.list`,
 * `proc.signal`, `proc.release` work on the table. Detached processes are
 * scripted by `behavior`; other commands go to `run` or run on this machine.
 */
export function fakeAgentConnection(
  options: { boxId?: string; sys?: Partial<BoxSysInfo>; behavior?: FakeProcBehavior; run?: FakeRunHandler; bufferBytes?: number } = {}
): FakeAgentConnection {
  const base = localBoxConnection({ boxId: options.boxId ?? "box-1", sys: options.sys });
  const localExec = base.exec.bind(base);
  const localRequest = base.request.bind(base) as (method: string, params: unknown) => Promise<unknown>;
  const procs = new Map<string, FakeProc>();
  const loose = new Set<FakeHandle>();
  const execs: BoxExecOptions[] = [];
  const waiters = new EventEmitter();
  let nextPid = 4000;
  const cap = options.bufferBytes ?? 1024 * 1024;

  const notConnected = (): Error => Object.assign(new Error("Box is not connected"), { code: "BOX_NOT_CONNECTED" });

  const emitOutput = (proc: FakeProc, data: Buffer, stream: 1 | 2): void => {
    proc.outputBytes += data.length;
    proc.buffer.push({ stream, data });
    let kept = proc.buffer.reduce((sum, segment) => sum + segment.data.length, 0);
    while (kept > cap && proc.buffer.length > 0) {
      const first = proc.buffer[0]!;
      const drop = Math.min(first.data.length, kept - cap);
      if (drop === first.data.length) proc.buffer.shift();
      else first.data = first.data.subarray(drop);
      proc.bufferStart += drop;
      kept -= drop;
    }
    for (const handle of proc.handles) (stream === 2 ? handle.stderr : handle.stdout).write(data);
  };

  const signalProc = (proc: FakeProc, signal: string): void => {
    proc.control?.signals.push(signal);
    if (proc.behavior?.onSignal) proc.behavior.onSignal(signal);
    else proc.control?.exit(null, signal as NodeJS.Signals);
  };

  const newHandle = (proc: FakeProc): FakeHandle => {
    const handle = new FakeHandle(proc, (signal) => signalProc(proc, signal));
    proc.handles.add(handle);
    return handle;
  };

  const emptyProc = (procId: string): FakeProc => ({
    procId,
    pid: nextPid++,
    running: true,
    exitCode: null,
    signal: null,
    buffer: [],
    bufferStart: 0,
    outputBytes: 0,
    handles: new Set(),
    control: null,
    behavior: undefined
  });

  const connection = base as FakeAgentConnection;
  Object.assign(connection, {
    execs,
    exec(spec: BoxExecOptions): BoxProcess {
      if (!connection.connected) throw notConnected();
      execs.push(spec);
      waiters.emit("exec", spec);
      if (!spec.detach) {
        const answer = options.run?.(spec);
        if (answer === undefined) return localExec(spec);
        const proc = emptyProc("");
        const handle = new FakeHandle(proc, () => undefined);
        loose.add(handle);
        handle.stdin.resume();
        setImmediate(() => {
          if (answer.stdout) handle.stdout.write(answer.stdout);
          if (answer.stderr) handle.stderr.write(answer.stderr);
          proc.running = false;
          loose.delete(handle);
          handle.finish(answer.code, null);
        });
        return handle;
      }
      const procId = spec.detach.procId;
      if (procs.get(procId)?.running) throw new Error(`procId ${procId} is already running`);
      const proc = emptyProc(procId);
      const control: FakeProcControl = {
        spec,
        input: [],
        resizes: [],
        signals: [],
        write(data, stream = 1) {
          if (proc.running) emitOutput(proc, Buffer.from(data), stream);
        },
        exit(code, signal = null) {
          if (!proc.running) return;
          proc.running = false;
          proc.exitCode = code;
          proc.signal = signal;
          for (const handle of proc.handles) handle.finish(code, signal);
          proc.handles.clear();
        }
      };
      proc.control = control;
      procs.set(procId, proc);
      const handle = newHandle(proc);
      proc.behavior = (options.behavior ?? (() => undefined))(control);
      return handle;
    },
    attach(procId: string, fromOffset: number): BoxProcess {
      if (!connection.connected) throw notConnected();
      const proc = procs.get(procId);
      if (!proc) throw Object.assign(new Error(`UNKNOWN_PROC ${procId}`), { code: "UNKNOWN_PROC" });
      const handle = newHandle(proc);
      // Replay what is kept from `fromOffset`, each byte on the stream it was emitted on.
      let at = proc.bufferStart;
      for (const segment of proc.buffer) {
        const end = at + segment.data.length;
        if (end > fromOffset) {
          const part = segment.data.subarray(Math.max(0, fromOffset - at));
          (segment.stream === 2 ? handle.stderr : handle.stdout).write(part);
        }
        at = end;
      }
      if (!proc.running) {
        proc.handles.delete(handle);
        handle.finish(proc.exitCode, proc.signal as NodeJS.Signals | null);
      }
      return handle;
    },
    detachedProcs(): BoxDetachedProcInfo[] {
      return [...procs.values()].map((proc) => ({
        procId: proc.procId,
        pid: proc.running ? proc.pid : null,
        running: proc.running,
        exitCode: proc.exitCode,
        signal: proc.signal,
        outputBytes: proc.outputBytes,
        bufferStart: proc.bufferStart
      }));
    },
    async request(method: string, params: unknown): Promise<unknown> {
      if (method === "proc.list" || method === "proc.signal" || method === "proc.release") {
        if (!connection.connected) throw notConnected();
        connection.calls.push({ method, params });
        setImmediate(() => waiters.emit(`call:${method}`, params));
      }
      if (method === "proc.list") return connection.detachedProcs();
      if (method === "proc.signal") {
        const { procId, signal } = params as { procId: string; signal: string };
        const proc = procs.get(procId);
        if (proc?.running) signalProc(proc, signal);
        return undefined;
      }
      if (method === "proc.release") {
        const { procId } = params as { procId: string };
        // As orq-agent: a running process is not released (BUSY); an unknown one is a no-op.
        if (procs.get(procId)?.running) throw Object.assign(new Error("the process is still running; signal it first"), { code: "BUSY" });
        procs.delete(procId);
        return undefined;
      }
      return localRequest(method, params);
    },
    proc(procId: string): FakeProcControl | undefined {
      return procs.get(procId)?.control ?? undefined;
    },
    dropLink(): void {
      for (const proc of procs.values()) {
        for (const handle of proc.handles) handle.detach();
        proc.handles.clear();
      }
      for (const handle of loose) handle.finish(null, "SIGHUP");
      loose.clear();
      base.setConnected(false);
    },
    restoreLink(): void {
      base.setConnected(true);
    },
    restartAgent(): void {
      procs.clear();
    },
    nextCall(method: string): Promise<unknown> {
      return new Promise((resolve) => waiters.once(`call:${method}`, resolve));
    },
    nextExec(predicate: (spec: BoxExecOptions) => boolean): Promise<BoxExecOptions> {
      return new Promise((resolve) => {
        const listener = (spec: BoxExecOptions): void => {
          if (!predicate(spec)) return;
          waiters.off("exec", listener);
          resolve(spec);
        };
        waiters.on("exec", listener);
      });
    }
  });
  return connection;
}
