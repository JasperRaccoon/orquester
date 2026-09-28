/**
 * The log viewer's buffer (workflows spec §7.3: "a live log tail, following,
 * with download full log"): text chunks from the chunked log route in, a
 * bounded list of display lines out.
 *
 * - ANSI escape sequences (colours, cursor moves, OSC titles and links) are
 *   stripped — a sequence split across two chunks is carried to the next one
 *   rather than printed as garbage;
 * - a carriage return rewrites its line, as a terminal would (progress bars
 *   print one line, not a thousand);
 * - the DOM holds at most `maxLines` lines of at most `maxLineChars` each;
 *   older lines are counted, not kept, and the viewer offers the full log as
 *   a download instead.
 *
 * Pure: the state is a value, `appendLog` returns the next one.
 */

export const LOG_MAX_LINES = 5_000;
export const LOG_MAX_LINE_CHARS = 4_000;

// CSI: ESC [ params intermediates final. OSC: ESC ] … (BEL | ESC \). Other two/three-byte escapes.
// A C1 CSI (U+009B) reads as a CSI too.
// eslint-disable-next-line no-control-regex
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const DCS = /\u001b[PX^_][\s\S]*?\u001b\\/g;
// eslint-disable-next-line no-control-regex
const SHORT_ESC = /\u001b[ -/]*[0-~]/g;
// Every other control character but tab, newline and carriage return.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

/** Text without ANSI escape sequences or stray control characters (tabs, newlines and CRs stay). */
function stripAnsi(text: string): string {
  if (!/[\u001b\u009b\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return text;
  return text.replace(OSC, "").replace(DCS, "").replace(CSI, "").replace(SHORT_ESC, "").replace(CONTROL, "");
}

/**
 * Split off an escape sequence the chunk ends in the middle of, so the next
 * chunk completes it. Returns `[complete, carry]`. A carry longer than 256
 * characters is not an escape we will ever complete: it is let through.
 */
function splitIncompleteEscape(text: string): [string, string] {
  const at = text.lastIndexOf("\u001b");
  if (at < 0 || text.length - at > 256) return [text, ""];
  const tail = text.slice(at);
  // Complete forms end the tail exactly; anything else is still arriving.
  if (/^\u001b\[[0-?]*[ -/]*[@-~]/.test(tail)) return [text, ""];
  if (/^\u001b\][\s\S]*?(?:\u0007|\u001b\\)/.test(tail)) return [text, ""];
  if (/^\u001b[PX^_][\s\S]*?\u001b\\/.test(tail)) return [text, ""];
  if (/^\u001b[ -/]*[0-~]/.test(tail) && !/^\u001b[[\]PX^_]/.test(tail)) return [text, ""];
  return [text.slice(0, at), tail];
}

/** A line as a terminal leaves it: what follows the last carriage return wins. */
function applyCarriageReturns(line: string): string {
  const at = line.lastIndexOf("\r");
  if (at < 0) return line;
  if (at === line.length - 1) {
    // "text\r" at the end of a line: the next write would overwrite it; keep it until then.
    const before = line.slice(0, at);
    const previous = before.lastIndexOf("\r");
    return previous < 0 ? before : before.slice(previous + 1);
  }
  return line.slice(at + 1);
}

function clipLine(line: string, max: number): string {
  return line.length > max
    ? `${line.slice(0, max)} … [${(line.length - max).toLocaleString("en-US")} more characters]`
    : line;
}

export interface LogBufferState {
  /** Complete lines, oldest first, at most `maxLines` (with the partial line). */
  lines: string[];
  /** The line still being written (no newline yet), escapes stripped, CRs applied lazily. */
  partial: string;
  /** An escape sequence the last chunk ended inside of. */
  carry: string;
  /** Lines dropped off the top to stay within `maxLines`. */
  dropped: number;
}

export const EMPTY_LOG: LogBufferState = { lines: [], partial: "", carry: "", dropped: 0 };

/** `state` with `chunk` appended. */
export function appendLog(state: LogBufferState, chunk: string): LogBufferState {
  if (chunk.length === 0) return state;
  const maxLines = LOG_MAX_LINES;
  const maxChars = LOG_MAX_LINE_CHARS;
  const [complete, carry] = splitIncompleteEscape(state.carry + chunk);
  const clean = stripAnsi(complete).replace(/\r\n/g, "\n");
  const pieces = clean.split("\n");
  const lines = state.lines.slice();
  let partial = state.partial + pieces[0]!;
  for (let index = 1; index < pieces.length; index += 1) {
    lines.push(clipLine(applyCarriageReturns(partial), maxChars));
    partial = pieces[index]!;
  }
  // A partial line that grows without a newline (a spinner) keeps only what a terminal would show.
  if (partial.includes("\r")) partial = applyCarriageReturns(partial) + (partial.endsWith("\r") ? "\r" : "");
  if (partial.length > maxChars * 4) partial = partial.slice(-maxChars * 4);
  const room = maxLines - (partial.length > 0 ? 1 : 0);
  let dropped = state.dropped;
  if (lines.length > room) {
    const cut = lines.length - Math.max(0, room);
    lines.splice(0, cut);
    dropped += cut;
  }
  return { lines, partial, carry, dropped };
}

/** The lines to render: the complete ones and the line in progress. */
export function visibleLogLines(state: LogBufferState): string[] {
  if (state.partial.length === 0) return state.lines;
  const partial = clipLine(applyCarriageReturns(state.partial), LOG_MAX_LINE_CHARS);
  return partial.length === 0 ? state.lines : [...state.lines, partial];
}

/** "1,204 earlier lines are not shown here." */
export function droppedLinesText(dropped: number): string | null {
  if (dropped <= 0) return null;
  return `${dropped.toLocaleString("en-US")} earlier ${dropped === 1 ? "line is" : "lines are"} not shown here.`;
}

/** A human size: "812 B", "14.2 KB", "3.1 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file name for a downloaded log: "Build-stdout.log". */
export function logFileName(blockName: string, stream: "stdout" | "stderr"): string {
  const base =
    blockName
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "block";
  return `${base}-${stream}.log`;
}
