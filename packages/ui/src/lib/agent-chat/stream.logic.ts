/**
 * Agent chat — the pure parts of the §6.3 stream client.
 *
 * No React, no transport: line framing, frame validation, the reconnect
 * schedule and the resume-vs-resync decision live here so they can be tested
 * without a socket. `transport.ts` wires them onto `Transporter.openStream`.
 *
 * Ported from T3 Code (MIT): `packages/client-runtime/src/state/threads.ts`
 * (the cursor rules) — the NDJSON framing itself is ours, because T3 rides an
 * Effect-RPC WebSocket and we ride a chunked HTTP body (§6).
 */

import {
  AGENT_CHAT_DAEMON_HEARTBEAT_MS,
  AGENT_CHAT_HEARTBEAT_MS,
  AGENT_CHAT_ERROR_CODES,
  type AgentChatStreamErrorLine,
  type AgentChatStreamFrame
} from "@orquester/api/agent-chat";

import { backoffDelayMs } from "../connection/backoff";

/**
 * Incremental NDJSON line splitter.
 *
 * The daemon writes `\n`-terminated JSON plus bare `:hb` comment lines
 * (§6.3), and a chunk boundary can land anywhere — including inside a
 * multi-byte character, which is why the caller decodes with
 * `{ stream: true }` before pushing text in here.
 */
export class NdjsonLineBuffer {
  private buffer = "";

