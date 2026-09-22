/**
 * Codex adapter — the `codex app-server` NDJSON peer (spec §4.5 Codex
 * "Transport", §3.1).
 *
 * Ported from T3 Code (MIT): `packages/effect-codex-app-server/src/protocol.ts`
 * and `packages/effect-codex-app-server/src/client.ts`, reimplemented in plain
 * TypeScript without Effect.
 *
 * Four facts about this protocol that shape everything below:
 *
 * 1. **There is no `jsonrpc` field.** A request is `{id, method, params?}`, a
 *    response `{id, result}` or `{id, error}`, a notification
 *    `{method, params?}`. Confirmed against the generated bindings
 *    (`_generated/README.md`, "Transport").
 * 2. **The two id spaces are independent.** Server→client request ids start at
 *    **0** per connection and increment over *all* server requests regardless
 *    of method; the client's own ids also start low. They are disambiguated
 *    only by direction, so one map keyed by id for both directions mis-routes
 *    (fixtures README observation 15).
 * 3. **Inbound server requests must not block the read loop.** A handler is
 *    started and awaited off the loop, because an approval can be parked for
 *    minutes. The real bound is a **32 in-flight server-request cap**, beyond
 *    which the peer is answered `-32001` — T3's in-source "inline on the read
 *    loop" rationale is stale (brief, W7).
 * 4. **There are no request timeouts at all.** Callers add their own deadlines
 *    (`support/deadline.ts`), and termination fails every pending request
 *    exactly once, after which later sends fail fast.
 */

import type { Writable } from "node:stream";

import { NdjsonLineReader, parseNdjsonLine } from "../../support/ndjson.ts";
import {
  SERVER_REQUEST_METHODS,
  type ClientNotificationMethod,
  type ClientRequestMethod,
  type ClientRequestParamsByMethod,
  type ClientRequestResultsByMethod,
  type ServerNotificationMethod,
  type ServerNotificationParamsByMethod,
  type ServerRequestMethod,
  type ServerRequestParamsByMethod,
  type ServerRequestResultsByMethod
} from "./_generated/index.ts";

/**
 * Beyond this many concurrently parked server→client requests the peer is
 * answered `-32001` rather than queued: an unbounded parked set is how one
 * wedged approval turns into a host-wide leak.
 *
 * *T3: `packages/effect-codex-app-server/src/protocol.ts:18, 300-314`.*
 */
export const MAX_IN_FLIGHT_SERVER_REQUESTS = 32;

/** The code T3 answers when the cap is hit. Codex has no reserved meaning for it. */
export const TOO_MANY_REQUESTS_CODE = -32001;
export const TOO_MANY_REQUESTS_MESSAGE = "Too many Codex requests are already active.";

/** Every unhandled server→client request is refused with this (§4.5). */
export const METHOD_NOT_FOUND_CODE = -32601;
export const METHOD_NOT_FOUND_MESSAGE = "methodNotFound";

/** A JSON-RPC error object as this server spells it — no `jsonrpc`, no `data` guarantee. */
export interface CodexRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * A failure answered by the peer.
 *
 * **Never classify a Codex failure by code**: every request error observed on
 * 0.154.0 is `-32600`, including the ones JSON-RPC would spell `-32601` or
 * `-32602`; only the `message` distinguishes "bad shape" from "bad state"
 * (fixtures README observation 13).
 */
export class CodexRpcError extends Error {
  readonly code: number;
  readonly method: string;
  readonly data: unknown;

  constructor(method: string, error: CodexRpcErrorShape) {
    super(`${method} failed: ${error.message}`);
    this.name = "CodexRpcError";
    this.code = error.code;
    this.method = method;
    this.data = error.data;
  }
}

/**
 * Does this rejection mean "there was nothing left to interrupt"?
 *
 * `turn/interrupt` answers a turn that settled underneath us — and a turn id
 * the server never knew — with a hard `-32600 "no active turn to interrupt"`
 * (fixtures README obs. 5; `13-error-envelopes.ndjson` case (f)). That is a
 * benign race: the user's Stop got what they asked for.
 *
 * It must be matched on the MESSAGE, never on the code alone. `-32600` is the
 * app-server's catch-all `Invalid request`, and the very same method answers a
 * malformed call with it too — case (c) is
 * `turn/interrupt` → `-32600 "Invalid request: missing field \`turnId\`"`.
 * Treating the whole code as benign would report our own protocol bug to the
 * user as a successful Stop and quietly mark the turn settled while the model
 * kept running.
 */
