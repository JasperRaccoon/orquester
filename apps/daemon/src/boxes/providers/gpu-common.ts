/**
 * Small pieces the GPU adapters (`gpu-providers.ts`) share: credential lookup,
 * the validate wrapper, offer labels and number parsing. Kept apart from
 * `gpu-providers.ts` so adapters do not import the module that imports them.
 */

import type { BoxGpuInfo } from "@orquester/api";

import type { ProviderCallOptions, ProviderCredentials } from "../contracts.ts";
import { ProviderHttpError, isAuthError, providerRequest } from "./http.ts";
import type { ProviderRequest, ProviderResponse } from "./http.ts";

/** A required credential field, trimmed; throws a plain message (never the value) when it is missing. */
export function requireCredential(credentials: ProviderCredentials, field: string, provider: string): string {
  const value = credentials[field]?.trim();
  if (!value) throw new ProviderHttpError(provider, 401, `${provider}: the ${field} credential is not set`, null);
  return value;
}

/**
 * Run a cheap authenticated read. Bad credentials (and any other provider failure)
 * become `{ ok: false }` with the provider's wording; only the caller's abort throws.
 */
export async function validateWith(
  provider: string,
  signal: AbortSignal,
  read: () => Promise<unknown>
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await read();
    return { ok: true };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isAuthError(error)) {
      return { ok: false, message: `${provider} rejected the API key: ${(error as Error).message.replace(`${provider}: `, "")}` };
    }
    return { ok: false, message: (error as Error).message || `${provider}: validation failed` };
  }
}

/**
 * `providerRequest` for providers whose error bodies pair a short code with a sentence
 * (`{"error":"auth_error","msg":"Invalid user key"}`, `{"error":"unauthorized","message":"…"}`): the
 * generic helper would show the code, this shows the sentence.
 */
export async function providerRequestWorded<T>(provider: string, request: ProviderRequest, options: ProviderCallOptions): Promise<ProviderResponse<T>> {
  try {
    return await providerRequest<T>(provider, request, options);
  } catch (error) {
    const body = error instanceof ProviderHttpError ? (error.body as Record<string, unknown> | null) : null;
    const sentence = body && typeof body === "object" ? [body.msg, body.message].find((value) => typeof value === "string" && value.trim()) : undefined;
    if (error instanceof ProviderHttpError && typeof body?.error === "string" && !/\s/.test(body.error) && typeof sentence === "string") {
      throw new ProviderHttpError(provider, error.status, `${provider}: ${sentence.trim().slice(0, 300)}`, error.body);
    }
    throw error;
  }
}

/** `ProviderHttpError` with a 404: the instance (or resource) no longer exists. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ProviderHttpError && error.status === 404;
}

/** A finite number from a provider field that may be a number, a numeric string, or missing. */
export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Hourly USD rounded to a tenth of a cent, or null for missing/zero/negative prices. */
export function hourly(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1000) / 1000;
}

/** "1× RTX 4090 24 GB · 16 vCPU · 64 GB RAM" — the size label the offers list shows. */
export function gpuSizeLabel(gpu: BoxGpuInfo, extras: { vcpu?: number; ramGb?: number; note?: string } = {}): string {
  const parts = [`${gpu.count}× ${gpu.model}${gpu.vramGb ? ` ${gpu.vramGb} GB` : ""}`];
  if (extras.vcpu) parts.push(`${extras.vcpu} vCPU`);
  if (extras.ramGb) parts.push(`${extras.ramGb} GB RAM`);
  if (extras.note) parts.push(extras.note);
  return parts.join(" · ");
}

/** ISO string from an epoch-seconds number, an ISO/date string, or null. */
export function isoTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Epoch seconds (providers here never send ms below year 2001 in seconds form).
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/**
 * Poll `read` with a growing interval (1 s → 10 s) until it returns a value or `deadlineMs` passes
 * (then null). For provider states that only polling can observe; the caller's signal aborts it.
 */
export async function pollUntil<T>(
  read: () => Promise<T | null>,
  options: { signal: AbortSignal; deadlineMs: number }
): Promise<T | null> {
  const deadline = Date.now() + options.deadlineMs;
  for (let attempt = 0; ; attempt++) {
    const value = await read();
    if (value !== null) return value;
    const wait = Math.min(1000 * 2 ** attempt, 10_000);
    if (Date.now() + wait > deadline) return null;
    await new Promise<void>((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        options.signal.removeEventListener("abort", onAbort);
        resolve();
      }, wait);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(options.signal.reason);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * The bootstrap as one shell command line, for providers whose "startup command" is a single
 * string (templated into cloud-init or run by their agent): decode the base64 `posixScript` into a
 * private temp file (mktemp → 0600) and start it detached, so the command returns at once and the
 * script survives the provider's shell. Base64 keeps the line free of quotes and newlines.
 */
export function detachedStartCommand(posixScript: string): string {
  const encoded = Buffer.from(posixScript, "utf8").toString("base64");
  return `f=$(mktemp) && echo ${encoded} | base64 -d > "$f" && nohup sh "$f" > "$f.log" 2>&1 &`;
}

/** Throws `signal.reason` when aborted (between multi-call steps). */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
