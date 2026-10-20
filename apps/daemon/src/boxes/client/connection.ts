/**
 * `BoxConnection` over a {@link BoxMux} that can be swapped as the link drops
 * and returns (contracts.ts: "a connection object stays valid across
 * reconnects"). Used by the hub (mux over the box's WebSocket) and by
 * `connectBoxRelay` (mux over a relay socket). Requests made while
 * disconnected wait for the next link until their timeout.
 *
 * Static imports only: this module runs inside the agent host.
 */

import { EventEmitter } from "node:events";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";

import {
  BOX_STREAM_FROM_BOX,
  BOX_STREAM_STDERR,
  BOX_STREAM_TO_BOX,
  type BoxChannelSpec,
  type BoxDetachedProcInfo,
  type BoxForwardSpec,
  type BoxHostToBoxMethods,
  type BoxMethodName,
  type BoxMethodParams,
  type BoxMethodResult,
  type BoxPathMap,
  type BoxStream,
  type BoxSysInfo
} from "@orquester/api";

import type { BoxConnection, BoxExecOptions, BoxHostForward, BoxProcess, BoxRequestOptions } from "../contracts.ts";
import { BOX_DISCONNECTED, BoxError, disconnectedError, type BoxMux, type MuxChannel } from "./mux.ts";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** How long exec/attach/open wait for a link before failing. */
export const CHANNEL_OPEN_TIMEOUT_MS = 30_000;

export interface LinkInfo {
  sys: BoxSysInfo;
  paths: BoxPathMap;
  agentVersion: string;
  procs: BoxDetachedProcInfo[];
}

/** A Readable fed by one inbound stream, returning credit as it drains. */
class ChannelReadable extends Readable {
  private held = 0;
  private readonly credit: (bytes: number) => void;

  constructor(credit: (bytes: number) => void) {
    super();
    this.credit = credit;
  }

  feed(chunk: Buffer): void {
    if (this.readableEnded || this.destroyed) return;
    if (this.push(chunk)) this.credit(chunk.byteLength);
    else this.held += chunk.byteLength;
  }

  override _read(): void {
    if (this.held > 0) {
      const bytes = this.held;
      this.held = 0;
      this.credit(bytes);
    }
  }

  finish(): void {
    if (!this.readableEnded && !this.destroyed) this.push(null);
  }
}

/** Reads are ended (not errored) on a lost link: consumers see EOF. */
function attachReadable(channel: MuxChannel, readable: ChannelReadable, stream: BoxStream): void {
  const previous = channel.onData;
  channel.onData = (s, chunk) => {
    if (s === stream) readable.feed(chunk);
    else previous?.(s, chunk);
  };
}

/** A Writable that sends stream 0 of a channel (eof on end). */
function channelWritable(channel: MuxChannel, ready: Promise<unknown>): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      ready
        .then(() => channel.send(BOX_STREAM_TO_BOX, chunk))
        .then(
          () => callback(),
          // Writing to a process that already ended is not an error the caller can act on.
          () => callback()
        );
    },
    final(callback) {
      ready.then(
        () => {
          channel.sendEof(BOX_STREAM_TO_BOX);
          callback();
        },
        () => callback()
      );
    }
  });
}

/** A Duplex over a channel: writes → stream 0, reads ← stream 1. */
export function channelDuplex(channel: MuxChannel): Duplex {
  let held = 0;
  let ended = false;
  const duplex: Duplex = new Duplex({
    read() {
      if (held > 0) {
        const bytes = held;
        held = 0;
        channel.consumed(bytes);
      }
    },
    write(chunk: Buffer, _encoding, callback) {
      if (channel.closed) {
        // Like writing to a socket the peer already closed: nothing to deliver to.
        callback();
        return;
      }
      channel.send(BOX_STREAM_TO_BOX, chunk).then(
        () => callback(),
        () => callback()
      );
    },
    final(callback) {
      channel.sendEof(BOX_STREAM_TO_BOX);
      callback();
    },
    destroy(error, callback) {
      // After a graceful end of both directions the box sends `close`; a
      // close from here would race its last writes. Anything else aborts.
      if (error || !(duplex.readableEnded && duplex.writableFinished)) {
        channel.close(error ? { code: "ABORTED", message: error.message } : undefined);
      }
      callback(error);
    }
  });
  channel.onData = (stream, chunk) => {
    if (stream !== BOX_STREAM_FROM_BOX || ended) return;
    if (duplex.push(chunk)) channel.consumed(chunk.byteLength);
    else held += chunk.byteLength;
  };
  channel.onEof = (stream) => {
    if (stream === BOX_STREAM_FROM_BOX && !ended) {
      ended = true;
      duplex.push(null);
    }
  };
  // The box sends `close` once both directions are done (or on failure); the
  // host only closes to abort (destroy). Buffered output is still delivered.
  channel.onClose = (error) => {
    if (error && error.code !== BOX_DISCONNECTED && !ended) {
      ended = true;
      duplex.destroy(error);
      return;
    }
    if (!ended) {
      ended = true;
      duplex.push(null);
    }
    const settle = (): void => {
      if (!duplex.destroyed) duplex.destroy();
    };
    if (duplex.readableEnded) settle();
    else duplex.once("end", settle);
  };
  return duplex;
}

