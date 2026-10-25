/**
 * Agent host — the one error a box launch fails with (spec 2026-10-19 §8.5).
 *
 * Its message is what the chat shows: written for the user, naming the box
 * step that failed and what to do. Never a token, never a secret.
 */

export type BoxLaunchErrorCode =
  | "BOX_UNAVAILABLE"
  | "BOX_NOT_CONNECTED"
  | "BOX_SYSTEM_ACCOUNT"
  | "BOX_CLI_INSTALL_FAILED"
  | "BOX_CLI_VERSION"
  | "BOX_TOKEN_UNAVAILABLE"
  | "BOX_SYNC_FAILED"
  | "BOX_UNSUPPORTED";

export class BoxLaunchError extends Error {
  readonly code: BoxLaunchErrorCode;

  constructor(code: BoxLaunchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BoxLaunchError";
    this.code = code;
  }
}

/** One line of a failure detail, for a user-facing message (no stack, bounded). */
export function describeBoxFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
