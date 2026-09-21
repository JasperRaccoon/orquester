/**
 * The write-side delta buffer (spec §5.6).
 *
 * Assistant, reasoning and plan deltas buffer per message and flush every
 * **250 ms or 8 KB, whichever first**, preferring a paragraph or closed-fence
 * boundary so a flush never splits a code block. Command and file-change
 * output deltas use the same buffer keyed by item id.
 *
 * It is a write reducer, not just a wire one: it sits upstream of
 * `events.ndjson`, so a token-by-token provider becomes a few appended events
 * per second per message.
 *
 * *T3: `ProviderRuntimeIngestion.ts:117-122` — `MIN_ASSISTANT_DELIVERY_INTERVAL_MS = 400`,
 * `MAX_BUFFERED_ASSISTANT_CHARS = 24_000`; `:1325-1370` — paragraph split, pacing check and the
 * over-budget flush valve. differs: 250 ms / 8 KB here, and a real timer rather than
 * flush-on-next-delta, so a model that stops mid-paragraph still delivers within one window.*
 */

import { splitBufferedText } from "./text-boundary.ts";

/** §5.6: flush every 250 ms … */
export const BATCH_INTERVAL_MS = 250;
/** … or 8 KB, whichever first. Measured in UTF-16 code units, the cheap bound. */
export const BATCH_MAX_CHARS = 8 * 1024;

export type TimerHandle = unknown;

export interface BufferTimers {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
}

/**
 * One buffered stream. Owned by {@link DeltaBufferSet}; the set is what
 * ingestion holds, because a flush has to know which message it belongs to.
 */
interface BufferEntry {
  text: string;
  /** Epoch millis of the last delivery, for pacing. */
  lastDeliveredAtMs: number;
  /** Stamp the first delta of the block carried, so "Thought for …" measures the model. */
  openedAt: string;
  timer: TimerHandle | null;
}

export interface BufferFlush {
  key: string;
  text: string;
  openedAt: string;
}

/**
 * A set of independently paced buffers, keyed by message id (or item id for
 * tool output). `onFlush` is called synchronously from `append`, and
 * asynchronously from the 250 ms timer.
 */
export class DeltaBufferSet {
  readonly #timers: BufferTimers;
  readonly #now: () => number;
  readonly #onTimerFlush: (flush: BufferFlush) => void;
  readonly #entries = new Map<string, BufferEntry>();

  constructor(options: {
    timers: BufferTimers;
    now: () => number;
    /** Called when the 250 ms window expires. `append` returns its flush instead. */
    onTimerFlush: (flush: BufferFlush) => void;
  }) {
    this.#timers = options.timers;
    this.#now = options.now;
    this.#onTimerFlush = options.onTimerFlush;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  /** The stamp the buffer's first delta carried, or `fallback`. */
  openedAt(key: string, fallback: string): string {
    const entry = this.#entries.get(key);
    return entry !== undefined && entry.openedAt.length > 0 ? entry.openedAt : fallback;
  }

  /**
   * Append a delta. Returns the text to deliver now, or `""` when it stays
   * buffered. Delivers early on a paragraph/fence boundary once the 250 ms
   * pacing window has passed, and unconditionally once the buffer passes 8 KB.
   */
  append(key: string, delta: string, createdAt: string): string {
    const entry = this.#entries.get(key) ?? {
      text: "",
      lastDeliveredAtMs: 0,
      openedAt: createdAt,
      timer: null
    };
    entry.text += delta;
    this.#entries.set(key, entry);

    const nowMs = this.#now();
    const { ready, rest } = splitBufferedText(entry.text);
    const paced =
      entry.lastDeliveredAtMs === 0 || nowMs - entry.lastDeliveredAtMs >= BATCH_INTERVAL_MS;

    if (paced && ready.trim().length > 0 && rest.length <= BATCH_MAX_CHARS) {
      entry.lastDeliveredAtMs = nowMs;
      if (rest.length > 0) {
        entry.text = rest;
        this.#arm(key, entry);
      } else {
        this.#dispose(key, entry);
      }
      return ready;
    }

    if (entry.text.length > BATCH_MAX_CHARS) {
      // Safety valve: the 8 KB bound is memory, so it wins over the fence rule.
      const text = entry.text;
      entry.lastDeliveredAtMs = nowMs;
      this.#dispose(key, entry);
      return text;
    }

    this.#arm(key, entry);
    return "";
  }

  /** Take everything buffered for a key and forget it. */
  take(key: string): string {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return "";
    }
    const text = entry.text;
    this.#dispose(key, entry);
    return text;
  }

  /** Drop a key's buffer without delivering it. */
  discard(key: string): void {
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      this.#dispose(key, entry);
    }
  }

  /** Every pending timer, cancelled. Used by `clear()` and on shutdown. */
  clear(): void {
    for (const [key, entry] of [...this.#entries]) {
      this.#dispose(key, entry);
    }
  }

  #arm(key: string, entry: BufferEntry): void {
    if (entry.timer !== null) {
      return;
    }
    entry.timer = this.#timers.setTimer(() => {
      const current = this.#entries.get(key);
      if (current === undefined) {
        return;
      }
      current.timer = null;
      const { ready, rest, openFence } = splitBufferedText(current.text);
      if (ready.trim().length > 0) {
        current.lastDeliveredAtMs = this.#now();
        const openedAt = current.openedAt;
        if (rest.length > 0) {
          current.text = rest;
          this.#arm(key, current);
        } else {
          this.#dispose(key, current);
        }
        this.#onTimerFlush({ key, text: ready, openedAt });
        return;
      }
      if (openFence) {
        // "a flush never splits a code block": hold the block one more window.
        // The 8 KB valve in `append` still bounds the buffer.
        this.#arm(key, current);
        return;
      }
      if (current.text.trim().length === 0) {
        this.#arm(key, current);
        return;
      }
      const text = current.text;
      const openedAt = current.openedAt;
      current.lastDeliveredAtMs = this.#now();
      this.#dispose(key, current);
      this.#onTimerFlush({ key, text, openedAt });
    }, BATCH_INTERVAL_MS);
  }

  #dispose(key: string, entry: BufferEntry): void {
    if (entry.timer !== null) {
      this.#timers.clearTimer(entry.timer);
      entry.timer = null;
    }
    this.#entries.delete(key);
  }
}
