import {
  buildQueryString,
  type SessionChannel,
  type StreamHandle,
  type StreamHandlers,
  type Transporter,
  type TransportRequest,
  type TransportResponse
} from "../transporter";
import { FetchHttpClient, type HttpClient } from "../http-client";
import { getSessionChannel } from "./ws-session-channel";

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

    let body: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    const response = await this.client.send({
      url,
      method: req.method,
      headers,
      body,
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
    fetch(url, { headers, signal: controller.signal })
      .then((response) => {
        if (!response.body) {
          handlers.onEnd();
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              handlers.onEnd();
              return;
            }
            handlers.onData(decoder.decode(value, { stream: true }));
            return pump();
          });
        return pump();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          handlers.onError?.(error);
        }
        handlers.onEnd();
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
}
