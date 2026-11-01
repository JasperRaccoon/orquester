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

import { request as httpRequest, type ClientRequest } from "node:http";
import { Readable } from "node:stream";
import {
  AGENT_HOST_AUTH_HEADER,
  AGENT_HOST_HTTP_HOST,
  agentHostAuthValue
} from "../agent-host/host-protocol.ts";
import type { AgentChatErrorCode } from "@orquester/api/agent-chat";
import type { HostDirectory, HostEndpoint } from "./host-directory.ts";

/** Bounded request/response calls never hang a route. Streams opt out. */
const HOST_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Ceiling on a buffered (`json()`) host response. Generous — a whole thread
 * snapshot is a legitimate multi-megabyte read — but finite, because the body
 * is concatenated in daemon memory and nothing else bounds it.
 */
const HOST_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;

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
  body: Readable;
  /** Tear the upstream down (client disconnect, backpressure overflow). */
  abort(): void;
}

export interface HostJsonResponse<T> {
  status: number;
  /** Parsed body, or null when the body was empty or not JSON. */
  value: T | null;
  raw: string;
}

export interface HostOpenInit {
  body?: string | Buffer | Readable;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Aborts the upstream when it fires (client disconnect). */
  signal?: AbortSignal;
}

/**
 * What every caller of "the agent host" depends on: one socket's {@link AgentHostClient}, or the
 * {@link RoutingHostClient} that picks the host per request during an update (spec 2026-11-01
 * P2.4 R24). A caller cannot tell them apart, and must not need to.
 */
export interface HostClient {
  open(method: string, path: string, init?: HostOpenInit): Promise<HostStream>;
  json<T>(method: string, path: string, body?: unknown, init?: { timeoutMs?: number }): Promise<HostJsonResponse<T>>;
}

export interface AgentHostClientOptions {
  socketPath: string;
  /** Read at call time — the token is regenerated whenever a host is spawned. */
  token: () => string | null;
}

/** One host's socket and token, no routing: a {@link HostEndpoint}'s client. */
export class AgentHostClient implements HostClient {
  constructor(private readonly opts: AgentHostClientOptions) {}

  /**
   * Open a request and resolve once the response headers are in. The caller
   * owns the body stream and MUST either consume it or call `abort()`.
   *
   * `timeoutMs` bounds the *headers*, never the body: a §6.3 stream is
   * deliberately long-lived, and a socket timeout on it would cut a healthy
   * subscription every N seconds.
   */
  open(method: string, path: string, init: HostOpenInit = {}): Promise<HostStream> {
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
    return { status: stream.status, value, raw };
  }
}

// ---------------------------------------------------------------------------
// Routing over several hosts (spec 2026-11-01 P2.4 R24)
// ---------------------------------------------------------------------------

/** The host-only 409 codes that mean "ask another host". Never answered to a client. */
type Misroute = Extract<AgentChatErrorCode, "THREAD_NOT_OWNED" | "HOST_RETIRING">;

/** A misroute is a small error envelope; a 409 body past this is not one, and is not buffered. */
const MISROUTE_BODY_LIMIT_BYTES = 64 * 1024;

/** `/threads/<encoded id>` followed by `/`, `?` or the end — never `POST /threads` (create). */
const THREAD_PATH = /^\/threads\/([^/?#]+)/;

function threadIdOfPath(path: string): string | null {
  const match = THREAD_PATH.exec(path);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    // Not an id any host could own: the primary answers it as it answers any malformed path.
    return null;
  }
}

function misrouteOf(status: number, value: unknown): Misroute | null {
  if (status !== 409 || value === null || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return code === "THREAD_NOT_OWNED" || code === "HOST_RETIRING" ? code : null;
}

interface Answer<R> {
  misroute: Misroute | null;
  result: R;
}

/**
 * A 409's headers are in before its body: read the (small) envelope to tell a misroute from any
 * other conflict. Any other answer is handed back untouched; another 409 is handed back as a
 * replay of the bytes read, so the caller reads it exactly as it would have.
 */
async function inspectStream(stream: HostStream): Promise<Answer<HostStream>> {
  if (stream.status !== 409) return { misroute: null, result: stream };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MISROUTE_BODY_LIMIT_BYTES) throw new Error("agent host 409 body is not an error envelope");
      chunks.push(buffer);
    }
  } catch (error) {
    stream.abort();
    throw new HostUnavailableError(error instanceof Error ? error.message : String(error), error);
  }
  const raw = Buffer.concat(chunks);
  let value: unknown = null;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    value = null;
  }
  const misroute = misrouteOf(stream.status, value);
  if (misroute !== null) {
    stream.abort();
    return { misroute, result: stream };
  }
  return {
    misroute: null,
    result: { status: stream.status, body: Readable.from([raw], { objectMode: false }), abort: stream.abort }
  };
}

