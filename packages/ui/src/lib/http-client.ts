/**
 * Minimal HTTP client contract. The HTTP transporter depends on this rather
 * than on `fetch` directly, so each runtime can plug in its own client:
 *
 *  - web:     {@link FetchHttpClient} (wraps the browser `fetch`)
 *  - desktop: a custom Node/Electron HTTP client can implement the same shape.
 */

export interface HttpClientRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpClientResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
}

export interface HttpClientBytesResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  bytes(): Promise<ArrayBuffer>;
}

/** Callbacks for a chunked GET stream (session output / event bus). */
export interface HttpClientStreamHandlers {
  /** A decoded text chunk arrived. */
  onData(chunk: string): void;
  /** The stream ended (server closed it, or it failed). */
  onEnd(): void;
}

/** Handle to a chunked stream opened via {@link HttpClient.stream}. */
export interface HttpClientStreamHandle {
  close(): void;
}

export interface HttpClient {
  send(req: HttpClientRequest): Promise<HttpClientResponse>;
  /**
   * Optional binary GET (file preview). Web uses fetch -> arrayBuffer; desktop
   * injects a Node client that returns bytes over IPC. Absent => binary preview
   * is unavailable on that connection.
   */
  sendBytes?(req: HttpClientRequest): Promise<HttpClientBytesResponse>;
  /**
   * Optional chunked GET stream. When present, the HTTP transporter routes
   * `openStream` (the NDJSON event bus, session output) through it instead of
   * the browser `fetch`. The desktop's Node client implements this so remote
   * streams go through Node and bypass browser CORS (the daemon is same-origin
   * for web but cross-origin for the desktop renderer); web omits it and keeps
   * streaming `fetch`.
   */
  stream?(req: HttpClientRequest, handlers: HttpClientStreamHandlers): HttpClientStreamHandle;
}

/** HttpClient backed by the platform `fetch`. Used by the web runtime. */
export class FetchHttpClient implements HttpClient {
  private readonly fetchImpl: typeof fetch;

  // Bind to the global so `fetch` keeps its required `this` (a method call like
  // `this.fetchImpl(...)` otherwise throws "Illegal invocation" in browsers).
  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async send(req: HttpClientRequest): Promise<HttpClientResponse> {
    const doFetch = this.fetchImpl;
    const response = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: response.status,
      ok: response.ok,
      headers,
      text: () => response.text()
    };
  }

  async sendBytes(req: HttpClientRequest): Promise<HttpClientBytesResponse> {
    const doFetch = this.fetchImpl;
    const response = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      signal: req.signal
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      headers,
      bytes: () => response.arrayBuffer()
    };
  }
}
