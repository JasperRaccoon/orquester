/**
 * Errors of the box file features. A box project whose box cannot be reached
 * answers with a box error (`BOX_NOT_READY` 409 while it is not connected,
 * `BOX_DESTROYED` 410 once it is gone) instead of a file error, so the UI can
 * show the box's state rather than "cannot read file".
 */

import type { BoxErrorCode } from "@orquester/api";

export type BoxFsUnavailableCode = Extract<BoxErrorCode, "BOX_NOT_READY" | "BOX_DESTROYED">;

export class BoxFsUnavailableError extends Error {
  readonly status: 409 | 410;

  constructor(
    readonly code: BoxFsUnavailableCode,
    readonly boxId: string,
    message: string
  ) {
    super(message);
    this.name = "BoxFsUnavailableError";
    this.status = code === "BOX_DESTROYED" ? 410 : 409;
  }
}

/** Codes a box link uses when a request could not reach `orq-agent` (link down, closed mid-request). */
const LINK_DOWN_CODES = new Set(["BOX_NOT_CONNECTED", "BOX_DISCONNECTED", "BOX_LINK_CLOSED", "BOX_NOT_READY"]);

/** The errno-style code of an error thrown by node:fs or answered by `orq-agent` (`{ code }`), if any. */
export function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** `error` as a 409 when it says the box link went down mid-operation; null for any other error. */
export function linkDownError(error: unknown, boxId: string): BoxFsUnavailableError | null {
  if (error instanceof BoxFsUnavailableError) return error;
  const code = errnoOf(error);
  if (code === undefined || !LINK_DOWN_CODES.has(code)) return null;
  return new BoxFsUnavailableError("BOX_NOT_READY", boxId, "The project's box is not connected right now. Try again once it is back.");
}

/** An Error carrying an errno-style `code`, worded like node:fs's own (so file-route messages read the same). */
export function fsError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
