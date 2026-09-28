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
  isThreadItemOutputWindow,
  THREAD_ITEM_OUTPUT_MAX_BYTES,
  THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES,
  type AccountCommandBody,
  type AgentChatCommandBodies,
  type AgentChatCommandName,
  type AgentChatErrorCode,
  type AgentChatStreamFrame,
  type AgentProvidersResponse,
  type AttachmentRef,
  type CommandReceiptResponse,
  type RefreshProviderResponse,
  type ThreadHistoryPage,
  type ThreadHistoryQuery,
  type ThreadItemOutputResponse,
  type ThreadItemOutputWindowResponse,
  type ThreadItemResponse,
  type ThreadReadResponse,
  type ThreadSearchQuery,
  type ThreadSearchResponse,
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
}

/** A stream that reconnects itself; `close()` retires it for good. */
export interface AgentChatStreamHandle extends StreamHandle {
  /** The highest sequence handed to `onFrame`. */
  readonly lastSeq: number;
  /** The last `synchronized` instance id, or null before the first one. */
  readonly hostInstanceId: string | null;
  /**
   * Drop the sequence floor and ask for a snapshot on the next connection.
   *
   * The store calls this when it detects a changed `hostInstanceId` and
   * re-reads (§6.3, §8). Without it the reader keeps its own `lastSeq` floor
   * across the resync, so a host that restarted its sequence space *lower*
   * would have its live frames silently suppressed (fix-wave Q2-8).
   */
  resetCursor(): void;
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
  /**
   * §3.4's account switch. A separate seam from {@link command} because the
   * route is daemon-owned rather than proxied — it is not in
   * `AGENT_CHAT_COMMAND_NAMES` — but it answers the same receipt and the same
   * error envelope, so the store retries it on the same rules.
   */
  switchAccount(
    sessionId: string,
    body: AccountCommandBody,
    signal?: AbortSignal
  ): Promise<CommandReceiptResponse>;
  read(
    sessionId: string,
    options?: { after?: number; signal?: AbortSignal }
  ): Promise<ThreadReadResponse>;
  readItem(sessionId: string, itemId: string, signal?: AbortSignal): Promise<ThreadItemResponse>;
  /**
   * `GET …/items/:itemId/output`, whole — the streamed output of the tool
   * call the item belongs to: its `tool.output` chunks, which no item's
   * payload holds and the retained window may hold only part of, joined by
   * the host from the log. Read ONE window at a time (`?offset=&maxBytes=`,
   * each {@link THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES} wide: the reader wants
   * all of it, so the fewest round trips) from 0 to the end, and answered in
   * the whole join's own shape, flags from the last window — `complete`
   * false while the call runs, `truncated` once the join passed the host's
   * 8 MiB cap. A host from before windows ignores the query and answers that
   * whole join itself, which is taken as it comes.
   *
   * `null` on a 404 — the host's own `ITEM_NOT_FOUND` (no such item, or one
   * naming no call), or a host from before the route answering its route
   * miss — so the caller reads the item instead; never an error. A body of
   * neither shape, or windows that do not meet end to end, reject: a
   * stitched text would hold what the call never printed.
   *
   * Optional: a transport a runtime supplies itself (`Transporter.agentChat()`)
   * may predate it, and a caller then reads the item, as it always did.
   */
  readItemOutput?(
    sessionId: string,
    itemId: string,
    signal?: AbortSignal
  ): Promise<ThreadItemOutputResponse | null>;
  /**
   * `GET …/history` — a page of turns OLDER than what the client holds,
   * folded from the log by the host (design 2026-09-23 §C "History page").
   * No `before` asks for the turns just below the retained window. Answers
   * 503 `INDEX_UNAVAILABLE` while the host has no usable index.
   */
  readHistory(
    sessionId: string,
    query: ThreadHistoryQuery,
    signal?: AbortSignal
  ): Promise<ThreadHistoryPage>;
  /**
   * `GET /api/agent/search` — full-text search over every indexed thread on
   * the host (design 2026-09-23 §C "Search"). Host-level, not per session.
   */
  search(query: ThreadSearchQuery, signal?: AbortSignal): Promise<ThreadSearchResponse>;
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
  /** §6.3 read-back: the attachment's bytes, for a chip's thumbnail/preview. */
  fetchAttachment(sessionId: string, attachmentId: string, signal?: AbortSignal): Promise<ArrayBuffer>;
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

