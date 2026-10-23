/**
 * Agent host — where each of a thread's newest lines starts in `events.ndjson`, so a reconnect's
 * `GET …/events?after=N` reads the log from line `N + 1` instead of decoding all of it
 * (`ThreadStore.readTail`).
 *
 * A cache in memory only, filled from `append`'s own positions and bounded to the newest
 * {@link REPLAY_CURSOR_CAPACITY} sequences (the replay's own row cap): a reconnect further back
 * than that answers a snapshot anyway. Never trusted on its own — the store reads through
 * `readEventsFrom`, which checks that the line at the offset carries the expected sequence, and
 * falls back to the whole log on any doubt. A fresh host (a restart, a handover) starts empty and
 * fills again with the thread's next appends.
 */

import { AGENT_CHAT_REPLAY_MAX_EVENTS } from "@orquester/api/agent-chat";

import type { EventPosition } from "../services.ts";

/** How many of a thread's newest sequences the ring remembers. */
export const REPLAY_CURSOR_CAPACITY = AGENT_CHAT_REPLAY_MAX_EVENTS;

export class ReplayCursorRing {
  // Two flat arrays indexed by `seq % capacity`: a few KB per thread, no object per line.
  private readonly seqs: Float64Array;
  private readonly offsets: Float64Array;

  constructor(private readonly capacity = REPLAY_CURSOR_CAPACITY) {
    this.seqs = new Float64Array(capacity);
    this.offsets = new Float64Array(capacity);
  }

  /** Remember where each appended line starts. */
  note(positions: readonly EventPosition[]): void {
    for (const position of positions) {
      const slot = position.seq % this.capacity;
      this.seqs[slot] = position.seq;
      this.offsets[slot] = position.byteOffset;
    }
  }

  /** The byte offset of `seq`'s line, or undefined when the ring no longer (or never) held it. */
  offsetOf(seq: number): number | undefined {
    if (!Number.isSafeInteger(seq) || seq <= 0) return undefined;
    const slot = seq % this.capacity;
    return this.seqs[slot] === seq ? this.offsets[slot] : undefined;
  }

  /** Forget every position: the log was rewritten under them. */
  clear(): void {
    this.seqs.fill(0);
  }
}
