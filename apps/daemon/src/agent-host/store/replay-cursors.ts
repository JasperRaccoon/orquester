/**
 * Agent host — where each of a thread's newest lines starts in `events.ndjson`, so a reconnect's
 * `GET …/events?after=N` reads the log from line `N + 1` instead of decoding all of it
 * (`ThreadStore.readTail`).
 *
 * A cache in memory only, filled from `append`'s own positions. Never trusted on its own — the
 * store reads through `readEventsFrom`, which checks that the line at the offset carries the
 * expected sequence, and falls back to the whole log on any doubt — so dropping it is always safe:
 * the next reconnect reads the whole log, and the next append starts a new one.
 *
 * Memory policy (the store never unloads a thread, so the cache must not live as long as it):
 * - it grows with the thread's appends — one number per line — and keeps the newest
 *   {@link REPLAY_CURSOR_CAPACITY} sequences only (the replay's own row cap: a reconnect further
 *   back answers a snapshot anyway);
 * - the store drops a thread's cursors once it has seen no append for
 *   {@link REPLAY_CURSOR_IDLE_MS} (`dropIdleReplayCursors`, on an unref'd timer), and on `close`.
 *   A client that reconnects after that with nothing new is answered without any read
 *   (`measureReplay`'s up-to-date check); one with something new costs one whole read.
 * A fresh host (a restart, a handover) starts with none.
 */

import { AGENT_CHAT_REPLAY_MAX_EVENTS } from "@orquester/api/agent-chat";

import type { EventPosition } from "../services.ts";

/** How many of a thread's newest sequences the cursors remember. */
export const REPLAY_CURSOR_CAPACITY = AGENT_CHAT_REPLAY_MAX_EVENTS;

/** A thread with no append for this long loses its cursors. */
export const REPLAY_CURSOR_IDLE_MS = 10 * 60_000;

/** Front trims happen in batches of this many, so a full ring does not shift on every append. */
const TRIM_SLACK = 256;

export class ReplayCursorRing {
  /** Byte offsets of consecutive sequences, starting at {@link firstSeq}. */
  private offsets: number[] = [];
  private firstSeq = 0;
  /** When the last position was noted (epoch ms): what the idle drop reads. */
  lastNotedAtMs: number;

  constructor(
    nowMs: number,
    private readonly capacity = REPLAY_CURSOR_CAPACITY
  ) {
    this.lastNotedAtMs = nowMs;
  }

  /** How many sequences it holds now. */
  get size(): number {
    return this.offsets.length;
  }

  /** Remember where each appended line starts. A gap in the sequences starts over from it. */
  note(positions: readonly EventPosition[], nowMs: number): void {
    for (const position of positions) {
      if (this.offsets.length === 0 || position.seq !== this.firstSeq + this.offsets.length) {
        this.offsets = [];
        this.firstSeq = position.seq;
      }
      this.offsets.push(position.byteOffset);
    }
    const excess = this.offsets.length - this.capacity;
    if (excess >= TRIM_SLACK || (excess > 0 && this.capacity < TRIM_SLACK)) {
      this.offsets.splice(0, excess);
      this.firstSeq += excess;
    }
    this.lastNotedAtMs = nowMs;
  }

  /** The byte offset of `seq`'s line, or undefined when it does not (or no longer) hold it. */
  offsetOf(seq: number): number | undefined {
    const index = seq - this.firstSeq;
    if (!Number.isSafeInteger(seq) || this.offsets.length === 0 || index < 0 || index >= this.offsets.length) {
      return undefined;
    }
    // Beyond the newest `capacity` (a trim not due yet) it is not offered either.
    return this.offsets.length - index > this.capacity ? undefined : this.offsets[index];
  }

  /** Forget every position: the log was rewritten under them. */
  clear(): void {
    this.offsets = [];
    this.firstSeq = 0;
  }
}
