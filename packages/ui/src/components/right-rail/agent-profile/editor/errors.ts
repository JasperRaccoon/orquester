/**
 * How an agent-profile refusal reads in the editor. The daemon answers
 * `{error: {code, message}}` (`AgentProfileErrorBody`); an `ApiError` carries
 * that body and its `serverMessage`. Duck-typed rather than `instanceof
 * ApiError`, so this stays importable (and testable) without the API client.
 */

export interface ProfileErrorInfo {
  /** The daemon's code (`ITEM_EXISTS`, `PROFILE_CONFLICT`, …), else `null` (a network failure). */
  code: string | null;
  /** The words to show: the daemon's message when it sent one. */
  message: string;
}

/**
 * Where the editor shows a refusal:
 * - `name` — beside the name field (`INVALID_NAME`);
 * - `exists` — the Replace / Keep both prompt (`ITEM_EXISTS`);
 * - `changed` — "Changed on disk" with Reload (`PROFILE_CONFLICT`);
 * - `general` — the banner above the Save bar.
 */
export type ProfileErrorPlacement = "name" | "exists" | "changed" | "general";

function codeOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === "object" && nested !== null) {
    const code = (nested as Record<string, unknown>).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return typeof record.code === "string" && record.code.length > 0 ? record.code : null;
}

export function profileError(error: unknown, fallback = "Something went wrong."): ProfileErrorInfo {
  if (typeof error === "object" && error !== null) {
    const record = error as { serverMessage?: unknown; message?: unknown; body?: unknown };
    const code = codeOf(record.body);
    const server = typeof record.serverMessage === "string" ? record.serverMessage.trim() : "";
    const own = typeof record.message === "string" ? record.message.trim() : "";
    return { code, message: server || own || fallback };
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return { code: null, message: error.trim() };
  }
  return { code: null, message: fallback };
}

export function profileErrorPlacement(info: ProfileErrorInfo): ProfileErrorPlacement {
  switch (info.code) {
    case "INVALID_NAME":
      return "name";
    case "ITEM_EXISTS":
      return "exists";
    case "PROFILE_CONFLICT":
      return "changed";
    default:
      return "general";
  }
}

/** A request the user or the editor abandoned — nothing to show. */
export function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
