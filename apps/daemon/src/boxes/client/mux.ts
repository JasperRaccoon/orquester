/**
 * The host side of the box wire protocol (`packages/api/src/box-protocol.ts`)
 * over any frame transport: the hub's WebSocket to a box, or a relay socket.
 * Requests, events, and channels with the BOX_CHANNEL_WINDOW_BYTES credit
 * window. The host opens EVEN channel ids, never reused within one transport.
 *
 * Raw channels ({@link BoxMux.openRaw}) skip flow control and stream
 * adaptation: every frame for the id goes to a sink as-is. The relay uses
 * them to pass a local client's channel through to the box end to end.
 *
 * Static imports only: this module runs inside the agent host.
 */

import {
  BOX_CHANNEL_WINDOW_BYTES,
  BOX_MAX_FRAME_PAYLOAD,
  decodeDataFrame,
  encodeDataFrame,
  type BoxChannelOpenedInfo,
  type BoxChannelSpec,
  type BoxControlMessage,
  type BoxRpcError,
  type BoxStream
} from "@orquester/api";

/** An error carrying a protocol code (`ENOENT`, `BOX_DISCONNECTED`, …). */
export class BoxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BoxError";
    this.code = code;
  }
  static from(error: BoxRpcError): BoxError {
    return new BoxError(error.code, error.message);
  }
}

export const BOX_DISCONNECTED = "BOX_DISCONNECTED";

export function disconnectedError(): BoxError {
  return new BoxError(BOX_DISCONNECTED, "The box is not connected");
}

/** Credit is returned in batches of this size (or when a reader drains). */
const CREDIT_BATCH = 64 * 1024;

export interface MuxTransport {
  sendText(text: string): void;
  sendBinary(frame: Uint8Array): void;
}

export interface MuxRequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface MuxHandlers {
  /** A request from the peer; reject with a `code` to answer that code. */
  onRequest?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
  /**
   * A channel the peer opened (odd id). Return a starter to accept it (called
   * right after `opened` was sent), or null to refuse it.
   */
  onChannel?: (spec: BoxChannelSpec) => ((channel: MuxChannel) => void) | null;
  onEvent?: (name: string, data: unknown) => void;
  /** A request of ours timed out or was aborted before its answer (the relay tells the daemon). */
  onAbandon?: (id: number) => void;
}

/** Frames of a raw (pass-through) channel, delivered as they arrive. */
export interface RawChannelSink {
  control(message: BoxControlMessage): void;
  data(stream: BoxStream, payload: Uint8Array): void;
  /** The transport went away; no more frames will come. */
  lost(): void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
};