function misrouted(endpoint: HostEndpoint, misroute: Misroute, path: string): HostUnavailableError {
  return new HostUnavailableError(`agent host generation ${endpoint.generation} answered ${misroute} on ${path}`);
}

/**
 * "The agent host" while an update may have several (spec 2026-11-01 P2.4 R24), behind the same
 * {@link HostClient} surface as one socket's client, so no caller changes:
 *
 * - A thread-scoped path (`/threads/:id…`, the id decoded) goes to
 *   {@link HostDirectory.hostForThread}: the retiring host that owns it, else the primary, once
 *   any adoption of it is done. Every other path goes to the primary.
 * - No host to send to is {@link HostUnavailableError}: callers answer 503, as during a restart.
 * - A 409 `THREAD_NOT_OWNED` calls {@link HostDirectory.ownershipStale} (which awaits the
 *   adoption that answer implies) and retries ONCE on the host then resolved. A 409
 *   `HOST_RETIRING` (create, fork) retries once on the primary. A second misroute is
 *   {@link HostUnavailableError}: never a loop, and neither code ever reaches a client.
 * - `open()` follows the same rules: the 409 arrives in the headers, before the caller reads.
 *
 * **A streamed request body (`Readable`: chat uploads) is never retried.** It cannot be replayed
 * without buffering it, and an upload may be large. Its owner is resolved first like any request,
 * so the only misroute left is a release racing the upload. That answers 503 (the client retries
 * the upload, as after a restart) and marks ownership stale, so the retry routes right.
 *
 * Health, stop, retire and adopt address one generation, so they use that host's own
 * {@link HostEndpoint.client}, never this.
 */
export class RoutingHostClient implements HostClient {
  constructor(private readonly directory: HostDirectory) {}

  open(method: string, path: string, init: HostOpenInit = {}): Promise<HostStream> {
    return this.route(path, !(init.body instanceof Readable), (client) => client.open(method, path, init), inspectStream);
  }

  json<T>(method: string, path: string, body?: unknown, init: { timeoutMs?: number } = {}): Promise<HostJsonResponse<T>> {
    return this.route(
      path,
      true,
      (client) => client.json<T>(method, path, body, init),
      async (response) => ({ misroute: misrouteOf(response.status, response.value), result: response })
    );
  }

  private async route<R>(
    path: string,
    replayable: boolean,
    send: (client: HostClient) => Promise<R>,
    inspect: (result: R) => Promise<Answer<R>>
  ): Promise<R> {
    const threadId = threadIdOfPath(path);
    const first = await this.resolve(threadId);
    const answer = await inspect(await send(first.client));
    if (answer.misroute === null) return answer.result;
    if (!replayable) {
      this.noteStale(threadId, first, answer.misroute);
      throw misrouted(first, answer.misroute, path);
    }
    const second = await this.reroute(threadId, first, answer.misroute, path);
    const retried = await inspect(await send(second.client));
    if (retried.misroute === null) return retried.result;
    this.noteStale(threadId, second, retried.misroute);
    throw misrouted(second, retried.misroute, path);
  }

  private async resolve(threadId: string | null): Promise<HostEndpoint> {
    let endpoint: HostEndpoint | null;
    try {
      endpoint = threadId === null ? this.directory.primary() : await this.directory.hostForThread(threadId);
    } catch (error) {
      throw new HostUnavailableError(error instanceof Error ? error.message : String(error), error);
    }
    if (endpoint === null) throw new HostUnavailableError("No agent host is ready.");
    return endpoint;
  }

  /** Where the one retry goes, or a {@link HostUnavailableError} when nowhere new can take it. */
  private async reroute(
    threadId: string | null,
    from: HostEndpoint,
    misroute: Misroute,
    path: string
  ): Promise<HostEndpoint> {
    if (misroute === "HOST_RETIRING") {
      const primary = this.directory.primary();
      // The same host again would only refuse again.
      if (primary === null || primary.generation === from.generation) throw misrouted(from, misroute, path);
      return primary;
    }
    // A global route has no thread to re-resolve.
    if (threadId === null) throw misrouted(from, misroute, path);
    try {
      await this.directory.ownershipStale(threadId, from.generation);
    } catch (error) {
      throw new HostUnavailableError(error instanceof Error ? error.message : String(error), error);
    }
    return this.resolve(threadId);
  }

  /** A misroute that is not retried still tells the directory, so the next request routes right. */
  private noteStale(threadId: string | null, endpoint: HostEndpoint, misroute: Misroute): void {
    if (misroute !== "THREAD_NOT_OWNED" || threadId === null) return;
    void this.directory.ownershipStale(threadId, endpoint.generation).catch(() => undefined);
  }
}
