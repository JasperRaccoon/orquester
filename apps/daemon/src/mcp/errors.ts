import type { DaemonResponse } from "./daemon-api.ts";

/** Every tool failure. `code` is a daemon code passed through or an MCP-level one (spec §4.5). */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

const STATUS_CODES: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "COMMAND_REJECTED", 413: "UPLOAD_TOO_LARGE", 429: "TOO_MANY_ATTEMPTS", 502: "HOST_UNAVAILABLE", 503: "HOST_UNAVAILABLE" };

/** The code a bare status stands for: the table, else INVALID_ARGUMENT for a 4xx and INTERNAL for the rest. */
function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 400 && status < 500 ? "INVALID_ARGUMENT" : "INTERNAL");
}

/**
 * Fastify's serialisation of an error no route caught: `{statusCode, code?, error: "<status text>", message}`.
 * No daemon route sends that shape on purpose, so its `code` is an errno such as `ENOENT`, not a daemon code.
 */
function isUncaughtError(body: Record<string, unknown>): boolean {
  return typeof body.statusCode === "number" && typeof body.error === "string";
}

/**
 * Map a failed daemon response to a ToolError (spec §4.5). A deliberate code passes through: the
 * chat envelope `{error: {code, message, detail?}}` or a route's flat `{code, message}`. A 5xx without
 * one is a crash or an unreachable service whose text can carry a host path or a stack, so it is
 * never echoed: it becomes INTERNAL (HOST_UNAVAILABLE for 502/503). A 4xx `{error: "…"}` or
 * `{message: "…"}` is the route's own validation text and is kept. `fallback` replaces the
 * status-derived error when the body names no code; it never echoes the body either.
 */
export function daemonError(res: DaemonResponse, fallback?: { code: string; message: string }): ToolError {
  const body = res.body !== null && typeof res.body === "object" ? (res.body as Record<string, unknown>) : null;
  if (body) {
    const env = body.error;
    if (env && typeof env === "object") {
      const e = env as { code?: unknown; message?: unknown; detail?: unknown };
      if (typeof e.code === "string") return new ToolError(e.code, typeof e.message === "string" ? e.message : e.code, e.detail);
    }
    if (typeof body.code === "string" && !(res.status >= 500 && isUncaughtError(body))) {
      return new ToolError(body.code, typeof body.message === "string" ? body.message : body.code, body.detail);
    }
    if (res.status < 500) {
      if (typeof env === "string") return new ToolError(codeForStatus(res.status), env);
      if (typeof body.message === "string") return new ToolError(codeForStatus(res.status), body.message);
    }
  }
  if (fallback) return new ToolError(fallback.code, fallback.message);
  const code = codeForStatus(res.status);
  if (code === "INTERNAL") return new ToolError(code, "The daemon failed handling the request.");
  if (code === "HOST_UNAVAILABLE") return new ToolError(code, `The daemon answered ${res.status}: the service behind it is unavailable. Try again shortly.`);
  return new ToolError(code, `The daemon answered ${res.status}.`);
}

/** The body of a successful response, or a ToolError for a failed one. */
export function expectOk<T = unknown>(res: DaemonResponse, what: string): T {
  if (res.status >= 400) throw daemonError(res, undefined);
  void what;
  return res.body as T;
}