function errorPayload(error: unknown): BoxRpcError {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "INTERNAL";
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

/**
 * One channel with flow control. Inbound data is delivered to `onData`; the
 * consumer returns credit with {@link MuxChannel.consumed} once it has room
 * (Node stream adapters live in `connection.ts`).
 */
export class MuxChannel {
  readonly id: number;
  readonly opened: Promise<BoxChannelOpenedInfo>;
  onData: ((stream: BoxStream, chunk: Buffer) => void) | null = null;
  onEof: ((stream: BoxStream) => void) | null = null;
  onExit: ((code: number | null, signal: string | null) => void) | null = null;
  onClose: ((error: BoxError | null) => void) | null = null;
  onResize: ((cols: number, rows: number) => void) | null = null;
  onSignal: ((signal: string) => void) | null = null;

  private readonly mux: BoxMux;
  private credit = BOX_CHANNEL_WINDOW_BYTES;
  private creditWaiters: (() => void)[] = [];
  private uncredited = 0;
  private creditTimer: NodeJS.Immediate | null = null;
  private resolveOpen!: (info: BoxChannelOpenedInfo) => void;
  private rejectOpen!: (error: Error) => void;
  private isOpen = false;
  private dead = false;

  constructor(mux: BoxMux, id: number, alreadyOpen: boolean) {
    this.mux = mux;
    this.id = id;
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    // Callers that never await `opened` must not cause unhandled rejections.
    this.opened.catch(() => undefined);
    if (alreadyOpen) {
      this.isOpen = true;
      this.resolveOpen({});
    }
  }

  get closed(): boolean {
    return this.dead;
  }

  /** @internal */
  handleOpened(info: BoxChannelOpenedInfo): void {
    if (this.isOpen || this.dead) return;
    this.isOpen = true;
    this.resolveOpen(info);
  }

  /** @internal */
  handleOpenFailed(error: BoxRpcError): void {
    // Reported through `opened` only: the channel never carried anything.
    this.markDead();
    this.rejectOpen(BoxError.from(error));
  }

  /** @internal */
  handleData(stream: BoxStream, payload: Uint8Array): void {
    if (this.dead) return;
    this.onData?.(stream, Buffer.from(payload));
  }

  /** @internal */
  handleCredit(bytes: number): void {
    if (!(bytes > 0)) return;
    this.credit += bytes;
    const waiters = this.creditWaiters;
    this.creditWaiters = [];
    for (const wake of waiters) wake();
  }

  /** @internal Peer `close`, or the transport is gone. */
  handlePeerClose(error: BoxError | null): void {
    if (this.dead) return;
    this.markDead();
    if (!this.isOpen) this.rejectOpen(error ?? new BoxError("CLOSED", "Channel closed before it opened"));
    this.onClose?.(error);
  }

  private markDead(): void {
    this.dead = true;
    if (this.creditTimer) {
      clearImmediate(this.creditTimer);
      this.creditTimer = null;
    }
    const waiters = this.creditWaiters;
    this.creditWaiters = [];
    for (const wake of waiters) wake();
    this.mux.forget(this.id);
  }

  /** Return credit for `bytes` the consumer has taken in. */
  consumed(bytes: number): void {
    if (this.dead || bytes <= 0) return;
    this.uncredited += bytes;
    if (this.uncredited >= CREDIT_BATCH) {
      this.flushCredit();
      return;
    }
    this.creditTimer ??= setImmediate(() => {
      this.creditTimer = null;
      this.flushCredit();
    });
  }

  private flushCredit(): void {
    if (this.creditTimer) {
      clearImmediate(this.creditTimer);
      this.creditTimer = null;
    }
    if (this.dead || this.uncredited <= 0) return;
    const bytes = this.uncredited;
    this.uncredited = 0;
    this.mux.sendControl({ t: "credit", ch: this.id, bytes });
  }

  /** Send bytes on a stream, paced by the peer's credit. Rejects once the channel is gone. */
  async send(stream: BoxStream, data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < data.byteLength) {
      if (this.dead) throw new BoxError("CLOSED", "Channel closed");
      if (this.credit <= 0) {
        await new Promise<void>((resolve) => this.creditWaiters.push(resolve));
        continue;
      }
      const n = Math.min(data.byteLength - offset, BOX_MAX_FRAME_PAYLOAD, this.credit);
      this.credit -= n;
      this.mux.sendData(this.id, stream, data.subarray(offset, offset + n));
      offset += n;
    }
  }

  sendEof(stream: BoxStream): void {
    if (!this.dead) this.mux.sendControl({ t: "eof", ch: this.id, stream });
  }

  sendExit(code: number | null, signal: string | null): void {
    if (!this.dead) this.mux.sendControl({ t: "exit", ch: this.id, code, signal });
  }

  resize(cols: number, rows: number): void {
    if (!this.dead) this.mux.sendControl({ t: "resize", ch: this.id, cols, rows });
  }

  signal(signal: string): void {
    if (!this.dead) this.mux.sendControl({ t: "signal", ch: this.id, signal });
  }

  /** End the channel from our side (idempotent). `onClose` does not fire for a local close. */
  close(error?: BoxRpcError): void {
    if (this.dead) return;
    this.flushCredit();
    this.markDead();
    this.mux.sendControl(error ? { t: "close", ch: this.id, error } : { t: "close", ch: this.id });
    if (!this.isOpen) this.rejectOpen(new BoxError("CLOSED", "Channel closed before it opened"));
  }
}