export function isNoActiveTurnError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("no active turn") || message.includes("unknown turn");
}

/** Raised on every pending request when the transport is torn down. */
export class CodexTransportClosedError extends Error {
  constructor(reason: string) {
    super(`codex app-server transport closed: ${reason}`);
    this.name = "CodexTransportClosedError";
  }
}

/** Thrown by a handler to answer the peer with a specific JSON-RPC error. */
export class CodexRequestRefusal extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "CodexRequestRefusal";
    this.code = code;
  }

  static methodNotFound(method: string): CodexRequestRefusal {
    return new CodexRequestRefusal(
      METHOD_NOT_FOUND_CODE,
      `${METHOD_NOT_FOUND_MESSAGE}: ${method}`
    );
  }

  static invalidParams(message: string): CodexRequestRefusal {
    return new CodexRequestRefusal(-32602, message);
  }
}

/** One decoded server→client request, before a handler has answered it. */
export interface CodexServerRequest<TMethod extends ServerRequestMethod = ServerRequestMethod> {
  id: number | string;
  method: TMethod;
  params: ServerRequestParamsByMethod[TMethod];
}

export interface CodexPeerHandlers {
  /**
   * Answer one server→client request. Resolving sends `{id, result}`; throwing
   * a {@link CodexRequestRefusal} sends that error, and any other throw is
   * reported as `-32603`.
   *
   * An unhandled method must be refused with `-32601`, which the server treats
   * as "the model was refused", never as a protocol violation (fixtures README
   * observation 14).
   */
  onRequest(
    request: CodexServerRequest
  ): Promise<ServerRequestResultsByMethod[ServerRequestMethod]>;
  /** One server notification. Never awaited — a slow consumer must not stall the loop. */
  onNotification<TMethod extends ServerNotificationMethod>(
    method: TMethod,
    params: ServerNotificationParamsByMethod[TMethod]
  ): void;
  /**
   * A frame that is neither a known request, a response to one of ours, nor a
   * known notification. Surfaced, **never** dropped by a catch-all (§10).
   */
  onUnknownFrame(frame: unknown, reason: string): void;
  /** A line that did not parse as JSON. */
  onMalformedLine(line: string, error: unknown): void;
}

export interface CodexPeerOptions {
  stdin: Writable;
  stdout: NodeJS.ReadableStream;
  handlers: CodexPeerHandlers;
  /** Every outbound and inbound frame, for `raw.ndjson`. Best-effort. */
  onFrame?: (direction: "send" | "recv", frame: unknown) => void;
  maxInFlightServerRequests?: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** Derived from the generated catalogue, never a hand-kept copy. */
const SERVER_REQUEST_METHOD_SET: ReadonlySet<string> = new Set<string>(
  Object.keys(SERVER_REQUEST_METHODS)
);

/**
 * A live NDJSON peer over one child's stdio.
 *
 * Nothing here has a timeout: `withDeadline` at the call site is what bounds a
 * wait, so a slow provider is the caller's problem and never a silent hang in
 * the transport (§3.1).
 */
export class CodexPeer {
  private readonly reader = new NdjsonLineReader();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inFlightServerRequests = new Set<number | string>();
  private readonly settledWaiters: (() => void)[] = [];
  private readonly maxInFlight: number;
  private nextId = 1;
  private closedReason: string | null = null;

