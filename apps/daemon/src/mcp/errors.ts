import type { DaemonResponse } from "./daemon-api.ts";

/** Every tool failure. `code` is a daemon code passed through or an MCP-level one (spec §4.5). */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

const STATUS_CODES: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "COMMAND_REJECTED", 413: "UPLOAD_TOO_LARGE", 429: "TOO_MANY_ATTEMPTS", 502: "HOST_UNAVAILABLE", 503: "HOST_UNAVAILABLE" };

/** Map a failed daemon response to a ToolError: chat envelope, flat `{code,message}`, `{error: string}`, else by status. */
export function daemonError(res: DaemonResponse, fallback?: { code: string; message: string }): ToolError {
  const body = res.body as Record<string, unknown> | null;
  if (body && typeof body === "object") {
    const env = body.error;
    if (env && typeof env === "object") {
      const e = env as { code?: unknown; message?: unknown; detail?: unknown };
      if (typeof e.code === "string") return new ToolError(e.code, typeof e.message === "string" ? e.message : e.code, e.detail);
    }
    if (typeof body.code === "string") return new ToolError(body.code, typeof body.message === "string" ? body.message : body.code, body.detail);
    if (typeof env === "string") return new ToolError(STATUS_CODES[res.status] ?? "INVALID_ARGUMENT", env);
    if (typeof body.message === "string") return new ToolError(STATUS_CODES[res.status] ?? "INTERNAL", body.message);
  }
  if (fallback) return new ToolError(fallback.code, fallback.message);
  return new ToolError(STATUS_CODES[res.status] ?? "INTERNAL", `The daemon answered ${res.status}.`);
}

/** The body of a successful response, or a ToolError for a failed one. */
export function expectOk<T = unknown>(res: DaemonResponse, what: string): T {
  if (res.status >= 400) throw daemonError(res, undefined);
  void what;
  return res.body as T;
}
