/**
 * Agent host — the §6.3 thread event stream.
 *
 * Ported from T3 Code (MIT): `apps/server/src/ws.ts:2150-2300`
 * (`subscribeThread`: attach the live tail **before** reading, snapshot-or-
 * replay decided server-side, the `synchronized` marker offered into the same
 * buffer), `apps/server/src/orchestration/LiveStreamBudget.ts` (overflow closes
 * the stream with "resume from the last received sequence") and
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
  AGENT_CHAT_ERROR_CODES,
  AGENT_CHAT_STREAM_BUFFER_LIMIT_BYTES,
  AGENT_ROWS_FRAME_MAX_BYTES,
  type AgentChatStreamErrorLine,
  type AgentChatStreamFrame,
  type AgentRowsFrame,
  type DomainEvent,
  type HistoryImportProgress
} from "@orquester/api/agent-chat";
import { slimActivityEvent } from "../ingestion/index.ts";

/**
 * The one non-`AgentChatStreamFrame` line the stream may write: the budget
 * overflow of §6.3, immediately before the close.
 */
const STREAM_OVERFLOW_FRAME = {
  kind: "error" as const,
  message: "The live event buffer is full. Resume from the last received sequence."
};

/** The most agents one stream holds asked-for but unwritten (`requestAgentRows`); a roster lists 100. */
const AGENT_ROWS_QUEUE_LIMIT = 1_024;

/** *T3: `ThreadLiveEventCoalescer.ts:18-19`.* */
const COALESCE_WINDOW_MS = 50;
const MAX_PENDING_UPDATES = 512;

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
function coalesceToolUpdates(events: readonly DomainEvent[]): DomainEvent[] {
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
  /**
   * Wired to the orchestrator's per-thread subscription. `onHistoryImport`
   * hears a resumed conversation's replay progress (transient, unsequenced).
   */
  subscribe(
    listener: (events: DomainEvent[]) => void,
    onHistoryImport?: (progress: HistoryImportProgress) => void
  ): Promise<() => void>;
  /**
   * Reads the snapshot or the replay. Runs **after** the live tail is attached
   * — attaching afterwards loses every event published while the read is in
   * flight (§6.3).
   */
  read(): Promise<AgentChatStreamFrame[]>;
  onClose?: (reason: "client" | "budget" | "host") => void;
  /**
   * On-demand agent rows (`?agentRows=on-demand`): this stream's id, announced
   * on its `synchronized` frame, and the frame a `POST …/agent-rows` naming it
   * writes — built SYNCHRONOUSLY from the fold as it stands when it is written,
   * so every event at or below its `seq` has already been offered here.
   * Absent: the stream announces no id and takes no request.
   */
  agentRows?: {
    streamId: string;
    frame(agentIds: readonly string[]): AgentRowsFrame | null;
  };
}

export interface ThreadStream {
  /** Attach the live tail, then read, then go live. Resolves when live. */
  start(): Promise<void>;
  /** Close from the host side (shutdown). */
  close(reason?: "client" | "budget" | "host"): void;
  readonly closed: boolean;
  /** {@link ThreadStreamOptions.agentRows}' id, or undefined for a stream without it. */
  readonly streamId: string | undefined;
  /**
   * Write the agents' {@link AgentRowsFrame}s into this stream, ONE PER AGENT,
   * in order: each after the tool updates still in their coalescing window
   * (committed first), from right after `synchronized` when the stream is not
   * live yet, and the next one only while the stream's undrained bytes are
   * under {@link AGENT_ROWS_FRAME_MAX_BYTES} (else at the socket's next
   * `drain`) — so no request ever trips the stream's budget. `"closed"`: the
   * stream is closed or was opened without the opt-in. `"gone"`: the thread
   * is no longer one the host can read (the stream closes too).
   */
  requestAgentRows(agentIds: readonly string[]): "ok" | "closed" | "gone";
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
  const { response, hostInstanceId, subscribe, read } = options;

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let live = false;
  /** Events observed while the read was in flight, not yet emitted. */
  const preReadBuffer: DomainEvent[] = [];
  /** The latest replay progress heard before going live; sent after `synchronized`. */
  let preReadImport: HistoryImportProgress | null = null;
  /** Tool updates waiting on the 50 ms coalescing window. */
  let pendingUpdates: DomainEvent[] = [];
  let windowHandle: ReturnType<typeof setTimeout> | null = null;
  let heartbeatHandle: ReturnType<typeof setTimeout> | null = null;
  /** Bytes handed to the socket that have not drained yet (§6.3). */
  let chargedBytes = 0;
  /**
   * Bytes written since the last `drain`. One listener is armed for the whole
   * backlog rather than one per write: a slow client would otherwise collect a
   * listener per un-flushed frame and trip Node's `MaxListenersExceededWarning`
   * (default 10) long before the 8 MiB budget does, and any still pending when
   * `close()` runs would stay attached to the response.
   */
  let pendingDrainBytes = 0;
  let drainArmed = false;
  /**
   * Agents asked for whose frame is not written yet, in order of asking: before the stream is
   * live, or while its undrained bytes are past the frame cap. Bounded: past it a request's
   * agents are not taken, and the client asks again on its next stream.
   */
  const agentRowsQueue = new Set<string>();

