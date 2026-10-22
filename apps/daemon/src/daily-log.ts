// The daemon's request log: one file per local day (`packages/config` dailyLogFile), rolled over
// at local midnight and when a file reaches its size cap, with files older than the retention
// deleted at boot and after every midnight.
//
// Pino writes one whole line per `write` call, and a rollover happens only between calls: the
// next line goes to a freshly opened file while the previous stream is ended, which flushes what
// it still queues — no line is split or lost. The day is checked on every write, so a clock that
// jumps (or a host that slept through midnight) never logs into yesterday's file; the timer only
// makes a quiet daemon prune on time.

import { createWriteStream, mkdirSync, readdirSync, statSync, type WriteStream } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DAILY_LOG_RETENTION_DAYS, dailyLogFile, localDateStamp, parseDailyLogFileName } from "@orquester/config";

/** A day's file is cut at this size and continued in `<day>.<n>.log`. */
export const DAILY_LOG_MAX_BYTES = 64 * 1024 * 1024;

export interface DailyLogClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: DailyLogClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

export interface DailyLogOptions {
  /** Read at every open, so a changed logs directory takes effect at the next rollover. */
  logsDir: () => string;
  retentionDays?: number;
  maxBytes?: number;
  clock?: DailyLogClock;
  /** A file that cannot be opened, written or pruned (the daemon keeps running). */
  onError?: (error: unknown) => void;
}

/** The first moment of the local day after `ms`. */
function nextLocalMidnight(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

export class DailyLogStream {
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly clock: DailyLogClock;
  private readonly onError: (error: unknown) => void;
  private stream: WriteStream | null = null;
  private day = "";
  private part = 0;
  private bytes = 0;
  private dayEndsAt = 0;
  private timer: unknown = null;
  private closed = false;
  /** Streams being ended, and the prune in flight: what `settled` / `close` wait for. */
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: DailyLogOptions) {
    this.retentionDays = options.retentionDays ?? DAILY_LOG_RETENTION_DAYS;
    this.maxBytes = options.maxBytes ?? DAILY_LOG_MAX_BYTES;
    this.clock = options.clock ?? systemClock;
    this.onError = options.onError ?? ((error) => console.error("[daily-log]", error));
    this.open(this.clock.now(), false);
    this.track(this.prune());
    this.schedule();
  }

  /** The file lines are written to now. */
  get path(): string {
    return this.stream?.path.toString() ?? "";
  }

  write(chunk: string): boolean {
    if (this.closed) return false;
    const now = this.clock.now();
    const size = Buffer.byteLength(chunk);
    if (now >= this.dayEndsAt) this.rollover(now, false);
    else if (this.bytes > 0 && this.bytes + size > this.maxBytes) this.rollover(now, true);
    this.bytes += size;
    return this.stream!.write(chunk);
  }

  /** Resolves once ended files are flushed and the last prune finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  async close(): Promise<void> {
    if (this.closed) return this.settled();
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.stream) this.track(this.end(this.stream));
    this.stream = null;
    await this.settled();
  }

  /** Delete daily files from before the retention window (today and the last N days are kept). */
  async prune(): Promise<void> {
    const now = new Date(this.clock.now());
    const cutoff = localDateStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - this.retentionDays));
    const dir = this.options.logsDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError(error);
      return;
    }
    for (const name of names) {
      const parsed = parseDailyLogFileName(name);
      if (!parsed || parsed.day >= cutoff) continue;
      try {
        await unlink(join(dir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError(error);
      }
    }
  }

  /**
   * Open the file for the day of `now`: the day's last part (a daemon that ran earlier today
   * continues it), or after a size rollover the next one — skipping any part already at the cap.
   */
  private open(now: number, nextPart: boolean): void {
    const dir = this.options.logsDir();
    const date = new Date(now);
    const day = localDateStamp(date);
    let part = nextPart && day === this.day ? this.part + 1 : 0;
    try {
      mkdirSync(dir, { recursive: true });
      part = Math.max(part, this.lastPart(dir, day));
    } catch (error) {
      this.onError(error);
    }
    let bytes = this.sizeOf(dailyLogFile(dir, date, part));
    while (bytes >= this.maxBytes) {
      part += 1;
      bytes = this.sizeOf(dailyLogFile(dir, date, part));
    }
    const stream = createWriteStream(dailyLogFile(dir, date, part), { flags: "a" });
    stream.on("error", (error) => this.onError(error));
    this.stream = stream;
    this.day = day;
    this.part = part;
    this.bytes = bytes;
    this.dayEndsAt = nextLocalMidnight(now);
  }

  private rollover(now: number, forSize: boolean): void {
    const previous = this.stream;
    this.open(now, forSize);
    if (previous) this.track(this.end(previous));
  }

  private schedule(): void {
    if (this.closed) return;
    const now = this.clock.now();
    this.timer = this.clock.setTimeout(() => this.onMidnight(), Math.max(0, nextLocalMidnight(now) - now));
  }

  private onMidnight(): void {
    this.timer = null;
    if (this.closed) return;
    const now = this.clock.now();
    if (now >= this.dayEndsAt) this.rollover(now, false);
    this.track(this.prune());
    this.schedule();
  }

  private lastPart(dir: string, day: string): number {
    let last = 0;
    for (const name of readdirSync(dir)) {
      const parsed = parseDailyLogFileName(name);
      if (parsed && parsed.day === day && parsed.part > last) last = parsed.part;
    }
    return last;
  }

  private sizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private end(stream: WriteStream): Promise<void> {
    return new Promise((resolve) => {
      if (stream.destroyed) return resolve();
      stream.once("error", () => resolve());
      stream.end(() => resolve());
    });
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}
