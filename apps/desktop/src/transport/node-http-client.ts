import type {
  HttpClient,
  HttpClientBytesResponse,
  HttpClientRequest,
  HttpClientResponse,
  HttpClientStreamHandle,
  HttpClientStreamHandlers
} from "@orquester/ui";
import type { DesktopBridge } from "./unix-socket-transporter";

/**
 * HttpClient for the desktop runtime's remote (HTTP) transporter. The renderer
 * is loaded from `file://` (or the dev-server origin), so a browser `fetch` to a
 * remote daemon (`https://…`) is cross-origin and the daemon serves no CORS
 * headers (it is same-origin only for the web SPA behind Caddy). Running the
 * request/stream in the Electron main process (Node) over this IPC bridge has no
 * CORS gate, so the desktop's remote REST calls and NDJSON event stream work.
 * The bearer token still authenticates each call (sent as Authorization).
 */
export class NodeHttpClient implements HttpClient {
  constructor(private readonly bridge: DesktopBridge) {}

  async send(req: HttpClientRequest): Promise<HttpClientResponse> {
    // Reject an already-aborted request the way the web `fetch` path does
    // (throws signal.reason, a DOMException "AbortError" by default) before
    // minting a requestId or hitting IPC.
    req.signal?.throwIfAborted();

    const requestId = req.signal ? crypto.randomUUID() : undefined;
    const onAbort = requestId ? () => this.bridge.httpRequestAbort(requestId) : undefined;
    if (req.signal && onAbort) req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.bridge.httpRequest({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        requestId
      });

      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        text: () => Promise.resolve(response.body)
      };
    } finally {
      if (req.signal && onAbort) req.signal.removeEventListener("abort", onAbort);
    }
  }

  async sendBytes(req: HttpClientRequest): Promise<HttpClientBytesResponse> {
    req.signal?.throwIfAborted();

    const requestId = req.signal ? crypto.randomUUID() : undefined;
    const onAbort = requestId ? () => this.bridge.httpRequestAbort(requestId) : undefined;
    if (req.signal && onAbort) req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.bridge.httpRequestBytes({
        url: req.url,
        method: req.method,
        headers: req.headers,
        requestId
      });
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        bytes: () => Promise.resolve(response.body)
      };
    } finally {
      if (req.signal && onAbort) req.signal.removeEventListener("abort", onAbort);
    }
  }

  stream(req: HttpClientRequest, handlers: HttpClientStreamHandlers): HttpClientStreamHandle {
    const streamId = crypto.randomUUID();
    let closed = false;

    const offData = this.bridge.onHttpStreamData(({ streamId: id, chunk }) => {
      if (id === streamId) {
        handlers.onData(chunk);
      }
    });
    const offEnd = this.bridge.onHttpStreamEnd(({ streamId: id }) => {
      if (id === streamId && !closed) {
        closed = true;
        offData();
        offEnd();
        handlers.onEnd();
      }
    });

    this.bridge.httpStreamOpen(streamId, req.url, req.headers);

    return {
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        offData();
        offEnd();
        this.bridge.httpStreamClose(streamId);
      }
    };
  }
}
