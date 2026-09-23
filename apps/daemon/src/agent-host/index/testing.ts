/**
 * Test scaffolding for the thread index: an in-memory `events.ndjson` whose
 * positions are the real byte positions of the JSON lines (multi-byte text
 * included), a `readEventsFrom` with the store's mismatch semantics, and a
 * few event builders. Not imported by production code.
 */

import type {
  DomainEvent,
  DomainEventType,
  ThreadActivityItem,
  ThreadSessionState
} from "@orquester/api/agent-chat";

import type { AdapterLogger } from "../adapter.ts";
import type { EventPosition, EventsFromResult } from "../services.ts";

/** An event before the log stamps it. */
export type Draft = {
  [T in DomainEventType]: {
    type: T;
    payload: Extract<DomainEvent, { type: T }>["payload"];
    /** Defaults to a clock that ticks one second per event. */
    occurredAt?: string;
  };
}[DomainEventType];

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

export function stampAt(seconds: number): string {
  return new Date(EPOCH + seconds * 1000).toISOString();
}

export interface AppendedBatch {
  events: DomainEvent[];
  positions: EventPosition[];
}

export class TestLog {
  readonly threadId: string;
  private lines: Array<{ event: DomainEvent; line: string; position: EventPosition }> = [];
  private bytes = 0;
  private seq = 0;
  /** Every `readEventsFrom` call, for assertions. */
  readonly reads: Array<{ byteOffset: number; afterSeq: number }> = [];

  constructor(threadId = "thread-1") {
    this.threadId = threadId;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.bytes;
  }

  append(...drafts: Draft[]): AppendedBatch {
    const events: DomainEvent[] = [];
    const positions: EventPosition[] = [];
    for (const draft of drafts) {
      this.seq += 1;
      const event = {
        seq: this.seq,
        eventId: `e${this.seq}`,
        threadId: this.threadId,
        type: draft.type,
        payload: draft.payload,
        occurredAt: draft.occurredAt ?? stampAt(this.seq),
        commandId: null,
        causationEventId: null,
        metadata: {}
      } as DomainEvent;
      const line = `${JSON.stringify(event)}\n`;
      const position: EventPosition = {
        seq: this.seq,
        byteOffset: this.bytes,
        byteLength: Buffer.byteLength(line, "utf8")
      };
      this.bytes += position.byteLength;
      this.lines.push({ event, line, position });
      events.push(event);
      positions.push(position);
    }
    return { events, positions };
  }

  /** The line holding `seq`. */
  at(seq: number): EventPosition {
    const found = this.lines.find((entry) => entry.position.seq === seq);
    if (found === undefined) {
      throw new Error(`no line for seq ${seq}`);
    }
    return found.position;
  }

  /** Where the line after `seq` starts. */
  endOf(seq: number): number {
    const position = this.at(seq);
    return position.byteOffset + position.byteLength;
  }

  event(seq: number): DomainEvent {
    const found = this.lines.find((entry) => entry.position.seq === seq);
    if (found === undefined) {
      throw new Error(`no event for seq ${seq}`);
    }
    return found.event;
  }

  /** The events a history page reads: every line inside `[fromByte, toByte)`. */
  slice(fromByte: number, toByte: number): DomainEvent[] {
    return this.lines
      .filter(
        (entry) =>
          entry.position.byteOffset >= fromByte &&
          entry.position.byteOffset + entry.position.byteLength <= toByte
      )
      .map((entry) => entry.event);
  }

  all(): AppendedBatch {
    return {
      events: this.lines.map((entry) => entry.event),
      positions: this.lines.map((entry) => entry.position)
    };
  }

