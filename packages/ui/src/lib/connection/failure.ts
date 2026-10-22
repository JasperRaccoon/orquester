import { ORQUESTER_SERVICE, type HealthResponse } from "@orquester/api";

/**
 * Why one attempt to reach the daemon failed, as precisely as the runtime lets
 * us say. A browser's `fetch` hides the cause of a network failure (DNS,
 * refused, TLS and CORS all read "Failed to fetch"), so the web client mostly
 * sees `unreachable`; the desktop app's requests run in Node and carry the
 * system error code, which names the cause.
 */
export type ConnectionFailureKind =
  /** This device reports no network. */
  | "offline"
  /** The server's name did not resolve. */
  | "dns"
  /** The host answered, but nothing listens on that port. */
  | "refused"
  /** The secure connection failed (certificate, protocol). */
  | "tls"
  /** No answer in time. */
  | "timeout"
  /** The request never got an answer, cause unknown. */
  | "unreachable"
  /** A proxy answered 502/503/504: it is up, the daemon behind it is not. */
  | "proxy-down"
  /** Something answered, but not an Orquester daemon. */
  | "not-orquester"
  /** The daemon answered with an error. */
  | "server-error"
  /** The credential was refused (401). */
  | "unauthorized"
  /** Too many failed sign-ins from this address (429). */
  | "locked"
  /** The live event stream went silent. */
  | "stalled"
  | "unknown";

export interface ConnectionFailure {
  kind: ConnectionFailureKind;
  /** HTTP status, when the server answered. */
  status?: number;
  /** The error's own text, redacted. */
  detail: string;
  /** Epoch ms of the (latest) occurrence. */
  at: number;
}

/** The response was not JSON, so whatever answered is not the daemon's API. */
export class UnexpectedResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly contentType: string | null
  ) {
    super(`The server answered ${status} with ${contentType ? `"${contentType}"` : "a body"} instead of JSON.`);
    this.name = "UnexpectedResponseError";
  }
}

/** `/health` answered JSON, but not an Orquester daemon's. */
export class NotOrquesterError extends Error {
  constructor() {
    super("The server's /health answer is not an Orquester daemon's.");
    this.name = "NotOrquesterError";
  }
}

/**
 * Accept a `/health` answer only from an Orquester daemon. Daemons that predate
 * the `service` marker answer `{ ok: true }`, so the marker is checked only
 * when present.
 */
