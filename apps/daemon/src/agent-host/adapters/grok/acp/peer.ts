/**
 * ACP client — a generic JSON-RPC 2.0 NDJSON duplex peer (spec §4.5 Grok
 * "Generic ACP machinery a fresh implementation must rebuild", §10).
 *
 * Ported from T3 Code (MIT): `packages/effect-acp/src/protocol.ts` and
 * `packages/effect-acp/src/client.ts`, translated from Effect into plain
 * promises.
 *
 * One stdio pipe carries traffic in BOTH directions: we call the agent
 * (`initialize`, `session/prompt`, …) and the agent calls us
 * (`session/request_permission`, `_x.ai/exit_plan_mode`, …). The peer is
 * transport-agnostic on purpose — it is handed a `send(line)` and is fed
 * `handleLine(line)` — so a lifecycle test can drive it through an injected
 * transport with no child process at all (§9).
 *
 * Four rules the captures make load-bearing
 * (`apps/daemon/test/fixtures/grok/`):
 *
 * 1. **Request handlers must not block the read loop.** A handler is invoked
 *    and its promise is awaited *off* the dispatch path, so an open approval
 *    card cannot stop the next frame being parsed. T3's transport answers
 *    inline; §3.1 names the resulting deadlock ("cancelling after the
 *    interrupt RPC deadlocks Stop exactly when a card is open") as the reason
 *    settling has to come first. Not blocking the loop removes the deadlock
 *    entirely, and the settle-first ordering stays as belt and braces.
 * 2. **Every extension method exists in two spellings.** `x.ai/foo` and
 *    `_x.ai/foo` are distinct strings to a dispatcher; 1.0.34 only ever used
 *    the underscore form, so registering one is silent loss.
 *    {@link AcpPeer.registerExtension} registers both.
 * 3. **Tolerant reader, strict writer.** Outbound framing is exactly
 *    `{jsonrpc, id?, method|result|error, params?}`; inbound, a missing or
 *    wrong `jsonrpc` is warned about rather than rejected, because a vendor
 *    extension that omits it must not take the session down.
 * 4. **An unknown method is answered, never swallowed** (§10): a request gets
 *    `-32601`, a notification gets nothing, and both raise a warning the
 *    adapter turns into `runtime.warning`.
 * 5. **Transport death fails every in-flight request exactly once**, and every
 *    later send fails fast — `14-sigterm-mid-prompt.ndjson` shows the
 *    in-flight `session/prompt` getting no response and no error at all.
 */

import { AGENT_HOST_DEADLINES } from "../../../support/deadline.ts";
import {
  ACP_ERROR_CODES,
  AcpProtocolError,
  AcpRpcError,
  AcpTransportClosedError,
  type AcpErrorPayload
} from "./errors.ts";
import { xaiMethodSpellings } from "./_generated/xai.ts";

/** Which way a frame travelled. Stamped onto the raw log (§3.1). */
export type AcpFrameDirection = "send" | "recv";

export type AcpRequestHandler = (params: unknown, context: AcpRequestContext) => Promise<unknown>;
export type AcpNotificationHandler = (params: unknown) => void;

export interface AcpRequestContext {
  /** The method name as it arrived — which spelling, for the raw log. */
  readonly method: string;
  /** The JSON-RPC id, echoed verbatim on the reply. */
  readonly id: string | number;
}

export interface AcpPeerOptions {
  /** Write one already-serialised NDJSON line (no trailing newline needed). */
  send(line: string): void;
  /**
   * Every frame, both directions, before any interpretation. The adapter
   * routes this at `raw.ndjson` through its redactor — `_x.ai/mcp/servers_updated`
   * carries the host's real MCP credentials.
   */
  onFrame?(direction: AcpFrameDirection, frame: unknown): void;
  /** An unknown method, a malformed line, a reply to nothing (§10). */
  onWarning?(message: string, detail?: unknown): void;
  /** Default per-request deadline. Individual calls may override it. */
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  readonly method: string;
  readonly settle: (value: unknown) => void;
  readonly fail: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

interface JsonRpcFrame {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface AcpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AcpPeer {
  private readonly options: AcpPeerOptions;
  private readonly requestHandlers = new Map<string, AcpRequestHandler>();
  private readonly notificationHandlers = new Map<string, AcpNotificationHandler>();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closedReason: AcpTransportClosedError | null = null;

  constructor(options: AcpPeerOptions) {
    this.options = options;
  }

  // -------------------------------------------------------------- outbound

