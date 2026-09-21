/**
 * Agent chat — `Transporter.agentChat` (spec §6.3 client side, §6.5, §7.1).
 *
 * The chat stream is a long-lived chunked NDJSON `GET`, so it needs nothing
 * the transporter layer does not already have: every runtime already exposes
 * `openStream(path, handlers)` (web streams `fetch`, desktop bridges chunked
 * NDJSON over IPC — the same path `/events` and terminal output ride). That is
 * why {@link createAgentChatTransport} is built from `request` + `openStream`
 * alone and works unchanged on the HTTP transporter *and* on the desktop
 * unix-socket transporter the Electron host injects (§6.5: "nothing in the
 * chat UI depends on WebSockets").
 *
 * A transporter may still override it by implementing `agentChat()`.
 */

import {
  agentChatCommandPath,
  agentChatRoutes,
  type AgentChatCommandBodies,
  type AgentChatCommandName,
  type AgentChatErrorCode,
  type AgentChatStreamFrame,
  type AgentProvidersResponse,
  type AttachmentRef,
  type CommandReceiptResponse,
  type RefreshProviderResponse,
  type ThreadItemResponse,
  type ThreadReadResponse,
  type TurnDiffResponse
} from "@orquester/api/agent-chat";
import type { SessionUploadResponse } from "@orquester/api";

import type { BinaryBody, StreamHandle, Transporter } from "../transporter";
import {
  NdjsonLineBuffer,
  parseStreamLine,
  RECONNECT_MAX_MS,
  reconnectDelayMs,
  resumeCursorFor,
  STREAM_STALL_TIMEOUT_MS
} from "./stream.logic";

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export interface AgentChatStreamHandlers {
  /** One decoded `snapshot` / `event` / `synchronized` frame, in wire order. */
  onFrame(frame: AgentChatStreamFrame): void;
  /** The underlying HTTP response opened. Fires again on every reconnect. */
  onOpen?(): void;
  /** The transport dropped; a reconnect is scheduled. `delayMs` is when. */
  onReconnect?(info: { attempt: number; delayMs: number; reason: string }): void;
  /** The stream was closed by the caller, or gave up. */
  onClose?(): void;
  onError?(error: unknown): void;
}

export interface AgentChatStreamOptions {
  /** Resume cursor. Omitted (or 0) asks the host for a snapshot. */
  after?: number;
  /**
   * The instance id the caller last synchronized with. When the host answers
   * with a different one, the client re-reads instead of resuming (§6.3, §8).
   */
  hostInstanceId?: string | null;
  /** Injected in tests. Defaults to `setTimeout`/`clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

/** A stream that reconnects itself; `close()` retires it for good. */
export interface AgentChatStreamHandle extends StreamHandle {
  /** The highest sequence handed to `onFrame`. */
  readonly lastSeq: number;
  /** The last `synchronized` instance id, or null before the first one. */
  readonly hostInstanceId: string | null;
}

export interface AgentChatUploadMeta {
  name: string;
  type?: string;
}

/**
 * What `Transporter.agentChat` exposes. `stream`, `command` and `read` are the
 * three §7.1 names; the rest are the remaining §6.3 reads, kept here rather
 * than on `ApiClient` so the whole chat surface has one seam.
 */
export interface AgentChatTransport {
  stream(
    sessionId: string,
    options: AgentChatStreamOptions,
    handlers: AgentChatStreamHandlers
  ): AgentChatStreamHandle;
  command<TName extends AgentChatCommandName>(
    sessionId: string,
    name: TName,
    body: AgentChatCommandBodies[TName],
    signal?: AbortSignal
  ): Promise<CommandReceiptResponse>;
  read(
    sessionId: string,
    options?: { after?: number; signal?: AbortSignal }
  ): Promise<ThreadReadResponse>;
  readItem(sessionId: string, itemId: string, signal?: AbortSignal): Promise<ThreadItemResponse>;
  turnDiff(
    sessionId: string,
    turnCount: number,
    options?: { ignoreWhitespace?: boolean; signal?: AbortSignal }
  ): Promise<TurnDiffResponse>;
  providers(signal?: AbortSignal): Promise<AgentProvidersResponse>;
  refreshProvider(
    adapterId: string,
    body?: { cwd?: string },
    signal?: AbortSignal
  ): Promise<RefreshProviderResponse>;
  /** The existing raw-binary upload route; returns the §6.3 attachment reference. */
  upload(
    sessionId: string,
    data: BinaryBody,
    meta: AgentChatUploadMeta,
    onProgress?: (sent: number, total: number) => void
  ): Promise<AttachmentRef>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failed §6.2 command. Carries the daemon's code so a caller can retry
 * `HOST_UNAVAILABLE` with the **same** `commandId` (the receipt makes that
 * free) and surface everything else.
 */
export class AgentChatCommandError extends Error {
  readonly status: number;
  readonly code: AgentChatErrorCode | "UNKNOWN";
  readonly detail: unknown;

