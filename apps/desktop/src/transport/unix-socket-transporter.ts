import {
  buildQueryString,
  type StreamHandle,
  type StreamHandlers,
  type Transporter,
  type TransportRequest,
  type TransportResponse
} from "@orquester/ui";

/** Shape exchanged with the Electron main process over IPC for unary requests. */
export interface DesktopBridgeRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  // Present only when the request is cancellable; the main process keys the
  // in-flight ClientRequest by this id so requestAbort can destroy it.
  requestId?: string;
}

export interface DesktopBridgeResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

/** Binary response shape (file preview) — raw bytes instead of a decoded body. */
export interface DesktopBridgeBytesResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/** Shape exchanged with the main process for a remote (TCP) unary request. */
export interface DesktopBridgeHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // See DesktopBridgeRequest.requestId.
  requestId?: string;
}

/** The full bridge the preload exposes for talking to the daemon over the socket. */
export interface DesktopBridge {
  request(request: DesktopBridgeRequest): Promise<DesktopBridgeResponse>;
  requestBytes(request: DesktopBridgeRequest): Promise<DesktopBridgeBytesResponse>;
  requestAbort(requestId: string): void;
  streamOpen(streamId: string, path: string): void;
  streamClose(streamId: string): void;
  onStreamData(cb: (payload: { streamId: string; chunk: string }) => void): () => void;
  onStreamEnd(cb: (payload: { streamId: string }) => void): () => void;
  // Remote HTTP transport (used by the renderer's HttpTransporter for remote
  // servers; performed in the main process so it bypasses browser CORS).
  httpRequest(request: DesktopBridgeHttpRequest): Promise<DesktopBridgeResponse>;
  httpRequestBytes(request: DesktopBridgeHttpRequest): Promise<DesktopBridgeBytesResponse>;
  httpRequestAbort(requestId: string): void;
  httpStreamOpen(streamId: string, url: string, headers?: Record<string, string>): void;
  httpStreamClose(streamId: string): void;
  onHttpStreamData(cb: (payload: { streamId: string; chunk: string }) => void): () => void;
  onHttpStreamEnd(cb: (payload: { streamId: string }) => void): () => void;
}

/**
 * Transporter for the desktop runtime. The renderer cannot open a unix socket
 * directly, so requests and chunked streams are forwarded over the Electron IPC
 * bridge to the main process, which performs the actual HTTP-over-unix-socket
 * calls to the daemon.
 */
export class UnixSocketTransporter implements Transporter {
  readonly kind = "unix";

  constructor(private readonly bridge: DesktopBridge) {}

  async request<T = unknown>(req: TransportRequest): Promise<TransportResponse<T>> {
    // Reject an already-aborted request the way the web `fetch` path does
    // (throws signal.reason, a DOMException "AbortError" by default) before
    // minting a requestId or hitting IPC.
    req.signal?.throwIfAborted();

    const headers: Record<string, string> = { ...req.headers };
    let body: string | undefined;

    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    const requestId = req.signal ? crypto.randomUUID() : undefined;
    const onAbort = requestId ? () => this.bridge.requestAbort(requestId) : undefined;
    if (req.signal && onAbort) req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.bridge.request({
        method: req.method,
        path: `${req.path}${buildQueryString(req.query)}`,
        headers,
        body,
        requestId
      });

      const data = response.body ? (JSON.parse(response.body) as T) : (undefined as T);

      return {
        status: response.status,
        ok: response.ok,
        data,
        headers: response.headers
      };
    } finally {
      if (req.signal && onAbort) req.signal.removeEventListener("abort", onAbort);
    }
  }

  async requestBytes(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>> {
    req.signal?.throwIfAborted();

    const requestId = req.signal ? crypto.randomUUID() : undefined;
    const onAbort = requestId ? () => this.bridge.requestAbort(requestId) : undefined;
    if (req.signal && onAbort) req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.bridge.requestBytes({
        method: req.method,
        path: `${req.path}${buildQueryString(req.query)}`,
        headers: { ...req.headers },
        requestId
      });
      return { status: response.status, ok: response.ok, data: response.body, headers: response.headers };
    } finally {
      if (req.signal && onAbort) req.signal.removeEventListener("abort", onAbort);
    }
  }

  openStream(path: string, handlers: StreamHandlers): StreamHandle {
    const streamId = crypto.randomUUID();
    let closed = false;

    const offData = this.bridge.onStreamData(({ streamId: id, chunk }) => {
      if (id === streamId) {
        handlers.onData(chunk);
      }
    });
    const offEnd = this.bridge.onStreamEnd(({ streamId: id }) => {
      if (id === streamId && !closed) {
        closed = true;
        offData();
        offEnd();
        handlers.onEnd();
      }
    });

    this.bridge.streamOpen(streamId, path);

    return {
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        offData();
        offEnd();
        this.bridge.streamClose(streamId);
      }
    };
  }
}