  /**
   * The host is restarting, or the response never arrived. Either way the same
   * `commandId` may be re-posted: the receipt makes a retry free, and a
   * reconnect must never replay a *different* mutation (§6.2, §6.6).
   *
   * `status: 0` is our marker for "the transport threw before a response" —
   * a dropped socket mid-post, which is exactly the case §6.6 names.
   */
  get retryable(): boolean {
    return this.code === "HOST_UNAVAILABLE" || this.status === 0;
  }
}

/** Wrap a transport-level throw so a lost response is retryable by command id. */
function transportError(error: unknown, path: string): AgentChatCommandError {
  const message = error instanceof Error ? error.message : `${path} failed`;
  return new AgentChatCommandError(0, "HOST_UNAVAILABLE", message, error);
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
    let response: { ok: boolean; status: number; data: T };
    try {
      response = await transporter.request<T>({
        method,
        path,
        ...(init?.body === undefined ? {} : { body: init.body }),
        ...(init?.query === undefined ? {} : { query: init.query }),
        ...(init?.signal === undefined ? {} : { signal: init.signal })
      });
    } catch (error) {
      // The response never arrived. §6.6: the client retries the SAME
      // `commandId`, which the receipt makes free — so this is retryable, not
      // a failure to surface.
      throw transportError(error, path);
    }
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

    switchAccount(sessionId, body, signal) {
      return send<CommandReceiptResponse>("POST", agentChatRoutes.account(sessionId), {
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

    async readItemOutput(sessionId, itemId, signal) {
      const path = agentChatRoutes.itemOutput(sessionId, itemId);
      const texts: string[] = [];
      let offset = 0;
      let call: string | null = null;
      for (;;) {
        let body: unknown;
        try {
          body = await send<unknown>("GET", path, {
            query: { offset, maxBytes: THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES },
            ...(signal === undefined ? {} : { signal })
          });
        } catch (error) {
          if (error instanceof AgentChatCommandError && error.status === 404) {
            return null;
          }
          throw error;
        }
        if (!isThreadItemOutputWindow(body)) {
          if (isWholeItemOutput(body)) {
            return body;
          }
          throw new Error("Expected a tool call's streamed output.");
        }
        const next = nextWindowOffset(body, offset, call);
        call = body.toolUseId;
        texts.push(body.text);
        if (next === undefined) {
          return {
            toolUseId: body.toolUseId,
            output: texts.join(""),
            complete: body.complete,
            truncated: body.truncated
          };
        }
        offset = next;
      }
    },

    readHistory(sessionId, query, signal) {
      return send<ThreadHistoryPage>("GET", agentChatRoutes.history(sessionId), {
        query: definedQuery({ before: query.before, turns: query.turns }),
        ...(signal === undefined ? {} : { signal })
      });
    },

    search(query, signal) {
      return send<ThreadSearchResponse>("GET", agentChatRoutes.search, {
        query: definedQuery({ q: query.q, limit: query.limit, projectPath: query.projectPath }),
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
    },

    // Rides the bearer-authed binary channel, never a `?token=` URL: the
    // transports that cannot carry binary have no `requestBytes` at all
    // (`api-client.ts` `readFileBytes` guards it the same way).
    async fetchAttachment(sessionId, attachmentId, signal) {
      if (!transporter.requestBytes) {
        throw new Error("Attachment preview is not supported on this connection.");
      }
      const response = await transporter.requestBytes({
        method: "GET",
        path: agentChatRoutes.attachment(sessionId, attachmentId),
        ...(signal === undefined ? {} : { signal })
      });
      if (!response.ok) {
        throw commandErrorFrom(response.status, undefined, "Attachment fetch failed");
      }
      return response.data;
    }
  };
}

/**
 * A query object with its `undefined` keys dropped, so an absent option never
 * travels as an empty parameter the host would have to tell apart from a real
 * one (`?before=` is not "no cursor").
 */
function definedQuery(
  query: Record<string, string | number | undefined>
): Record<string, string | number> {
  const defined: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      defined[key] = value;
    }
  }
  return defined;
}

/**
 * The whole join ({@link ThreadItemOutputResponse}), as a host from before
 * windows answers `GET …/items/:itemId/output` whatever the query asks: its
 * route matches on the path alone.
 */
function isWholeItemOutput(body: unknown): body is ThreadItemOutputResponse {
  return (
    isRecord(body) &&
    typeof body.toolUseId === "string" &&
    typeof body.output === "string" &&
    typeof body.complete === "boolean" &&
    typeof body.truncated === "boolean"
  );
}

const utf8 = new TextEncoder();

/**
 * Where the window after `window` starts — `undefined` once `window` reached
 * the join's end — for a window the chain can take: the one asked for (at
 * `offset`, which is 0 or the last window's `nextOffset`: a character
 * boundary of a join that only grows at its end, so the host has no reason
 * to move it), of the same call, within the host's caps, inside the join,
 * and naming as its `nextOffset` exactly where its text ends — never where
 * it began, so every read advances. Anything else throws: windows that do
 * not meet end to end would stitch a text the call never printed.
 */
function nextWindowOffset(
  window: ThreadItemOutputWindowResponse,
  offset: number,
  call: string | null
): number | undefined {
  const bytes = utf8.encode(window.text).length;
  const end = window.offset + bytes;
  const sane =
    window.offset === offset &&
    (call === null || window.toolUseId === call) &&
    window.totalBytes <= THREAD_ITEM_OUTPUT_MAX_BYTES &&
    bytes <= THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES &&
    end <= window.totalBytes &&
    (window.nextOffset === undefined
      ? end === window.totalBytes
      : bytes > 0 && window.nextOffset === end);
  if (!sane) {
    throw new Error("Expected the next window of a tool call's streamed output.");
  }
  return window.nextOffset;
}

/**
 * The command wire takes metadata only — `{type, id, name, mimeType, sizeBytes}`,
 * never bytes and never a data URL (§6.3).
 *
 * Two upload shapes reach this: a CHAT session's upload is streamed through
 * the daemon to the agent host, which claims the file into the thread's
 * attachment namespace, mints the id and answers the finished `AttachmentRef`
 * itself (`agent-host/server/http-server.ts`, `sendJson(response, 200, ref)`)
 * — the server's word is final, as in T3 (`packages/contracts/src/assets.ts`,
 * the server-minted `attachmentId` the client carries verbatim). A TERMINAL
 * session's upload answers `{path, name, size}`, and there the daemon-side
 * path is the reference. Reading the terminal shape off a chat answer made
 * every chat upload an attachment without an `id` ("attachments[0].id is
 * required." on send, the chip gone) — 2026-09-22.
 *
 * The host's answer now also carries the absolute `path` (§7.4); it rides the
 * ref verbatim — the host strips it from every command body.
 */
export function attachmentRefFromUpload(
  response: SessionUploadResponse | AttachmentRef,
  meta: AgentChatUploadMeta
): AttachmentRef {
  if (isAttachmentRef(response)) {
    return response;
  }
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

function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    (record.type === "image" || record.type === "file") &&
    typeof record.name === "string"
  );
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
  let closed = false;
  let attempt = 0;
  let lastSeq = options.after ?? 0;
  let hostInstanceId: string | null = options.hostInstanceId ?? null;
  /**
   * The instance id this reader last *connected under*, so a reconnect can
   * compare it to the one it observes. Tracking only the caller's initial
   * option made the resume-vs-resync check unreachable (fix-wave Q2-8).
   */
  let knownHostInstanceId: string | null = options.hostInstanceId ?? null;
  let inner: StreamHandle | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const lines = new NdjsonLineBuffer();

  const clearStall = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const armStall = (): void => {
    clearStall();
    stallTimer = setTimeout(() => {
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
    const delayMs = reconnectDelayMs(attempt);
    attempt = Math.min(attempt + 1, 32);
    handlers.onReconnect?.({ attempt, delayMs, reason });
    retryTimer = setTimeout(() => {
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
      knownHostInstanceId,
      observedHostInstanceId: hostInstanceId
    });
    knownHostInstanceId = hostInstanceId;
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
    resetCursor() {
      lastSeq = 0;
      knownHostInstanceId = hostInstanceId;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      clearStall();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
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
