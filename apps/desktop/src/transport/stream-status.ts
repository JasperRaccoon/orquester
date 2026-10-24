/**
 * A bridge stream ended. `status` (a bridge value, so checked) is the error status the daemon
 * answered instead of a stream: an integer of 400 or more is reported to `onError` first — a 401
 * tells a chat stream to stop retrying a revoked token. Anything else is a plain end: a clean one,
 * or a stream the daemon cut (a revocation, a restart).
 */
export function endBridgeStream(status: unknown, handlers: { onEnd(): void; onError?(error: unknown): void }): void {
  if (typeof status === "number" && Number.isInteger(status) && status >= 400) {
    handlers.onError?.(Object.assign(new Error(`The stream failed with status ${status}.`), { status }));
  }
  handlers.onEnd();
}
