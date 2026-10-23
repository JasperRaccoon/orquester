import type { BoxErrorCode } from "@orquester/api";

/** A refusal the box routes answer verbatim: `status` with `{ code, message }`. Messages never quote a secret. */
export class BoxError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 502 | 503,
    readonly code: BoxErrorCode | "BOXES_UNAVAILABLE",
    message: string,
    /** Shell commands that fix the refusal, for the client to offer to copy (never a secret). */
    readonly commands?: readonly string[]
  ) {
    super(message);
    this.name = "BoxError";
  }
}

/** One line from an unknown thrown value, for a `stateReason` or a setup step message. */
export function errorLine(error: unknown, fallback = "Unknown error"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const line = message.split("\n").find((part) => part.trim().length > 0)?.trim() ?? fallback;
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}