  constructor(status: number, code: AgentChatErrorCode | "UNKNOWN", message: string, detail?: unknown) {
    super(message);
    this.name = "AgentChatCommandError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** 503 only: the host is restarting and the same command id may be re-posted. */
  get retryable(): boolean {
    return this.code === "HOST_UNAVAILABLE";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function commandErrorFrom(status: number, data: unknown, fallback: string): AgentChatCommandError {
  const envelope = isRecord(data) && isRecord(data.error) ? data.error : null;
  const code =
    envelope && typeof envelope.code === "string"
      ? (envelope.code as AgentChatErrorCode)
      : "UNKNOWN";
  const message =
    envelope && typeof envelope.message === "string" && envelope.message.length > 0
      ? envelope.message
      : fallback;
  return new AgentChatCommandError(status, code, message, envelope?.detail);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the chat transport over any {@link Transporter}.
 *
 * Reconnect is owned here rather than by the store: the store applies frames
 * and does not know that a dropped socket is different from a quiet thread.
 * A reconnect re-asks with the highest sequence we actually applied, so the
 * host decides snapshot-vs-replay (§6.3) and neither loses nor duplicates.
 */
export function createAgentChatTransport(transporter: Transporter): AgentChatTransport {
  const send = async <T>(
    method: "GET" | "POST",
    path: string,
    init?: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      signal?: AbortSignal;
    }
  ): Promise<T> => {
    const response = await transporter.request<T>({
      method,
      path,
      ...(init?.body === undefined ? {} : { body: init.body }),
      ...(init?.query === undefined ? {} : { query: init.query }),
      ...(init?.signal === undefined ? {} : { signal: init.signal })
    });
    if (!response.ok) {
      throw commandErrorFrom(response.status, response.data, `${method} ${path} failed`);
    }
    return response.data;
  };

  return {
    stream(sessionId, options, handlers) {
      return openAgentChatStream(transporter, sessionId, options, handlers);
    },

    command(sessionId, name, body, signal) {
      return send<CommandReceiptResponse>("POST", agentChatCommandPath(sessionId, name), {
        body,
        ...(signal === undefined ? {} : { signal })
      });
    },

    read(sessionId, options) {
      return send<ThreadReadResponse>("GET", agentChatRoutes.thread(sessionId), {
        query: options?.after === undefined ? undefined : { after: options.after },
        ...(options?.signal === undefined ? {} : { signal: options.signal })
      });
    },

    readItem(sessionId, itemId, signal) {
      return send<ThreadItemResponse>("GET", agentChatRoutes.item(sessionId, itemId), {
        ...(signal === undefined ? {} : { signal })
      });
    },

    turnDiff(sessionId, turnCount, options) {
      return send<TurnDiffResponse>("GET", agentChatRoutes.turnDiff(sessionId, turnCount), {
        // §5.4: whitespace is ignored by default; only an explicit `false` turns it off.
        query: { ignoreWhitespace: options?.ignoreWhitespace === false ? 0 : 1 },
        ...(options?.signal === undefined ? {} : { signal: options.signal })
      });
    },

    providers(signal) {
      return send<AgentProvidersResponse>("GET", agentChatRoutes.providers, {
        ...(signal === undefined ? {} : { signal })
      });
    },

    refreshProvider(adapterId, body, signal) {
      return send<RefreshProviderResponse>("POST", agentChatRoutes.providerRefresh(adapterId), {
        body: body ?? {},
        ...(signal === undefined ? {} : { signal })
      });
    },

    async upload(sessionId, data, meta, onProgress) {
      const response = await transporter.request<SessionUploadResponse>({
        method: "POST",
        path: `/api/sessions/${encodeURIComponent(sessionId)}/upload`,
        query: { name: meta.name, type: meta.type },
        binaryBody: data,
        ...(onProgress === undefined ? {} : { onUploadProgress: onProgress })
      });
      if (!response.ok) {
        throw commandErrorFrom(response.status, response.data, "Attachment upload failed");
      }
      return attachmentRefFromUpload(response.data, meta);
    }
  };
}

/**
 * The upload route answers `{path, name, size}`; the command wire takes
 * metadata only — `{id, name, mimeType, sizeBytes}`, never bytes and never a
 * data URL (§6.3). The daemon-side path IS the attachment reference, so it
 * becomes the id.
 */
export function attachmentRefFromUpload(
  response: SessionUploadResponse,
  meta: AgentChatUploadMeta
): AttachmentRef {
  const mimeType = meta.type?.toLowerCase();
  const name = response.name || meta.name;
  if (mimeType && mimeType.startsWith("image/")) {
    return { type: "image", id: response.path, name, mimeType, sizeBytes: response.size };
  }
  return {
    type: "file",
    id: response.path,
    name,
    ...(mimeType ? { mimeType } : {}),
    sizeBytes: response.size
  };
}

// ---------------------------------------------------------------------------
// The reconnecting reader
// ---------------------------------------------------------------------------

function openAgentChatStream(
  transporter: Transporter,
  sessionId: string,
  options: AgentChatStreamOptions,
  handlers: AgentChatStreamHandlers
): AgentChatStreamHandle {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  const random = options.random ?? Math.random;

  let closed = false;
  let attempt = 0;
  let lastSeq = options.after ?? 0;
  let hostInstanceId: string | null = options.hostInstanceId ?? null;
  let inner: StreamHandle | null = null;
  let retryTimer: unknown = null;
  let stallTimer: unknown = null;
  const lines = new NdjsonLineBuffer();

  const clearStall = (): void => {
    if (stallTimer !== null) {
      clearTimer(stallTimer);
      stallTimer = null;
    }
  };

  const armStall = (): void => {
    clearStall();
    stallTimer = setTimer(() => {
      // No byte for three heartbeats: the proxy or the socket is wedged.
      // Drop it ourselves and resume by cursor rather than wait forever.
      inner?.close();
      inner = null;
      scheduleReconnect("stalled");
    }, STREAM_STALL_TIMEOUT_MS);
  };

  const scheduleReconnect = (reason: string): void => {
    if (closed || retryTimer !== null) {
      return;
    }
    clearStall();
    const delayMs = reconnectDelayMs(attempt, random);
    attempt = Math.min(attempt + 1, 32);
    handlers.onReconnect?.({ attempt, delayMs, reason });
    retryTimer = setTimer(() => {
      retryTimer = null;
      connect();
    }, Math.min(delayMs, RECONNECT_MAX_MS));
  };

  const connect = (): void => {
    if (closed) {
      return;
    }
    lines.reset();
    // A changed host instance id means resync, not resume (§6.3).
    const after = resumeCursorFor({
      lastSeq,
      knownHostInstanceId: options.hostInstanceId ?? null,
      observedHostInstanceId: hostInstanceId
    });
    const query = after === undefined ? "" : `?after=${after}`;
    let opened = false;

    inner = transporter.openStream(`${agentChatRoutes.events(sessionId)}${query}`, {
      onData: (chunk) => {
        if (closed) {
          return;
        }
        if (!opened) {
          opened = true;
          handlers.onOpen?.();
        }
        armStall();
        for (const line of lines.push(chunk)) {
          const parsed = parseStreamLine(line);
          if (parsed.kind !== "frame") {
            // A heartbeat, a blank line, or a line an older bundle cannot
            // decode. None of them may abort the stream — a malformed frame
            // is a gap the next snapshot fixes, not a dead tab.
            continue;
          }
          const frame = parsed.frame;
          if (frame.kind === "event") {
            if (frame.seq <= lastSeq) {
              continue;
            }
            lastSeq = frame.seq;
          } else if (frame.kind === "snapshot") {
            lastSeq = frame.thread.seq;
          } else {
            hostInstanceId = frame.hostInstanceId;
            // A live stream is proof of health: reset the backoff only here,
            // so a host that accepts and immediately drops us still backs off.
            attempt = 0;
          }
          handlers.onFrame(frame);
        }
      },
      onEnd: () => {
        if (closed) {
          return;
        }
        inner = null;
        scheduleReconnect("ended");
      },
      onError: (error) => {
        if (closed) {
          return;
        }
        handlers.onError?.(error);
      }
    });
    armStall();
  };

  connect();

  return {
    get lastSeq() {
      return lastSeq;
    },
    get hostInstanceId() {
      return hostInstanceId;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      clearStall();
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      inner?.close();
      inner = null;
      handlers.onClose?.();
    }
  };
}

/**
 * Resolve the chat transport for a transporter, memoised per transporter so a
 * re-render never rebuilds it (and never re-opens a stream).
 */
const transportCache = new WeakMap<Transporter, AgentChatTransport>();

export function resolveAgentChatTransport(transporter: Transporter): AgentChatTransport {
  const own = transporter.agentChat?.();
  if (own) {
    return own;
  }
  const cached = transportCache.get(transporter);
  if (cached) {
    return cached;
  }
  const built = createAgentChatTransport(transporter);
  transportCache.set(transporter, built);
  return built;
}
