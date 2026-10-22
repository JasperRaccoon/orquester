/**
 * The hot replay ring a PTY session keeps in daemon memory, and the filter that
 * keeps terminal query traffic out of it.
 *
 * The ring is what the direct-PTY backend replays to a (re)connecting client,
 * and what the tmux backend falls back to once a pane is gone. Appends cost
 * O(chunk): output is stored as chunks with a running size, and the full
 * string is only built when a client asks for a replay. Trimming drops whole
 * chunks from the front and cuts the first one at a line or escape-sequence
 * start when one is close, never inside a surrogate pair.
 *
 * Replayed bytes are fed to a fresh xterm, which answers any terminal QUERY in
 * them (device attributes, cursor position, colours, modes) into the live
 * shell, where the replies land as junk at the prompt. So query and reply
 * sequences are stripped as output enters the ring. Live output is never
 * filtered: a program asking a question now must get its answer.
 */

/** UTF-16 code units the ring retains (the retention of the old `.slice(-256 KiB)`). */
export const TERMINAL_REPLAY_MAX_CHARS = 256 * 1024;
/** Small appends are joined into the newest chunk up to this length. */
const CHUNK_CHARS = 16 * 1024;
/** How far past the minimum cut trimming looks for a line or sequence start. */
const SAFE_CUT_SCAN = 1024;
/** An unterminated sequence longer than this is stored as is, unclassified. */
const MAX_PENDING_SEQUENCE = 16 * 1024;

export class TerminalOutputRing {
  private chunks: string[] = [];
  /** Index of the oldest live chunk; evicted slots before it are emptied, then compacted. */
  private start = 0;
  private size = 0;
  /** An incomplete control sequence held until its end arrives (see sanitizeTerminalReplayChunk). */
  private pending = "";
  private cached: string | null = "";

  constructor(private readonly maxChars = TERMINAL_REPLAY_MAX_CHARS) {}

  /** Retained length in UTF-16 code units. */
  get length(): number {
    return this.size;
  }

  append(data: string): void {
    const sanitized = sanitizeTerminalReplayChunk(this.pending, data);
    let visible = sanitized.visibleText;
    this.pending = sanitized.pendingControlSequence;
    if (this.pending.length > MAX_PENDING_SEQUENCE) {
      // A huge OSC (an inline image, a clipboard write) would otherwise be held
      // forever. Its tail then arrives as plain text, so it is stored intact.
      visible += this.pending;
      this.pending = "";
    }
    this.push(visible);
  }

  /** The retained output, oldest first. */
  value(): string {
    if (this.cached === null) {
      this.cached = this.chunks.slice(this.start).join("");
    }
    return this.cached;
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.size = 0;
    this.pending = "";
    this.cached = "";
  }

  private push(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.cached = null;
    const last = this.chunks.length - 1;
    if (last >= this.start && this.chunks[last]!.length + text.length <= CHUNK_CHARS) {
      this.chunks[last] += text;
    } else {
      this.chunks.push(text);
    }
    this.size += text.length;
    this.trim();
  }

  private trim(): void {
    while (this.size > this.maxChars) {
      const first = this.chunks[this.start]!;
      const excess = this.size - this.maxChars;
      if (first.length <= excess) {
        this.chunks[this.start++] = "";
        this.size -= first.length;
        continue;
      }
      const cut = safeCutIndex(first, excess);
      this.chunks[this.start] = first.slice(cut);
      this.size -= cut;
    }
    if (this.start === this.chunks.length || (this.start > 64 && this.start * 2 >= this.chunks.length)) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
    }
  }
}

/**
 * Where to cut `text` so at least `min` code units go: the first line start or
 * escape-sequence start within {@link SAFE_CUT_SCAN} of `min`, else `min` itself,
 * moved past a low surrogate so a pair is never split.
 */