export function checkHealth(value: unknown): HealthResponse {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (record?.ok !== true || (record.service !== undefined && record.service !== ORQUESTER_SERVICE)) {
    throw new NotOrquesterError();
  }
  return {
    ok: true,
    ...(typeof record.service === "string" ? { service: record.service } : {}),
    ...(typeof record.protocol === "number" && Number.isInteger(record.protocol) ? { protocol: record.protocol } : {})
  };
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL"]);
const REFUSED_CODES = new Set(["ECONNREFUSED"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);
const UNREACHABLE_CODES = new Set(["EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);
const isTlsCode = (code: string): boolean =>
  /^(CERT_|ERR_TLS_|ERR_SSL_|ERR_CERT_)/.test(code) ||
  code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
  code === "SELF_SIGNED_CERT_IN_CHAIN" ||
  code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
  code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";

/**
 * The first system error code on the error or its `cause` chain (Node's fetch
 * wraps the socket error in `cause`).
 */
// Adapted from T3 Code (MIT): apps/server/src/cloud/ConnectReachability.ts
function errorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}

/** All messages along the `cause` chain: Electron's IPC flattens a Node error into its message. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message) parts.push(message);
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.join(": ");
}

function kindFromCode(code: string): ConnectionFailureKind | null {
  if (DNS_CODES.has(code)) return "dns";
  if (REFUSED_CODES.has(code)) return "refused";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (isTlsCode(code)) return "tls";
  if (UNREACHABLE_CODES.has(code)) return "unreachable";
  return null;
}

/** Names a cause from an error's text: Electron IPC errors and Chromium `net::` names. */
const TEXT_KINDS: ReadonlyArray<readonly [RegExp, ConnectionFailureKind]> = [
  [/ENOTFOUND|EAI_AGAIN|EAI_NONAME|ERR_NAME_NOT_RESOLVED|getaddrinfo/i, "dns"],
  // `connect ENOENT <path>`: the desktop's local socket file is gone — no daemon listening.
  [/ECONNREFUSED|ERR_CONNECTION_REFUSED|connect ENOENT/i, "refused"],
  [/CERT_|ERR_SSL|ERR_TLS|self[- ]signed|certificate|SSL routines|TLS handshake|wrong version number/i, "tls"],
  [/ETIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|timed? ?out/i, "timeout"],
  [
    /Failed to fetch|NetworkError|Load failed|fetch failed|network error|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_(RESET|CLOSED)|socket hang up/i,
    "unreachable"
  ]
];

const NETWORK_KINDS: ReadonlySet<ConnectionFailureKind> = new Set(["dns", "refused", "tls", "timeout", "unreachable"]);

/** `navigator.onLine`, true where there is no navigator (tests, workers without one). */
export function deviceOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export interface ClassifyContext {
  /** `navigator.onLine`; false names the device itself as the cause. */
  online?: boolean;
  /** Epoch ms; defaults to now. */
  at?: number;
}

/** Status of an ApiError-shaped error (`status` + `name`), without importing the client. */
function httpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function kindFromStatus(status: number): ConnectionFailureKind {
  if (status === 401) return "unauthorized";
  if (status === 429) return "locked";
  if (status === 502 || status === 503 || status === 504) return "proxy-down";
  // The connection probes ask for routes every daemon has.
  if (status === 404 || status === 405) return "not-orquester";
  return "server-error";
}

/** Classify one failed attempt to reach the daemon. */
export function classifyConnectionError(error: unknown, context: ClassifyContext = {}): ConnectionFailure {
  const at = context.at ?? Date.now();
  const detail = redactSecrets(errorText(error) || String(error));
  if (error instanceof UnexpectedResponseError) {
    const kind = error.status >= 502 && error.status <= 504 ? "proxy-down" : "not-orquester";
    return { kind, status: error.status, detail, at };
  }
  if (error instanceof NotOrquesterError || error instanceof SyntaxError) {
    return { kind: "not-orquester", detail, at };
  }
  const status = httpStatus(error);
  if (status !== null) {
    return { kind: kindFromStatus(status), status, detail, at };
  }
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  let kind: ConnectionFailureKind | null =
    name === "TimeoutError" || name === "AbortError" ? "timeout" : null;
  const code = errorCode(error);
  kind ??= code ? kindFromCode(code) : null;
  const text = errorText(error);
  kind ??= TEXT_KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  // A device without a network fails every way at once: name the device.
  if (context.online === false && (kind === null || NETWORK_KINDS.has(kind))) {
    kind = "offline";
  }
  return { kind: kind ?? "unknown", detail, at };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [redacted]"],
  [/([?&#](?:token|access_token|auth|key|password|secret|code)=)[^&#\s"']*/gi, "$1[redacted]"],
  [/(\/\/)[^/@\s:]*:[^/@\s]*@/g, "$1[redacted]@"],
  [/tskey-[A-Za-z0-9_-]+/g, "tskey-[redacted]"],
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g, "[redacted hash]"],
  // A long base64/hex run is a credential far more often than anything a user needs.
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]"]
];

/**
 * Strip anything credential-shaped from text bound for the diagnostics report:
 * bearer and basic tokens, `?token=` query values, URL userinfo, Tailscale
 * keys, bcrypt hashes and long opaque runs. `known` adds exact values (the
 * live credential) to remove wherever they appear.
 */
export function redactSecrets(text: string, known: ReadonlyArray<string | null | undefined> = []): string {
  let out = text;
  for (const secret of known) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** The server URL with no credentials: no userinfo, query or fragment. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return redactSecrets(raw.split(/[?#]/)[0] ?? "");
  }
}
