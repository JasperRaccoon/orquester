/**
 * Reading an agent-profile refusal. The daemon answers every one as
 * `{error: {code, message}}` (the workflow routes' shape); `ApiClient` throws
 * it as an `ApiError` whose `body` is that object. Duck-typed rather than an
 * `instanceof ApiError`, so the store stays importable without the client.
 */

function errorObject(error: unknown): Record<string, unknown> | null {
  if (typeof error !== "object" || error === null) return null;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const inner = (body as Record<string, unknown>).error;
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  // A flat `{code, message}` body, as some routes of other versions send.
  return body as Record<string, unknown>;
}

/** The daemon's error code (`body.error.code`, e.g. `PROFILE_CONFLICT`), else `null`. */
export function agentProfileErrorCode(error: unknown): string | null {
  const code = errorObject(error)?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** The HTTP status an `ApiError` carries, else `null`. */
export function agentProfileErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * The words a failure is shown with: the daemon's own message
 * (`body.error.message`), else the error's `serverMessage` or `message`.
 */
export function agentProfileErrorText(error: unknown, fallback = "Something went wrong."): string {
  const nested = errorObject(error)?.message;
  if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
  if (typeof error === "object" && error !== null) {
    const server = (error as { serverMessage?: unknown }).serverMessage;
    if (typeof server === "string" && server.trim().length > 0) return server.trim();
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return fallback;
}
