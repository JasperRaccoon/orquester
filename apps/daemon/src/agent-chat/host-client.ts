/**
 * The daemon's HTTP client for the agent host's unix socket (spec §3.1, §6).
 *
 * Every chat route is a proxy hop: the daemon authenticates the browser and
 * then re-issues the request over `<appdir>/daemon/agent-host.sock` with the
 * 0600 shared token. Nothing here is ever reachable from a browser.
 *
 * Two shapes, because the surface has two shapes: `json()` for a bounded
 * request/response (commands, reads, health) and `open()` for the long-lived
 * NDJSON streams of §6.3, which must be piped with backpressure and cancelled
 * the moment the client disconnects.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  AGENT_HOST_AUTH_HEADER,
  AGENT_HOST_HTTP_HOST,
  agentHostAuthValue
} from "../agent-host/host-protocol.ts";

/** Bounded request/response calls never hang a route. Streams opt out. */
export const HOST_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Ceiling on a buffered (`json()`) host response. Generous — a whole thread
 * snapshot is a legitimate multi-megabyte read — but finite, because the body
 * is concatenated in daemon memory and nothing else bounds it.
 */
export const HOST_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * The host is not answering: no socket, connection refused, or the request
 * timed out. Every route maps this to 503 `HOST_UNAVAILABLE` (§6.2) — the one
 * error the client is told to retry with the same `commandId`.
 *
 * `cause` is the failure it wraps, kept whole. That includes a request body
 * that failed, and one such failure is the CALLER's rather than the host's: a
 * chat upload passing the daemon's cap (`countingLimit`) must still answer
 * 413, which is why `isUploadTooLarge` (`upload-stream.ts`) looks here too.
 */
export class HostUnavailableError extends Error {
  readonly code = "HOST_UNAVAILABLE";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "HostUnavailableError";
  }
}

export interface HostStream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: IncomingMessage;
  /** Tear the upstream down (client disconnect, backpressure overflow). */
  abort(): void;
}

export interface HostJsonResponse<T> {
  status: number;
  /** Parsed body, or null when the body was empty or not JSON. */
  value: T | null;
  raw: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface AgentHostClientOptions {
  socketPath: string;
  /** Read at call time — the token is regenerated whenever a host is spawned. */
  token: () => string | null;
}

export class AgentHostClient {
  constructor(private readonly opts: AgentHostClientOptions) {}

  get socketPath(): string {
    return this.opts.socketPath;
  }

  /**
   * Open a request and resolve once the response headers are in. The caller
   * owns the body stream and MUST either consume it or call `abort()`.
   *
   * `timeoutMs` bounds the *headers*, never the body: a §6.3 stream is
   * deliberately long-lived, and a socket timeout on it would cut a healthy
   * subscription every N seconds.
   */
  open(
    method: string,
    path: string,
    init: {
      body?: string | Buffer | Readable;
      headers?: Record<string, string>;
      timeoutMs?: number;
      /** Aborts the upstream when it fires (client disconnect). */
      signal?: AbortSignal;
    } = {}
  ): Promise<HostStream> {
    const token = this.opts.token();
    if (!token) {
      return Promise.reject(new HostUnavailableError("The agent host has no token yet."));
    }
    const timeoutMs = init.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
    return new Promise<HostStream>((resolve, reject) => {
      const headers: Record<string, string> = {
        host: AGENT_HOST_HTTP_HOST,
        [AGENT_HOST_AUTH_HEADER]: agentHostAuthValue(token),
        ...init.headers
      };
      if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
        headers["content-length"] = String(Buffer.byteLength(init.body as string | Buffer));
      }
      let settled = false;
      let req: ClientRequest;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        req?.destroy();
        reject(
          error instanceof HostUnavailableError
            ? error
            : new HostUnavailableError(
                error instanceof Error ? error.message : String(error),
                error
              )
        );
      };
      req = httpRequest({ socketPath: this.opts.socketPath, path, method, headers }, (res) => {
        if (settled) {
          res.resume();
          return;
        }
        settled = true;
        // The headers are in; from here the body is the caller's problem and a
        // header deadline must not fire against a long-lived stream.
        req.setTimeout(0);
        resolve({
          status: res.statusCode ?? 502,
          headers: res.headers,
          body: res,
          abort: () => {
            res.destroy();
            req.destroy();
          }
        });
      });
      // A wedged host must not pin a route open. Applies to the header phase
      // only — cleared above once the response starts.
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => fail(new HostUnavailableError("agent host request timed out")));
      }
      req.on("error", fail);
      if (init.signal) {
        if (init.signal.aborted) {
          fail(new HostUnavailableError("request aborted before it was sent"));
          return;
        }
        init.signal.addEventListener(
          "abort",
          () => {
            if (settled) {
              req.destroy();
              return;
            }
            fail(new HostUnavailableError("request aborted"));
          },
          { once: true }
        );
      }
      if (init.body instanceof Readable) {
        // A body error can fire AFTER the headers came back (the host answers
        // as soon as it starts reading), and `fail` no-ops once settled — so
        // destroy the request explicitly or the half-written upload stays open
        // until the host's own timeout. Covers both an aborting client and the
        // §6.3 byte cap tripping mid-stream.
        init.body.on("error", (error) => {
          req.destroy(error instanceof Error ? error : new Error(String(error)));
          fail(error);
        });
        init.body.pipe(req);
      } else if (init.body !== undefined) {
        req.end(init.body);
      } else {
        req.end();
      }
    });
  }

  /** A bounded JSON call. The body is read to completion; `value` is null when it is not JSON. */
  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { timeoutMs?: number } = {}
  ): Promise<HostJsonResponse<T>> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const stream = await this.open(method, path, {
      body: payload,
      headers: payload === undefined ? {} : { "content-type": "application/json" },
      timeoutMs: init.timeoutMs
    });
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      for await (const chunk of stream.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        received += buffer.length;
        // A bounded call must stay bounded in memory too: `GET …/thread` is a
        // whole snapshot and is unbounded by construction, so a runaway host
        // could otherwise push the daemon into an OOM one read at a time.
        if (received > HOST_RESPONSE_LIMIT_BYTES) {
          stream.abort();
          throw new HostUnavailableError(
            `agent host response exceeded ${HOST_RESPONSE_LIMIT_BYTES} bytes`
          );
        }
        chunks.push(buffer);
      }
    } catch (error) {
      stream.abort();
      throw new HostUnavailableError(
        error instanceof Error ? error.message : String(error),
        error
      );
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let value: T | null = null;
    if (raw.trim()) {
      try {
        value = JSON.parse(raw) as T;
      } catch {
        value = null;
      }
    }
    return { status: stream.status, value, raw, headers: stream.headers };
  }
}
