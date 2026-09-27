/**
 * Agent host — an in-memory `ThreadIndex` for orchestration tests (design
 * 2026-09-23, C).
 *
 * Keeps the rows the real index keeps, by the same contract (`index/index.ts`,
 * `IndexedTurn`), from exactly what `observe` and `catchUp` hand it: ordinals
 * by ORDER of started turns (§5.5); byte ranges that TILE the log — a started
 * turn owns everything from its opening prompt up to the next started turn's
 * first line, the latest one grows with every event, and a `thread.reverted`
 * closes every range so the reverted bytes belong to no turn; settled
 * compaction markers; every activity's LATEST line (last write wins); every
 * message's span, first chunk to last, with its author and text; the revert
 * truncation. The turn rules themselves come from the shared fold, and the
 * prompt list pages through the real index's `readPromptsPage`, so neither
 * can drift. It records every call for a test to assert on. No SQLite, no
 * I/O, and nothing in it waits.
 */

import {
  applyDomainEvent,
  compactionMarkerState,
  createEmptyThreadState,
  isConversationCompactionActivity,
  recallablePromptText,
  startedTurns,
  type DomainEvent,
  type HistoryCursor,
  type ThreadFoldState,
  type ThreadSearchHit
} from "@orquester/api/agent-chat";

import type {
  IndexCoverage,
  IndexedItemPosition,
  IndexedMessageSpan,
  IndexedPromptLookup,
  IndexedPromptsPage,
  IndexedThreadMeta,
  IndexedTurn,
  SpanningMessage,
  ThreadIndex
} from "../../index/index.ts";
import { capText, MAX_INDEXED_TEXT_CHARS } from "../../index/indexer.ts";
import { readPromptsPage, type PromptCandidate } from "../../index/queries.ts";
import type { EventPosition } from "../../services.ts";

interface ThreadRows {
  meta: IndexedThreadMeta;
  /** The whole fold — test logs are small — for the turn rules. */
  state: ThreadFoldState;
  turns: IndexedTurn[];
  /** User messages no turn has claimed as its opening prompt yet. */
  prompts: Map<string, EventPosition>;
  /** The turn whose range grows with the log; none after a revert. */
  openTurnId: string | null;
  /** The seq of the latest `thread.reverted`; 0 before any. */
  revertSeq: number;
  /** The conversation's own compaction markers (the shared rule); only a settled one blocks a rewind. */
  markers: Array<{ seq: number; compacted: boolean }>;
  /** Every activity's latest line, by id. */
  items: Map<string, IndexedItemPosition>;
  /** Every message's first line and last seq, its author and its text, by id. */
  messages: Map<string, FakeMessage>;
  cursor: { lastSeq: number; lastByte: number } | null;
}

interface FakeMessage {
  first: IndexedItemPosition;
  lastSeq: number;
  /** The first line's, as `message_docs` keeps them. */
  role: string;
  agentId: string | null;
  /** The fold's text rule: a delta appends, a finished row with text replaces. */
  text: string;
  /** The latest line's turn, as the FTS row keeps it. */
  turnId: string | null;
  /** The first line's stamp. */
  at: string;
}

export interface FakeThreadIndex extends ThreadIndex {
  /** Flip to model a host whose driver or file is unusable. */
  available: boolean;
  readonly observed: Array<
    IndexedThreadMeta & { events: DomainEvent[]; positions: EventPosition[] }
  >;
  readonly catchUps: Array<IndexedThreadMeta & { logSeq: number }>;
  readonly deleted: string[];
  readonly searches: Array<{ q: string; limit: number; projectPath?: string }>;
  /** What `search` answers, cut to the requested limit. */
  searchHits: ThreadSearchHit[];
  /**
   * What `coverage` answers for every thread, when set — to model a catch-up
   * in progress, a thread left behind, a failed read. Unset: `complete` once
   * the thread's observed events reach the log's seq, else `behind`.
   */
  coverageOverride: IndexCoverage | null;
  /** Sweeps begun and not ended. */
  sweeps: number;
  closed: boolean;
}

