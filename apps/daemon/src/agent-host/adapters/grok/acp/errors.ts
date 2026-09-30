/**
 * ACP client — the JSON-RPC error taxonomy (spec §4.5 Grok, §10).
 *
 * Ported from T3 Code (MIT): `packages/effect-acp/src/errors.ts`, translated
 * from Effect's tagged errors into plain classes.
 *
 * Two rules the captures make load-bearing
 * (`apps/daemon/test/fixtures/grok/13-errors-and-rpcs.ndjson`):
 *
 * - **Never classify by code alone.** Grok answers `-32602 "Invalid params"`
 *   for a bad model id AND for an unknown session id, and `-32603` for a
 *   missing transcript file. The `data` field is what distinguishes them, and
 *   it is sometimes a string and sometimes an object.
 * - **`-32601 Method not found` carries no `data`** and never names the
 *   offending method, so the caller has to remember what it sent.
 */

/** The JSON-RPC 2.0 reserved codes, plus the one vendor code T3 defines. */
export const ACP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /**
   * ACP's own "authentication required" (`ErrorCode` -32000 in the ACP
   * schema). Never produced by CLI 1.0.34 in any capture — a refused login
   * could not be recorded without logging the account out (Grok fixtures
   * README observation on error shapes) — kept so a not-logged-in failure the
   * CLI reports in the protocol's own words is recognised as one.
   */
  authRequired: -32000,
  /**
   * T3's typed rate-limit code, raised from a `prompt_complete` whose
   * `stopReason` is `rate_limit`. Never produced by CLI 1.0.34 in any capture
   * — kept because the adapter must still classify it if a later release
   * starts sending it.
   */
  rateLimit: -32003
} as const;

/** The wire shape of a JSON-RPC error object. */
export interface AcpErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** An error the peer answered a request with. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  /** The method we called, which the agent's message never names. */
  readonly method: string;
  /**
   * The peer's own `message`, undecorated. `Error.message` additionally
   * carries the method and the data for a human; re-sending THAT over the wire
   * produced `"boom: Invalid params (bad)"` plus a duplicated `data` (R4 #15).
   */
  readonly wireMessage: string;

  constructor(method: string, payload: AcpErrorPayload) {
    super(`${method}: ${payload.message}${describeData(payload.data)}`);
    this.name = "AcpRpcError";
    this.code = payload.code;
    this.data = payload.data;
    this.method = method;
    this.wireMessage = payload.message;
  }

  /** The payload, for re-sending an error the other way. */
  toPayload(): AcpErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.wireMessage }
      : { code: this.code, message: this.wireMessage, data: this.data };
  }
}

/** The transport died — the child exited, or the pipe closed. */
export class AcpTransportClosedError extends Error {
  readonly detail: string | undefined;

  constructor(reason: string, detail?: string) {
    super(reason);
    this.name = "AcpTransportClosedError";
    this.detail = detail;
  }
}

/** A line arrived that is not a JSON-RPC frame. Surfaced, never swallowed. */
export class AcpProtocolError extends Error {
  readonly line: string;

  constructor(message: string, line: string) {
    super(message);
    this.name = "AcpProtocolError";
    // Bounded: a malformed line can be a whole file's worth of bytes.
    this.line = line.length > 512 ? `${line.slice(0, 512)}…` : line;
  }
}

/** The §4.2 `runtime.error` class for a failure that reached the adapter. */
export function classifyAcpError(
  error: unknown
): "provider_error" | "transport_error" | "validation_error" | "unknown" {
  if (error instanceof AcpTransportClosedError || error instanceof AcpProtocolError) {
    return "transport_error";
  }
  if (error instanceof AcpRpcError) {
    switch (error.code) {
      case ACP_ERROR_CODES.invalidParams:
      case ACP_ERROR_CODES.invalidRequest:
        return "validation_error";
      default:
        return "provider_error";
    }
  }
  return "unknown";
}

/**
 * The account failure an RPC error names (workflows §5.4). By its CODE first — T3's typed
 * rate-limit code is a usage limit, ACP's authentication-required code a refused login — and,
 * since CLI 1.0.34 produces neither code in any capture, by the CLI's own wording of a refused
 * login or an exhausted quota on the error's message or data ({@link grokAuthFailureText},
 * {@link grokUsageLimitText}). Only an RPC error is read this way — the answer to OUR request
 * (`session/prompt`, `session/new`), never stderr, where a failing MCP server prints its own
 * `AuthRequired` / 401 lines (fixtures README observations 30, 46) that say nothing about the
 * account. Anything else names none.
 */
export function acpFailureReason(error: unknown): "usage_limit" | "auth" | undefined {
  if (!(error instanceof AcpRpcError)) {
    return undefined;
  }
  switch (error.code) {
    case ACP_ERROR_CODES.rateLimit:
      return "usage_limit";
    case ACP_ERROR_CODES.authRequired:
      return "auth";
    default: {
      const text = `${error.wireMessage} ${dataText(error.data)}`;
      if (grokAuthFailureText(text)) return "auth";
      if (grokUsageLimitText(text)) return "usage_limit";
      return undefined;
    }
  }
}

/**
 * The Grok CLI's words for a login it cannot use. Not captured (a refused login could not be
 * recorded without logging the account out — fixtures README "Error shapes"); what IS known is the
 * CLI's own vocabulary: `grok models` prints "You are not authenticated." with no login (fixture
 * README observation 35), the probe's advice is `grok login`, the binary names the
 * `authentication_failed` stop reason (observation 50), and the xAI OAuth server answers a revoked
 * or expired refresh with `invalid_grant`.
 */
function grokAuthFailureText(text: string): boolean {
  return (
    /\bnot (?:authenticated|logged[ -]?in|signed[ -]?in)\b/i.test(text) ||
    /\bauthentication[ _-]?(?:failed|required|error)\b/i.test(text) ||
    /\bunauthori[sz]ed\b/i.test(text) ||
    /\binvalid_grant\b/i.test(text) ||
    /\b(?:access|refresh|oauth|auth) token (?:has )?(?:expired|been revoked|is (?:invalid|expired|revoked))\b/i.test(text) ||
    /\brun [`'"]?grok login\b/i.test(text)
  );
}

/**
 * The words of an exhausted quota on an RPC error: xAI's `…-usage-exhausted` 429 (the model
 * proxy's accepted risk, AGENTS.md), a bare 429 / "too many requests", or a rate / usage limit.
 */
function grokUsageLimitText(text: string): boolean {
  return (
    /usage[-_ ]exhausted/i.test(text) ||
    /\b429\b/.test(text) ||
    /\btoo many requests\b/i.test(text) ||
    /\b(?:rate|usage)[-_ ]limit(?:ed| reached| exceeded)?\b/i.test(text) ||
    /\bquota (?:exceeded|exhausted)\b/i.test(text)
  );
}

function dataText(data: unknown): string {
  if (typeof data === "string") {
    return data.toLowerCase();
  }
  if (data !== null && typeof data === "object") {
    try {
      return JSON.stringify(data).toLowerCase();
    } catch {
      return "";
    }
  }
  return "";
}

function describeData(data: unknown): string {
  if (data === undefined || data === null) {
    return "";
  }
  if (typeof data === "string") {
    return ` (${data})`;
  }
  try {
    return ` (${JSON.stringify(data)})`;
  } catch {
    return "";
  }
}
