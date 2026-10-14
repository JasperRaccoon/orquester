/**
 * Agent chat — secrets an agent asks the user for (`request_secret`, design
 * `2026-10-14-agent-visuals-and-session-tools-design.md` §5 "Secrets").
 *
 * Where the value goes. The user types it into a private card in the thread
 * (`POST …/secret-requests/:requestId`, daemon-owned, never proxied to the
 * agent host). The daemon keeps it in memory only, hands it to the ONE
 * waiting `request_secret` call and forgets it. That call's result is the
 * only response that carries it. The provider then records the result in its
 * own conversation, and the agent host ingests that record — so the host
 * strips the value from every frame it persists, twice over:
 *
 * - **by value** — the host remembers the values it handed to a thread (in
 *   memory, for the thread's life in that host process) and masks every
 *   occurrence in that thread's runtime events and raw frames, so an agent
 *   that later echoes the secret in a command or a message is masked too;
 * - **by shape** ({@link stripSecretRequestValues}) — the result carries the
 *   value beside a {@link SECRET_REQUEST_RESULT_KEY} object, and any record of
 *   it, as an object or as JSON text, loses the value wherever it sits. This
 *   one needs no memory, so it also holds after a host restart.
 *
 * What stays: the request's name, purpose and outcome (the card's persisted
 * record, the tool row's `secretRequest` reference).
 */

/** The session tool's bare name. */
export const SECRET_REQUEST_TOOL_NAME = "request_secret";

/** The key of the result object that describes the request (and survives redaction). */
export const SECRET_REQUEST_RESULT_KEY = "secretRequest";

/** The key of the result field that carries the value (and never survives redaction). */
export const SECRET_REQUEST_VALUE_KEY = "value";

/** What stands where a secret value was. */
export const SECRET_REDACTED_TEXT = "[secret redacted]";

/** Bounds of a request and an answer. */
export const SECRET_REQUEST_NAME_MAX_CHARS = 80;
export const SECRET_REQUEST_PROMPT_MAX_CHARS = 500;
export const SECRET_REQUEST_PURPOSE_MAX_CHARS = 500;
/** 8 Ki chars: even fully JSON-escaped, the result stays under the 60 000-byte result cap. */
export const SECRET_VALUE_MAX_CHARS = 8 * 1024;

/** How a request ended. */
export type SecretRequestOutcome = "provided" | "declined" | "cancelled" | "timed_out";

/** A pending request as every client sees it: never a value. */
export interface SecretRequestSummary {
  requestId: string;
  /** The chat session (= thread) that asked. */
  sessionId: string;
  /** What is asked for, the card's title (e.g. `GITHUB_TOKEN`). */
  name: string;
  /** What the agent tells the user. */
  prompt: string;
  /** What the value will be used for. */
  purpose?: string;
  createdAt: string;
}

/** `GET /api/sessions/:id/secret-requests` — the thread's pending requests, oldest first. */
export interface SecretRequestListResponse {
  requests: SecretRequestSummary[];
}

/** `POST /api/sessions/:id/secret-requests/:requestId`. */
export type SecretRequestAnswerRequest =
  | { answer: "provide"; value: string }
  | { answer: "decline" };

/** The answer's response: the outcome only, never the value. */
export interface SecretRequestAnswerResponse {
  ok: true;
  outcome: "provided" | "declined";
}

/** The answer route's refusals. */
export type SecretRequestErrorCode =
  | "THREAD_NOT_FOUND"
  | "SECRET_REQUEST_NOT_FOUND"
  | "INVALID_ARGUMENT";

/** A refusal's body: the agent-chat error envelope's shape. Never quotes the request body. */
export interface SecretRequestErrorEnvelope {
  error: { code: SecretRequestErrorCode; message: string };
}

/** The bus event a request opening or closing publishes on the `sessions` channel. */
export const SECRET_REQUEST_EVENT_TYPE = "agentChat.secretRequest";

export interface AgentChatSecretRequestEventPayload {
  /** Session id (= thread id). */
  id: string;
  request: SecretRequestSummary;
  open: boolean;
  /** How it ended; only on `open: false`. */
  outcome?: SecretRequestOutcome;
}

/** What the redacted result keeps (the tool row's `secretRequest` reference). */
export interface SecretRequestRecord {
  name: string;
  purpose?: string;
  outcome: SecretRequestOutcome;
}

const MARKER = `"${SECRET_REQUEST_RESULT_KEY}"`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True for a result object of `request_secret` (with or without its value). */
function isSecretRequestResult(value: Record<string, unknown>): boolean {
  return isRecord(value[SECRET_REQUEST_RESULT_KEY]);
}

function stripString(text: string): string {
  if (!text.includes(MARKER)) {
    return text;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        const stripped = stripSecretRequestValues(parsed);
        return stripped === parsed ? text : JSON.stringify(stripped);
      }
    } catch {
      // Not whole JSON: a cut or a wrapped copy. Fall through.
    }
  }
  // The marker in text that does not parse as the result (a provider's cut, a
  // prefix, a different serialisation): nothing in it can be trusted to be
  // value-free, so none of it is kept.
  return SECRET_REDACTED_TEXT;
}

/**
 * `value` with every `request_secret` result's value removed, wherever it
 * sits: an object carrying {@link SECRET_REQUEST_RESULT_KEY} loses
 * {@link SECRET_REQUEST_VALUE_KEY}, a string holding such a result as JSON is
 * rewritten without it, and a string that names the marker but does not parse
 * is replaced whole. Returns `value` itself (same reference) when nothing
 * changed, so a caller can skip a copy.
 */
export function stripSecretRequestValues<T>(value: T): T {
  return strip(value, 0) as T;
}

const MAX_DEPTH = 64;

function strip(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return stripString(value);
  }
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index];
      const next = strip(entry, depth + 1);
      if (next !== entry) {
        out ??= value.slice();
        out[index] = next;
      }
    }
    return out ?? value;
  }
  const record = value as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  if (isSecretRequestResult(record) && SECRET_REQUEST_VALUE_KEY in record) {
    out = { ...record };
    delete out[SECRET_REQUEST_VALUE_KEY];
  }
  for (const [key, entry] of Object.entries(out ?? record)) {
    const next = strip(entry, depth + 1);
    if (next !== entry) {
      out ??= { ...record };
      out[key] = next;
    }
  }
  return out ?? value;
}

/** The `secretRequest` record of a (redacted) result, or null when it is not one. */
export function secretRequestRecordOf(value: unknown): SecretRequestRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, purpose, outcome } = value;
  if (typeof name !== "string" || typeof outcome !== "string") {
    return null;
  }
  if (!["provided", "declined", "cancelled", "timed_out"].includes(outcome)) {
    return null;
  }
  return {
    name,
    ...(typeof purpose === "string" && purpose.length > 0 ? { purpose } : {}),
    outcome: outcome as SecretRequestOutcome
  };
}

/** A `SecretRequestSummary` from untrusted JSON (a bus payload, a list answer), or null. */
export function parseSecretRequestSummary(value: unknown): SecretRequestSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const { requestId, sessionId, name, prompt, purpose, createdAt } = value;
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof name !== "string" ||
    typeof prompt !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  return {
    requestId,
    sessionId,
    name,
    prompt,
    ...(typeof purpose === "string" && purpose.length > 0 ? { purpose } : {}),
    createdAt
  };
}