  constructor(private readonly options: CodexPeerOptions) {
    this.maxInFlight = options.maxInFlightServerRequests ?? MAX_IN_FLIGHT_SERVER_REQUESTS;
    options.stdout.on("data", (chunk: Buffer | string) => {
      for (const line of this.reader.push(typeof chunk === "string" ? chunk : chunk)) {
        this.handleLine(line);
      }
    });
    options.stdout.on("end", () => {
      for (const line of this.reader.flush()) {
        this.handleLine(line);
      }
    });
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  /** Requests still parked on this transport. */
  get pendingRequestCount(): number {
    return this.pending.size;
  }

  /** Server→client requests whose handler has not answered yet. */
  get openServerRequestCount(): number {
    return this.inFlightServerRequests.size;
  }

  /**
   * Resolve once every parked server request has been **answered on the
   * wire**.
   *
   * Settling a request resolves its handler's promise, but the reply is only
   * written on the microtask that follows, so a caller that settles and then
   * immediately sends `turn/interrupt` would put the interrupt on the wire
   * FIRST. §4.1's "settle before interrupt" is an ordering guarantee about the
   * bytes, not about the local bookkeeping, so the interrupt path awaits this.
   */
  whenServerRequestsSettled(): Promise<void> {
    if (this.inFlightServerRequests.size === 0 || this.closedReason !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.settledWaiters.push(resolve);
    });
  }

