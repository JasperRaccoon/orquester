// Automated workflows — reading a sandbox attempt's stdout.log / stderr.log for the run view and
// the chunked log route (spec §5.6, §5.7, §7.3).
//
// Windows are cut in BYTES (offsets carry across requests and restarts) at UTF-8 character
// boundaries, and redacted before they are served. A secret must never leak in two halves across
// two windows, so a window reads a little past both of its ends (the longest secret minus one byte)
// and moves an end that falls inside a secret to the secret's end — the secret is then served
// whole, as its placeholder, by exactly one window. While the file may still grow (`holdTail`), the
// last `maxSecretBytes - 1` bytes at its end — possibly the first half of a secret still being
// written — and an incomplete trailing UTF-8 sequence are held back for the next read.

import { open } from "node:fs/promises";

import type { Redactor } from "../contracts.ts";
import { secretPlaceholder, type SecretMatch, type SecretRedactor } from "./redact.ts";

export interface LogWindow {
  /** The redacted text of the window. */
  text: string;
  /** Where the next window starts (a byte offset, at a character boundary). */
  nextOffset: number;
  /** The window reached the end of what the file holds now. */
  eof: boolean;
  /** The file's size when read. */
  size: number;
}

export interface ReadLogWindowOptions {
  /** The file may still grow: hold back a possible secret prefix / partial character at its end. */
  holdTail?: boolean;
}

const DEFAULT_WINDOW_BYTES = 256 * 1024;

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** The length of the UTF-8 sequence a lead byte starts (1 for anything else). */
function sequenceLength(byte: number): number {
  if (byte >= 0xf0 && byte <= 0xf7) return 4;
  if (byte >= 0xe0) return byte <= 0xef ? 3 : 1;
  if (byte >= 0xc0) return 2;
  return 1;
}

/** `end`, moved back so a trailing incomplete UTF-8 sequence of `buf[0..end)` is excluded. */
function trimIncompleteTail(buf: Buffer, from: number, end: number): number {
  let lead = end - 1;
  let seen = 0;
  while (lead >= from && isContinuation(buf[lead]) && seen < 3) {
    lead -= 1;
    seen += 1;
  }
  if (lead < from) {
    return end;
  }
  const need = sequenceLength(buf[lead]!);
  return need > 1 && end - lead < need ? lead : end;
}

/** The nearest character boundary at or before `at` (never before `floor`). */
function boundaryBack(buf: Buffer, at: number, floor: number): number {
  let pos = at;
  while (pos > floor && pos < buf.length && isContinuation(buf[pos])) {
    pos -= 1;
  }
  return pos;
}

/** The nearest character boundary at or after `at`. */
function boundaryForward(buf: Buffer, at: number, limit: number): number {
  let pos = at;
  while (pos < limit && isContinuation(buf[pos])) {
    pos += 1;
  }
  return pos;
}

function hasByteMatches(redactor: Redactor | undefined): redactor is SecretRedactor {
  return (
    redactor !== undefined &&
    typeof (redactor as Partial<SecretRedactor>).byteMatches === "function" &&
    typeof (redactor as Partial<SecretRedactor>).maxSecretBytes === "number"
  );
}

/**
 * Read `[offset, offset + maxBytes)` of a log file (cut to character boundaries, and moved past a
 * secret that straddles either end), redacted. A missing file reads as empty.
 */
