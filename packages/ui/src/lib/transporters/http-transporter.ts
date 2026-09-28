import {
  buildQueryString,
  type BinaryBody,
  type SessionChannel,
  type StreamHandle,
  type StreamHandlers,
  type Transporter,
  type TransportRequest,
  type TransportResponse
} from "../transporter";
import { FetchHttpClient, type HttpClient } from "../http-client";
import { getSessionChannel } from "./ws-session-channel";
import { getBrowserChannel, type WsBrowserChannel } from "./ws-browser-channel";

export interface HttpTransporterOptions {
  baseUrl: string;
  /** Bearer sent as `Authorization: Bearer <credential>` when present. The
   *  credential is base64("<username>:<hash>"). */
  credential?: string;
  /** Defaults to a {@link FetchHttpClient}. */
  httpClient?: HttpClient;
}

/**
 * Transporter that speaks plain HTTP to a remote daemon. The actual byte
 * transport is delegated to an {@link HttpClient}, so the web app uses
 * `fetch` while the desktop app can inject a custom Node-side client.
 */
export class HttpTransporter implements Transporter {
  readonly kind = "http";

  private readonly baseUrl: string;
  private readonly credential?: string;
  private readonly client: HttpClient;

  constructor(options: HttpTransporterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.credential = options.credential;
    this.client = options.httpClient ?? new FetchHttpClient();
  }

  async request<T = unknown>(req: TransportRequest): Promise<TransportResponse<T>> {
    const url = `${this.baseUrl}${req.path}${buildQueryString(req.query)}`;
    const headers: Record<string, string> = { ...req.headers };

    if (this.credential) {
      headers.Authorization = `Bearer ${this.credential}`;
    }

    let body: string | BinaryBody | undefined;
    if (req.binaryBody !== undefined) {
      // Uploads: the bytes go as-is (fetch streams a Blob from disk); the daemon
      // reads the metadata from the query string.
      headers["Content-Type"] = "application/octet-stream";
      body = req.binaryBody;
    } else if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    const response = await this.client.send({
      url,
      method: req.method,
      headers,
      body,
      onUploadProgress: req.onUploadProgress,
      signal: req.signal
    });

    const raw = await response.text();
    const data = raw ? (JSON.parse(raw) as T) : (undefined as T);

    return {
      status: response.status,
      ok: response.ok,
      data,
      headers: response.headers
    };
  }

  async requestBytes(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>> {
    if (!this.client.sendBytes) {
      throw new Error("This transport cannot fetch binary content.");
    }
    const url = `${this.baseUrl}${req.path}${buildQueryString(req.query)}`;
    const headers: Record<string, string> = { ...req.headers };
    if (this.credential) {
      headers.Authorization = `Bearer ${this.credential}`;
    }
    const response = await this.client.sendBytes({ url, method: req.method, headers, signal: req.signal });
    const data = response.ok ? await response.bytes() : new ArrayBuffer(0);
    return { status: response.status, ok: response.ok, data, headers: response.headers };
  }

  openStream(path: string, handlers: StreamHandlers): StreamHandle {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.credential) {
      headers.Authorization = `Bearer ${this.credential}`;
    }

    // Desktop injects a Node client that streams over IPC; using it here keeps
    // the remote event bus / output stream off the browser `fetch` so it isn't
    // gated by CORS (the daemon is cross-origin for the desktop renderer).
    if (this.client.stream) {
      return this.client.stream(
        { url, method: "GET", headers },
        { onData: handlers.onData, onEnd: handlers.onEnd }
      );
    }

    const controller = new AbortController();
    // Exactly one of onError/onEnd-after-error, and one onEnd, per stream.
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      handlers.onEnd();
    };
    fetch(url, { headers, signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          // An error answer is not stream content: never hand its JSON body to onData.
          void response.body?.cancel().catch(() => undefined);
          if (!controller.signal.aborted) {
            handlers.onError?.(Object.assign(new Error(`The stream failed with status ${response.status}.`), { status: response.status }));
          }
          end();
          return;
        }
        if (!response.body) {
          end();
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              end();
              return;
            }
            handlers.onData(decoder.decode(value, { stream: true }));
            return pump();
          });
        return pump();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !ended) {
          handlers.onError?.(error);
        }
        end();
      });

    return { close: () => controller.abort() };
  }

  /**
   * Session output/input/resize are multiplexed over a single WebSocket (shared
   * per origin) so many terminals don't each hold a streaming HTTP connection.
   */
  sessionChannel(): SessionChannel {
    return getSessionChannel(this.baseUrl, this.credential);
  }

  /**
   * Browser-tab screencast + control multiplexed over a single WebSocket
   * (shared per origin), a sibling of {@link sessionChannel} kept separate so
   * the terminals' text-only path is untouched.
   */
  browserChannel(): WsBrowserChannel {
    return getBrowserChannel(this.baseUrl, this.credential);
  }
}
