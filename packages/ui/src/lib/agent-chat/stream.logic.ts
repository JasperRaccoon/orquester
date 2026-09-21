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
  AGENT_CHAT_HEARTBEAT_MS,
  type AgentChatStreamFrame,
  type DomainEvent
} from "@orquester/api/agent-chat";

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

  /** Whatever is left unterminated. Dropped on close: a partial line is not a frame. */
  rest(): string {
    return this.buffer;
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
    default:
      return { kind: "malformed", line };
  }
}

/** The domain event carried by an `event` frame, for callers that narrowed already. */
export function frameEvent(frame: AgentChatStreamFrame): DomainEvent | null {
  return frame.kind === "event" ? frame.event : null;
}

// ---------------------------------------------------------------------------
// Reconnect schedule
// ---------------------------------------------------------------------------

/** Full jitter, capped. Attempt 0 is the first retry after a clean-ish drop. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;

/**
 * Exponential backoff with full jitter. `random` is injected so the test can
 * pin it; production passes `Math.random`.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(capped * (0.5 + random() * 0.5));
}

/**
 * The stream is considered dead when no byte — not even a `:hb` — has arrived
 * for this long. The host heartbeats every {@link AGENT_CHAT_HEARTBEAT_MS};
 * missing three in a row is a wedged proxy, not a quiet thread.
 */
export const STREAM_STALL_TIMEOUT_MS = AGENT_CHAT_HEARTBEAT_MS * 3 + 5_000;

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

/**
 * Whether a frame must be applied.
 *
 * Events at or below the cursor are dropped, which is what makes the
 * overlapping snapshot / replay / live windows safe (§6.6). A `snapshot`
 * always applies — it **replaces** loaded history rather than merging into it,
 * because a turn reverted while this client was disconnected has no event left
 * to remove it.
 */
export function shouldApplyFrame(frame: AgentChatStreamFrame, lastSeq: number): boolean {
  if (frame.kind !== "event") {
    return true;
  }
  return frame.seq > lastSeq;
}
