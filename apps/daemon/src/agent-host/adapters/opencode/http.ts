/**
 * Agent host — the OpenCode HTTP client (spec §4.5 OpenCode).
 *
 * Plain `fetch`, not `@opencode-ai/sdk`: the SDK in this workspace is 1.18.31
 * while the CLI on this host is **1.18.5**, and the SDK additionally offers
 * `POST /session/{id}/permissions/{permissionID}` — the route the spec names
 * as the trap. Every call the adapter makes is one of ~20 routes captured
 * verbatim in `apps/daemon/test/fixtures/opencode/`, so a hand-rolled client
 * is both smaller and pinned to what the server actually answers.
 *
 * Three rules hold for every call:
 * - **Every call has a deadline** (§3.1). `withDeadline` aborts the underlying
 *   fetch through its signal, so an expired window frees the socket too.
 * - **Auth is `Basic base64("opencode:<password>")`, exactly** — the literal
 *   username is checked and the empty-username form is rejected (fixtures
 *   README observation 20). `/global/health` is behind the same gate, so the
 *   post-start version check already carries the credential.
 * - **The directory travels per request** (§4.5 "there is no cwd on the
 *   process"), as `?directory=` on every method. The header form works too,
 *   but the query is what the captures used on GET and HEAD.
 */

import { withDeadline } from "../../support/deadline.ts";
import { isRecord } from "./protocol.ts";

/** A non-2xx answer, carrying the status and the parsed body. */
export class OpenCodeHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;

  constructor(input: {
    method: string;
    path: string;
    status: number;
    body: unknown;
    detail: string;
  }) {
    super(`opencode ${input.method} ${input.path} -> ${input.status}: ${input.detail}`);
    this.name = "OpenCodeHttpError";
    this.status = input.status;
    this.body = input.body;
    this.method = input.method;
    this.path = input.path;
  }
}

/** A transport failure — the server went away, DNS, a reset socket. */
export class OpenCodeTransportError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, cause: unknown) {
    super(`opencode ${method} ${path} failed: ${describe(cause)}`);
    this.name = "OpenCodeTransportError";
    this.method = method;
    this.path = path;
    this.cause = cause;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return String(cause);
}

/**
 * Whether an error **structurally confirms** a missing session (§4.5 Resume).
 * Only this may fall through to a fresh session; anything else must propagate,
 * or a transient blip silently resets a live thread to an empty one.
 *
 * 1.18.5 makes the good case easy — `{"name":"NotFoundError","data":{…}}` with
 * a 404 — and shows exactly what this guards against: a **malformed** session
 * id answers **500** (fixtures README observation 12), which must never read
 * as "session gone, start a new one". An explicit non-404 status therefore
 * **seals its subtree**: a wrapped `NotFoundError` name underneath a 500 does
 * not reclassify it.
 */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (!isRecord(node) || seen.has(node)) {
      continue;
    }
    seen.add(node);

    const response = node.response;
    const statuses = [
      node.status,
      node.statusCode,
      isRecord(response) ? response.status : undefined
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    if (typeof node.name === "string" && node.name.toLowerCase() === "notfounderror") {
      return true;
    }
    for (const key of ["cause", "body", "error", "data"] as const) {
      if (node[key] !== undefined) {
        queue.push(node[key]);
      }
    }
  }
  return false;
}

export interface OpenCodeClientOptions {
  baseUrl: string;
  /** Absolute, already resolved — a bad directory is silently served, never rejected. */
  directory: string;
  serverPassword?: string;
  /** Host shutdown; every in-flight call is aborted with it. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface OpenCodeRequestOptions {
  timeoutMs: number;
  /** Suppressed from the deadline label only; the path is enough for logs. */
  label?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/**
 * `Authorization: Basic base64("opencode:<password>")` — the literal username
 * is load-bearing (fixtures README observation 20).
 */
export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  readonly directory: string;
  private readonly password: string | undefined;
  private readonly hostSignal: AbortSignal | undefined;
  private readonly doFetch: typeof fetch;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.directory = options.directory;
    this.password = options.serverPassword;
    this.hostSignal = options.signal;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /** A client for the same server scoped to a different directory. */
  withDirectory(directory: string): OpenCodeClient {
    return new OpenCodeClient({
      baseUrl: this.baseUrl,
      directory,
      ...(this.password !== undefined ? { serverPassword: this.password } : {}),
      ...(this.hostSignal !== undefined ? { signal: this.hostSignal } : {}),
      fetchImpl: this.doFetch
    });
  }

  url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("directory", this.directory);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    return {
      accept: "application/json",
      ...(this.password !== undefined ? { authorization: basicAuthHeader(this.password) } : {}),
      ...extra
    };
  }

  async request<T>(
    method: string,
    path: string,
    options: OpenCodeRequestOptions
  ): Promise<T> {
    const url = this.url(path, options.query);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.hostSignal?.addEventListener("abort", abort, { once: true });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (this.hostSignal?.aborted === true || options.signal?.aborted === true) {
      controller.abort();
    }

    try {
      return await withDeadline(
        (async (): Promise<T> => {
          let response: Response;
          try {
            response = await this.doFetch(url, {
              method,
              headers: this.headers(
                options.body === undefined ? undefined : { "content-type": "application/json" }
              ),
              ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
              signal: controller.signal
            });
          } catch (cause) {
            throw new OpenCodeTransportError(method, path, cause);
          }

          const text = response.status === 204 ? "" : await response.text();
          const parsed = parseBody(text);
          if (!response.ok) {
            throw new OpenCodeHttpError({
              method,
              path,
              status: response.status,
              body: parsed,
              detail: errorDetail(parsed) ?? text.slice(0, 512)
            });
          }
          return parsed as T;
        })(),
        {
          label: options.label ?? `opencode ${method} ${path}`,
          timeoutMs: options.timeoutMs,
          onTimeout: abort
        }
      );
    } finally {
      this.hostSignal?.removeEventListener("abort", abort);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  get<T>(path: string, options: OpenCodeRequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, options: OpenCodeRequestOptions): Promise<T> {
    return this.request<T>("POST", path, options);
  }

  patch<T>(path: string, options: OpenCodeRequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, options);
  }

  /**
   * Open the SSE stream. Returns the response so the caller owns the body; the
   * stream has no deadline by design — it is long-lived.
   */
  async openEventStream(signal: AbortSignal): Promise<Response> {
    const url = this.url("/event");
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream" }),
        signal
      });
    } catch (cause) {
      throw new OpenCodeTransportError("GET", "/event", cause);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OpenCodeHttpError({
        method: "GET",
        path: "/event",
        status: response.status,
        body: parseBody(text),
        detail: text.slice(0, 512)
      });
    }
    return response;
  }
}

function parseBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * 1.18.5 answers with **three** error envelopes (fixtures README observation
 * 12): `{name, data:{message}}` on session routes, `{_tag, requestID, message}`
 * on permission/question replies, and a flat string otherwise.
 */
export function errorDetail(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim().length > 0) {
    return body.trim();
  }
  if (!isRecord(body)) {
    return undefined;
  }
  if (typeof body.message === "string" && body.message.trim().length > 0) {
    return body.message.trim();
  }
  const data = body.data;
  if (isRecord(data) && typeof data.message === "string" && data.message.trim().length > 0) {
    return data.message.trim();
  }
  if (typeof body.name === "string") {
    return body.name;
  }
  return undefined;
}
