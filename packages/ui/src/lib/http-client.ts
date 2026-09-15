/**
 * Minimal HTTP client contract. The HTTP transporter depends on this rather
 * than on `fetch` directly, so each runtime can plug in its own client:
 *
 *  - web:     {@link FetchHttpClient} (wraps the browser `fetch`)
 *  - desktop: a custom Node/Electron HTTP client can implement the same shape.
 */

import type { BinaryBody } from "./transporter";

export interface HttpClientRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  /** A string is JSON; a {@link BinaryBody} is an upload's raw bytes (Content-Type already set by the transporter). */
  body?: string | BinaryBody;
  /** See TransportRequest.onUploadProgress — only meaningful with a binary body. */
  onUploadProgress?: (sent: number, total: number) => void;
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

/**
 * Binary upload via XMLHttpRequest — the only browser API that reports upload
 * progress. Mirrors the fetch path's contract: resolves with the response for
 * any HTTP status (the caller maps non-2xx), rejects on a network failure, and
 * honours `signal` by aborting the request (rejecting with its reason).
 */
function sendWithUploadProgress(
  req: HttpClientRequest,
  body: BinaryBody,
  onProgress: (sent: number, total: number) => void
): Promise<HttpClientResponse> {
  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(req.signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url);
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };
    const onAbort = () => xhr.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = () => req.signal?.removeEventListener("abort", onAbort);
    xhr.onload = () => {
      settle();
      const headers: Record<string, string> = {};
      for (const line of xhr.getAllResponseHeaders().split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }
      const text = xhr.responseText;
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, headers, text: () => Promise.resolve(text) });
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError("Failed to fetch"));
    };
    xhr.onabort = () => {
      settle();
      reject(req.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    xhr.send(body);
  });
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
    // `fetch` cannot observe upload progress, so a binary body whose caller
    // wants it goes through XMLHttpRequest instead (same headers, same result
    // shape). Everything else keeps the fetch path untouched.
    if (req.onUploadProgress && req.body !== undefined && typeof req.body !== "string") {
      return sendWithUploadProgress(req, req.body, req.onUploadProgress);
    }
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