export async function readLogWindow(
  path: string,
  offset: number,
  maxBytes: number = DEFAULT_WINDOW_BYTES,
  redactor?: Redactor,
  options: ReadLogWindowOptions = {}
): Promise<LogWindow> {
  const start = Math.max(0, Math.floor(offset));
  const wanted = Math.max(1, Math.floor(maxBytes));
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "", nextOffset: start, eof: true, size: 0 };
    }
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (start >= size) {
      return { text: "", nextOffset: Math.min(start, size), eof: true, size };
    }
    const byteAware = hasByteMatches(redactor) && redactor.maxSecretBytes > 0;
    const margin = byteAware ? redactor.maxSecretBytes - 1 : 0;
    // 3 extra bytes on each side are enough to find a character boundary.
    const lookback = Math.min(start, margin + 3);
    const readStart = start - lookback;
    const readEnd = Math.min(size, start + wanted + margin + 3);
    const buf = Buffer.alloc(readEnd - readStart);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, readStart + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const data = got === buf.length ? buf : buf.subarray(0, got);
    const atFileEnd = readStart + data.length >= size;
    const hold = options.holdTail === true;

    // The bytes that exist to be served: at the growing end of a live file, a partial character
    // (and, below, a possible secret prefix) waits for the next read.
    let limit = data.length;
    if (atFileEnd && hold) {
      limit = trimIncompleteTail(data, lookback, limit);
    }

    let winStart = boundaryForward(data, lookback, limit);
    let winEnd = Math.min(lookback + wanted, limit);
    if (winEnd < limit) {
      winEnd = boundaryBack(data, winEnd, winStart);
      if (winEnd <= winStart) {
        // A window narrower than one character still serves that character.
        winEnd = boundaryForward(data, Math.min(winStart + 1, limit), limit);
      }
    }
    if (winEnd < winStart) {
      // Nothing servable yet (a live file's end held back from the very offset asked for).
      winEnd = winStart;
    }

    let prefix = "";
    let found: SecretMatch[] = [];
    if (byteAware) {
      found = redactor.byteMatches(data.subarray(0, limit));
      for (const match of found) {
        // A secret the previous window ended inside of (a caller-picked offset): serve its
        // placeholder, never its tail.
        if (match.start < winStart && match.end > winStart) {
          prefix = secretPlaceholder(match.name);
          winStart = match.end;
          if (winEnd < winStart) winEnd = winStart;
        }
      }
      const extendAcross = (): void => {
        for (const match of found) {
          if (match.start < winEnd && match.end > winEnd) {
            winEnd = match.end;
          }
        }
      };
      extendAcross();
      if (atFileEnd && hold) {
        const holdFrom = limit - margin;
        if (winEnd > holdFrom) {
          winEnd = Math.max(winStart, boundaryBack(data, Math.max(holdFrom, 0), winStart));
          extendAcross();
        }
      }
    }

    let text = prefix;
    let at = winStart;
    for (const match of found) {
      if (match.start < winStart || match.end > winEnd) continue;
      text += data.toString("utf8", at, match.start) + secretPlaceholder(match.name);
      at = match.end;
    }
    text += data.toString("utf8", at, winEnd);
    if (!byteAware && redactor !== undefined) {
      text = redactor.text(text);
    }
    const nextOffset = readStart + winEnd;
    return { text, nextOffset, eof: nextOffset >= size, size };
  } finally {
    await handle.close();
  }
}

export interface FollowLogOptions {
  offset?: number;
  /** Whether the log may still grow; the follow ends once it is false and everything was read. */
  isLive(): boolean;
  signal?: AbortSignal;
  redactor?: Redactor;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Follow a log for a chunked "follow" route: yields redacted text as the file grows, and ends
 * once the log is no longer live and has been read to its end (or the signal aborts).
 */
export async function* followLog(path: string, options: FollowLogOptions): AsyncGenerator<string, void, void> {
  let offset = Math.max(0, options.offset ?? 0);
  while (!options.signal?.aborted) {
    // Decide liveness BEFORE reading, so a writer that finished just after the read is caught by
    // one more read rather than lost.
    const live = options.isLive();
    const window = await readLogWindow(path, offset, DEFAULT_WINDOW_BYTES, options.redactor, { holdTail: live });
    const advanced = window.nextOffset !== offset;
    offset = window.nextOffset;
    if (window.text.length > 0) {
      yield window.text;
      continue;
    }
    if (advanced && !window.eof) {
      continue;
    }
    if (!live) {
      return;
    }
    // At the end of a live file, or holding back its last bytes: wait for more.
    await pause(250, options.signal);
  }
}
