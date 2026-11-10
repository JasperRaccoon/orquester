// One X11 client connection: handshake, request sequencing and reply/error matching, event
// dispatch. Encoding and decoding are in ./protocol.ts and ./xres.ts.
//
// Sequence numbers: every request increments a counter; replies, errors and events carry the low
// 16 bits of the last request the server processed. Replies and errors are matched to pending
// requests by widening those 16 bits against the counter. Requests without a reply ("void") are
// sent "checked": a GetInputFocus follows them, and since the server answers in order, the sync
// reply arriving without an error for the void request means it succeeded. `post` sends a void
// request without its own sync, so a burst (XTEST input) shares one `sync()` barrier.
//
// Incoming bytes are gathered as a list of chunks and joined once per message, so a reply of
// several MiB (GetImage) arriving in many small reads is not copied once per read.

import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

import {
  AnyPropertyType,
  decodeGetGeometryReply,
  decodeGetImageReply,
  decodeGetKeyboardMappingReply,
  decodeGetModifierMappingReply,
  decodeGetPropertyReply,
  decodeGetSelectionOwnerReply,
  decodeInternAtomReply,
  decodeQueryExtensionReply,
  decodeQueryPointerReply,
  decodeServerMessage,
  decodeSetupResponse,
  decodeTranslateCoordinatesReply,
  encodeGetGeometry,
  encodeGetImage,
  encodeGetInputFocus,
  encodeGetKeyboardMapping,
  encodeGetModifierMapping,
  encodeGetProperty,
  encodeGetSelectionOwner,
  encodeInternAtom,
  encodeQueryExtension,
  encodeQueryPointer,
  encodeSelectInput,
  encodeSendEvent,
  encodeSetupRequest,
  encodeTranslateCoordinates,
  ImageFormat,
  serverMessageLength,
  setupResponseLength,
  type GeometryReply,
  type GetImageReply,
  type GetPropertyReply,
  type KeyboardMapping,
  type QueryExtensionReply,
  type QueryPointerReply,
  type SetupInfo,
  type TranslateCoordinatesReply,
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
    super(cause ? `X11 connection closed: ${cause.message}` : "X11 connection closed", cause ? { cause } : undefined);
    this.name = "X11ConnectionClosedError";
  }
}

/**
 * The server declared a message longer than {@link MAX_SERVER_MESSAGE_BYTES}: the
 * connection is closed instead of buffering it (boxes: a VM's X server is not trusted
 * to stay within what this client ever asks for).
 */
export class X11MessageTooLargeError extends Error {
  constructor(readonly length: number) {
    super(`X11 server sent a ${length}-byte message (more than ${MAX_SERVER_MESSAGE_BYTES} bytes)`);
    this.name = "X11MessageTooLargeError";
  }
}

/**
 * The longest reply or event this client accepts (property reads ask for 64 KiB at a time, a
 * screen capture is read in bands that fit).
 */
export const MAX_SERVER_MESSAGE_BYTES = 4 * 1024 * 1024;

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
  /** Received bytes not yet dispatched, in arrival order. */
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private closed = false;
  private closedByUs = false;
  private nextResourceId = 1;

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
    const done = this.post(buf);
    // The sync's own outcome is irrelevant: a close rejects `done` too.
    this.sync().catch(() => {});
    return done;
  }

  /**
   * Send a request without a reply and without a sync: it settles once a later reply or error
   * shows the server processed it (rejecting with its own error), so a `sync()` must follow.
   */
  post(buf: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.isClosed) {
        reject(new X11ConnectionClosedError());
        return;
      }
      this.pending.set(this.send(buf), { kind: "void", resolve, reject });
    });
  }

  /** A round trip (GetInputFocus): resolves once the server has processed every earlier request. */
  async sync(): Promise<void> {
    await this.request(encodeGetInputFocus());
  }

  /** A new resource id (window, damage, …) from the setup's range. */
  allocateId(): number {
    const mask = this.setup.resourceIdMask;
    const step = mask & -mask;
    const id = (this.nextResourceId * step) & mask;
    if (id === 0 || this.nextResourceId * step > mask) throw new Error("X11 resource ids exhausted");
    this.nextResourceId += 1;
    return (this.setup.resourceIdBase | id) >>> 0;
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

  async queryPointer(window: number): Promise<QueryPointerReply> {
    return decodeQueryPointerReply(await this.request(encodeQueryPointer(window)));
  }

  async translateCoordinates(source: number, destination: number, x: number, y: number): Promise<TranslateCoordinatesReply> {
    return decodeTranslateCoordinatesReply(await this.request(encodeTranslateCoordinates(source, destination, x, y)));
  }

  /** GetImage in ZPixmap format with every plane; the reply must fit {@link MAX_SERVER_MESSAGE_BYTES}. */
  async getImage(drawable: number, rect: { x: number; y: number; width: number; height: number }): Promise<GetImageReply> {
    return decodeGetImageReply(await this.request(encodeGetImage(ImageFormat.ZPixmap, drawable, rect)));
  }

  /** The keysyms of every keycode the server has (`setup.minKeycode` … `setup.maxKeycode`). */
  async getKeyboardMapping(): Promise<KeyboardMapping> {
    const { minKeycode, maxKeycode } = this.setup;
    return decodeGetKeyboardMappingReply(await this.request(encodeGetKeyboardMapping(minKeycode, maxKeycode - minKeycode + 1)));
  }

  async getModifierMapping(): Promise<number[][]> {
    return decodeGetModifierMappingReply(await this.request(encodeGetModifierMapping()));
  }

  async getSelectionOwner(selection: number): Promise<number> {
    return decodeGetSelectionOwnerReply(await this.request(encodeGetSelectionOwner(selection)));
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
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
    for (;;) {
      if (this.bufferedBytes < 32) return;
      // The 32-byte header may straddle reads: join just the leading chunks it covers.
      while (this.chunks[0]!.length < 32) this.chunks.splice(0, 2, Buffer.concat([this.chunks[0]!, this.chunks[1]!]));
      const length = serverMessageLength(this.chunks[0]!)!;
      if (length > MAX_SERVER_MESSAGE_BYTES) {
        this.chunks = [];
        this.bufferedBytes = 0;
        this.stream.destroy(new X11MessageTooLargeError(length));
        return;
      }
      if (this.bufferedBytes < length) return;
      this.dispatch(this.take(length));
      if (this.closed) return;
    }
  }

  /** The next `length` buffered bytes: a view when one chunk holds them, else one join. */
  private take(length: number): Buffer {
    this.bufferedBytes -= length;
    const first = this.chunks[0]!;
    if (first.length >= length) {
      if (first.length === length) this.chunks.shift();
      else this.chunks[0] = first.subarray(length);
      return first.subarray(0, length);
    }
    const parts: Buffer[] = [];
    let needed = length;
    while (needed > 0) {
      const head = this.chunks[0]!;
      if (head.length <= needed) {
        parts.push(head);
        this.chunks.shift();
        needed -= head.length;
      } else {
        parts.push(head.subarray(0, needed));
        this.chunks[0] = head.subarray(needed);
        needed = 0;
      }
    }
    return Buffer.concat(parts, length);
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