export function safeCutIndex(text: string, min: number): number {
  const limit = Math.min(text.length, min + SAFE_CUT_SCAN);
  for (let index = min; index < limit; index += 1) {
    if (isSequenceIntroducer(text.charCodeAt(index)) || text.charCodeAt(index - 1) === 0x0a) {
      return index;
    }
  }
  const code = text.charCodeAt(min);
  return code >= 0xdc00 && code <= 0xdfff ? min + 1 : min;
}

function isSequenceIntroducer(code: number): boolean {
  return code === 0x1b || code === 0x90 || code === 0x9b || code === 0x9d || code === 0x9e || code === 0x9f;
}

// Adapted from T3 Code (MIT): apps/server/src/terminal/Manager.ts
function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  // DSR requests and status reports (5n, 6n, ?…n).
  if (finalByte === "n") {
    return true;
  }
  // Cursor position reports.
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  // Primary, secondary and tertiary device attributes, queries and replies.
  if (finalByte === "c" && /^[>=0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries ($p) and DECRPM replies ($y). The `$` guard keeps
  // setters like DECSTR (!p) and DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r),
// and the tertiary device attributes reply (!|).
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content) || content.startsWith("!|");
}

function shouldStripOscSequence(content: string): boolean {
  // Default foreground/background/cursor colour queries and their replies.
  if (/^(10|11|12);(?:\?|rgb:)/.test(content)) {
    return true;
  }
  // The other dynamic colour queries (13–19).
  if (/^1[3-9];\?/.test(content)) {
    return true;
  }
  // Palette and special colour queries (4;N;? and 5;N;?, possibly several
  // pairs). A palette SET (4;N;rgb:…) is real output and stays.
  if (/^[45];/.test(content)) {
    const specs = content.split(";").slice(1);
    return specs.some((spec, index) => index % 2 === 1 && spec === "?");
  }
  // Clipboard read request (52;c;?).
  return /^52;[^;]*;\?$/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

// eslint-disable-next-line no-control-regex -- Terminal sequence introducers must reach the parser.
const HISTORY_SEQUENCE_START = /[\u001b\u0090\u009b\u009d\u009e\u009f]/;
const NEXT_HISTORY_SEQUENCE_START = new RegExp(HISTORY_SEQUENCE_START.source, "g");

/**
 * Drop terminal query/response sequences from one chunk of output bound for the
 * replay ring. `pendingControlSequence` carries a sequence split across chunks:
 * pass back what the previous call returned; it is not part of `visibleText`
 * until its end arrives.
 */
export function sanitizeTerminalReplayChunk(
  pendingControlSequence: string,
  data: string
): { visibleText: string; pendingControlSequence: string } {
  if (pendingControlSequence.length === 0 && !HISTORY_SEQUENCE_START.test(data)) {
    return { visibleText: data, pendingControlSequence: "" };
  }

  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            if (!shouldStripCsiSequence(input.slice(index + 2, cursor), input[cursor] ?? "")) {
              visibleText += input.slice(index, cursor + 1);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (nextCodePoint === 0x5d || nextCodePoint === 0x50 || nextCodePoint === 0x5e || nextCodePoint === 0x5f) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          visibleText += input.slice(index, terminatorIndex);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      visibleText += input.slice(index, escapeSequenceEndIndex);
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          if (!shouldStripCsiSequence(input.slice(index + 1, cursor), input[cursor] ?? "")) {
            visibleText += input.slice(index, cursor + 1);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        visibleText += input.slice(index, terminatorIndex);
      }
      index = terminatorIndex;
      continue;
    }

    // One slice per printable run: every chunk of coloured output reaches this loop.
    NEXT_HISTORY_SEQUENCE_START.lastIndex = index + 1;
    const nextSequenceStart = NEXT_HISTORY_SEQUENCE_START.exec(input)?.index ?? input.length;
    visibleText += input.slice(index, nextSequenceStart);
    index = nextSequenceStart;
  }

  return { visibleText, pendingControlSequence: "" };
}
