/**
 * The store's in-memory cache behind `GET …/items/:itemId/output?offset=&maxBytes=`
 * (one window of a tool call's streamed output) and `GET …/items/:itemId`
 * (an item's newest write), so a reader paging a long output — the MCP's
 * `read_tool_output` above all — reads the thread's log whole once, not twice
 * per page.
 *
 * Two kinds of entry, each a position in the log plus what was folded from
 * the lines before it:
 * - an **item cursor**, keyed `(threadId, itemId)`: the item's newest write
 *   ({@link ItemWrite} — the line of an activity and the call it names, a
 *   message, or nothing), which is what `readItem` and `callOf` read the whole
 *   log backwards for;
 * - a **join**, keyed `(threadId, toolUseId)`: the call's streamed output so
 *   far ({@link ToolOutputJoin}). Keyed by CALL, never by item, so an item
 *   re-pointed at another call, or first seen in the log's tail, never makes a
 *   join rebuild: the other call's join is an entry of its own.
 *
 * The log is the authority and this is a cache of it (as `state.json` and
 * `index.sqlite` are):
 * - **Only committed bytes are read** — up to the length the store's appends
 *   have reported (`entry.logBytes`, after the first load cut any torn tail),
 *   never an append still in flight, whose batch may yet be rolled back.
 * - **An entry is extended by the tail alone**, decoded by `readLog`'s rules:
 *   a line that does not decode, or whose `seq` does not climb, ends the log
 *   for every reader, and the entry's cursor never passes it.
 * - **Any doubt rebuilds from byte 0**: a log shorter than the cursor, or a
 *   first line past the cursor that does not decode or does not carry the
 *   cursor's `seq + 1` — the fold snapshot's continuity rule
 *   (`readEventsFrom`).
 * - **A revert invalidates nothing**: the join reads the raw log, where a
 *   `thread.reverted` is one more line (`tool-output.ts`).
 * - **`deleteThread` drops the thread's entries** and bumps its generation,
 *   so a scan that started before the delete never publishes into the thread
 *   a recreated log answers for; its reader starts over.
 * - **One scan per entry at a time** (a promise chain per key), and a line is
 *   applied only past the cursor's `seq`: two readers of one call never join
 *   a chunk twice.
 *
 * Bounded: {@link TOOL_OUTPUT_CACHE_MAX_BYTES} of join buffers,
 * {@link TOOL_OUTPUT_CACHE_MAX_ENTRIES} item cursors (and as many joins),
 * least recently used first out; an entry idle for
 * {@link TOOL_OUTPUT_CACHE_IDLE_MS} expires the next time the cache is
 * touched — no timer. An evicted entry is rebuilt from the log: slower, never
 * wrong. Nothing is built at boot, and a scan yields to the loop like every
 * other decode of a log.
 */

import * as fsp from "node:fs/promises";

import type {
  DomainEvent,
  ThreadItemOutputWindowQuery,
  ThreadItemOutputWindowResponse
} from "@orquester/api/agent-chat";

import type { EventPosition } from "../services.ts";
import { ToolOutputJoin, nextItemWrite, type ItemWrite } from "./tool-output.ts";

/** The join buffers the cache holds at most: room for four full 8 MiB joins. */
export const TOOL_OUTPUT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** The item cursors the cache holds at most (a few hundred bytes each), and as many joins. */
export const TOOL_OUTPUT_CACHE_MAX_ENTRIES = 1024;

/** An entry nobody read for this long is dropped the next time the cache is touched. */
export const TOOL_OUTPUT_CACHE_IDLE_MS = 10 * 60 * 1000;

/** How much of the log one read takes while an entry catches up. */
const SCAN_WINDOW_BYTES = 4 * 1024 * 1024;

/** A reader whose thread was deleted under it this many times in a row gives up. */
const MAX_ATTEMPTS = 3;

