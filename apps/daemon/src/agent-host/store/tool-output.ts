/**
 * A tool call's streamed output, joined from its thread's log — the answer of
 * `GET …/items/:itemId/output` ({@link ThreadItemOutputResponse}), or one
 * window of it ({@link ThreadItemOutputWindowResponse}).
 *
 * Some output exists only as `tool.output` chunks: ingestion's §5.6
 * command-output buffer writes a row per flush, `payload.delta` carrying the
 * text and `payload.toolUseId` the call's item id — a Claude background
 * shell's output, tailed from the file the CLI writes (≤ 1 MiB per shell plus
 * one notice, `support/tail-file.ts`), and a running command's output so far.
 * The GUI joins the chunks onto the call's row (`joinLifecycleDetails`); the
 * snapshot cannot give them back whole (per-agent windows evict chunks, the
 * wire caps every string, history pages are slimmed), so the log is read.
 *
 * Pure over the decoded events, two ways: {@link joinToolOutput} over a whole
 * log (the store runs it after its one `readLog` for the whole join, the
 * orchestrator over `readAll` for a store without it), and
 * {@link ToolOutputJoin} + {@link nextItemWrite}, the same join and the same
 * call built one event at a time — what the store's cache
 * (`tool-output-cache.ts`) keeps and extends by the log's tail, so a window
 * never reads the whole log again. Both take the ONE step, {@link joinStep}:
 * the cap's accounting cannot drift between them.
 *
 * It reads the RAW log, and a `thread.reverted` does not filter it: a chunk
 * written in a turn a rewind later removed is still joined. Chunks written
 * before a rewind are what the command printed, and a rewind unprints nothing
 * (a Claude rewind restarts the session, which closes an open shell first, so
 * no shell prints on through one); the log is the one place that output
 * survives. The join is by call, not by stream: a file change's
 * `file_change_output` chunks are joined as a command's `command_output` are,
 * and the reader decides what the text is (the MCP's `read_tool_output`
 * answers only a command's as its output).
 */

import {
  THREAD_ITEM_OUTPUT_MAX_BYTES,
  THREAD_ITEM_OUTPUT_WINDOW_DEFAULT_BYTES,
  THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES,
  type DomainEvent,
  type ThreadItemOutputResponse,
  type ThreadItemOutputWindowQuery,
  type ThreadItemOutputWindowResponse
} from "@orquester/api/agent-chat";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A write's `payload.toolUseId` when it names a call: a non-empty string. */
function toolUseIdOf(payload: unknown): string | undefined {
  const toolUseId = asRecord(payload)?.toolUseId;
  return typeof toolUseId === "string" && toolUseId.length > 0 ? toolUseId : undefined;
}

/**
 * The call an item belongs to: its NEWEST write's `payload.toolUseId`, as
 * `readItem` reads the newest write as the item. Undefined for a message, for a
 * row that names no call, and for an id the log never wrote.
 */
function callOf(events: readonly DomainEvent[], itemId: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "thread.activity-appended") {
      if (event.payload.activity.id !== itemId) continue;
      return toolUseIdOf(event.payload.activity.payload);
    }
    if (event.type === "thread.message-sent" && event.payload.messageId === itemId) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The newest write of one item in a log read forward so far — what `callOf`
 * and `readItem` find reading the whole log backwards: an activity (with its
 * line, which the store reads back alone, and the call it names), a message
 * (whose body only a fold rebuilds), or nothing yet.
 */
export type ItemWrite =
  | { kind: "none" }
  | { kind: "message" }
  | { kind: "activity"; seq: number; byteOffset: number; byteLength: number; toolUseId?: string };

/**
 * {@link ItemWrite} after one more event, at `position` in the log: the
 * forward continuation of `callOf`, so the item's write over a prefix extended
 * by the rest is the item's write over the whole log.
 */
export function nextItemWrite(
  write: ItemWrite,
  event: DomainEvent,
  itemId: string,
  position: { byteOffset: number; byteLength: number }
): ItemWrite {
  if (event.type === "thread.activity-appended") {
    if (event.payload.activity.id !== itemId) return write;
    const toolUseId = toolUseIdOf(event.payload.activity.payload);
    return {
      kind: "activity",
      seq: event.seq,
      byteOffset: position.byteOffset,
      byteLength: position.byteLength,
      ...(toolUseId !== undefined ? { toolUseId } : {})
    };
  }
  if (event.type === "thread.message-sent" && event.payload.messageId === itemId) {
    return { kind: "message" };
  }
  return write;
}

