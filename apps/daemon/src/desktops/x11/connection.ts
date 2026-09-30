// One X11 client connection: handshake, request sequencing and reply/error matching, event
// dispatch. Encoding and decoding are in ./protocol.ts and ./xres.ts.
//
// Sequence numbers: every request increments a counter; replies, errors and events carry the low
// 16 bits of the last request the server processed. Replies and errors are matched to pending
// requests by widening those 16 bits against the counter. Requests without a reply ("void") are
// sent "checked": a GetInputFocus follows them, and since the server answers in order, the sync
// reply arriving without an error for the void request means it succeeded.

import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

import {
  AnyPropertyType,
  decodeGetGeometryReply,
  decodeGetPropertyReply,
  decodeInternAtomReply,
  decodeQueryExtensionReply,
  decodeServerMessage,
  decodeSetupResponse,
  encodeGetGeometry,
  encodeGetInputFocus,
  encodeGetProperty,
  encodeInternAtom,
  encodeQueryExtension,
  encodeSelectInput,
  encodeSendEvent,
  encodeSetupRequest,
  serverMessageLength,
  setupResponseLength,
  type GeometryReply,
  type GetPropertyReply,
  type QueryExtensionReply,
  type SetupInfo,
  type XAuthData,
  type XErrorInfo,
  type XEvent
} from "./protocol.ts";
import {
  decodeXResQueryClientIdsReply,
  decodeXResQueryVersionReply,
  encodeXResQueryClientIds,
  encodeXResQueryVersion,
  pidFromClientIds,
  XResClientIdMask
} from "./xres.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** GetProperty chunk size in 32-bit units (64 KiB). */
const PROPERTY_CHUNK_LONGS = 16_384;
const DEFAULT_PROPERTY_MAX_BYTES = 1 << 20;

export const x11SocketPath = (display: number): string => `/tmp/.X11-unix/X${display}`;

export class X11Error extends Error {
  readonly code: number;
  readonly sequence: number;
  readonly badValue: number;
  readonly majorOpcode: number;
  readonly minorOpcode: number;

  constructor(info: XErrorInfo) {
    super(`X11 error ${info.code} (request ${info.majorOpcode}.${info.minorOpcode}, value 0x${info.badValue.toString(16)})`);
    this.name = "X11Error";
    this.code = info.code;
    this.sequence = info.sequence;
    this.badValue = info.badValue;
    this.majorOpcode = info.majorOpcode;
    this.minorOpcode = info.minorOpcode;
  }
}

/** The server refused the connection (bad or missing authorization, wrong protocol). */
export class X11SetupError extends Error {
  constructor(readonly status: "failed" | "authenticate", readonly reason: string) {
    super(`X11 connection refused: ${reason || status}`);
    this.name = "X11SetupError";
  }
}

export class X11ConnectionClosedError extends Error {
  constructor(cause?: Error) {
    super(cause ? `X11 connection closed: ${cause.message}` : "X11 connection closed");
    this.name = "X11ConnectionClosedError";
  }
}

export interface X11ConnectionEvents {
  event: [XEvent];
  /** An error for a request nobody is waiting on. */
  protocolError: [X11Error];
  /** The socket closed; `error` is null when `close()` was called. */
  close: [Error | null];
}

type Pending =
  | { kind: "reply"; resolve: (reply: Buffer) => void; reject: (error: Error) => void }
  | { kind: "void"; resolve: () => void; reject: (error: Error) => void };

export interface X11ConnectOptions {
  /** Unix socket path, usually `x11SocketPath(display)`. */
  path: string;
  auth: XAuthData | null;
  timeoutMs?: number;
}

export class X11Connection extends EventEmitter<X11ConnectionEvents> {
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private buffered: Buffer = Buffer.alloc(0);
  private closed = false;
  private closedByUs = false;

  private constructor(
    private readonly stream: Duplex,
    readonly setup: SetupInfo
  ) {
    super();
    stream.on("data", (chunk: Buffer) => this.onData(chunk));
    let streamError: Error | undefined;
    stream.on("error", (error) => {
      streamError = error;
    });
    stream.on("close", () => this.onClose(streamError));
  }

  /** Connect to a Unix socket and complete the handshake. */
  static connect(options: X11ConnectOptions): Promise<X11Connection> {
    const socket = createConnection(options.path);
    return X11Connection.handshake(socket, options.auth, options.timeoutMs);
  }

