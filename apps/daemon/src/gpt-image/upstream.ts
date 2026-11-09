/**
 * The ChatGPT image endpoint Codex itself calls (design
 * `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §4; captures and findings in
 * `./fixtures/README.md`): building a request, classifying an answer, and one call with retries.
 *
 * - `POST https://chatgpt.com/backend-api/codex/images/generations` without reference images,
 *   `…/images/edits` with 1–5 (`images: [{image_url: "data:…;base64,…"}]`).
 * - Body: `{prompt, model: "gpt-image-2", background, quality: "auto", size: "auto"}`. The spike
 *   found `size` and `quality` are not honored, so they are always `auto` (as Codex sends them).
 * - Answer: `{data: [{b64_json, generation_id}], background, output_format, quality, size, usage}`.
 *
 * Retried (with backoff, honoring `Retry-After`): a 429 that is not a usage limit, a 5xx, a network
 * failure. Never retried: a usage limit, a plan refusal, a safety refusal, a 401, any other 4xx.
 * Nothing here logs or returns a token or an account id.
 */

export const GPT_IMAGE_MODEL = "gpt-image-2";
export const CHATGPT_IMAGES_URL = "https://chatgpt.com/backend-api/codex/images";
/** Codex's own `originator` (it sends the same value to this endpoint). */
const ORIGINATOR = "codex_cli_rs";
/** At most this many attempts of one call (the first plus retries). */
export const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
/** A `Retry-After` above this is not waited for: the call fails as unavailable instead. */
const MAX_RETRY_AFTER_MS = 30_000;
/** An answer larger than this is no image this endpoint sends (a 1536×1024 PNG is ~2 MB of base64). */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Upstream refusal text is clipped to this many characters before it reaches the agent. */
const MAX_REFUSAL_CHARS = 300;

export interface ImageRequestInput {
  prompt: string;
  /** 0–5 reference images; any switches the call to the edits endpoint. */
  images: readonly { bytes: Buffer; mimeType: string }[];
  transparent: boolean;
}

export interface UpstreamCredentials {
  accessToken: string;
  /** The ChatGPT workspace (`ChatGPT-Account-Id`); the spike found it optional for a one-workspace login. */
  chatgptAccountId: string | null;
}

export interface UpstreamImage {
  bytes: Buffer;
  revisedPrompt?: string;
  /** What the endpoint says it made: `transparent` / `opaque`. */
  background?: string;
  outputFormat?: string;
}

export type UpstreamFailure =
  | { kind: "quota"; resetsAt: number | null }
  | { kind: "free-plan" }
  | { kind: "auth" }
  | { kind: "safety"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "transient"; status: number | null; retryAfterMs: number | null }
  | { kind: "unexpected"; status: number };

export class UpstreamError extends Error {
  constructor(readonly failure: UpstreamFailure) {
    super(`chatgpt images: ${failure.kind}`);
    this.name = "UpstreamError";
  }
}