/**
 * A process in the box (contracts.ts `BoxProcess`). `outputOffset` is the
 * detached-output offset reached so far (stdout + stderr bytes), for a later
 * `attach`.
 */
export class RemoteBoxProcess extends EventEmitter implements BoxProcess {
  readonly stdin: Writable;
  readonly stdout: ChannelReadable;
  readonly stderr: ChannelReadable;
  readonly procId: string | null;
  pid: number | null = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  outputOffset: number;

  private channel: MuxChannel | null = null;
  private done = false;
  private pendingSize: { cols: number; rows: number } | null = null;
  private pendingSignals: string[] = [];

  constructor(connection: LinkedBoxConnection, spec: BoxChannelSpec, procId: string | null, fromOffset: number, signal?: AbortSignal) {
    super();
    this.procId = procId;
    this.outputOffset = fromOffset;
    let resolveChannel!: (channel: MuxChannel) => void;
    let rejectChannel!: (error: Error) => void;
    const channelReady = new Promise<MuxChannel>((resolve, reject) => {
      resolveChannel = resolve;
      rejectChannel = reject;
    });
    channelReady.catch(() => undefined);
    const ready = channelReady.then((channel) => channel.opened);
    ready.catch(() => undefined);
    const credit = (bytes: number): void => this.channel?.consumed(bytes);
    this.stdout = new ChannelReadable(credit);
    this.stderr = new ChannelReadable(credit);
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        ready.then(() => this.channel!.send(BOX_STREAM_TO_BOX, chunk)).then(
          () => callback(),
          () => callback()
        );
      },
      final: (callback) => {
        ready.then(
          () => {
            this.channel?.sendEof(BOX_STREAM_TO_BOX);
            callback();
          },
          () => callback()
        );
      }
    });
    if (signal) {
      const onAbort = (): void => {
        this.kill("SIGTERM");
        this.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
      };
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener("abort", onAbort, { once: true });
      this.once("exit", () => signal.removeEventListener("abort", onAbort));
    }
    connection.openMuxChannel(spec, CHANNEL_OPEN_TIMEOUT_MS).then(
      (channel) => {
        this.wire(channel);
        resolveChannel(channel);
        channel.opened.then(
          (info) => {
            this.pid = info.pid ?? null;
            if (info.droppedBytes) this.outputOffset += info.droppedBytes;
            if (this.pendingSize) channel.resize(this.pendingSize.cols, this.pendingSize.rows);
            for (const name of this.pendingSignals) channel.signal(name);
            this.pendingSignals = [];
            this.emit("spawn");
          },
          (error: Error) => this.fail(error)
        );
      },
      (error: Error) => {
        rejectChannel(error);
        this.fail(error);
      }
    );
  }

  private wire(channel: MuxChannel): void {
    this.channel = channel;
    channel.onData = (stream, chunk) => {
      this.outputOffset += chunk.byteLength;
      if (stream === BOX_STREAM_FROM_BOX) this.stdout.feed(chunk);
      else if (stream === BOX_STREAM_STDERR) this.stderr.feed(chunk);
    };
    channel.onEof = (stream) => {
      if (stream === BOX_STREAM_FROM_BOX) this.stdout.finish();
      else if (stream === BOX_STREAM_STDERR) this.stderr.finish();
    };
    channel.onExit = (code, signal) => this.finishWith(code, (signal as NodeJS.Signals | null) ?? null);
    channel.onClose = (error) => {
      if (this.done) return;
      if (error && error.code !== BOX_DISCONNECTED && error.code !== "CLOSED") {
        this.fail(error);
        return;
      }
      // The link dropped (or the box gave up) before `exit`.
      this.endStreams();
      this.done = true;
      if (this.procId !== null) {
        this.emit("detached");
      } else {
        this.signalCode = "SIGHUP";
        this.emit("exit", null, "SIGHUP");
      }
    };
  }

  private endStreams(): void {
    this.stdout.finish();
    this.stderr.finish();
  }

  private finishWith(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.done) return;
    this.done = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.endStreams();
    this.emit("exit", code, signal);
  }

  private fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.endStreams();
    this.emit("error", error);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.done) return false;
    this.killed = true;
    if (this.channel && this.pid !== null) this.channel.signal(signal);
    else this.pendingSignals.push(signal);
    return true;
  }

  resize(cols: number, rows: number): void {
    if (this.done) return;
    if (this.channel && this.pid !== null) this.channel.resize(cols, rows);
    else this.pendingSize = { cols, rows };
  }
}