  /** Complete the handshake over an already-open stream (tests use an in-memory duplex). */
  static handshake(stream: Duplex, auth: XAuthData | null, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<X11Connection> {
    return new Promise((resolve, reject) => {
      let buffered: Buffer = Buffer.alloc(0);
      const cleanup = (): void => {
        clearTimeout(timer);
        stream.off("data", onData);
        stream.off("error", onError);
        stream.off("close", onClose);
      };
      const fail = (error: Error): void => {
        cleanup();
        stream.destroy();
        reject(error);
      };
      const onError = (error: Error): void => fail(error);
      const onClose = (): void => fail(new X11ConnectionClosedError());
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length < 8) return;
        const total = setupResponseLength(buffered);
        if (buffered.length < total) return;
        let response;
        try {
          response = decodeSetupResponse(buffered.subarray(0, total));
        } catch (error) {
          fail(error as Error);
          return;
        }
        if (response.status !== "success") {
          fail(new X11SetupError(response.status, response.reason));
          return;
        }
        if (response.info.screens.length === 0) {
          fail(new Error("X11 server reported no screens"));
          return;
        }
        cleanup();
        stream.pause();
        const connection = new X11Connection(stream, response.info);
        const rest = buffered.subarray(total);
        if (rest.length > 0) connection.onData(rest);
        stream.resume();
        resolve(connection);
      };
      const timer = setTimeout(() => fail(new Error(`X11 connection timed out after ${timeoutMs} ms`)), timeoutMs);
      stream.on("data", onData);
      stream.on("error", onError);
      stream.on("close", onClose);
      stream.write(encodeSetupRequest(auth));
    });
  }

  get root(): number {
    return this.setup.screens[0]!.root;
  }

  /** True once `close()` was called or the socket closed. */
  get isClosed(): boolean {
    return this.closed || this.closedByUs;
  }

  close(): void {
    if (this.closed) return;
    this.closedByUs = true;
    this.stream.destroy();
  }

  /** Send a request that has a reply. */
  request(buf: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.isClosed) {
        reject(new X11ConnectionClosedError());
        return;
      }
      this.pending.set(this.send(buf), { kind: "reply", resolve, reject });
    });
  }

  /** Send a request without a reply, followed by a sync, resolving once the server processed it without error. */
  requestVoid(buf: Buffer): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      if (this.isClosed) {
        reject(new X11ConnectionClosedError());
        return;
      }
      this.pending.set(this.send(buf), { kind: "void", resolve, reject });
    });
    // The sync's own outcome is irrelevant: a close rejects `done` too.
    this.request(encodeGetInputFocus()).catch(() => {});
    return done;
  }

  async internAtom(name: string, onlyIfExists = false): Promise<number> {
    return decodeInternAtomReply(await this.request(encodeInternAtom(name, onlyIfExists)));
  }

  /**
   * The whole value of a property (reading it in chunks when it is long), or null when it does not
   * exist. Values past `maxBytes` are cut off.
   */
  async getProperty(window: number, property: number, type = AnyPropertyType, maxBytes = DEFAULT_PROPERTY_MAX_BYTES): Promise<GetPropertyReply | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    let longOffset = 0;
    for (;;) {
      const reply = decodeGetPropertyReply(await this.request(encodeGetProperty(window, property, type, longOffset, PROPERTY_CHUNK_LONGS)));
      if (reply.type === 0) return null;
      chunks.push(reply.value);
      size += reply.value.length;
      if (reply.bytesAfter === 0 || reply.value.length === 0 || size >= maxBytes) {
        const value = Buffer.concat(chunks);
        return { ...reply, bytesAfter: 0, value: value.length > maxBytes ? value.subarray(0, maxBytes) : value };
      }
      longOffset += reply.value.length / 4;
    }
  }

  selectInput(window: number, eventMask: number): Promise<void> {
    return this.requestVoid(encodeSelectInput(window, eventMask));
  }

  async getGeometry(drawable: number): Promise<GeometryReply> {
    return decodeGetGeometryReply(await this.request(encodeGetGeometry(drawable)));
  }

  async queryExtension(name: string): Promise<QueryExtensionReply> {
    return decodeQueryExtensionReply(await this.request(encodeQueryExtension(name)));
  }

  sendEvent(propagate: boolean, destination: number, eventMask: number, event: Buffer): Promise<void> {
    return this.requestVoid(encodeSendEvent(propagate, destination, eventMask, event));
  }

  async xresQueryVersion(majorOpcode: number): Promise<{ major: number; minor: number }> {
    return decodeXResQueryVersionReply(await this.request(encodeXResQueryVersion(majorOpcode)));
  }

  /** The pid of the local client owning `xid`, via X-Resource QueryClientIds; null if unknown. */
  async xresClientPid(majorOpcode: number, xid: number): Promise<number | null> {
    const reply = await this.request(encodeXResQueryClientIds(majorOpcode, [{ client: xid, mask: XResClientIdMask.LocalClientPid }]));
    return pidFromClientIds(decodeXResQueryClientIdsReply(reply));
  }

  private send(buf: Buffer): number {
    this.sequence += 1;
    this.stream.write(buf);
    return this.sequence;
  }

  /** The full sequence number of the most recent request whose low 16 bits are `low`. */
  private widen(low: number): number {
    return this.sequence - ((this.sequence - low) & 0xffff);
  }

  private onData(chunk: Buffer): void {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    for (;;) {
      const length = serverMessageLength(this.buffered);
      if (length === null || this.buffered.length < length) return;
      const message = Buffer.from(this.buffered.subarray(0, length));
      this.buffered = this.buffered.subarray(length);
      this.dispatch(message);
      if (this.closed) return;
    }
  }

  private dispatch(buf: Buffer): void {
    const message = decodeServerMessage(buf);
    if (message.kind === "event") {
      this.emit("event", message.event);
      return;
    }
    const sequence = this.widen(message.kind === "reply" ? message.sequence : message.error.sequence);
    // Everything sent before this sequence has been processed: void requests without an error succeeded.
    for (const [seq, pending] of this.pending) {
      if (seq >= sequence) break;
      this.pending.delete(seq);
      if (pending.kind === "void") pending.resolve();
      else pending.reject(new Error(`X11 request ${seq} got no reply`));
    }
    const pending = this.pending.get(sequence);
    if (message.kind === "error") {
      const error = new X11Error(message.error);
      if (!pending) {
        this.emit("protocolError", error);
        return;
      }
      this.pending.delete(sequence);
      pending.reject(error);
      return;
    }
    if (!pending) return;
    this.pending.delete(sequence);
    if (pending.kind === "reply") pending.resolve(message.data);
    else pending.resolve();
  }

  private onClose(streamError: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    const error = new X11ConnectionClosedError(streamError);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit("close", this.closedByUs ? null : error);
  }
}
