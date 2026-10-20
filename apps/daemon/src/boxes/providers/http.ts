/**
 * The one HTTP helper every provider adapter uses: JSON requests with a
 * deadline, retries on 429/5xx (honouring `Retry-After`), and errors that
 * carry the provider's own message — never the request's credentials.
 */

import type { ProviderCallOptions } from "../contracts.ts";

export class ProviderHttpError extends Error {
  readonly status: number;
  /** The provider's error body, parsed when JSON (credentials never appear in it). */
  readonly body: unknown;
  readonly provider: string;

  constructor(provider: string, status: number, message: string, body: unknown) {
    super(message);
    this.name = "ProviderHttpError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

export interface ProviderRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** Serialized as JSON unless it is a string (sent as is). */
  body?: unknown;
  /** Statuses that are not errors for this call (e.g. 404 on an idempotent delete). */
  okStatuses?: readonly number[];
  /** Per-attempt timeout; default 30 s. */
  timeoutMs?: number;
  /** Total attempts on 429/5xx/network errors; default 4. Non-idempotent creates should pass 1. */
  attempts?: number;
}

export interface ProviderResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 20_000;

/** Pull a human message out of the common provider error shapes. */
export function providerErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim().length > 0) return body.trim().slice(0, 300);
  if (typeof body !== "object" || body === null) return fallback;
  const record = body as Record<string, unknown>;
  const candidates: unknown[] = [
    (record.error as Record<string, unknown> | undefined)?.message,
    record.error,
    record.message,
    record.detail,
    record.title,
    (record.errors as unknown[] | undefined)?.[0],
    ((record.errors as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined)?.message,
    ((record.errors as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined)?.detail
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim().slice(0, 300);
  }
  return fallback;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), MAX_BACKOFF_MS);
  }
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Make one provider API call. Retries 429, 5xx and network failures (unless
 * `attempts: 1`), waits honour `Retry-After` and the caller's signal, and a
 * non-OK status throws {@link ProviderHttpError} with the provider's message.
 */
export async function providerRequest<T = unknown>(
  provider: string,
  request: ProviderRequest,
  options: ProviderCallOptions
): Promise<ProviderResponse<T>> {
  const doFetch = options.fetch ?? fetch;
  const attempts = Math.max(1, request.attempts ?? DEFAULT_ATTEMPTS);
  const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
  let body: string | undefined;
  if (request.body !== undefined) {
    if (typeof request.body === "string") {
      body = request.body;
    } else {
      body = JSON.stringify(request.body);
      headers["Content-Type"] ??= "application/json";
    }
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await doFetch(request.url, { method: request.method ?? "GET", headers, body, signal });
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      lastError = new ProviderHttpError(provider, 0, `${provider}: ${(error as Error).message || "network error"}`, null);
      if (attempt + 1 < attempts) {
        await abortableDelay(retryDelayMs(attempt, null), options.signal);
        continue;
      }
      throw lastError;
    }

    const text = await response.text();
    let data: unknown = text;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else {
      data = null;
    }

    if (response.ok || request.okStatuses?.includes(response.status)) {
      return { status: response.status, headers: response.headers, data: data as T };
    }

    const retryable = response.status === 429 || response.status >= 500;
    lastError = new ProviderHttpError(
      provider,
      response.status,
      `${provider}: ${providerErrorMessage(data, `HTTP ${response.status}`)}`,
      data
    );
    if (retryable && attempt + 1 < attempts) {
      await abortableDelay(retryDelayMs(attempt, response.headers.get("retry-after")), options.signal);
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

/** `ProviderHttpError` with a 401/403: the credentials are wrong or lack permission. */
export function isAuthError(error: unknown): boolean {
  return error instanceof ProviderHttpError && (error.status === 401 || error.status === 403);
}

/** The standard tags every provider applies (where it supports tags/labels). */
export function boxTags(boxId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "orquester-box": boxId, ...extra };
}

/** `orq-<boxId>` → boxId; null for names Orquester did not create. */
export function boxIdFromInstanceName(name: string): string | null {
  const match = /^orq-([A-Za-z0-9-]{8,64})$/.exec(name);
  return match ? match[1]! : null;
}
