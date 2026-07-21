/**
 * A Transporter is a thin wrapper that maps logical HTTP-style requests
 * (method + path + body) onto a concrete network transport. Each runtime
 * supplies its own implementation:
 *
 *  - desktop (local):  a unix-domain-socket transporter (over the Electron IPC bridge)
 *  - desktop (remote): a custom HTTP-client transporter
 *  - web:              an HTTP transporter wrapping `fetch`
 *
 * Keeping this interface tiny means the rest of the app (ApiClient, services,
 * hooks) never needs to know how bytes reach the daemon.
 */

export type TransportMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TransportRequest {
  method: TransportMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface TransportResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  headers?: Record<string, string>;
}

/** Handler invoked for every event pushed over a realtime subscription. */
export type EventHandler = (event: unknown) => void;

export interface StreamHandlers {
  /** A decoded text chunk arrived. */
  onData: (chunk: string) => void;
  /** The stream ended (server closed it). */
  onEnd: () => void;
  onError?: (error: unknown) => void;
  /**
   * The multiplexed session socket reconnected and is about to replay the
   * session's buffer; clear the terminal first so the replay doesn't duplicate.
   */
  onReset?: () => void;
}

export interface StreamHandle {
  close(): void;
}

/**
 * Multiplexed session I/O over a single connection (a WebSocket on the web).
 * Used instead of one streaming HTTP connection per terminal so the web app
 * doesn't exhaust the browser's per-origin connection cap (~6) once several
 * terminals are open.
 */
export interface SessionChannel {
  /** Subscribe to a session's output (buffer replay, then live). */
  openOutput(id: string, handlers: StreamHandlers): StreamHandle;
  /** Forward keystrokes/data to the session's PTY. */
  sendInput(id: string, data: string): void;
  /** Resize the session's PTY. */
  resize(id: string, cols: number, rows: number): void;
}

export interface Transporter {
  /** Short identifier for diagnostics, e.g. "unix" | "http". */
  readonly kind: string;
  /** Perform a single request/response round trip. */
  request<T = unknown>(req: TransportRequest): Promise<TransportResponse<T>>;
  /**
   * Optional binary GET (file preview: image/pdf/audio/video bytes). Returns the
   * raw bytes; absent on transports that cannot carry binary.
   */
  requestBytes?(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>>;
  /**
   * Open a long-lived chunked GET stream (session output, event bus). Runtime
   * specific: web uses streaming fetch, desktop bridges over IPC.
   */
  openStream(path: string, handlers: StreamHandlers): StreamHandle;
  /**
   * Optional multiplexed channel for session output/input/resize. When present
   * (web/HTTP), the ApiClient routes terminal I/O through it instead of opening
   * a stream plus POSTs per session. Transports with no connection limit (the
   * desktop unix socket) omit it and fall back to {@link openStream}/request.
   */
  sessionChannel?(): SessionChannel;
  /**
   * Optional multiplexed browser-tab channel (screencast + control). Present on
   * HTTP transports only; the desktop unix socket omits it (v1 — browser tabs
   * are HTTP-transport-only, which includes desktop-remote).
   */
  browserChannel?(): import("./transporters/ws-browser-channel").WsBrowserChannel;
}

/** Build a querystring (with leading `?`) from a query object, or "" if empty. */
export function buildQueryString(query?: TransportRequest["query"]): string {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
