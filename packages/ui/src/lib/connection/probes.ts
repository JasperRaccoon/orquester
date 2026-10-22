/**
 * The live checks behind the connection diagnostics: can this device get an
 * Orquester `/health` answer over HTTP, and can it open the terminal
 * WebSocket? Each resolves to one {@link ProbeResult} and never rejects.
 */

import { checkHealth, classifyConnectionError } from "./failure";
import type { ProbeResult } from "./diagnosis.logic";

export const PROBE_TIMEOUT_MS = 6_000;

/** The slice of `WebSocket` the probe uses, so a test can hand in a fake. */
export interface ProbeSocket {
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** GET `/health` through the app's own transport (fetch, the desktop bridge, or the unix socket). */
export async function probeHttp(
  health: (signal: AbortSignal) => Promise<unknown>,
  options: { timeoutMs?: number; online?: boolean } = {}
): Promise<ProbeResult> {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const answer = checkHealth(await health(controller.signal));
    const protocol = answer.protocol !== undefined ? `, protocol ${answer.protocol}` : "";
    return { outcome: "ok", summary: `GET /health answered as Orquester${protocol}`, durationMs: now() - started };
  } catch (error) {
    const failure = classifyConnectionError(error, { online: options.online });
    const status = failure.status !== undefined ? ` HTTP ${failure.status},` : "";
    return {
      outcome: "failed",
      summary: `GET /health failed:${status} ${failure.kind} — ${failure.detail}`,
      durationMs: now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open the terminal WebSocket once and close it again. `url` carries the
 * credential (as the real channel does); it never appears in the result.
 */
export function probeWebSocket(
  url: string | null,
  open: (url: string) => ProbeSocket,
  options: { timeoutMs?: number } = {}
): Promise<ProbeResult> {
  if (url === null) {
    return Promise.resolve({ outcome: "skipped", summary: "this connection does not use WebSockets (local socket)" });
  }
  const started = now();
  return new Promise((resolve) => {
    let socket: ProbeSocket | null = null;
    let done = false;
    const finish = (result: Omit<ProbeResult, "durationMs">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket) {
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      resolve({ ...result, durationMs: now() - started });
    };
    const timer = setTimeout(
      () => finish({ outcome: "failed", summary: "the WebSocket did not open in time" }),
      options.timeoutMs ?? PROBE_TIMEOUT_MS
    );
    try {
      socket = open(url);
    } catch (error) {
      finish({ outcome: "failed", summary: `the WebSocket could not be created: ${classifyConnectionError(error).detail}` });
      return;
    }
    socket.onopen = () => finish({ outcome: "ok", summary: "the WebSocket opened" });
    socket.onclose = (event) =>
      finish({ outcome: "failed", summary: `the WebSocket closed before opening (code ${event.code})` });
    // An error is always followed by a close, which carries the code.
    socket.onerror = () => undefined;
  });
}