  /** The store's `readEventsFrom`, over this log. */
  readonly readEventsFrom = async (input: {
    byteOffset: number;
    afterSeq: number;
  }): Promise<EventsFromResult> => {
    this.reads.push({ ...input });
    const stale: EventsFromResult = {
      events: [],
      positions: [],
      truncated: false,
      seq: input.afterSeq,
      logBytes: input.byteOffset,
      mismatch: true
    };
    if (input.byteOffset > this.bytes) {
      return stale;
    }
    const tail = this.lines.filter((entry) => entry.position.byteOffset >= input.byteOffset);
    if (tail.length > 0 && tail[0]!.position.byteOffset !== input.byteOffset) {
      return stale;
    }
    if (tail.length > 0 && tail[0]!.event.seq !== input.afterSeq + 1) {
      return stale;
    }
    const last = tail[tail.length - 1];
    return {
      events: tail.map((entry) => entry.event),
      positions: tail.map((entry) => entry.position),
      truncated: false,
      seq: last?.event.seq ?? input.afterSeq,
      logBytes: last === undefined ? input.byteOffset : this.bytes,
      mismatch: false
    };
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function created(projectPath = "/w/p", title = "New thread"): Draft {
  return {
    type: "thread.created",
    payload: {
      projectPath,
      cwd: projectPath,
      title,
      adapter: "claude",
      refId: "claude",
      accountId: "",
      home: "system",
      modelSelection: { model: "sonnet" },
      runtimeMode: "approval-required"
    }
  };
}

export function userMessage(messageId: string, text: string, turnId: string | null = null): Draft {
  return {
    type: "thread.message-sent",
    payload: { messageId, role: "user", text, streaming: false, turnId }
  };
}

export function delta(
  messageId: string,
  text: string,
  turnId: string | null,
  role: "assistant" | "reasoning" = "assistant"
): Draft {
  return {
    type: "thread.message-sent",
    payload: { messageId, role, text, streaming: true, turnId }
  };
}

export function done(
  messageId: string,
  turnId: string | null,
  text = "",
  role: "assistant" | "reasoning" | "user" = "assistant"
): Draft {
  return {
    type: "thread.message-sent",
    payload: { messageId, role, text, streaming: false, turnId }
  };
}

export function turnStart(messageId: string, turnId: string | null = null): Draft {
  return {
    type: "thread.turn-start-requested",
    payload: { turnId, messageId, interactionMode: "default" }
  };
}

/** A turn replayed from the provider's transcript: minted at its END, already settled. */
export function replayedTurn(messageId: string, turnId: string, completedAt: string): Draft {
  return {
    type: "thread.turn-start-requested",
    payload: {
      turnId,
      messageId,
      interactionMode: "default",
      settled: { state: "completed", completedAt }
    }
  };
}

export function session(
  status: ThreadSessionState["status"],
  activeTurnId: string | null = null,
  settles?: string
): Draft {
  return {
    type: "thread.session-set",
    payload: {
      session: { status, activeTurnId },
      ...(settles !== undefined ? { turn: { turnId: settles } } : {})
    }
  };
}

export function activity(
  id: string,
  activityKind: string,
  input: {
    summary?: string;
    payload?: Record<string, unknown>;
    turnId?: string | null;
    createdAt?: string;
  } = {}
): Draft {
  const row: ThreadActivityItem = {
    kind: "activity",
    id,
    tone: "info",
    activityKind,
    summary: input.summary ?? activityKind,
    payload: input.payload ?? {},
    turnId: input.turnId ?? null,
    createdAt: input.createdAt ?? stampAt(0),
    updatedAt: input.createdAt ?? stampAt(0)
  };
  return { type: "thread.activity-appended", payload: { activity: row } };
}

export function compaction(
  id: string,
  turnId: string | null,
  state: "compacted" | "compacting" | "compaction-failed" = "compacted"
): Draft {
  return activity(id, "context-compaction", {
    summary: state === "compacted" ? "Context compacted" : "Compacting context",
    payload: { state },
    turnId
  });
}

export function checkpoint(turnId: string, turnCount: number): Draft {
  return {
    type: "thread.turn-diff-completed",
    payload: {
      turnCount,
      turnId,
      ref: `turn/${turnCount}`,
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: stampAt(0)
    }
  };
}

export function reverted(turnCount: number): Draft {
  return { type: "thread.reverted", payload: { turnCount } };
}

export function deleted(): Draft {
  return { type: "thread.deleted", payload: { deletedAt: stampAt(0) } };
}

/**
 * One complete live turn as the orchestrator and ingestion write it: the
 * prompt and its turn row in one append, the provider's turn id adopted by
 * `running`, an answer streamed in two chunks, the settle, and the turn-end
 * checkpoint the capture appends after it.
 */
export function liveTurn(input: {
  n: number;
  prompt: string;
  answer?: [string, string];
  extra?: Draft[];
  checkpoint?: boolean;
}): Draft[] {
  const turnId = `t${input.n}`;
  const answer = input.answer ?? [`Answer `, `number ${input.n}.`];
  return [
    userMessage(`u${input.n}`, input.prompt),
    turnStart(`u${input.n}`),
    session("running", turnId),
    delta(`a${input.n}`, answer[0], turnId),
    delta(`a${input.n}`, answer[1], turnId),
    ...(input.extra ?? []),
    done(`a${input.n}`, turnId),
    session("ready", null, turnId),
    ...(input.checkpoint === false ? [] : [checkpoint(turnId, input.n)])
  ];
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface RecordingLogger extends AdapterLogger {
  readonly entries: Array<{ level: "debug" | "info" | "warn" | "error"; message: string }>;
}

export function recordingLogger(): RecordingLogger {
  const entries: RecordingLogger["entries"] = [];
  const record =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string): void => {
      entries.push({ level, message });
    };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error")
  };
}
