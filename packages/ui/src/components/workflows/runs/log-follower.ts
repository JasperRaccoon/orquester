/**
 * Reading a block's log by WINDOWS (`…/log?offset=&maxBytes=`, no follow):
 * every answer carries the daemon's position in the raw file
 * (`X-Log-Next-Offset`), so a read that fails or a poll that comes back later
 * resumes exactly where the last one ended — never from the length of the
 * (redacted) text, and never twice. One read in flight at a time, one timer at
 * a time; `stop()` ends it for good.
 *
 * - A window short of the file's end: the next one is read at once, so a
 *   finished block's whole log is read (not just its first window).
 * - At the end while the block is live (the prop, or the daemon's
 *   `X-Log-Live`): read again after `pollMs`.
 * - At the end of a finished log: done.
 * - A failed read while live: retried after `retryMs` from the same offset;
 *   while not live: reported, and done.
 */

import type { WorkflowLogWindow } from "../../../lib/api-client";

export interface LogFollowerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: LogFollowerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export interface LogFollowerOptions {
  read(offset: number, signal: AbortSignal): Promise<WorkflowLogWindow>;
  /** Whether the block is running (the run view's word). */
  live(): boolean;
  onText(text: string): void;
  /** Reading has settled into a state: waiting on the next poll, done, or failed. */
  onState(state: { following: boolean; loading: boolean; error: string | null }): void;
  offset?: number;
  pollMs?: number;
  retryMs?: number;
  timers?: LogFollowerTimers;
  errorText?: (error: unknown) => string;
}

export interface LogFollower {
  /** The raw byte offset the next read starts at. */
  readonly offset: number;
  readonly running: boolean;
  /** Read again now if idle (the block went live again). */
  wake(): void;
  stop(): void;
}

export const LOG_POLL_MS = 1_000;
export const LOG_RETRY_MS = 3_000;

export function startLogFollower(options: LogFollowerOptions): LogFollower {
  const timers = options.timers ?? REAL_TIMERS;
  const pollMs = options.pollMs ?? LOG_POLL_MS;
  const retryMs = options.retryMs ?? LOG_RETRY_MS;
  let offset = Math.max(0, options.offset ?? 0);
  let stopped = false;
  let reading = false;
  let timer: unknown = null;
  let done = false;
  let controller: AbortController | null = null;

  const schedule = (ms: number): void => {
    if (timer !== null) timers.clear(timer);
    timer = timers.set(() => {
      timer = null;
      void step();
    }, ms);
  };

  const step = async (): Promise<void> => {
    if (stopped || reading) return;
    reading = true;
    done = false;
    controller = new AbortController();
    let window: WorkflowLogWindow;
    try {
      window = await options.read(offset, controller.signal);
    } catch (error) {
      reading = false;
      if (stopped) return;
      if (options.live()) {
        options.onState({ following: true, loading: false, error: null });
        schedule(retryMs);
      } else {
        done = true;
        options.onState({
          following: false,
          loading: false,
          error: options.errorText ? options.errorText(error) : "The log could not be read."
        });
      }
      return;
    }
    reading = false;
    if (stopped) return;
    const advanced = window.nextOffset > offset;
    offset = Math.max(offset, window.nextOffset);
    if (window.text.length > 0) options.onText(window.text);
    const live = window.live || options.live();
    if (!window.eof && advanced) {
      // More is already there: read on at once (a microtask, not a timer).
      void Promise.resolve().then(step);
      return;
    }
    // At the end — or held at a partial last line the daemon keeps back while live.
    if (live) {
      options.onState({ following: true, loading: false, error: null });
      schedule(pollMs);
      return;
    }
    done = true;
    options.onState({ following: false, loading: false, error: null });
  };

  void step();

  return {
    get offset() {
      return offset;
    },
    get running() {
      return !stopped && !done;
    },
    wake() {
      if (stopped || reading) return;
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
      void step();
    },
    stop() {
      stopped = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
      controller?.abort();
    }
  };
}

/** Read a whole log, window after window, to the end it has now (the download). */
export async function readWholeLog(
  read: (offset: number) => Promise<WorkflowLogWindow>,
  options: { maxWindows?: number } = {}
): Promise<string[]> {
  const parts: string[] = [];
  let offset = 0;
  const max = options.maxWindows ?? 10_000;
  for (let index = 0; index < max; index += 1) {
    const window = await read(offset);
    if (window.text.length > 0) parts.push(window.text);
    if (window.eof || window.nextOffset <= offset) break;
    offset = window.nextOffset;
  }
  return parts;
}