export class BoxMux {
  private readonly transport: MuxTransport;
  private readonly handlers: MuxHandlers;
  private nextRequestId = 1;
  private nextChannelId = 2;
  private readonly pending = new Map<number, Pending>();
  private readonly channels = new Map<number, MuxChannel>();
  private readonly raw = new Map<number, RawChannelSink>();
  private readonly inbound = new Map<number, AbortController>();
  private shutDown = false;

  constructor(transport: MuxTransport, handlers: MuxHandlers = {}) {
    this.transport = transport;
    this.handlers = handlers;
  }

  get isShutDown(): boolean {
    return this.shutDown;
  }

  /** @internal */
  sendControl(message: BoxControlMessage): void {
    if (this.shutDown) return;
    this.transport.sendText(JSON.stringify(message));
  }

  /** @internal */
  sendData(channel: number, stream: BoxStream, payload: Uint8Array): void {
    if (this.shutDown) return;
    this.transport.sendBinary(encodeDataFrame(channel, stream, payload));
  }

  /** @internal */
  forget(id: number): void {
    this.channels.delete(id);
  }

  request(method: string, params: unknown, options: MuxRequestOptions): Promise<unknown> {
    if (this.shutDown) return Promise.reject(disconnectedError());
    if (options.signal?.aborted) return Promise.reject(new BoxError("ABORTED", `${method} was aborted`));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cleanup();
        this.handlers.onAbandon?.(id);
        reject(new BoxError("ABORTED", `${method} was aborted`));
      };
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cleanup();
        this.handlers.onAbandon?.(id);
        reject(new BoxError("TIMEOUT", `${method} timed out after ${options.timeoutMs} ms`));
      }, Math.max(1, options.timeoutMs));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        }
      });
      this.sendControl({ t: "req", id, method, params });
    });
  }

  sendEvent(name: string, data: unknown): void {
    this.sendControl({ t: "event", name, data });
  }

  /** Open a channel; frames may be written before `opened` resolves. */
  open(spec: BoxChannelSpec): MuxChannel {
    const id = this.allocateId();
    const channel = new MuxChannel(this, id, false);
    if (this.shutDown) {
      channel.handlePeerClose(disconnectedError());
      return channel;
    }
    this.channels.set(id, channel);
    this.sendControl({ t: "open", ch: id, spec });
    return channel;
  }

  /** Open a pass-through channel; returns its id on this transport. */
  openRaw(spec: BoxChannelSpec, sink: RawChannelSink): number {
    const id = this.allocateId();
    if (this.shutDown) {
      queueMicrotask(() => sink.lost());
      return id;
    }
    this.raw.set(id, sink);
    this.sendControl({ t: "open", ch: id, spec });
    return id;
  }

  /** Send a control frame of a raw channel (its `ch` is replaced by `id`). */
  sendRaw(id: number, message: BoxControlMessage): void {
    if (!this.raw.has(id)) return;
    if (message.t === "close") this.raw.delete(id);
    this.sendControl({ ...message, ch: id } as BoxControlMessage);
  }

  sendRawData(id: number, stream: BoxStream, payload: Uint8Array): void {
    if (this.raw.has(id)) this.sendData(id, stream, payload);
  }

  private allocateId(): number {
    const id = this.nextChannelId;
    this.nextChannelId += 2;
    return id;
  }

  receiveBinary(frame: Uint8Array): void {
    let decoded: ReturnType<typeof decodeDataFrame>;
    try {
      decoded = decodeDataFrame(frame);
    } catch {
      return;
    }
    const raw = this.raw.get(decoded.channel);
    if (raw) {
      raw.data(decoded.stream, decoded.payload);
      return;
    }
    // Frames for unknown or closed ids are dropped (ids are never reused).
    this.channels.get(decoded.channel)?.handleData(decoded.stream, decoded.payload);
  }

  receiveControl(message: BoxControlMessage): void {
    switch (message.t) {
      case "ping":
        this.sendControl({ t: "pong", id: message.id });
        return;
      case "pong":
        return;
      case "res": {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        entry.cleanup();
        if (message.ok) entry.resolve(message.result);
        else entry.reject(BoxError.from(message.error ?? { code: "INTERNAL", message: "Request failed" }));
        return;
      }
      case "req":
        void this.serveRequest(message.id, message.method, message.params);
        return;
      case "event":
        this.handlers.onEvent?.(message.name, message.data);
        return;
      case "open":
        this.acceptChannel(message.ch, message.spec);
        return;
      default:
        break;
    }
    if (!("ch" in message)) return;
    const raw = this.raw.get(message.ch);
    if (raw) {
      if (message.t === "close" || message.t === "open-failed") this.raw.delete(message.ch);
      raw.control(message);
      return;
    }
    const channel = this.channels.get(message.ch);
    if (!channel) return;
    switch (message.t) {
      case "opened":
        channel.handleOpened(message.info ?? {});
        return;
      case "open-failed":
        channel.handleOpenFailed(message.error);
        return;
      case "eof":
        channel.onEof?.(message.stream);
        return;
      case "exit":
        channel.onExit?.(message.code, message.signal);
        return;
      case "credit":
        channel.handleCredit(message.bytes);
        return;
      case "resize":
        channel.onResize?.(message.cols, message.rows);
        return;
      case "signal":
        channel.onSignal?.(message.signal);
        return;
      case "close":
        channel.handlePeerClose(message.error ? BoxError.from(message.error) : null);
        return;
    }
  }

  private acceptChannel(id: number, spec: BoxChannelSpec): void {
    if (id % 2 === 0 || this.channels.has(id) || this.raw.has(id)) {
      this.sendControl({ t: "open-failed", ch: id, error: { code: "BAD_CHANNEL", message: "Channel id not allowed" } });
      return;
    }
    let start: ((channel: MuxChannel) => void) | null = null;
    try {
      start = this.handlers.onChannel?.(spec) ?? null;
    } catch {
      start = null;
    }
    if (!start) {
      this.sendControl({ t: "open-failed", ch: id, error: { code: "UNKNOWN_CHANNEL", message: `No handler for ${spec.kind} channels` } });
      return;
    }
    const channel = new MuxChannel(this, id, true);
    this.channels.set(id, channel);
    this.sendControl({ t: "opened", ch: id });
    start(channel);
  }

  private async serveRequest(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.onRequest;
    if (!handler) {
      this.sendControl({ t: "res", id, ok: false, error: { code: "UNKNOWN_METHOD", message: `Unknown method ${method}` } });
      return;
    }
    const controller = new AbortController();
    this.inbound.set(id, controller);
    try {
      const result = await handler(method, params, controller.signal);
      this.sendControl({ t: "res", id, ok: true, result: result ?? null });
    } catch (error) {
      this.sendControl({ t: "res", id, ok: false, error: errorPayload(error) });
    } finally {
      this.inbound.delete(id);
    }
  }

  /** The transport is gone: fail pending work, close every channel. Idempotent. */
  shutdown(): void {
    if (this.shutDown) return;
    this.shutDown = true;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.cleanup();
      entry.reject(disconnectedError());
    }
    for (const controller of this.inbound.values()) controller.abort();
    this.inbound.clear();
    for (const channel of [...this.channels.values()]) channel.handlePeerClose(disconnectedError());
    this.channels.clear();
    const raw = [...this.raw.values()];
    this.raw.clear();
    for (const sink of raw) sink.lost();
  }
}