  /** Feed a decoded chunk; returns every complete line it closed. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      lines.push(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
    return lines;
  }

  reset(): void {
    this.buffer = "";
  }
}

/** What one NDJSON line decoded to. A comment line is a heartbeat, not a frame. */
export type StreamLine =
  | { kind: "frame"; frame: AgentChatStreamFrame }
  | { kind: "heartbeat" }
  | { kind: "blank" }
  /** The host could not serve the stream (`AgentChatStreamErrorLine`); it closes after it. */
  | { kind: "error"; error: AgentChatStreamErrorLine }
  | { kind: "malformed"; line: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate a decoded line into a stream frame.
 *
 * Deliberately structural rather than schema-driven: a newer host may add
 * fields to a `DomainEvent`, and an older client must still apply the arms it
 * knows (§5.1's rollback boundary). We check only what the reducer indexes on.
 */
export function parseStreamLine(line: string): StreamLine {
  if (line.length === 0 || line.trim().length === 0) {
    return { kind: "blank" };
  }
  // A comment line is anything starting with `:` — `:hb` today (§6.3).
  if (line.startsWith(":")) {
    return { kind: "heartbeat" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return { kind: "malformed", line };
  }
  if (!isRecord(decoded)) {
    return { kind: "malformed", line };
  }
  switch (decoded.kind) {
    case "snapshot": {
      const thread = decoded.thread;
      if (!isRecord(thread) || typeof thread.seq !== "number" || !Array.isArray(thread.items)) {
        return { kind: "malformed", line };
      }
      return { kind: "frame", frame: decoded as unknown as AgentChatStreamFrame };
    }
    case "event": {
      const event = decoded.event;
      if (
        typeof decoded.seq !== "number" ||
        !isRecord(event) ||
        typeof event.type !== "string" ||
        typeof event.seq !== "number"
      ) {
        return { kind: "malformed", line };
      }
      return { kind: "frame", frame: decoded as unknown as AgentChatStreamFrame };
    }
    case "synchronized": {
      if (typeof decoded.hostInstanceId !== "string") {
        return { kind: "malformed", line };
      }
      return { kind: "frame", frame: decoded as unknown as AgentChatStreamFrame };
    }
    case "history-import": {
      const progress = decoded.progress;
      if (
        !isRecord(progress) ||
        (progress.phase !== "reading" && progress.phase !== "importing" && progress.phase !== "done") ||
        typeof progress.done !== "number" ||
        (progress.total !== null && typeof progress.total !== "number")
      ) {
        return { kind: "malformed", line };
      }
      return { kind: "frame", frame: decoded as unknown as AgentChatStreamFrame };
    }
    case "error": {
      if (typeof decoded.message !== "string") {
        return { kind: "malformed", line };
      }
      const code =
        typeof decoded.code === "string" && (AGENT_CHAT_ERROR_CODES as readonly string[]).includes(decoded.code)
          ? (decoded.code as AgentChatStreamErrorLine["code"])
          : undefined;
      return { kind: "error", error: { kind: "error", ...(code ? { code } : {}), message: decoded.message } };
    }
    default:
      return { kind: "malformed", line };
  }
}

// ---------------------------------------------------------------------------
// Reconnect schedule
// ---------------------------------------------------------------------------

/** Attempt 0 is the first retry after a clean-ish drop. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;

/**
 * Exponential backoff with full jitter: the app's one reconnect policy
 * (`lib/connection/backoff.ts`), with a short cap because a chat tab is
 * something the user is looking at.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  return backoffDelayMs(attempt, { baseMs: RECONNECT_BASE_MS, maxMs: RECONNECT_MAX_MS }, random);
}

/**
 * The stream is considered dead when no byte — not even a `:hb` — has arrived
 * for this long. The host heartbeats every {@link AGENT_CHAT_HEARTBEAT_MS};
 * missing three in a row is a wedged proxy, not a quiet thread.
 */
export const STREAM_STALL_TIMEOUT_MS = AGENT_CHAT_HEARTBEAT_MS * 3 + 5_000;

/**
 * The same window against the daemon's faster heartbeat
 * ({@link AGENT_CHAT_DAEMON_HEARTBEAT_MS}): three missed beats and a margin.
 * A mobile link that died without a FIN is noticed in 20 s instead of 50 s.
 */
export const LIVE_STREAM_STALL_TIMEOUT_MS = AGENT_CHAT_DAEMON_HEARTBEAT_MS * 3 + 5_000;

/**
 * Two heartbeats this far apart prove the daemon's cadence. Closer than the
 * floor is one chunk carrying two beats (a proxy that held them), which
 * proves nothing; the host's own beats are 15 s apart, far past the ceiling.
 */
const FAST_HEARTBEAT_MIN_GAP_MS = 1_000;
const FAST_HEARTBEAT_MAX_GAP_MS = AGENT_CHAT_DAEMON_HEARTBEAT_MS * 2 - 1_000;

export function isFastHeartbeatGap(gapMs: number): boolean {
  return gapMs >= FAST_HEARTBEAT_MIN_GAP_MS && gapMs <= FAST_HEARTBEAT_MAX_GAP_MS;
}

/** What one connection has shown about itself, for {@link stallTimeoutFor}. */
export interface StreamLiveness {
  /** Its heartbeats came at the daemon's cadence ({@link isFastHeartbeatGap}). */
  fastHeartbeat: boolean;
  /** It reached `synchronized`: a reconnect now resumes by cursor, cheaply. */
  synchronized: boolean;
}

/**
 * How long a connection may stay silent before it is dropped and resumed.
 *
 * The short window applies only once the stream is both proven to beat fast
 * and live: before `synchronized` the connection may be carrying a snapshot,
 * and cutting it over a brief outage TCP would have ridden out would throw
 * away everything received and start the snapshot over.
 */
export function stallTimeoutFor(liveness: StreamLiveness): number {
  return liveness.fastHeartbeat && liveness.synchronized
    ? LIVE_STREAM_STALL_TIMEOUT_MS
    : STREAM_STALL_TIMEOUT_MS;
}

/**
 * How long a connection may have been silent when the page wakes (visible
 * again, back online) before it is taken for dead and resumed at once: a
 * frozen tab's timers fire late, and a mobile OS drops a background socket
 * without a word. Two missed fast beats for a live, fast stream; otherwise
 * the stall window itself, which a timer that ran would already have hit.
 */
export function wakeStaleAfterMs(liveness: StreamLiveness): number {
  return liveness.fastHeartbeat && liveness.synchronized
    ? AGENT_CHAT_DAEMON_HEARTBEAT_MS * 2 + 2_000
    : STREAM_STALL_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Cursor rules (§6.3, §6.6)
// ---------------------------------------------------------------------------

/**
 * What a reconnect should ask for.
 *
 * A **changed `hostInstanceId` is a resync, not a resume** (§6.3, §8): the new
 * host's sequence space is its own, so resuming by our cursor could silently
 * skip or replay. `after: undefined` makes the host send a snapshot.
 */
export function resumeCursorFor(input: {
  lastSeq: number;
  knownHostInstanceId: string | null;
  observedHostInstanceId: string | null;
}): number | undefined {
  if (
    input.knownHostInstanceId !== null &&
    input.observedHostInstanceId !== null &&
    input.knownHostInstanceId !== input.observedHostInstanceId
  ) {
    return undefined;
  }
  return input.lastSeq > 0 ? input.lastSeq : undefined;
}