export function createFakeThreadIndex(options: { available?: boolean } = {}): FakeThreadIndex {
  const threads = new Map<string, ThreadRows>();

  const rowsFor = (meta: IndexedThreadMeta): ThreadRows => {
    const known = threads.get(meta.threadId);
    if (known !== undefined) {
      known.meta = { threadId: meta.threadId, projectPath: meta.projectPath, title: meta.title };
      return known;
    }
    const rows: ThreadRows = {
      meta: { threadId: meta.threadId, projectPath: meta.projectPath, title: meta.title },
      state: createEmptyThreadState(),
      turns: [],
      prompts: new Map(),
      openTurnId: null,
      revertSeq: 0,
      markers: [],
      items: new Map(),
      messages: new Map(),
      cursor: null
    };
    threads.set(meta.threadId, rows);
    return rows;
  };

  const apply = (rows: ThreadRows, event: DomainEvent, position: EventPosition): void => {
    if (rows.cursor !== null && event.seq <= rows.cursor.lastSeq) {
      return;
    }
    const end = position.byteOffset + position.byteLength;
    rows.cursor = { lastSeq: event.seq, lastByte: end };
    if (event.type === "thread.deleted") {
      threads.delete(rows.meta.threadId);
      return;
    }
    if (
      event.type === "thread.message-sent" &&
      event.payload.role === "user" &&
      !event.payload.streaming
    ) {
      rows.prompts.set(event.payload.messageId, position);
    }
    if (event.type === "thread.message-sent") {
      const payload = event.payload;
      const known = rows.messages.get(payload.messageId);
      if (known === undefined) {
        rows.messages.set(payload.messageId, {
          first: { seq: event.seq, byteOffset: position.byteOffset, byteLength: position.byteLength },
          lastSeq: event.seq,
          role: payload.role,
          agentId:
            typeof payload.agentId === "string" && payload.agentId.length > 0
              ? payload.agentId
              : null,
          text: payload.text,
          turnId: payload.turnId,
          at: event.occurredAt
        });
      } else {
        known.lastSeq = event.seq;
        known.turnId = payload.turnId;
        known.text = payload.streaming
          ? `${known.text}${payload.text}`
          : payload.text.length > 0
            ? payload.text
            : known.text;
      }
    }
    if (event.type === "thread.activity-appended") {
      rows.items.set(event.payload.activity.id, {
        seq: event.seq,
        byteOffset: position.byteOffset,
        byteLength: position.byteLength
      });
    }
    if (
      event.type === "thread.activity-appended" &&
      isConversationCompactionActivity(event.payload.activity)
    ) {
      rows.markers.push({
        seq: event.seq,
        compacted: compactionMarkerState(event.payload.activity) === "compacted"
      });
    }
    if (event.type === "thread.reverted") {
      const keep = event.payload.turnCount;
      const removed = rows.turns.filter((turn) => turn.ordinal > keep);
      if (removed.length > 0) {
        const cut = Math.min(...removed.map((turn) => turn.firstSeq));
        rows.markers = rows.markers.filter((marker) => marker.seq < cut);
        for (const [id, item] of [...rows.items]) {
          if (item.seq >= cut) rows.items.delete(id);
        }
        for (const [id, message] of [...rows.messages]) {
          if (message.role !== "user" && message.first.seq >= cut) rows.messages.delete(id);
        }
      }
      rows.turns = rows.turns.filter((turn) => turn.ordinal <= keep);
      // A revert closes every range: nothing grows until the next turn starts.
      rows.openTurnId = null;
      rows.revertSeq = event.seq;
      rows.state = applyDomainEvent(rows.state, event);
      // User messages go the fold's way, as the real index takes them
      // (`dropRevertedUserMessages`): the fold here holds the whole log.
      const surviving = new Set(
        rows.state.items.filter((item) => item.kind === "message").map((item) => item.id)
      );
      for (const [id, message] of [...rows.messages]) {
        if (message.role === "user" && !surviving.has(id)) rows.messages.delete(id);
      }
      return;
    }

    rows.state = applyDomainEvent(rows.state, event);
    const started = startedTurns(rows.state.turns);
    const rowOf = (turnId: string): IndexedTurn | undefined =>
      rows.turns.find((row) => row.turnId === turnId);
    started.forEach((turn, index) => {
      if (rowOf(turn.turnId) !== undefined) return;
      // A turn starts at the prompt that opened it, and the turn that was open
      // ends there.
      const anchor =
        (turn.userMessageId !== undefined ? rows.prompts.get(turn.userMessageId) : undefined) ??
        position;
      if (turn.userMessageId !== undefined) rows.prompts.delete(turn.userMessageId);
      const open = rows.openTurnId !== null ? rowOf(rows.openTurnId) : undefined;
      if (open !== undefined && open.endByte > anchor.byteOffset) {
        open.endByte = anchor.byteOffset;
        open.lastSeq = Math.max(open.firstSeq, anchor.seq - 1);
      }
      rows.turns.push({
        turnId: turn.turnId,
        ordinal: index + 1,
        userMessageId: turn.userMessageId ?? null,
        requestedAt: turn.requestedAt,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        firstSeq: anchor.seq,
        lastSeq: event.seq,
        firstByte: anchor.byteOffset,
        endByte: end
      });
      rows.openTurnId = turn.turnId;
    });
    // The open turn owns every event until the next one starts.
    const open = rows.openTurnId !== null ? rowOf(rows.openTurnId) : undefined;
    if (open !== undefined && open.lastSeq < event.seq) {
      open.lastSeq = event.seq;
      open.endByte = end;
    }
    rows.turns = rows.turns
      .map((row) => {
        const index = started.findIndex((turn) => turn.turnId === row.turnId);
        const turn = started[index];
        return turn === undefined
          ? row
          : { ...row, ordinal: index + 1, startedAt: turn.startedAt, completedAt: turn.completedAt };
      })
      .sort((left, right) => left.ordinal - right.ordinal);
  };

  /** Every indexed activity's line below `beforeSeq`, newest first. */
  const itemSeqsBelow = (rows: ThreadRows, beforeSeq: number): number[] =>
    [...rows.items.values()]
      .map((item) => item.seq)
      .filter((seq) => seq < beforeSeq)
      .sort((left, right) => right - left);

  /** The real index's cursor rule: the cursor's own turn, else the first turn at or after its anchor. */
  const upperOrdinal = (rows: ThreadRows, anchorAt: string, turnId: string): number => {
    const own = rows.turns.find((turn) => turn.turnId === turnId);
    if (own !== undefined) return own.ordinal;
    const after = rows.turns.filter(
      (turn) =>
        turn.requestedAt > anchorAt || (turn.requestedAt === anchorAt && turn.turnId >= turnId)
    );
    return after.length > 0
      ? Math.min(...after.map((turn) => turn.ordinal))
      : Number.MAX_SAFE_INTEGER;
  };

  const fake: FakeThreadIndex = {
    available: options.available ?? true,
    observed: [],
    catchUps: [],
    deleted: [],
    searches: [],
    searchHits: [],
    coverageOverride: null,
    sweeps: 0,
    closed: false,

    observe(input): void {
      fake.observed.push({
        threadId: input.threadId,
        projectPath: input.projectPath,
        title: input.title,
        events: [...input.events],
        positions: [...input.positions]
      });
      if (!fake.available || fake.closed) return;
      const rows = rowsFor(input);
      input.events.forEach((event, index) => {
        const position = input.positions[index];
        if (position !== undefined) apply(rows, event, position);
      });
    },

    async drain(): Promise<void> {},

    async catchUp(input): Promise<void> {
      fake.catchUps.push({
        threadId: input.threadId,
        projectPath: input.projectPath,
        title: input.title,
        logSeq: input.logSeq
      });
      if (!fake.available || fake.closed) return;
      let rows = rowsFor(input);
      if (rows.cursor !== null && rows.cursor.lastSeq >= input.logSeq) return;
      let read = await input.read({
        byteOffset: rows.cursor?.lastByte ?? 0,
        afterSeq: rows.cursor?.lastSeq ?? 0
      });
      if (read.mismatch) {
        // The log was rewritten under the index: re-index it from the top.
        threads.delete(input.threadId);
        rows = rowsFor(input);
        read = await input.read({ byteOffset: 0, afterSeq: 0 });
        if (read.mismatch) return;
      }
      read.events.forEach((event, index) => {
        const position = read.positions[index];
        if (position !== undefined) apply(rows, event, position);
      });
    },

    deleteThread(threadId: string): void {
      fake.deleted.push(threadId);
      threads.delete(threadId);
    },

    cursor(threadId: string): { lastSeq: number; lastByte: number } | null {
      const cursor = threads.get(threadId)?.cursor ?? null;
      return cursor === null ? null : { ...cursor };
    },

    turnByOrdinal(threadId: string, ordinal: number): IndexedTurn | null {
      const turn = threads.get(threadId)?.turns.find((row) => row.ordinal === ordinal);
      return turn === undefined ? null : { ...turn };
    },

    turnById(threadId: string, turnId: string): IndexedTurn | null {
      const turn = threads.get(threadId)?.turns.find((row) => row.turnId === turnId);
      return turn === undefined ? null : { ...turn };
    },

    totalTurns(threadId: string): number {
      return threads.get(threadId)?.turns.length ?? 0;
    },

    turnsBefore(threadId, input): IndexedTurn[] {
      const rows = threads.get(threadId);
      if (rows === undefined || !Number.isFinite(input.limit) || input.limit < 1) return [];
      const before: HistoryCursor | null =
        input.before !== null && input.before.threadId === threadId ? input.before : null;
      const beforeTurn = input.beforeTurn ?? null;
      const upper =
        before !== null
          ? upperOrdinal(rows, before.beforeAnchorAt, before.beforeTurnId)
          : beforeTurn !== null
            ? upperOrdinal(rows, beforeTurn.requestedAt, beforeTurn.turnId)
            : Number.MAX_SAFE_INTEGER;
      const older = rows.turns.filter((turn) => turn.ordinal < upper);
      return older
        .slice(Math.max(0, older.length - Math.floor(input.limit)))
        .map((turn) => ({ ...turn }));
    },

    itemPosition(threadId: string, itemId: string): IndexedItemPosition | null {
      const item = threads.get(threadId)?.items.get(itemId);
      return item === undefined ? null : { ...item };
    },

    itemPositionBySeq(threadId: string, seq: number): IndexedItemPosition | null {
      const rows = threads.get(threadId);
      if (rows === undefined) return null;
      for (const item of rows.items.values()) {
        if (item.seq === seq) return { ...item };
      }
      return null;
    },

    hasItemsBefore(threadId: string, seq: number): boolean {
      const rows = threads.get(threadId);
      return rows !== undefined && itemSeqsBelow(rows, seq).length > 0;
    },

    activitySeqBefore(threadId, input): number | null {
      const rows = threads.get(threadId);
      if (rows === undefined) return null;
      const below = itemSeqsBelow(rows, input.beforeSeq);
      if (below.length === 0) return null;
      const count = Math.max(1, Math.floor(input.count));
      return below[Math.min(count, below.length) - 1]!;
    },

    turnsInSeqRange(threadId, input): IndexedTurn[] {
      const turns = threads.get(threadId)?.turns ?? [];
      return turns
        .filter((turn) => turn.firstSeq < input.toSeq && turn.lastSeq >= input.fromSeq)
        .map((turn) => ({ ...turn }));
    },

    turnOfSeq(threadId: string, seq: number): IndexedTurn | null {
      const turns = threads.get(threadId)?.turns ?? [];
      let found: IndexedTurn | null = null;
      for (const turn of turns) {
        if (turn.firstSeq <= seq && (found === null || turn.firstSeq > found.firstSeq)) {
          found = turn;
        }
      }
      return found === null ? null : { ...found };
    },

    eventPositionBySeq(threadId: string, seq: number): IndexedItemPosition | null {
      const rows = threads.get(threadId);
      if (rows === undefined) return null;
      for (const item of rows.items.values()) {
        if (item.seq === seq) return { ...item };
      }
      for (const message of rows.messages.values()) {
        if (message.first.seq === seq) return { ...message.first };
      }
      return null;
    },

    messageSpan(threadId: string, messageId: string): IndexedMessageSpan | null {
      const message = threads.get(threadId)?.messages.get(messageId);
      return message === undefined
        ? null
        : { firstSeq: message.first.seq, firstByte: message.first.byteOffset, lastSeq: message.lastSeq };
    },

    messagesSpanning(threadId: string, seq: number): SpanningMessage[] {
      const rows = threads.get(threadId);
      if (rows === undefined) return [];
      return [...rows.messages.entries()]
        .filter(([, message]) => message.first.seq < seq && seq <= message.lastSeq)
        .map(([messageId, message]) => ({
          messageId,
          firstSeq: message.first.seq,
          firstByte: message.first.byteOffset,
          lastSeq: message.lastSeq
        }))
        .sort((left, right) => left.firstSeq - right.firstSeq);
    },

    firstBoundaryAfter(threadId: string, seq: number): IndexedItemPosition | null {
      const rows = threads.get(threadId);
      if (rows === undefined) return null;
      let found: IndexedItemPosition | null = null;
      const consider = (line: IndexedItemPosition): void => {
        if (line.seq > seq && (found === null || line.seq < found.seq)) found = { ...line };
      };
      for (const item of rows.items.values()) consider(item);
      for (const message of rows.messages.values()) consider(message.first);
      return found;
    },

    latestRevertSeq(threadId: string): number {
      return threads.get(threadId)?.revertSeq ?? 0;
    },

    turnByPrompt(threadId: string, messageId: string): IndexedTurn | null {
      const turn = threads.get(threadId)?.turns.find((row) => row.userMessageId === messageId);
      return turn === undefined ? null : { ...turn };
    },

    rewindable(threadId: string, turn: IndexedTurn): boolean {
      const markers = threads.get(threadId)?.markers ?? [];
      return !markers.some((marker) => marker.compacted && marker.seq > turn.firstSeq);
    },

    search(input): ThreadSearchHit[] {
      fake.searches.push({
        q: input.q,
        limit: input.limit,
        ...(input.projectPath !== undefined ? { projectPath: input.projectPath } : {})
      });
      if (!fake.available || fake.closed) return [];
      return fake.searchHits.slice(0, input.limit);
    },

    async coverage(threadId: string, logSeq: number): Promise<IndexCoverage> {
      if (!fake.available || fake.closed) return "unavailable";
      if (fake.coverageOverride !== null) return fake.coverageOverride;
      const lastSeq = threads.get(threadId)?.cursor?.lastSeq ?? 0;
      return lastSeq >= logSeq ? "complete" : fake.sweeps > 0 ? "catching-up" : "behind";
    },

    beginCatchUpSweep() {
      fake.sweeps += 1;
      let ended = false;
      return {
        end: () => {
          if (!ended) {
            ended = true;
            fake.sweeps -= 1;
          }
        }
      };
    },

    prompts(threadId, input): IndexedPromptsPage | null {
      if (!fake.available || fake.closed) return null;
      const rows = threads.get(threadId);
      // The rows `message_docs_prompts` reaches: the parent's `user` messages,
      // text or not — one without text is walked past like a refused one.
      const candidates: PromptCandidate[] = [...(rows?.messages.entries() ?? [])]
        .filter(([, message]) => message.role === "user" && message.agentId === null)
        .map(([messageId, message]) => ({
          messageId,
          seq: message.first.seq,
          text: capText(message.text),
          turnId: message.turnId,
          createdAt: message.at
        }))
        .sort((left, right) => right.seq - left.seq);
      return readPromptsPage(threadId, input, {
        olderThan: (beforeSeq, count) => {
          const read = candidates.filter((candidate) => candidate.seq < beforeSeq).slice(0, count);
          return { candidates: read, scanned: read.length };
        },
        turnOpenedBy: (messageId) => {
          const opened = (rows?.turns ?? [])
            .filter((turn) => turn.userMessageId === messageId)
            .sort((left, right) => left.ordinal - right.ordinal)[0];
          return opened === undefined ? null : { ...opened };
        },
        rewindable: (turn) => fake.rewindable(threadId, turn)
      });
    },

    prompt(threadId: string, messageId: string): IndexedPromptLookup {
      if (!fake.available || fake.closed) return { status: "failed" };
      const message = threads.get(threadId)?.messages.get(messageId);
      if (message === undefined || message.role !== "user" || message.agentId !== null) {
        return { status: "absent" };
      }
      const copy = capText(message.text);
      const text = recallablePromptText(copy);
      return text === null
        ? { status: "absent" }
        : {
            status: "found",
            prompt: {
              messageId,
              text,
              cut: copy.length >= MAX_INDEXED_TEXT_CHARS - 1,
              line: { ...message.first },
              lastSeq: message.lastSeq
            }
          };
    },

    async stop(): Promise<void> {
      // Nothing here is ever queued or in flight: a stop is a close.
      fake.closed = true;
    },

    close(): void {
      fake.closed = true;
    }
  };
  return fake;
}