  /**
   * Send a client→server request and await its reply.
   *
   * Rejects with {@link CodexRpcError} when the peer answers an error, and
   * with {@link CodexTransportClosedError} when the transport is already, or
   * becomes, closed.
   */
  request<TMethod extends ClientRequestMethod>(
    method: TMethod,
    params: ClientRequestParamsByMethod[TMethod]
  ): Promise<ClientRequestResultsByMethod[TMethod]> {
    if (this.closedReason !== null) {
      return Promise.reject(new CodexTransportClosedError(this.closedReason));
    }
    const id = this.nextId++;
    const frame = { id, method, params };
    return new Promise<ClientRequestResultsByMethod[TMethod]>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      if (!this.writeFrame(frame)) {
        this.pending.delete(id);
        reject(new CodexTransportClosedError(this.closedReason ?? "stdin is not writable"));
      }
    });
  }

  /** Send a client→server notification. Fire and forget. */
  notify<TMethod extends ClientNotificationMethod>(method: TMethod, params?: unknown): void {
    if (this.closedReason !== null) {
      return;
    }
    // `initialized` takes no params, and the server rejects an explicit
    // `"params": null`, so the key is omitted rather than nulled.
    this.writeFrame(params === undefined ? { method } : { method, params });
  }

  /**
   * Fail every pending request **once** and refuse everything after. Called
   * when the child exits or the session is torn down, so a running state never
   * outlives its process (§3.1).
   */
  close(reason: string): void {
    if (this.closedReason !== null) {
      return;
    }
    this.closedReason = reason;
    const error = new CodexTransportClosedError(reason);
    const parked = [...this.pending.values()];
    this.pending.clear();
    for (const entry of parked) {
      entry.reject(error);
    }
    this.inFlightServerRequests.clear();
    this.releaseSettledWaiters();
  }

  private releaseSettledWaiters(): void {
    if (this.inFlightServerRequests.size > 0 && this.closedReason === null) {
      return;
    }
    while (this.settledWaiters.length > 0) {
      this.settledWaiters.shift()!();
    }
  }

  // -------------------------------------------------------------------------
  // Read side
  // -------------------------------------------------------------------------

  private handleLine(line: string): void {
    let frame: unknown;
    try {
      frame = parseNdjsonLine(line);
    } catch (error) {
      this.options.handlers.onMalformedLine(line, error);
      return;
    }
    if (frame === undefined) {
      return;
    }
    this.logFrame("recv", frame);
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      this.options.handlers.onUnknownFrame(frame, "not a JSON object");
      return;
    }

    const record = frame as Record<string, unknown>;
    const hasId = "id" in record && record.id !== null && record.id !== undefined;
    const method = typeof record.method === "string" ? record.method : undefined;

    if (hasId && method === undefined) {
      this.handleResponse(record);
      return;
    }
    if (hasId && method !== undefined) {
      this.handleServerRequest(record, method);
      return;
    }
    if (method !== undefined) {
      this.handleNotification(record, method);
      return;
    }
    this.options.handlers.onUnknownFrame(frame, "neither a request, a response nor a notification");
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = record.id;
    if (typeof id !== "number") {
      // A string id can only be a server request we did not recognise as one;
      // our own ids are always numbers.
      this.options.handlers.onUnknownFrame(record, "response with a non-numeric id");
      return;
    }
    const entry = this.pending.get(id);
    if (entry === undefined) {
      this.options.handlers.onUnknownFrame(record, `response for unknown request id ${id}`);
      return;
    }
    this.pending.delete(id);
    if ("error" in record && record.error !== undefined && record.error !== null) {
      entry.reject(new CodexRpcError(entry.method, toRpcErrorShape(record.error)));
      return;
    }
    entry.resolve(record.result ?? {});
  }

  private handleServerRequest(record: Record<string, unknown>, method: string): void {
    const id = record.id as number | string;

    if (!SERVER_REQUEST_METHOD_SET.has(method)) {
      // Unknown server→client request: surfaced AND refused. Degrading to "the
      // model was refused" is documented-safe; dropping it would wedge the turn.
      this.options.handlers.onUnknownFrame(record, `unknown server request ${method}`);
      this.respondError(id, METHOD_NOT_FOUND_CODE, `${METHOD_NOT_FOUND_MESSAGE}: ${method}`);
      return;
    }

    if (this.inFlightServerRequests.size >= this.maxInFlight) {
      this.respondError(id, TOO_MANY_REQUESTS_CODE, TOO_MANY_REQUESTS_MESSAGE);
      return;
    }

    this.inFlightServerRequests.add(id);
    const request: CodexServerRequest = {
      id,
      method: method as ServerRequestMethod,
      params: record.params as ServerRequestParamsByMethod[ServerRequestMethod]
    };

    // Forked off the read loop on purpose: an approval parks for as long as the
    // user takes, and the loop must keep delivering notifications meanwhile.
    void (async () => {
      try {
        const result = await this.options.handlers.onRequest(request);
        this.respondResult(id, result);
      } catch (error) {
        if (error instanceof CodexRequestRefusal) {
          this.respondError(id, error.code, error.message);
          return;
        }
        this.respondError(id, -32603, describeError(error));
      } finally {
        this.inFlightServerRequests.delete(id);
        this.releaseSettledWaiters();
      }
    })();
  }

  private handleNotification(record: Record<string, unknown>, method: string): void {
    try {
      this.options.handlers.onNotification(
        method as ServerNotificationMethod,
        record.params as ServerNotificationParamsByMethod[ServerNotificationMethod]
      );
    } catch (error) {
      // A consumer that throws must not take the read loop down with it.
      this.options.handlers.onUnknownFrame(record, `notification handler threw: ${describeError(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Write side
  // -------------------------------------------------------------------------

  private respondResult(id: number | string, result: unknown): void {
    this.writeFrame({ id, result: result ?? {} });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.writeFrame({ id, error: { code, message } });
  }

  private writeFrame(frame: unknown): boolean {
    if (this.closedReason !== null) {
      return false;
    }
    let line: string;
    try {
      line = `${JSON.stringify(frame)}\n`;
    } catch {
      return false;
    }
    const stdin = this.options.stdin;
    if (stdin.destroyed || stdin.writableEnded) {
      // Logged AFTER the writability check, so an unwritten frame is never
      // recorded as sent (Q1 finding 33).
      return false;
    }
    try {
      stdin.write(line);
    } catch {
      return false;
    }
    this.logFrame("send", frame);
    return true;
  }

  /**
   * `AdapterContext.logRawFrame` is documented "best-effort and never
   * blocking", but it runs on a stream event and inside the request-handler
   * IIFE's `finally`. A throw there would be an uncaught exception that kills
   * the host, so it is contained here (Q1 finding 33).
   */
  private logFrame(direction: "send" | "recv", frame: unknown): void {
    try {
      this.options.onFrame?.(direction, frame);
    } catch {
      // Diagnostics must never take the transport down.
    }
  }
}

function toRpcErrorShape(value: unknown): CodexRpcErrorShape {
  if (typeof value !== "object" || value === null) {
    return { code: -32603, message: String(value) };
  }
  const record = value as Record<string, unknown>;
  return {
    code: typeof record.code === "number" ? record.code : -32603,
    message: typeof record.message === "string" ? record.message : JSON.stringify(value),
    data: record.data
  };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
