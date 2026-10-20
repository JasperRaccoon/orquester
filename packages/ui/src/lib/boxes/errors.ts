/** The daemon's error text for a failed boxes request (`ApiError.serverMessage`), else the error's own, else `fallback`. */
export function boxesErrorText(err: unknown, fallback = "The request failed."): string {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : fallback;
}
