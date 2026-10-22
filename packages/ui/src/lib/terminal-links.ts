/**
 * Links in terminal output: URLs and file paths (with an optional
 * `:line:col`), found in xterm's buffer, mapped to buffer cells, and resolved
 * to targets the app can open. Pure, so it is testable without xterm.
 *
 * A path is resolved against the session's working directory and offered only
 * when it lands inside the session's project; the file API sandboxes it again.
 */

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  /** UTF-16 offsets into the (wrapped) line, end exclusive. */
  start: number;
  end: number;
}

// Adapted from T3 Code (MIT): apps/web/src/terminal-links.ts
const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/giu;
// Bare paths start only at a segment boundary: hover detection runs this on
// every frame, so separator-free output must not be rescanned at every suffix.
const FILE_PATH_PATTERN =
  /(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|(?<![\p{L}\p{M}\p{N}._-])[\p{L}\p{M}\p{N}._-]+(?:[\\/][\p{L}\p{M}\p{N}._-]+)+(?::\d+){0,2}/gu;
const QUOTED_FILE_PATH_PATTERN =
  /(["'`])(?<path>(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\|[\p{L}\p{M}\p{N}._ -]+[\\/])[^\r\n]*?|[\p{L}\p{M}\p{N}._ -]+\.[\p{L}\p{M}\p{N}_-]+(?::\d+){0,2})\1(?<position>(?::\d+){0,2})/gu;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;
// Paths also drop a trailing colon: compilers end `file:line:col:` with one.
const TRAILING_PATH_PUNCTUATION_PATTERN = /[.,;:!?]+$/;
// A question mark is legal in filenames; only exclude query-bearing request targets.
const REQUEST_ROUTE_PATTERN =
  /(?:^|[\s"'`])(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE|proxying)\s+["'`]?(?:\/|[A-Za-z0-9_-]+\/)[^\s?]*\?\S*/g;

function trimClosingDelimiters(value: string, kind: TerminalLinkKind): string {
  let output = value.replace(kind === "path" ? TRAILING_PATH_PUNCTUATION_PATTERN : TRAILING_PUNCTUATION_PATTERN, "");
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[]
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const quotedPath = rawMatch.groups?.path;
    const raw = quotedPath === undefined ? rawMatch[0] : quotedPath + (rawMatch.groups?.position ?? "");
    const start = (rawMatch.index ?? 0) + (quotedPath === undefined ? 0 : 1);
    if (raw.length === 0) continue;

    const trimmed = quotedPath === undefined ? trimClosingDelimiters(raw, kind) : raw;
    if (trimmed.length === 0) continue;
    if (kind === "path" && isTerminalUrl(trimmed)) continue;

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      // A position outside quotes spans the closing quote in the terminal buffer.
      end: start + trimmed.length + (rawMatch.groups?.position ? 1 : 0)
    };

    if ([...existing, ...matches].some((other) => overlaps(candidate, other))) continue;
    matches.push(candidate);
  }

  return matches;
}

/** Every URL and path in one logical line, in order. */
export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const requestRoutes = Array.from(line.matchAll(REQUEST_ROUTE_PATTERN), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));
  const urlMatches = collectMatches(line, "url", URL_PATTERN, []);
  const quotedMatches = collectMatches(line, "path", QUOTED_FILE_PATH_PATTERN, urlMatches);
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, [...urlMatches, ...quotedMatches]);
  return [...urlMatches, ...quotedMatches, ...pathMatches]
    .filter((match) => match.kind === "url" || !requestRoutes.some((route) => overlaps(match, route)))
    .sort((a, b) => a.start - b.start);
}

export function isTerminalUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

/**
 * Cmd-click on Apple platforms, Ctrl-click elsewhere (never both, so the other
 * chord stays free for the program in the terminal).
 */
export function isTerminalLinkActivation(event: Pick<MouseEvent, "metaKey" | "ctrlKey">, apple: boolean): boolean {
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

// --- Buffer → links ---------------------------------------------------------

/** The parts of xterm's IBufferCell this reads. */
export interface TerminalCellLike {
  getChars(): string;
  getWidth(): number;
}

/** The parts of xterm's IBufferLine this reads. */
export interface TerminalBufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): TerminalCellLike | undefined;
}

interface WrappedLineSegment {
  /** 1-based buffer line, as xterm's link API counts. */
  bufferLineNumber: number;
  startIndex: number;
  endIndex: number;
  /** For each UTF-16 unit of this row's text: its cell's 0-based column and width. */
  columns: number[];
  widths: number[];
}

export interface WrappedTerminalLine {
  text: string;
  segments: WrappedLineSegment[];
}

/** One row's text as xterm draws it, with the cell each UTF-16 unit sits in. */
function rowText(line: TerminalBufferLineLike, trimRight: boolean): { text: string; columns: number[]; widths: number[] } {
  let text = "";
  const columns: number[] = [];
  const widths: number[] = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    // The trailing half of a wide character.
    if (width === 0) continue;
    const chars = cell.getChars() || " ";
    for (let unit = 0; unit < chars.length; unit += 1) {
      columns.push(x);
      widths.push(width);
    }
    text += chars;
  }
  if (trimRight) {
    const trimmed = text.replace(/\s+$/u, "");
    columns.length = trimmed.length;
    widths.length = trimmed.length;
    text = trimmed;
  }
  return { text, columns, widths };
}

