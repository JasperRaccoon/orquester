/**
 * The words a saved-prompt failure is shown with: the daemon's own message
 * when it sent one (an `ApiError`'s `serverMessage` — "Title is required",
 * git's stderr), else the error's message. Duck-typed rather than an
 * `instanceof ApiError`, so this stays importable without the API client.
 */
export function savedPromptErrorText(error: unknown, fallback = "Something went wrong."): string {
  if (typeof error === "object" && error !== null) {
    const server = (error as { serverMessage?: unknown }).serverMessage;
    if (typeof server === "string" && server.trim().length > 0) return server.trim();
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return fallback;
}

/** The HTTP status an `ApiError` carries, else `null`. */
export function savedPromptErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}