export interface ToolOutputCacheOptions {
  /** The thread's `events.ndjson`. */
  eventsPath(threadId: string): string;
  /** The log's committed length: what the store's appends have reported, a torn tail already cut. */
  committedLength(threadId: string): Promise<number>;
  /** The store's own line decoder (`JSON.parse` + the domain-event envelope), null for a line that does not decode. */
  decodeLine(line: string): DomainEvent | null;
  /** Milliseconds, for the idle expiry. */
  now(): number;
  maxJoinBytes: number;
  maxEntries: number;
  idleMs: number;
  /** A scan yields to the loop after this much synchronous decoding (the store's `DECODE_SLICE_MS`). */
  decodeSliceMs: number;
  yieldToLoop(): Promise<void>;
  /** Test seam: every read of a log, `[fromByte, toByte)`. */
  onLogRead?: (threadId: string, fromByte: number, toByte: number) => void;
}

export interface ToolOutputCache {
  /** The item's newest write, as of the committed log. */
  itemWrite(threadId: string, itemId: string): Promise<ItemWrite>;
  /** Drop an item's cursor: the line it recorded no longer checks out, so the next read starts over. */
  forgetItem(threadId: string, itemId: string): Promise<void>;
  /** One window of the join of the call the item names, or null when it names none. */
  window(
    threadId: string,
    itemId: string,
    query: ThreadItemOutputWindowQuery
  ): Promise<ThreadItemOutputWindowResponse | null>;
  /** The thread was deleted: its entries go, and a scan already running publishes nothing. */
  dropThread(threadId: string): void;
  clear(): void;
}

/** Where an entry has read the log to: just past its last decoded line, and that line's `seq`. */
interface LogCursor {
  byteOffset: number;
  seq: number;
  /**
   * The line at `byteOffset` is complete and does not decode, or its `seq`
   * does not climb: the log ends there for every reader (`readLog`), for
   * good — a committed line never changes.
   */
  stopped: boolean;
}

const LOG_START: LogCursor = { byteOffset: 0, seq: 0, stopped: false };

interface Entry {
  threadId: string;
  /** The thread's generation the entry was built under. */
  generation: number;
  cursor: LogCursor;
  usedAt: number;
}

interface ItemEntry extends Entry {
  itemId: string;
  write: ItemWrite;
}

interface JoinEntry extends Entry {
  join: ToolOutputJoin;
}

/** The thread was deleted while an entry of it was being read. */
const STALE = Symbol("stale");

