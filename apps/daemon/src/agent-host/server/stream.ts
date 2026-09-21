/**
 * Agent host — the §6.3 thread event stream.
 *
 * Ported from T3 Code (MIT): `apps/server/src/ws.ts:2150-2300`
 * (`subscribeThread`: attach the live tail **before** reading, snapshot-or-
 * replay decided server-side, the `synchronized` marker offered into the same
 * buffer), `apps/server/src/orchestration/LiveStreamBudget.ts` (sizes measured
 * once via a `WeakMap` because events are shared across subscriptions; overflow
 * closes the stream with "resume from the last received sequence") and
 * `apps/server/src/orchestration/ThreadLiveEventCoalescer.ts:18-19,56-94,189-193`
 * (the 50 ms window, the 512-row pending cap, latest-per-stable-id, and a
 * non-update frame flushing the run immediately).
 *
 * Differs from T3 in its carrier only: one chunked NDJSON HTTP response per
 * open thread instead of an Effect-RPC WebSocket, so the budget's charge is
 * released on the socket's **drain** rather than on an RPC ACK.
 */

import type { ServerResponse } from "node:http";

import {
  AGENT_CHAT_HEARTBEAT_LINE,
  AGENT_CHAT_HEARTBEAT_MS,
  AGENT_CHAT_STREAM_BUFFER_LIMIT_BYTES,
  type AgentChatStreamFrame,
  type DomainEvent
} from "@orquester/api/agent-chat";

/** *T3: `ThreadLiveEventCoalescer.ts:18-19`.* */
export const COALESCE_WINDOW_MS = 50;
export const MAX_PENDING_UPDATES = 512;

const sizeCache = new WeakMap<object, number>();

/**
 * Measured once and cached by identity, since one event object is shared by
 * every stream watching that thread (§6.3).
 */
export function serializedSize(value: object): number {
  const cached = sizeCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const bytes = Buffer.byteLength(JSON.stringify(value));
  sizeCache.set(value, bytes);
  return bytes;
}

function isToolUpdated(event: DomainEvent): boolean {
  return (
    event.type === "thread.activity-appended" &&
    event.payload.activity.activityKind === "tool.updated"
  );
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A tool call's stable id. Anonymous calls pass through: labels are not unique
 * when tools execute in parallel.
 */
function stableToolCallIdentity(event: DomainEvent): string | null {
  if (event.type !== "thread.activity-appended") return null;
  const activity = event.payload.activity;
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const data =
    typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  return (
    asTrimmedString(record.toolUseId) ??
    asTrimmedString(record.toolCallId) ??
    asTrimmedString(data?.toolUseId) ??
    asTrimmedString(data?.toolCallId)
  );
}

/**
 * Retain only the latest in-flight update per stable tool-call id in one run.
 * Survivors keep sequence order.
 *
 * *T3: `ThreadLiveEventCoalescer.ts:56-94`.*
 */
export function coalesceToolUpdates(events: readonly DomainEvent[]): DomainEvent[] {
  const survivors: DomainEvent[] = [];
  let pending: DomainEvent[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const seen = new Set<string>();
    const latest: DomainEvent[] = [];
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const event = pending[index]!;
      const identity = stableToolCallIdentity(event);
      const turnId =
        event.type === "thread.activity-appended" ? (event.payload.activity.turnId ?? "") : "";
      const key = identity ? `${turnId}\u0000${identity}` : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      latest.push(event);
    }
    latest.reverse();
    survivors.push(...latest);
    pending = [];
  };

  for (const event of events) {
    if (isToolUpdated(event)) {
      pending.push(event);
      continue;
    }
    // A non-update event closes the run immediately, keeping the boundary
    // after the final update of that run.
    flush();
    survivors.push(event);
  }
  flush();
  return survivors;
}

export interface ThreadStreamOptions {
  response: ServerResponse;
  hostInstanceId: string;
  /** Wired to the orchestrator's per-thread subscription. */
  subscribe(listener: (events: DomainEvent[]) => void): Promise<() => void>;
  /**
   * Reads the snapshot or the replay. Runs **after** the live tail is attached
   * — attaching afterwards loses every event published while the read is in
   * flight (§6.3).
   */
  read(): Promise<AgentChatStreamFrame[]>;
  heartbeatMs?: number;
  coalesceWindowMs?: number;
  bufferLimitBytes?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onClose?: (reason: "client" | "budget" | "host") => void;
}

export interface ThreadStream {
  /** Attach the live tail, then read, then go live. Resolves when live. */
  start(): Promise<void>;
  /** Close from the host side (shutdown). */
  close(reason?: "client" | "budget" | "host"): void;
  readonly closed: boolean;
}

/**
 * One open `GET …/events` response.
 *
 * Order is fixed and load-bearing: subscribe → buffer → read → emit the read's
 * frames → push `synchronized` **through the same buffer** → drain the buffer.
 * Writing `synchronized` straight to the socket would tell the client it is
 * caught up while frames are still queued.
 */