type Waiter = { resolve: (mux: BoxMux) => void; reject: (error: Error) => void; cleanup: () => void };

export interface LinkedBoxConnectionOptions {
  /** Re-issue active `fs.watch` / `forward.listen` requests on every new link. */
  replay?: boolean;
}

export class LinkedBoxConnection implements BoxConnection {
  readonly boxId: string;
  private info: LinkInfo;
  private mux: BoxMux | null = null;
  private waiters = new Set<Waiter>();
  private readonly events = new EventEmitter();
  private readonly status = new EventEmitter();
  private readonly anyEvent = new Set<(name: string, data: unknown) => void>();
  private readonly watches = new Map<string, BoxMethodParams<BoxHostToBoxMethods, "fs.watch">>();
  private readonly forwards = new Map<number, BoxForwardSpec>();
  private readonly replay: boolean;

  constructor(boxId: string, info: LinkInfo, options: LinkedBoxConnectionOptions = {}) {
    this.boxId = boxId;
    this.info = info;
    this.replay = options.replay ?? false;
    this.events.setMaxListeners(0);
    this.status.setMaxListeners(0);
  }

  get sys(): BoxSysInfo {
    return this.info.sys;
  }
  get paths(): BoxPathMap {
    return this.info.paths;
  }
  get agentVersion(): string {
    return this.info.agentVersion;
  }
  get connected(): boolean {
    return this.mux !== null && !this.mux.isShutDown;
  }

  detachedProcs(): BoxDetachedProcInfo[] {
    return this.info.procs.map((proc) => ({ ...proc }));
  }

  /** Whether `mux` is the link this connection is attached to. */
  currentLinkIs(mux: BoxMux): boolean {
    return this.mux === mux;
  }

  /** The live mux, if any (the relay passes channels through it). */
  currentMux(): BoxMux | null {
    return this.connected ? this.mux : null;
  }