/** The UTF-8 size of one code point (a lone surrogate encodes as U+FFFD: 3). */
const utf8Size = (codePoint: number): number =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/** The longest head of `text` whose UTF-8 fits `budget` bytes, in whole code points. */
function utf8Head(text: string, budget: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += utf8Size(char.codePointAt(0)!);
    if (bytes > budget) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * A join's running counts: `bytes` is the sum of each joined chunk's own
 * UTF-8 size — the counter the cap is decided on, which can run ahead of the
 * join's real size (a surrogate pair split across two chunks counts 3 + 3 and
 * encodes as 4) — and the two flags.
 */
interface JoinCounters {
  bytes: number;
  complete: boolean;
  truncated: boolean;
}

/**
 * One event's part in the join of `toolUseId`: the text it appends — cut on a
 * character boundary when it crosses `maxBytes` — or undefined. A completion
 * sets `complete`; nothing is appended once the join is `truncated`, but the
 * scan goes on so a completion after the cut is still reported.
 */
function joinStep(
  counters: JoinCounters,
  event: DomainEvent,
  toolUseId: string,
  maxBytes: number
): string | undefined {
  if (event.type !== "thread.activity-appended") return undefined;
  const { activity } = event.payload;
  const payload = asRecord(activity.payload);
  if (payload?.toolUseId !== toolUseId) return undefined;
  if (activity.activityKind === "tool.completed") {
    counters.complete = true;
    return undefined;
  }
  const delta = payload.delta;
  if (activity.activityKind !== "tool.output" || counters.truncated || typeof delta !== "string") {
    return undefined;
  }
  const size = Buffer.byteLength(delta, "utf8");
  if (counters.bytes + size <= maxBytes) {
    counters.bytes += size;
    return delta;
  }
  counters.truncated = true;
  return utf8Head(delta, maxBytes - counters.bytes);
}

/**
 * The streamed output of the call `itemId` belongs to: the `payload.delta` of
 * every `tool.output` row with that `toolUseId`, joined verbatim in log order
 * (never trimmed — a command's output is its whitespace, and the GUI's join
 * keeps it too), and `complete` once a `tool.completed` row of the call exists.
 * Past `maxBytes` of UTF-8 the join stops on a character boundary and says
 * `truncated`; the scan still runs to the end for the completion. Null when the
 * item names no call ({@link callOf}).
 */
export function joinToolOutput(
  events: readonly DomainEvent[],
  itemId: string,
  maxBytes: number = THREAD_ITEM_OUTPUT_MAX_BYTES
): ThreadItemOutputResponse | null {
  const toolUseId = callOf(events, itemId);
  if (toolUseId === undefined) {
    return null;
  }
  const counters: JoinCounters = { bytes: 0, complete: false, truncated: false };
  const chunks: string[] = [];
  for (const event of events) {
    const piece = joinStep(counters, event, toolUseId, maxBytes);
    if (piece !== undefined) chunks.push(piece);
  }
  return { toolUseId, output: chunks.join(""), complete: counters.complete, truncated: counters.truncated };
}

/** How many bytes the UTF-8 character a lead byte starts takes (1 for ASCII, or for a byte no character starts with). */
const utf8SequenceLength = (lead: number): number =>
  lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

/**
 * One window of UTF-8 `bytes`: from `offset` — clamped to the end, then moved
 * back to the lead byte of the character it falls in (at most 3 bytes) — to
 * the end of the most whole characters that fit in `maxBytes`, and always at
 * least one, so paging through `end` advances whatever `maxBytes` is. At (or
 * past) the end the window is empty. The MCP's `read_tool_output` windows a
 * whole text by the same rule, so a page is the same bytes whichever side cut
 * it.
 */
