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
}

/** The full bridge the preload exposes for talking to the daemon over the socket. */
export interface DesktopBridge {
  request(request: DesktopBridgeRequest): Promise<DesktopBridgeResponse>;
  requestBytes(request: DesktopBridgeRequest): Promise<DesktopBridgeBytesResponse>;
  streamOpen(streamId: string, path: string): void;
  streamClose(streamId: string): void;
  onStreamData(cb: (payload: { streamId: string; chunk: string }) => void): () => void;
  onStreamEnd(cb: (payload: { streamId: string }) => void): () => void;
  // Remote HTTP transport (used by the renderer's HttpTransporter for remote
  // servers; performed in the main process so it bypasses browser CORS).
  httpRequest(request: DesktopBridgeHttpRequest): Promise<DesktopBridgeResponse>;
  httpRequestBytes(request: DesktopBridgeHttpRequest): Promise<DesktopBridgeBytesResponse>;
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
    const headers: Record<string, string> = { ...req.headers };
    let body: string | undefined;

    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    const response = await this.bridge.request({
      method: req.method,
      path: `${req.path}${buildQueryString(req.query)}`,
      headers,
      body
    });

    const data = response.body ? (JSON.parse(response.body) as T) : (undefined as T);

    return {
      status: response.status,
      ok: response.ok,
      data,
      headers: response.headers
    };
  }

  async requestBytes(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>> {
    const response = await this.bridge.requestBytes({
      method: req.method,
      path: `${req.path}${buildQueryString(req.query)}`,
      headers: { ...req.headers }
    });
    return { status: response.status, ok: response.ok, data: response.body, headers: response.headers };
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