  /**
   * Call a method on the agent and await its result.
   *
   * The deadline is the §3.1 rule — every step that waits on a child has one.
   * On expiry the pending entry is dropped and nothing is sent: ACP's own
   * cancellation is the `session/cancel` NOTIFICATION, and the catalog's
   * `$/cancel_request` was never observed from this CLI in either direction,
   * so sending one would be speculation against a live agent. A late reply
   * then arrives for an id nobody is waiting on and becomes a warning rather
   * than a crash.
   *
   * *T3: `packages/effect-acp/src/protocol.ts:137-140` — RpcClient's own
   * interrupt frame is deliberately dropped for the same reason ("ACP has no
   * such method; agents log it as an error and cannot act on it").*
   */
  request<T = unknown>(method: string, params?: unknown, options: AcpRequestOptions = {}): Promise<T> {
    if (this.closedReason !== null) {
      return Promise.reject(this.closedReason);
    }
    const id = this.nextId;
    this.nextId += 1;

    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? AGENT_HOST_DEADLINES.sessionOpenMs;

    return new Promise<T>((resolve, reject) => {
      const finish = (fn: () => void): void => {
        const entry = this.pending.get(id);
        if (entry === undefined) {
          return;
        }
        this.pending.delete(id);
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
        }
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const onAbort = (): void => {
        finish(() => {
          reject(options.signal?.reason ?? new Error("Aborted"));
        });
      };

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              finish(() => {
                reject(new AcpRpcError(method, {
                  code: ACP_ERROR_CODES.internalError,
                  message: `timed out after ${timeoutMs}ms`
                }));
              });
              // Deliberately NOT unref'd: an expired deadline is what lets the
              // adapter retire a wedged child (§3.1).
            }, timeoutMs)
          : null;

      this.pending.set(id, {
        method,
        settle: (value) => finish(() => resolve(value as T)),
        fail: (error) => finish(() => reject(error)),
        timer
      });

      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** Send a notification. Fire and forget — the protocol defines no reply. */
  notify(method: string, params?: unknown): void {
    if (this.closedReason !== null) {
      return;
    }
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  // --------------------------------------------------------------- handlers

  /** Serve an exactly-named method the agent may call on us. */
  onRequest(method: string, handler: AcpRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Observe an exactly-named notification the agent sends us. */
  onNotification(method: string, handler: AcpNotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Register an `x.ai/*` extension under BOTH legal spellings, unwrapping the
   * `{method, params}` envelope T3 unwraps defensively. 1.0.34 never sent the
   * wrapped form, so nothing may *depend* on it — but it costs one line.
   */
  registerExtension(bareMethod: string, handler: AcpRequestHandler): void {
    for (const spelling of xaiMethodSpellings(bareMethod)) {
      this.requestHandlers.set(spelling, (params, context) =>
        handler(unwrapExtensionParams(params, bareMethod), context)
      );
    }
  }

  /** The notification half of {@link registerExtension}. */
  registerExtensionNotification(bareMethod: string, handler: AcpNotificationHandler): void {
    for (const spelling of xaiMethodSpellings(bareMethod)) {
      this.notificationHandlers.set(spelling, (params) => {
        handler(unwrapExtensionParams(params, bareMethod));
      });
    }
  }

  // --------------------------------------------------------------- inbound

  /** Feed one NDJSON line from the agent. Never throws. */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let frame: JsonRpcFrame;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new AcpProtocolError("frame is not a JSON-RPC object", trimmed);
      }
      frame = parsed as JsonRpcFrame;
    } catch (error) {
      this.warn("acp: unparsable frame", {
        error: error instanceof Error ? error.message : String(error),
        line: trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed
      });
      return;
    }

    this.options.onFrame?.("recv", frame);

    // Tolerant reader, strict writer: a frame without `jsonrpc: "2.0"` is
    // still dispatched, because a vendor extension that omits it must not take
    // the session down — but it is surfaced, never silently accepted (R4 #14).
    if (frame.jsonrpc !== "2.0") {
      this.warn("acp: frame is not JSON-RPC 2.0", { jsonrpc: frame.jsonrpc });
    }

    if (typeof frame.method === "string") {
      if (frame.id === undefined || frame.id === null) {
        this.dispatchNotification(frame.method, frame.params);
        return;
      }
      // The one place an untrusted field would otherwise escape the shape
      // guards: an `id` that is an object, array or boolean would be echoed
      // back verbatim and typed wrongly inside the handlers (Q1 #32).
      if (typeof frame.id !== "string" && typeof frame.id !== "number") {
        this.warn("acp: request id is neither a string nor a number", { id: frame.id });
        return;
      }
      void this.dispatchRequest(frame.method, frame.id, frame.params);
      return;
    }

    if (frame.id === undefined || frame.id === null) {
      this.warn("acp: frame has neither a method nor an id", frame);
      return;
    }
    this.dispatchResponse(frame);
  }

  /**
   * The transport is gone. Every in-flight request is failed exactly once and
   * every later send fails fast (§3.1: "a dead child never leaves a running
   * turn"). Idempotent.
   */
  close(reason: string, detail?: string): void {
    if (this.closedReason !== null) {
      return;
    }
    this.closedReason = new AcpTransportClosedError(reason, detail);
    // Iterate a copy but leave the map populated: `fail` routes through the
    // per-request `finish`, which looks the id up and is what actually
    // rejects. Clearing first would settle nothing and hang every caller.
    for (const entry of [...this.pending.values()]) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      entry.fail(this.closedReason);
    }
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  /** How many calls are still awaiting a reply. Tests assert on this. */
  get inFlightCount(): number {
    return this.pending.size;
  }

  // --------------------------------------------------------------- internals

  private dispatchNotification(method: string, params: unknown): void {
    const handler = this.notificationHandlers.get(method);
    if (handler === undefined) {
      // §10: surfaced, never dropped by a catch-all. A notification has no
      // reply, so the warning is the whole surface.
      this.warn(`acp: unhandled notification ${method}`, summarisePayload(params));
      return;
    }
    try {
      handler(params);
    } catch (error) {
      this.warn(`acp: notification handler for ${method} threw`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async dispatchRequest(method: string, id: string | number, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (handler === undefined) {
      this.warn(`acp: unknown method ${method}`, summarisePayload(params));
      this.respondError(id, {
        code: ACP_ERROR_CODES.methodNotFound,
        message: "Method not found"
      });
      return;
    }
    try {
      const result = await handler(params, { method, id });
      this.respondResult(id, result === undefined ? {} : result);
    } catch (error) {
      if (error instanceof AcpRpcError) {
        this.respondError(id, error.toPayload());
        return;
      }
      this.respondError(id, {
        code: ACP_ERROR_CODES.internalError,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private dispatchResponse(frame: JsonRpcFrame): void {
    const id = typeof frame.id === "number" ? frame.id : Number(frame.id);
    const entry = Number.isFinite(id) ? this.pending.get(id) : undefined;
    if (entry === undefined) {
      // A reply to a request whose deadline already expired, or one we never
      // sent. Neither is fatal; both must be visible.
      this.warn("acp: response for an unknown request id", { id: frame.id });
      return;
    }
    if (frame.error !== undefined && frame.error !== null) {
      entry.fail(new AcpRpcError(entry.method, toErrorPayload(frame.error)));
      return;
    }
    entry.settle(frame.result);
  }

  private respondResult(id: string | number, result: unknown): void {
    if (this.closedReason !== null) {
      return;
    }
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: string | number, error: AcpErrorPayload): void {
    if (this.closedReason !== null) {
      return;
    }
    this.write({ jsonrpc: "2.0", id, error });
  }

  private write(frame: unknown): void {
    this.options.onFrame?.("send", frame);
    let line: string;
    try {
      line = JSON.stringify(frame);
    } catch (error) {
      this.warn("acp: outbound frame is not serialisable", {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    try {
      this.options.send(line);
    } catch (error) {
      this.close("acp: transport write failed", error instanceof Error ? error.message : String(error));
    }
  }

  private warn(message: string, detail?: unknown): void {
    this.options.onWarning?.(message, detail);
  }
}

/**
 * T3 unwraps a `{method, params}` envelope around extension params. 1.0.34
 * always sent them unwrapped, so this only ever fires on a hypothetical newer
 * CLI — and only when the inner `method` really names this extension, so a
 * payload that happens to carry a `method` field of its own is left alone.
 */
export function unwrapExtensionParams(params: unknown, bareMethod: string): unknown {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }
  const record = params as { method?: unknown; params?: unknown };
  if (typeof record.method !== "string" || record.params === undefined) {
    return params;
  }
  const spellings = xaiMethodSpellings(bareMethod) as readonly string[];
  return spellings.includes(record.method) ? record.params : params;
}

function toErrorPayload(value: unknown): AcpErrorPayload {
  if (value === null || typeof value !== "object") {
    return { code: ACP_ERROR_CODES.internalError, message: String(value) };
  }
  const record = value as { code?: unknown; message?: unknown; data?: unknown };
  return {
    code: typeof record.code === "number" ? record.code : ACP_ERROR_CODES.internalError,
    message: typeof record.message === "string" ? record.message : "unknown error",
    ...(record.data === undefined ? {} : { data: record.data })
  };
}

/**
 * Protocol logging **summarises payloads, never logs them raw** (§4.5): a
 * warning about an unknown method must not copy a file's contents into the
 * host log.
 */
export function summarisePayload(params: unknown): unknown {
  if (params === null || params === undefined) {
    return params;
  }
  if (typeof params !== "object") {
    return typeof params === "string" ? `<string len=${params.length}>` : params;
  }
  if (Array.isArray(params)) {
    return `<array len=${params.length}>`;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    out[key] = describeValue(value);
  }
  return out;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  switch (typeof value) {
    case "string":
      return value.length <= 40 ? JSON.stringify(value) : `string(${value.length})`;
    case "number":
    case "boolean":
      return String(value);
    case "object":
      return `object(${Object.keys(value as object).length})`;
    default:
      return typeof value;
  }
}