export function utf8Window(bytes: Uint8Array, offset: number, maxBytes: number): { start: number; end: number } {
  const total = bytes.length;
  const at = Math.min(offset, total);
  let start = at;
  // A continuation byte is 10xxxxxx, and a character's lead byte is at most 3 bytes before any of them.
  while (start > 0 && start < total && at - start < 3 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  let end = start;
  while (end < total) {
    const size = Math.min(utf8SequenceLength(bytes[end]!), total - end);
    if (end > start && end + size - start > maxBytes) break;
    end += size;
  }
  return { start, end };
}

/**
 * A window query as {@link utf8Window} takes it: `offset` a whole number of
 * bytes from 0 (the start when absent), `maxBytes` clamped to
 * `[1, THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES]` (the default when absent).
 */
function windowBounds(query: ThreadItemOutputWindowQuery): { offset: number; maxBytes: number } {
  const offset =
    query.offset === undefined || Number.isNaN(query.offset) || query.offset < 0
      ? 0
      : Math.floor(Math.min(query.offset, Number.MAX_SAFE_INTEGER));
  const maxBytes =
    query.maxBytes === undefined || Number.isNaN(query.maxBytes)
      ? THREAD_ITEM_OUTPUT_WINDOW_DEFAULT_BYTES
      : Math.min(THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES, Math.max(1, Math.floor(query.maxBytes)));
  return { offset, maxBytes };
}

/** The window of a join's `bytes` a query asks for. */
function windowOf(
  bytes: Buffer,
  query: ThreadItemOutputWindowQuery,
  join: { toolUseId: string; complete: boolean; truncated: boolean }
): ThreadItemOutputWindowResponse {
  const { offset, maxBytes } = windowBounds(query);
  const { start, end } = utf8Window(bytes, offset, maxBytes);
  return {
    toolUseId: join.toolUseId,
    offset: start,
    text: bytes.toString("utf8", start, end),
    totalBytes: bytes.length,
    ...(end < bytes.length ? { nextOffset: end } : {}),
    complete: join.complete,
    truncated: join.truncated
  };
}

/** One window of a whole join — the answer of a store that keeps no cache (the orchestrator's fallback). */
export function toolOutputWindow(
  joined: ThreadItemOutputResponse,
  query: ThreadItemOutputWindowQuery
): ThreadItemOutputWindowResponse {
  return windowOf(Buffer.from(joined.output, "utf8"), query, joined);
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** The first capacity a join's buffer grows to. */
const INITIAL_JOIN_CAPACITY = 4 * 1024;

/**
 * The join of ONE call, built one event at a time: {@link joinToolOutput}'s
 * output for that call over the events pushed so far, kept as its UTF-8 bytes
 * so a window is a slice. The bytes are always `Buffer.from(output)` of the
 * join as it stands: a trailing lone high surrogate is held back, reading as
 * U+FFFD (3 bytes) until its low half arrives and the two encode as one
 * 4-byte character — what `Buffer.from` of the longer join says.
 *
 * Keyed by call, never by item: which call an item names is its own question
 * ({@link nextItemWrite}), so an item re-pointed at another call, or first
 * seen in a log's tail, never makes a join rebuild — the other call's join is
 * a join of its own.
 */
export class ToolOutputJoin {
  private buffer: Buffer = Buffer.alloc(0);
  private length = 0;
  /** A high surrogate that ended the text so far: its low half may start the next piece. */
  private pendingHigh = "";
  private readonly counters: JoinCounters = { bytes: 0, complete: false, truncated: false };

  constructor(
    readonly toolUseId: string,
    private readonly maxBytes: number = THREAD_ITEM_OUTPUT_MAX_BYTES
  ) {}

  push(event: DomainEvent): void {
    const piece = joinStep(this.counters, event, this.toolUseId, this.maxBytes);
    if (piece !== undefined) this.append(piece);
  }

  get complete(): boolean {
    return this.counters.complete;
  }

  get truncated(): boolean {
    return this.counters.truncated;
  }

  /** UTF-8 bytes of the join as it stands. */
  get totalBytes(): number {
    return this.length + (this.pendingHigh === "" ? 0 : 3);
  }

  /** The bytes this join holds in memory — its buffer, grown ahead of its text — for the cache's budget. */
  get capacity(): number {
    return this.buffer.length;
  }

  /**
   * The join's bytes: exactly `Buffer.from(output, "utf8")`. A view of the
   * join's own buffer, valid until the next {@link push}.
   */
  bytes(): Buffer {
    if (this.pendingHigh === "") return this.buffer.subarray(0, this.length);
    // U+FFFD in the spare room past the text: the next piece overwrites it.
    this.reserve(this.length + 3);
    this.buffer[this.length] = 0xef;
    this.buffer[this.length + 1] = 0xbf;
    this.buffer[this.length + 2] = 0xbd;
    return this.buffer.subarray(0, this.length + 3);
  }

  /** The window of the join a query asks for (`utf8Window`). */
  window(query: ThreadItemOutputWindowQuery): ThreadItemOutputWindowResponse {
    return windowOf(this.bytes(), query, this);
  }

  private append(piece: string): void {
    let text = this.pendingHigh + piece;
    this.pendingHigh = "";
    if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
      // Lone for now: a high surrogate before it would have paired with it.
      this.pendingHigh = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (text.length === 0) return;
    this.reserve(this.length + Buffer.byteLength(text, "utf8"));
    this.length += this.buffer.write(text, this.length, "utf8");
  }

  /**
   * Room for `needed` bytes, doubling. The join's real size never passes the
   * cap it is counted against (a split pair only makes it smaller), so this
   * stops growing within a few bytes of `maxBytes`.
   */
  private reserve(needed: number): void {
    if (needed <= this.buffer.length) return;
    const doubled = Math.max(INITIAL_JOIN_CAPACITY, this.buffer.length * 2);
    const grown = Buffer.alloc(Math.max(needed, Math.min(doubled, this.maxBytes + 3)));
    this.buffer.copy(grown, 0, 0, this.length);
    this.buffer = grown;
  }
}