export function createToolOutputCache(options: ToolOutputCacheOptions): ToolOutputCache {
  const items = new Map<string, ItemEntry>();
  const joins = new Map<string, JoinEntry>();
  /** The last scan queued per key: the next one runs after it. */
  const chains = new Map<string, Promise<unknown>>();
  const generations = new Map<string, number>();
  let epoch = 0;
  /** Every thread's generation until its first delete; moved by `clear`. */
  let baseline = 0;

  const generationOf = (threadId: string): number => generations.get(threadId) ?? baseline;
  // A thread id never holds a newline (`isSafeThreadId`), so the pair is unambiguous.
  const keyOf = (threadId: string, id: string): string => `${threadId}\n${id}`;

  function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key);
    const next = previous === undefined ? task() : previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return next;
  }

  /** Drop every entry nobody has read for `idleMs`: the maps are in least-recently-used order. */
  function expireIdle(): void {
    const cutoff = options.now() - options.idleMs;
    for (const map of [items, joins] as Array<Map<string, Entry>>) {
      for (const [key, entry] of map) {
        if (entry.usedAt > cutoff) break;
        map.delete(key);
      }
    }
  }

  /**
   * Read the log from the entry's cursor to `to`, handing `visit` every line
   * that decodes with a climbing `seq` and moving the cursor past it — line
   * by line, so the entry and its cursor agree whenever this stops. Streamed
   * a window at a time, never the whole file as one string, and yielding to
   * the loop like `readLog`. `"mismatch"` when the log is not the one the
   * cursor was read from: gone, or its first line past a warm cursor does not
   * decode or does not carry the cursor's `seq + 1`.
   */
  async function scan<E extends Entry>(
    entry: E,
    to: number,
    visit: (entry: E, event: DomainEvent, position: EventPosition) => void
  ): Promise<"ok" | "mismatch"> {
    const from = entry.cursor.byteOffset;
    const warm = entry.cursor.seq > 0;
    options.onLogRead?.(entry.threadId, from, to);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(options.eventsPath(entry.threadId), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return warm ? "mismatch" : "ok";
      throw error;
    }
    try {
      const window = Buffer.alloc(Math.min(SCAN_WINDOW_BYTES, to - from));
      let position = from;
      /** The log offset of `bytes[0]`: the start of the line a window cut in two. */
      let base = from;
      let carry: Buffer | null = null;
      let first = true;
      let sliceStartedAt = Date.now();
      while (position < to) {
        const { bytesRead } = await handle.read(window, 0, Math.min(window.length, to - position), position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const bytes: Buffer =
          carry === null ? window.subarray(0, bytesRead) : Buffer.concat([carry, window.subarray(0, bytesRead)]);
        let start = 0;
        for (;;) {
          const newline = bytes.indexOf(0x0a, start);
          if (newline === -1) break;
          const byteOffset = base + start;
          const byteLength = newline - start + 1;
          const event = newline > start ? options.decodeLine(bytes.toString("utf8", start, newline)) : null;
          // The line right past a warm cursor is the next one the store
          // wrote — never empty, as the store writes none — or this is
          // another log: a rewritten one can put a newline exactly there.
          if (first && warm && event?.seq !== entry.cursor.seq + 1) return "mismatch";
          first = false;
          if (newline === start) {
            // Every reader skips an empty line; the cursor steps over it.
            entry.cursor = { ...entry.cursor, byteOffset: byteOffset + 1 };
          } else {
            if (event === null || event.seq <= entry.cursor.seq) {
              entry.cursor = { ...entry.cursor, stopped: true };
              return "ok";
            }
            visit(entry, event, { seq: event.seq, byteOffset, byteLength });
            entry.cursor = { byteOffset: byteOffset + byteLength, seq: event.seq, stopped: false };
            if (Date.now() - sliceStartedAt >= options.decodeSliceMs) {
              await options.yieldToLoop();
              sliceStartedAt = Date.now();
            }
          }
          start = newline + 1;
        }
        // A copy: `window` is read into again.
        carry = start < bytes.length ? Buffer.from(bytes.subarray(start)) : null;
        base += start;
      }
      return "ok";
    } finally {
      await handle.close();
    }
  }

  /** Extend an entry to the committed log: by its tail, or — on any doubt — from byte 0. */
  async function catchUp<E extends Entry>(
    entry: E,
    visit: (entry: E, event: DomainEvent, position: EventPosition) => void,
    restart: (entry: E) => void
  ): Promise<void> {
    const committed = await options.committedLength(entry.threadId);
    if (committed < entry.cursor.byteOffset) restart(entry);
    if (entry.cursor.stopped || committed === entry.cursor.byteOffset) return;
    if ((await scan(entry, committed, visit)) === "mismatch") {
      restart(entry);
      await scan(entry, committed, visit);
    }
  }

  /**
   * The entry under `key`, caught up and marked most recently used — or a new
   * one built from the log's start — unless the thread was deleted while it
   * was read ({@link STALE}). A scan that throws drops the entry.
   */
  async function refresh<E extends Entry>(
    map: Map<string, E>,
    key: string,
    threadId: string,
    create: (generation: number) => E,
    visit: (entry: E, event: DomainEvent, position: EventPosition) => void,
    restart: (entry: E) => void
  ): Promise<E | typeof STALE> {
    expireIdle();
    const generation = generationOf(threadId);
    let entry = map.get(key);
    if (entry === undefined || entry.generation !== generation) entry = create(generation);
    try {
      await catchUp(entry, visit, restart);
    } catch (error) {
      if (map.get(key) === entry) map.delete(key);
      throw error;
    }
    if (generationOf(threadId) !== generation) {
      if (map.get(key) === entry) map.delete(key);
      return STALE;
    }
    map.delete(key);
    entry.usedAt = options.now();
    map.set(key, entry);
    return entry;
  }

  const visitItem = (entry: ItemEntry, event: DomainEvent, position: EventPosition): void => {
    entry.write = nextItemWrite(entry.write, event, entry.itemId, position);
  };
  const restartItem = (entry: ItemEntry): void => {
    entry.cursor = LOG_START;
    entry.write = { kind: "none" };
  };
  const visitJoin = (entry: JoinEntry, event: DomainEvent): void => {
    entry.join.push(event);
  };
  const restartJoin = (entry: JoinEntry): void => {
    entry.cursor = LOG_START;
    entry.join = new ToolOutputJoin(entry.join.toolUseId);
  };

  function readItemWrite(threadId: string, itemId: string): Promise<ItemWrite | typeof STALE> {
    const key = keyOf(threadId, itemId);
    return serialized(`item\n${key}`, async () => {
      const entry = await refresh(
        items,
        key,
        threadId,
        (generation): ItemEntry => ({ threadId, generation, cursor: LOG_START, usedAt: 0, itemId, write: { kind: "none" } }),
        visitItem,
        restartItem
      );
      if (entry === STALE) return STALE;
      for (const other of items.keys()) {
        if (items.size <= options.maxEntries) break;
        if (other !== key) items.delete(other);
      }
      return entry.write;
    });
  }

  function readJoinWindow(
    threadId: string,
    toolUseId: string,
    query: ThreadItemOutputWindowQuery
  ): Promise<ThreadItemOutputWindowResponse | typeof STALE> {
    const key = keyOf(threadId, toolUseId);
    return serialized(`join\n${key}`, async () => {
      const entry = await refresh(
        joins,
        key,
        threadId,
        (generation): JoinEntry => ({ threadId, generation, cursor: LOG_START, usedAt: 0, join: new ToolOutputJoin(toolUseId) }),
        visitJoin,
        restartJoin
      );
      if (entry === STALE) return STALE;
      let bytes = 0;
      for (const other of joins.values()) bytes += other.join.capacity;
      for (const [other, evicted] of joins) {
        if (bytes <= options.maxJoinBytes && joins.size <= options.maxEntries) break;
        if (other === key) continue;
        joins.delete(other);
        bytes -= evicted.join.capacity;
      }
      // Cut in the same step as the catch-up: the next scan of this call waits for it.
      return entry.join.window(query);
    });
  }

  /** Run a read again when its thread was deleted under it, so no answer mixes two logs. */
  async function untilSettled<T>(threadId: string, read: () => Promise<T | typeof STALE>): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const generation = generationOf(threadId);
      const result = await read();
      if (result !== STALE && generationOf(threadId) === generation) return result;
    }
    throw new Error(`agent-chat: thread ${threadId} was deleted while its log was read`);
  }

  return {
    itemWrite: (threadId, itemId) => untilSettled(threadId, () => readItemWrite(threadId, itemId)),

    forgetItem: (threadId, itemId) => {
      const key = keyOf(threadId, itemId);
      return serialized(`item\n${key}`, async () => {
        items.delete(key);
      });
    },

    window: (threadId, itemId, query) =>
      untilSettled(threadId, async () => {
        const write = await readItemWrite(threadId, itemId);
        if (write === STALE) return STALE;
        const toolUseId = write.kind === "activity" ? write.toolUseId : undefined;
        return toolUseId === undefined ? null : readJoinWindow(threadId, toolUseId, query);
      }),

    dropThread(threadId: string): void {
      epoch += 1;
      generations.set(threadId, epoch);
      for (const [key, entry] of items) if (entry.threadId === threadId) items.delete(key);
      for (const [key, entry] of joins) if (entry.threadId === threadId) joins.delete(key);
    },

    clear(): void {
      epoch += 1;
      baseline = epoch;
      generations.clear();
      items.clear();
      joins.clear();
    }
  };
}