  const close = (reason: "client" | "budget" | "host" = "host"): void => {
    if (closed) return;
    closed = true;
    if (windowHandle !== null) clearTimeout(windowHandle);
    if (heartbeatHandle !== null) clearTimeout(heartbeatHandle);
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

  /**
   * `charge: false` is for the read's own frames (the snapshot or the replay): written whole and
   * never counted. They are bounded by the thread itself, and one can be past the budget on its
   * own (a subagent fleet's single turn); charging it closed the stream before its first row on
   * every attempt, so the chat never loaded. The budget bounds the live backlog behind them.
   */
  const writeLine = (line: string, charge = true): void => {
    if (closed) return;
    if (!charge) {
      response.write(`${line}\n`);
      return;
    }
    const bytes = Buffer.byteLength(line) + 1;
    chargedBytes += bytes;
    if (chargedBytes > AGENT_CHAT_STREAM_BUFFER_LIMIT_BYTES) {
      // A slow client is cut and told to resume by cursor; it is never allowed
      // to grow host memory.
      try {
        // Not an `AgentChatStreamFrame`: a client that does not know this
        // shape must skip it rather than fail to decode. It is the last line
        // before the close, and the close itself is the signal.
        response.write(`${JSON.stringify(STREAM_OVERFLOW_FRAME)}\n`);
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
    pendingDrainBytes += bytes;
    if (drainArmed) {
      return;
    }
    drainArmed = true;
    response.once("drain", () => {
      drainArmed = false;
      const released = pendingDrainBytes;
      pendingDrainBytes = 0;
      chargedBytes = Math.max(0, chargedBytes - released);
      // Room again: the next agent's frame, if any waits.
      pumpAgentRows();
    });
  };

  const writeFrame = (frame: AgentChatStreamFrame, charge = true): void => {
    writeLine(JSON.stringify(frame), charge);
  };

  const emitEvents = (events: readonly DomainEvent[]): void => {
    for (const event of events) {
      // §5.6: the full payload is persisted, and slimming runs before anything
      // goes on the wire. It happens HERE, before `writeFrame` measures the
      // line, so the per-stream byte budget is charged the wire size rather
      // than the multi-MB persisted one — otherwise ordinary tool output cuts
      // a client on a slow link with "the live event buffer is full", and
      // `payload.truncated` never reaches the UI so "load full output" can
      // never appear (R5 #1). `readItem` stays unslimmed: it IS that fetch.
      writeFrame({ kind: "event", seq: event.seq, event: slimActivityEvent(event) });
    }
  };

  const flushPending = (): void => {
    if (windowHandle !== null) {
      clearTimeout(windowHandle);
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
          windowHandle = setTimeout(() => {
            windowHandle = null;
            flushPending();
          }, COALESCE_WINDOW_MS);
        } else if (pendingUpdates.length >= MAX_PENDING_UPDATES) {
          flushPending();
        }
        continue;
      }
      flushPending();
      emitEvents([event]);
    }
  };

  const offerHistoryImport = (progress: HistoryImportProgress): void => {
    if (closed) return;
    if (!live) {
      preReadImport = progress;
      return;
    }
    // After any tool updates still in their window: they were committed first.
    flushPending();
    writeFrame({ kind: "history-import", progress });
  };

  /**
   * The frame goes through the same ordered path as the live tail: the tool
   * updates waiting on their window were committed before the fold this frame
   * reads, so they go first — a row they update must never land after the
   * frame that already holds it, nor a frame's state be followed by an older
   * update of it. Built here, in the same synchronous step that writes it.
   */
  const pumpAgentRows = (): "ok" | "gone" => {
    const agentRows = options.agentRows;
    if (closed || !live || agentRows === undefined) return "ok";
    // Each frame is capped at the same size, so with this much undrained at most the stream
    // holds two frames' worth beside its live tail — far under its budget.
    while (!closed && agentRowsQueue.size > 0 && chargedBytes < AGENT_ROWS_FRAME_MAX_BYTES) {
      const agentId = agentRowsQueue.values().next().value as string;
      agentRowsQueue.delete(agentId);
      flushPending();
      const frame = agentRows.frame([agentId]);
      if (frame === null) {
        // The thread is gone from this host: the reconnect reads that and stops.
        close("host");
        return "gone";
      }
      writeFrame(frame);
    }
    return "ok";
  };

  const requestAgentRows = (agentIds: readonly string[]): "ok" | "closed" | "gone" => {
    if (closed || options.agentRows === undefined) return "closed";
    for (const agentId of agentIds) {
      if (agentRowsQueue.size >= AGENT_ROWS_QUEUE_LIMIT) break;
      agentRowsQueue.add(agentId);
    }
    return pumpAgentRows();
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
    const attached = await subscribe(
      (events) => {
        offerLive(events);
      },
      (progress) => {
        offerHistoryImport(progress);
      }
    );
    if (closed) {
      // The client went away during the await, so `close()` already ran and
      // found `unsubscribe` still null. Detach here or the subscriber stays in
      // the thread's set for the life of the host and every event iterates it.
      attached();
      return;
    }
    unsubscribe = attached;

    let frames: AgentChatStreamFrame[];
    try {
      frames = await read();
    } catch (error) {
      // The failure's §6.2 code rides along: THREAD_NOT_FOUND tells a client to stop
      // reconnecting to a thread this host does not hold.
      const code = (error as { code?: unknown } | null)?.code;
      const line: AgentChatStreamErrorLine = {
        kind: "error",
        ...(typeof code === "string" && (AGENT_CHAT_ERROR_CODES as readonly string[]).includes(code)
          ? { code: code as AgentChatStreamErrorLine["code"] }
          : {}),
        message: error instanceof Error ? error.message : String(error)
      };
      writeLine(JSON.stringify(line));
      close("host");
      return;
    }
    if (closed) return;

    for (const frame of frames) {
      writeFrame(frame, false);
    }

    // The heartbeat starts as soon as the headers are out: a very large
    // snapshot can take longer than a proxy's idle timeout to write, and the
    // stream would be cut before it ever reached `synchronized`.
    const beat = (): void => {
      if (closed) return;
      writeLine(AGENT_CHAT_HEARTBEAT_LINE);
      heartbeatHandle = setTimeout(beat, AGENT_CHAT_HEARTBEAT_MS);
    };
    heartbeatHandle = setTimeout(beat, AGENT_CHAT_HEARTBEAT_MS);

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
    writeFrame({
      kind: "synchronized",
      hostInstanceId,
      ...(options.agentRows !== undefined ? { streamId: options.agentRows.streamId } : {})
    });
    live = true;
    // A replay still running is announced after the marker, which clears
    // the client's view of it; one that ended meanwhile needs nothing.
    if (preReadImport !== null && preReadImport.phase !== "done") {
      writeFrame({ kind: "history-import", progress: preReadImport });
    }
    preReadImport = null;
    // Asked for before the marker: every event the fold holds is out by now.
    pumpAgentRows();
  };

  return {
    start,
    close,
    requestAgentRows,
    get closed() {
      return closed;
    },
    get streamId() {
      return options.agentRows?.streamId;
    }
  };
}