/**
 * The logical line that buffer row `bufferLineNumber` (1-based) belongs to:
 * the rows before it that it wraps from and the rows after that wrap from it.
 * `getLine` takes a 0-based index, like xterm's `buffer.getLine`.
 */
export function collectWrappedTerminalLine(
  bufferLineNumber: number,
  getLine: (index: number) => TerminalBufferLineLike | undefined
): WrappedTerminalLine | null {
  let first = bufferLineNumber;
  let line = getLine(first - 1);
  if (!line) return null;
  while (first > 1 && line.isWrapped) {
    const previous = getLine(first - 2);
    if (!previous) return null;
    first -= 1;
    line = previous;
  }

  const segments: WrappedLineSegment[] = [];
  let text = "";
  for (let number = first; ; number += 1) {
    const current = getLine(number - 1);
    if (!current) break;
    const continues = getLine(number)?.isWrapped === true;
    // A row that continues keeps its trailing spaces: they are part of the line.
    const row = rowText(current, !continues);
    segments.push({
      bufferLineNumber: number,
      startIndex: text.length,
      endIndex: text.length + row.text.length,
      columns: row.columns,
      widths: row.widths
    });
    text += row.text;
    if (!continues) break;
  }
  return { text, segments };
}

export interface TerminalLinkRange {
  /** 1-based columns and buffer lines, end inclusive (xterm's IBufferRange). */
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface TerminalBufferLink {
  kind: TerminalLinkKind;
  text: string;
  range: TerminalLinkRange;
}

function cellAt(line: WrappedTerminalLine, index: number): { segment: WrappedLineSegment; offset: number } | null {
  for (const segment of line.segments) {
    if (index >= segment.startIndex && index < segment.endIndex) {
      return { segment, offset: index - segment.startIndex };
    }
  }
  return null;
}

/** The links on buffer row `bufferLineNumber`, including ones wrapping onto or off it. */
export function terminalLinksForRow(
  bufferLineNumber: number,
  getLine: (index: number) => TerminalBufferLineLike | undefined
): TerminalBufferLink[] {
  const line = collectWrappedTerminalLine(bufferLineNumber, getLine);
  if (!line) return [];
  const links: TerminalBufferLink[] = [];
  for (const match of extractTerminalLinks(line.text)) {
    const first = cellAt(line, match.start);
    const last = cellAt(line, match.end - 1);
    if (!first || !last) continue;
    const range: TerminalLinkRange = {
      start: { x: first.segment.columns[first.offset]! + 1, y: first.segment.bufferLineNumber },
      end: {
        x: last.segment.columns[last.offset]! + last.segment.widths[last.offset]!,
        y: last.segment.bufferLineNumber
      }
    };
    if (range.start.y <= bufferLineNumber && range.end.y >= bufferLineNumber) {
      links.push({ kind: match.kind, text: match.text, range });
    }
  }
  return links;
}

// --- Path → target ----------------------------------------------------------

export interface TerminalPathTarget {
  /** Absolute, normalized, inside the project. */
  path: string;
  line?: number;
  column?: number;
}

const POSITION_SUFFIX_PATTERN = /:(\d+)(?::(\d+))?$/;

/** `src/a.ts:12:7` → `{ path: "src/a.ts", line: 12, column: 7 }`. */
export function splitFilePathPosition(text: string): TerminalPathTarget {
  const match = POSITION_SUFFIX_PATTERN.exec(text);
  if (!match?.[1]) return { path: text };
  const line = Number.parseInt(match[1], 10);
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  return {
    path: text.slice(0, -match[0].length),
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {})
  };
}

function isWindowsStyle(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || isWindowsStyle(path);
}

/** Resolve `.`/`..` segments; null when `..` climbs above the root. */
function normalize(path: string, windows: boolean): string | null {
  const unified = windows ? path.replace(/\\/g, "/") : path;
  const unc = windows && unified.startsWith("//");
  const drive = windows ? /^[A-Za-z]:/.exec(unified)?.[0] ?? "" : "";
  const rest = unified.slice(drive.length);
  const out: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  const joined = `${unc ? "//" : "/"}${out.join("/")}`;
  return windows ? `${drive}${joined}`.replace(/\//g, "\\") : joined;
}

/**
 * Resolve a path link from session output against the session's `cwd`. Null
 * unless it lands inside `projectRoot` (a `~` path is never resolved: the
 * client cannot know the daemon user's home).
 */
export function resolveTerminalPathLink(text: string, cwd: string, projectRoot: string): TerminalPathTarget | null {
  if (!projectRoot) return null;
  const { path, line, column } = splitFilePathPosition(text);
  if (path.length === 0 || path.startsWith("~")) return null;
  const windows = isWindowsStyle(projectRoot);
  const base = cwd || projectRoot;
  const joined = isAbsolute(path) ? path : `${base}${windows ? "\\" : "/"}${path}`;
  const resolved = normalize(joined, windows);
  const root = normalize(projectRoot, windows);
  if (!resolved || !root) return null;
  const separator = windows ? "\\" : "/";
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  const inside =
    fold(resolved) === fold(root) ||
    fold(resolved).startsWith(fold(root.endsWith(separator) ? root : root + separator));
  if (!inside) return null;
  return { path: resolved, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}