/** The endpoint and JSON body for one request. */
export function buildImageRequest(input: ImageRequestInput): { url: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    model: GPT_IMAGE_MODEL,
    background: input.transparent ? "transparent" : "opaque",
    quality: "auto",
    size: "auto"
  };
  if (input.images.length === 0) return { url: `${CHATGPT_IMAGES_URL}/generations`, body };
  body.images = input.images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` }));
  return { url: `${CHATGPT_IMAGES_URL}/edits`, body };
}

/** The request headers: the bearer, the workspace, Codex's originator. */
export function requestHeaders(credentials: UpstreamCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    ...(credentials.chatgptAccountId ? { "ChatGPT-Account-Id": credentials.chatgptAccountId } : {}),
    originator: ORIGINATOR,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function clip(text: string): string {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return line.length > MAX_REFUSAL_CHARS ? `${line.slice(0, MAX_REFUSAL_CHARS - 1)}…` : line;
}

/** The image an answer holds, or null when it is not the documented shape. */
export function parseImageResponse(json: unknown): UpstreamImage | null {
  const record = asRecord(json);
  const first = Array.isArray(record?.data) ? asRecord(record.data[0]) : undefined;
  if (!record || !first || typeof first.b64_json !== "string" || first.b64_json.length === 0) return null;
  const bytes = Buffer.from(first.b64_json, "base64");
  if (bytes.length === 0) return null;
  const revised = typeof first.revised_prompt === "string" ? first.revised_prompt : typeof record.revised_prompt === "string" ? record.revised_prompt : undefined;
  return {
    bytes,
    ...(revised && revised.trim() ? { revisedPrompt: revised.trim() } : {}),
    ...(typeof record.background === "string" ? { background: record.background } : {}),
    ...(typeof record.output_format === "string" ? { outputFormat: record.output_format } : {})
  };
}

type HeaderReader = { get(name: string): string | null };

function headerNumber(headers: HeaderReader, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** `Retry-After` in ms (seconds or an HTTP date), or null. */
export function retryAfterMs(headers: HeaderReader, now: number): number | null {
  const raw = headers.get("retry-after");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * When an exhausted limit resets, in unix ms: the body's `resets_at` (seconds) or
 * `resets_in_seconds`, else the latest `x-codex-{primary,secondary}-reset-at` among the windows at
 * 100% (`codex-rs/codex-api/src/api_bridge.rs`, `ext/image-generation/src/tool.rs`).
 */
function quotaResetsAt(error: Record<string, unknown> | undefined, headers: HeaderReader, now: number): number | null {
  if (typeof error?.resets_at === "number" && Number.isFinite(error.resets_at)) return error.resets_at * 1000;
  if (typeof error?.resets_in_seconds === "number" && Number.isFinite(error.resets_in_seconds)) return now + error.resets_in_seconds * 1000;
  let latest: number | null = null;
  for (const window of ["primary", "secondary"]) {
    const used = headerNumber(headers, `x-codex-${window}-used-percent`);
    const at = headerNumber(headers, `x-codex-${window}-reset-at`);
    if (used !== null && used >= 100 && at !== null && at > 0) latest = Math.max(latest ?? 0, at * 1000);
  }
  return latest;
}

/** Codes and types the image endpoint and the Responses API use for a policy refusal. */
const SAFETY_CODE = /moderation|safety|content_policy|policy_violation|invalid_prompt|cyber_policy|bio_policy/i;

/** What a non-2xx answer means. */
export function classifyFailure(status: number, headers: HeaderReader, bodyText: string, now: number): UpstreamFailure {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = undefined;
  }
  const error = asRecord(asRecord(json)?.error);
  const type = typeof error?.type === "string" ? error.type : "";
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  if (status === 401) return { kind: "auth" };
  if (type === "usage_not_included" || code === "usage_not_included") return { kind: "free-plan" };
  if (type === "usage_limit_reached") {
    if (typeof error?.plan_type === "string" && error.plan_type.toLowerCase() === "free") return { kind: "free-plan" };
    return { kind: "quota", resetsAt: quotaResetsAt(error, headers, now) };
  }
  if (status === 429 && (type === "insufficient_quota" || /^(insufficient_quota|credit_balance_exhausted|.*_usage_limit_exceeded|.*_spend_limit_exceeded)$/.test(code))) {
    return { kind: "quota", resetsAt: quotaResetsAt(error, headers, now) };
  }
  if (status === 400 || status === 403) {
    if (SAFETY_CODE.test(code) || SAFETY_CODE.test(type) || /safety system/i.test(message)) {
      return { kind: "safety", message: clip(message) || "The request was refused by the safety system." };
    }
    if (status === 400) return { kind: "invalid", message: clip(message) || "ChatGPT refused the request as invalid." };
  }
  if (status === 429 || status >= 500) return { kind: "transient", status, retryAfterMs: retryAfterMs(headers, now) };
  return { kind: "unexpected", status };
}

export interface UpstreamDeps {
  fetch: typeof fetch;
  /** Wait `ms`; rejects when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  logger?: Pick<Console, "warn">;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * One image request, retried per the module rules. Resolves the image or rejects an
 * {@link UpstreamError}; rejects the signal's reason once `signal` aborts.
 */
export async function postImageRequest(deps: UpstreamDeps, credentials: UpstreamCredentials, input: ImageRequestInput, signal: AbortSignal): Promise<UpstreamImage> {
  const { url, body } = buildImageRequest(input);
  const payload = JSON.stringify(body);
  let last: UpstreamFailure = { kind: "transient", status: null, retryAfterMs: null };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) throw abortReason(signal);
    let failure: UpstreamFailure;
    try {
      const res = await deps.fetch(url, { method: "POST", headers: requestHeaders(credentials), body: payload, signal });
      const buffer = Buffer.from(await res.arrayBuffer());
      if (res.ok) {
        let json: unknown;
        try {
          json = buffer.length <= MAX_RESPONSE_BYTES ? JSON.parse(buffer.toString("utf8")) : undefined;
        } catch {
          json = undefined;
        }
        const image = parseImageResponse(json);
        if (image) return image;
        const keys = Object.keys(asRecord(json) ?? {}).slice(0, 12).join(",");
        deps.logger?.warn?.(`gpt-image: unexpected answer from the image endpoint (HTTP ${res.status}, ${buffer.length} bytes, keys: ${keys || "none"})`);
        throw new UpstreamError({ kind: "unexpected", status: res.status });
      }
      failure = classifyFailure(res.status, res.headers, buffer.subarray(0, 64 * 1024).toString("utf8"), deps.now());
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (signal.aborted) throw abortReason(signal);
      // A network failure (DNS, reset, TLS): retried like a 5xx.
      failure = { kind: "transient", status: null, retryAfterMs: null };
    }
    last = failure;
    if (failure.kind !== "transient") throw new UpstreamError(failure);
    if (attempt === MAX_ATTEMPTS) break;
    const wait = failure.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
    if (wait > MAX_RETRY_AFTER_MS) break;
    deps.logger?.warn?.(`gpt-image: the image endpoint answered ${failure.status ?? "a network error"}; retrying in ${Math.round(wait / 100) / 10} s`);
    await deps.sleep(wait, signal);
  }
  throw new UpstreamError(last);
}