  /** A link is up. `replay` re-issues active watches/forwards on it. */
  attachLink(mux: BoxMux, info: LinkInfo, options: { replay?: boolean } = {}): void {
    this.mux = mux;
    this.info = info;
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve(mux);
    }
    this.status.emit("status", true);
    if (options.replay ?? this.replay) this.replayState(mux);
  }

  /** Update what the latest hello said without a reconnect. */
  updateInfo(info: LinkInfo): void {
    this.info = info;
  }

  /** The link dropped. */
  detachLink(mux?: BoxMux): void {
    if (mux && this.mux !== mux) return;
    if (this.mux === null) return;
    this.mux = null;
    this.status.emit("status", false);
  }

  private replayState(mux: BoxMux): void {
    for (const params of this.watches.values()) {
      mux.request("fs.watch", params, { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS }).catch(() => undefined);
    }
    for (const spec of this.forwards.values()) {
      mux.request("forward.listen", spec, { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS }).catch(() => undefined);
    }
  }

  /** Feed a box event (from the mux's `onEvent`). */
  emitEvent(name: string, data: unknown): void {
    this.events.emit(name, data);
    for (const listener of this.anyEvent) listener(name, data);
  }

  /** Every event, for the relay. */
  onAnyEvent(listener: (name: string, data: unknown) => void): () => void {
    this.anyEvent.add(listener);
    return () => this.anyEvent.delete(listener);
  }

  /** Wait for a link until `deadline` (epoch ms). */
  waitMux(deadline: number, signal?: AbortSignal): Promise<BoxMux> {
    const current = this.currentMux();
    if (current) return Promise.resolve(current);
    if (signal?.aborted) return Promise.reject(new BoxError("ABORTED", "Aborted"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      };
      const onAbort = (): void => {
        this.waiters.delete(waiter);
        waiter.cleanup();
        reject(new BoxError("ABORTED", "Aborted"));
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        waiter.cleanup();
        reject(new BoxError(BOX_DISCONNECTED, `Box ${this.boxId} did not reconnect in time`));
      }, Math.max(0, deadline - Date.now()));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  /** Fail every waiter (the connection is being thrown away). */
  rejectWaiters(error: Error): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.cleanup();
      waiter.reject(error);
    }
  }

  request<K extends BoxMethodName<BoxHostToBoxMethods>>(
    method: K,
    params: BoxMethodParams<BoxHostToBoxMethods, K>,
    options?: BoxRequestOptions
  ): Promise<BoxMethodResult<BoxHostToBoxMethods, K>> {
    return this.requestRaw(method, params, options) as Promise<BoxMethodResult<BoxHostToBoxMethods, K>>;
  }

  async requestRaw(method: string, params: unknown, options: BoxRequestOptions = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const mux = await this.waitMux(deadline, options.signal);
    const result = await mux.request(method, params, { timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal });
    this.track(method, params);
    return result;
  }

  private track(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    switch (method) {
      case "fs.watch":
        this.watches.set(String(p.watchId), params as BoxMethodParams<BoxHostToBoxMethods, "fs.watch">);
        break;
      case "fs.unwatch":
        this.watches.delete(String(p.watchId));
        break;
      case "forward.listen":
        this.forwards.set(Number(p.boxPort), params as BoxForwardSpec);
        break;
      case "forward.unlisten":
        this.forwards.delete(Number(p.boxPort));
        break;
    }
  }

  /** @internal Open a channel on the current (or next) link. */
  async openMuxChannel(spec: BoxChannelSpec, timeoutMs: number): Promise<MuxChannel> {
    const mux = await this.waitMux(Date.now() + timeoutMs);
    return mux.open(spec);
  }

  exec(options: BoxExecOptions): BoxProcess {
    const spec: BoxChannelSpec = {
      kind: "exec",
      command: options.command,
      args: options.args ?? [],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.envUnset !== undefined ? { envUnset: options.envUnset } : {}),
      ...(options.pty !== undefined ? { pty: options.pty } : {}),
      ...(options.detach !== undefined ? { detach: options.detach } : {}),
      ...(options.shell !== undefined ? { shell: options.shell } : {})
    };
    return new RemoteBoxProcess(this, spec, options.detach?.procId ?? null, 0, options.signal);
  }

  attach(procId: string, fromOffset: number): BoxProcess {
    return new RemoteBoxProcess(this, { kind: "attach", procId, fromOffset }, procId, fromOffset);
  }

  async openChannel(spec: BoxChannelSpec): Promise<Duplex> {
    const channel = await this.openMuxChannel(spec, CHANNEL_OPEN_TIMEOUT_MS);
    const duplex = channelDuplex(channel);
    try {
      await channel.opened;
    } catch (error) {
      duplex.destroy();
      throw error;
    }
    return duplex;
  }

  openTcp(port: number, host?: string): Promise<Duplex> {
    return this.openChannel(host === undefined ? { kind: "tcp", port } : { kind: "tcp", host, port });
  }

  async forwardToHost(boxPort: number, options: { hostPort?: number } = {}): Promise<BoxHostForward> {
    const sockets = new Set<Socket>();
    // Half-open sockets: a client's FIN travels to the box as eof, and the
    // box's answer can still come back.
    const server: Server = createServer({ allowHalfOpen: true }, (client) => {
      sockets.add(client);
      client.once("close", () => sockets.delete(client));
      client.pause();
      this.openTcp(boxPort).then(
        (upstream) => {
          client.pipe(upstream).pipe(client);
          client.resume();
          upstream.on("error", () => client.destroy());
          client.on("error", () => upstream.destroy());
          client.once("close", () => upstream.destroy());
          upstream.once("close", () => client.end());
        },
        () => client.destroy()
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.hostPort ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return {
      hostPort: (server.address() as AddressInfo).port,
      boxPort,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        })
    };
  }

  /** A download channel (file-read, tar-read): stream 1 as a Readable; errors on a failed close. */
  private async openDownload(spec: BoxChannelSpec, signal?: AbortSignal): Promise<Readable> {
    const channel = await this.openMuxChannel(spec, CHANNEL_OPEN_TIMEOUT_MS);
    const readable = new ChannelReadable((bytes) => channel.consumed(bytes));
    let gotEof = false;
    let returned = false;
    attachReadable(channel, readable, BOX_STREAM_FROM_BOX);
    channel.onEof = (stream) => {
      if (stream === BOX_STREAM_FROM_BOX) gotEof = true;
    };
    channel.onClose = (error) => {
      if (gotEof && !error) readable.finish();
      // Before the caller holds the stream the failure surfaces through `opened`.
      else if (!returned) readable.destroy();
      else readable.destroy(error ?? disconnectedError());
    };
    readable.once("close", () => channel.close());
    if (signal) {
      const onAbort = (): void => {
        readable.destroy(new BoxError("ABORTED", "Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      readable.once("close", () => signal.removeEventListener("abort", onAbort));
    }
    try {
      await channel.opened;
    } catch (error) {
      readable.destroy();
      throw error;
    }
    returned = true;
    return readable;
  }

  /** An upload channel (file-write, tar-write): resolves on eof(1)+close, rejects on a failed close. */
  private async upload(spec: BoxChannelSpec, source: Readable): Promise<void> {
    // Take hold of the source right away: a child process's stdout that has
    // no reader when the child exits is drained and discarded by Node.
    const staged = new PassThrough();
    source.once("error", (error) => staged.destroy(error));
    source.pipe(staged);
    let channel: MuxChannel;
    try {
      channel = await this.openMuxChannel(spec, CHANNEL_OPEN_TIMEOUT_MS);
    } catch (error) {
      source.destroy();
      staged.destroy();
      throw error;
    }
    let committed = false;
    let fail!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      fail = reject;
      channel.onEof = (stream) => {
        if (stream === BOX_STREAM_FROM_BOX) committed = true;
      };
      channel.onClose = (error) => {
        if (committed && !error) resolve();
        else reject(error ?? new BoxError("WRITE_FAILED", "The box closed the upload without committing it"));
      };
    });
    done.catch(() => undefined);
    try {
      await channel.opened;
    } catch (error) {
      source.destroy();
      staged.destroy();
      throw error;
    }
    const sink = channelWritable(channel, Promise.resolve());
    staged.once("error", (error) => {
      // Nothing was committed: the box drops its temp file on close.
      channel.close({ code: "SOURCE_FAILED", message: error.message });
      fail(error);
    });
    staged.pipe(sink);
    try {
      await done;
    } catch (error) {
      staged.unpipe(sink);
      source.destroy();
      staged.destroy();
      throw error;
    }
  }

  readFile(path: string, options: { offset?: number; length?: number; signal?: AbortSignal } = {}): Promise<Readable> {
    return this.openDownload(
      {
        kind: "file-read",
        path,
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
        ...(options.length !== undefined ? { length: options.length } : {})
      },
      options.signal
    );
  }

  writeFile(path: string, data: Readable | Uint8Array | string, options: { mode?: number; mkdirs?: boolean } = {}): Promise<void> {
    const source = typeof data === "string" || data instanceof Uint8Array ? Readable.from([Buffer.from(data)]) : data;
    return this.upload(
      {
        kind: "file-write",
        path,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.mkdirs !== undefined ? { mkdirs: options.mkdirs } : {})
      },
      source
    );
  }

  readTar(path: string, options: { exclude?: string[] } = {}): Promise<Readable> {
    return this.openDownload({ kind: "tar-read", path, ...(options.exclude ? { exclude: options.exclude } : {}) });
  }

  writeTar(path: string, tar: Readable): Promise<void> {
    return this.upload({ kind: "tar-write", path }, tar);
  }

  onEvent(name: string, listener: (data: unknown) => void): () => void {
    this.events.on(name, listener);
    return () => this.events.off(name, listener);
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.status.on("status", listener);
    return () => this.status.off("status", listener);
  }
}
