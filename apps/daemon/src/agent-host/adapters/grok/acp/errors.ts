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
   * T3's typed rate-limit code, raised from a `prompt_complete` whose
   * `stopReason` is `rate_limit`. Never produced by CLI 1.0.34 in any capture
   * — kept because the adapter must still classify it if a later release
   * starts sending it.
   */
  rateLimit: -32003
} as const;

export type AcpErrorCode = (typeof ACP_ERROR_CODES)[keyof typeof ACP_ERROR_CODES];

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

  constructor(method: string, payload: AcpErrorPayload) {
    super(`${method}: ${payload.message}${describeData(payload.data)}`);
    this.name = "AcpRpcError";
    this.code = payload.code;
    this.data = payload.data;
    this.method = method;
  }

  /** The payload, for re-sending an error the other way. */
  toPayload(): AcpErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
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

/**
 * `-32602` with `data` naming an unknown session. The session is gone, so the
 * caller must restart rather than retry — the same verdict for both spellings
 * the CLI produces (`"unknown session id"` on `session/prompt`, `FS_NOT_FOUND`
 * on `session/load`).
 */
export function isUnknownSessionError(error: unknown): boolean {
  if (!(error instanceof AcpRpcError)) {
    return false;
  }
  if (error.code === ACP_ERROR_CODES.invalidParams && dataText(error.data).includes("unknown session")) {
    return true;
  }
  return (
    error.code === ACP_ERROR_CODES.internalError &&
    (dataText(error.data).includes("FS_NOT_FOUND") || /path not found/i.test(error.message))
  );
}

/** `-32602` with `data: "unknown model id"` — including the `grok-build` slug. */
export function isUnknownModelError(error: unknown): boolean {
  return (
    error instanceof AcpRpcError &&
    error.code === ACP_ERROR_CODES.invalidParams &&
    dataText(error.data).includes("unknown model")
  );
}

/** `-32601`, the one code that is safe to classify on alone (§10). */
export function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof AcpRpcError && error.code === ACP_ERROR_CODES.methodNotFound;
}

/** The §4.2 `runtime.error` class for a failure that reached the adapter. */
export function classifyAcpError(
  error: unknown
): "provider_error" | "transport_error" | "validation_error" | "unknown" {
  if (error instanceof AcpTransportClosedError) {
    return "transport_error";
  }
  if (error instanceof AcpProtocolError) {
    return "transport_error";
  }
  if (error instanceof AcpRpcError) {
    switch (error.code) {
      case ACP_ERROR_CODES.invalidParams:
      case ACP_ERROR_CODES.invalidRequest:
        return "validation_error";
      case ACP_ERROR_CODES.methodNotFound:
      case ACP_ERROR_CODES.internalError:
      case ACP_ERROR_CODES.rateLimit:
        return "provider_error";
      default:
        return "provider_error";
    }
  }
  return "unknown";
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