export function createThreadStream(options: ThreadStreamOptions): ThreadStream {
  const {
    response,
    hostInstanceId,
    subscribe,
    read,
    heartbeatMs = AGENT_CHAT_HEARTBEAT_MS,
    coalesceWindowMs = COALESCE_WINDOW_MS,
    bufferLimitBytes = AGENT_CHAT_STREAM_BUFFER_LIMIT_BYTES
  } = options;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let live = false;
  /** Events observed while the read was in flight, not yet emitted. */
  const preReadBuffer: DomainEvent[] = [];
  /** Tool updates waiting on the 50 ms coalescing window. */
  let pendingUpdates: DomainEvent[] = [];
  let windowHandle: unknown = null;
  let heartbeatHandle: unknown = null;
  /** Bytes handed to the socket that have not drained yet (§6.3). */
  let chargedBytes = 0;

  const close = (reason: "client" | "budget" | "host" = "host"): void => {
    if (closed) return;
    closed = true;
    if (windowHandle !== null) clearTimer(windowHandle);
    if (heartbeatHandle !== null) clearTimer(heartbeatHandle);
    windowHandle = null;
    heartbeatHandle = null;
    unsubscribe?.();
    unsubscribe = null;
    try {
      response.end();
    } catch {
      // The socket may already be gone.
    }
    options.onClose?.(reason);
  };

  const writeLine = (line: string): void => {
    if (closed) return;
    const bytes = Buffer.byteLength(line) + 1;
    chargedBytes += bytes;
    if (chargedBytes > bufferLimitBytes) {
      // A slow client is cut and told to resume by cursor; it is never allowed
      // to grow host memory.
      try {
        response.write(
          `${JSON.stringify({
            kind: "error",
            message: "The live event buffer is full. Resume from the last received sequence."
          })}\n`
        );
      } catch {
        // Nothing more to say on a socket we are closing anyway.
      }
      close("budget");
      return;
    }
    const flushed = response.write(`${line}\n`);
    if (flushed) {
      // The charge is released only when the bytes have actually left the
      // process — for a chunked response, when `write()` has drained.
      chargedBytes -= bytes;
      return;
    }
    response.once("drain", () => {
      chargedBytes = Math.max(0, chargedBytes - bytes);
    });
  };

  const writeFrame = (frame: AgentChatStreamFrame): void => {
    writeLine(JSON.stringify(frame));
  };

  const emitEvents = (events: readonly DomainEvent[]): void => {
    for (const event of events) {
      writeFrame({ kind: "event", seq: event.seq, event });
    }
  };

  const flushPending = (): void => {
    if (windowHandle !== null) {
      clearTimer(windowHandle);
      windowHandle = null;
    }
    if (pendingUpdates.length === 0) return;
    const batch = pendingUpdates;
    pendingUpdates = [];
    emitEvents(coalesceToolUpdates(batch));
  };

  const offerLive = (events: DomainEvent[]): void => {
    if (closed) return;
    if (!live) {
      preReadBuffer.push(...events);
      return;
    }
    for (const event of events) {
      if (isToolUpdated(event)) {
        pendingUpdates.push(event);
        if (pendingUpdates.length === 1) {
          windowHandle = setTimer(() => {
            windowHandle = null;
            flushPending();
          }, coalesceWindowMs);
        } else if (pendingUpdates.length >= MAX_PENDING_UPDATES) {
          flushPending();
        }
        continue;
      }
      flushPending();
      emitEvents([event]);
    }
  };

  const start = async (): Promise<void> => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "keep-alive");
    // Flush the headers so a client waiting on the first byte sees the stream
    // open even before the read finishes.
    response.flushHeaders?.();

    response.on("close", () => {
      close("client");
    });

    // Attach live delivery BEFORE reading either replay or snapshot state.
    unsubscribe = await subscribe((events) => {
      offerLive(events);
    });
    if (closed) return;

    let frames: AgentChatStreamFrame[];
    try {
      frames = await read();
    } catch (error) {
      writeLine(
        JSON.stringify({
          kind: "error",
          message: error instanceof Error ? error.message : String(error)
        })
      );
      close("host");
      return;
    }
    if (closed) return;

    for (const frame of frames) {
      writeFrame(frame);
    }

    // Everything buffered during the read, then the marker — through the same
    // path, so the client is never told it is caught up early.
    const buffered = preReadBuffer.splice(0, preReadBuffer.length);
    const highest = frames.reduce(
      (max, frame) =>
        frame.kind === "event"
          ? Math.max(max, frame.seq)
          : frame.kind === "snapshot"
            ? Math.max(max, frame.thread.seq)
            : max,
      0
    );
    // Events at or below what the read already carried are dropped here as
    // well as on the client, so the overlapping windows of §6.6 are safe.
    emitEvents(coalesceToolUpdates(buffered.filter((event) => event.seq > highest)));
    writeFrame({ kind: "synchronized", hostInstanceId });
    live = true;

    const beat = (): void => {
      if (closed) return;
      writeLine(AGENT_CHAT_HEARTBEAT_LINE);
      heartbeatHandle = setTimer(beat, heartbeatMs);
    };
    heartbeatHandle = setTimer(beat, heartbeatMs);
  };

  return {
    start,
    close,
    get closed() {
      return closed;
    }
  };
}
