import type {
  FsFilesResponse,
  FsProjectFile,
  FsSearchFileResult,
  FsSearchMatch,
  FsSearchResponse
} from "@orquester/api";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { onPath } from "./archive";

const FILE_LIST_LIMIT = 5000;
const SEARCH_MATCH_DEFAULT_LIMIT = 200;
const SEARCH_MATCH_MAX_LIMIT = 1000;
const SEARCH_MATCHES_PER_FILE_LIMIT = 20;
const SEARCH_FILE_SIZE_LIMIT = 1024 * 1024;
const SEARCH_LINE_TEXT_LIMIT = 300;
const SEARCH_QUERY_LIMIT = 256;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export class FsSearchError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export async function listProjectFiles(
  fsRoot: string,
  root: string,
  options: { maxFiles?: number | string; signal?: AbortSignal } = {}
): Promise<FsFilesResponse> {
  const rootPath = resolve(root);
  const rootInfo = await stat(rootPath);
  if (!rootInfo.isDirectory()) throw new FsSearchError(400, "FS_ERROR", "Not a directory.");

  const maxFiles = clampInt(options.maxFiles, 1, FILE_LIST_LIMIT, FILE_LIST_LIMIT);
  const files: FsProjectFile[] = [];
  const state = { truncated: false };
  await walkProjectFiles(fsRoot, rootPath, rootPath, files, state, maxFiles, options.signal);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: rootPath, files, truncated: state.truncated };
}

export async function searchProjectFiles(
  fsRoot: string,
  root: string,
  options: {
    query: string;
    caseSensitive?: boolean;
    regex?: boolean;
    maxResults?: number | string;
    signal?: AbortSignal;
  }
): Promise<FsSearchResponse> {
  if (!options.query) throw new FsSearchError(400, "INVALID_REQUEST", "q required.");
  if (options.query.length > SEARCH_QUERY_LIMIT) {
    throw new FsSearchError(400, "INVALID_REQUEST", `q must be ${SEARCH_QUERY_LIMIT} characters or fewer.`);
  }

  const maxResults = clampInt(options.maxResults, 1, SEARCH_MATCH_MAX_LIMIT, SEARCH_MATCH_DEFAULT_LIMIT);

  // Optional ripgrep fast path. When `rg` is on PATH it walks + matches far faster
  // than the pure-Node engine; the engine below stays the fallback (and the tested
  // default on hosts without rg). A ReDoS check is unnecessary for rg — its Rust
  // regex engine is non-backtracking and rejects backreferences/lookarounds anyway.
  if (resolveRg()) {
    try {
      return await searchWithRipgrep(fsRoot, resolve(root), {
        query: options.query,
        caseSensitive: Boolean(options.caseSensitive),
        regex: Boolean(options.regex),
        maxResults,
        signal: options.signal
      });
    } catch (error) {
      // Regex/exit-2/abort surface as FsSearchError and must propagate. A spawn
      // failure at runtime (rg vanished after the probe) is any other error — fall
      // through to the node engine rather than failing the request.
      if (error instanceof FsSearchError) throw error;
    }
  }

  // Regex search runs ONLY through ripgrep's non-backtracking engine. The pure-Node
  // fallback below builds a JS RegExp, which backtracks catastrophically on inputs
  // like (a|aa)+ and cannot be time-bounded in-process (a single RegExp.exec blocks
  // the event loop). A shape-based blocklist cannot catch every such pattern, so when
  // rg is unavailable we refuse regex mode rather than risk stalling the daemon.
  if (options.regex) {
    throw new FsSearchError(
      400,
      "REGEX_UNSUPPORTED",
      "Regex search requires ripgrep (rg) installed on the server. Turn off regex mode or install rg."
    );
  }

  const matcher = createMatcher(options.query, Boolean(options.caseSensitive));
  const listing = await listProjectFiles(fsRoot, root, { signal: options.signal });
  const files: FsSearchFileResult[] = [];
  let totalMatches = 0;
  let limitHit = listing.truncated;

  for (const file of listing.files) {
    throwIfAborted(options.signal);
    if (totalMatches >= maxResults) {
      limitHit = true;
      break;
    }
    if (file.size > SEARCH_FILE_SIZE_LIMIT) continue;

    const safePath = await assertInsideFsRoot(fsRoot, join(listing.root, ...file.path.split("/").filter(Boolean)));
    const buffer = await readFile(safePath);
    throwIfAborted(options.signal);
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) continue;

    const result = searchTextFile(buffer.toString("utf8"), file.path, file.size, matcher, maxResults - totalMatches);
    if (!result) continue;

    totalMatches += result.matches.length;
    if (result.truncated || totalMatches >= maxResults) limitHit = true;
    files.push(result);
  }

  return { files, totalMatches, limitHit, tool: "node" };
}

// --- ripgrep fast path ---------------------------------------------------------

let resolvedRg: boolean | undefined;

/** Probe for `rg` on PATH once and cache, mirroring archive.ts's resolveTool(). */
function resolveRg(): boolean {
  if (resolvedRg !== undefined) return resolvedRg;
  return (resolvedRg = onPath("rg"));
}

interface RgTextField {
  text?: string;
  bytes?: string;
}
interface RgMatchData {
  path: RgTextField;
  lines: RgTextField;
  line_number: number;
  submatches: Array<{ start: number; end: number }>;
}

/** Decode a ripgrep `{text}|{bytes}` field to a string (bytes are base64). */
function decodeRgText(field: RgTextField): string {
  if (typeof field.text === "string") return field.text;
  if (typeof field.bytes === "string") return Buffer.from(field.bytes, "base64").toString("utf8");
  return "";
}

/** Raw bytes of a ripgrep field, so byte submatch offsets can be sliced. */
function rgFieldBytes(field: RgTextField): Buffer {
  if (typeof field.bytes === "string") return Buffer.from(field.bytes, "base64");
  return Buffer.from(field.text ?? "", "utf8");
}

/**
 * ripgrep-backed search, modeled on VSCode's ripgrepTextSearchEngine. Streams the
 * `--json` event stream, converts each submatch's BYTE offsets to CHAR (UTF-16)
 * offsets (Buffer slice + decoded length, exactly as VSCode does) so the output
 * shape matches the node engine, then reuses formatLineMatch() for windowing.
 */
async function searchWithRipgrep(
  fsRoot: string,
  root: string,
  opts: { query: string; caseSensitive: boolean; regex: boolean; maxResults: number; signal?: AbortSignal }
): Promise<FsSearchResponse> {
  const collected = await runRipgrep(root, opts);

  // ripgrep's match events carry no file size; stat each matched file so `size`
  // matches the node path. Files live under `root` (already sandboxed); guard anyway.
  for (const file of collected.files) {
    try {
      const safe = await assertInsideFsRoot(fsRoot, join(root, ...file.path.split("/").filter(Boolean)));
      const info = await stat(safe).catch(() => null);
      file.size = info?.size ?? 0;
    } catch (error) {
      if (error instanceof FsSandboxError) {
        file.size = 0;
        continue;
      }
      throw error;
    }
  }

  return { files: collected.files, totalMatches: collected.totalMatches, limitHit: collected.limitHit, tool: "rg" };
}

function runRipgrep(
  root: string,
  opts: { query: string; caseSensitive: boolean; regex: boolean; maxResults: number; signal?: AbortSignal }
): Promise<{ files: FsSearchFileResult[]; totalMatches: number; limitHit: boolean }> {
  return new Promise((resolveResult, rejectResult) => {
    if (opts.signal?.aborted) {
      rejectResult(new FsSearchError(499, "REQUEST_ABORTED", "Request aborted."));
      return;
    }

    const args = [
      "--json",
      "--hidden",
      // Match the node fallback's semantics: search everything except .git and
      // node_modules (below). Without this rg honors .gitignore/.ignore (and
      // --no-require-git would apply them even outside a git repo), so a gitignored
      // file would be found by one engine and invisible to the other on the same tree.
      "--no-ignore",
      "--no-config",
      "--crlf",
      "--max-filesize",
      String(SEARCH_FILE_SIZE_LIMIT),
      "-g",
      "!.git",
      "-g",
      "!node_modules",
      opts.caseSensitive ? "--case-sensitive" : "--ignore-case"
    ];
    // `--regexp <q>` binds the pattern to the flag (safe for a leading '-'); for a
    // literal search `--fixed-strings -- <q>` ends option parsing so `<q>` and the
    // trailing "." are the only positionals (pattern, then search path).
    if (opts.regex) args.push("--regexp", opts.query);
    else args.push("--fixed-strings", "--", opts.query);
    args.push(".");

    const child = spawn("rg", args, { cwd: root });
    const files: FsSearchFileResult[] = [];
    let current: FsSearchFileResult | null = null;
    let totalMatches = 0;
    let limitHit = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let killedForLimit = false;

    const finishOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (current) files.push(current);
      if (totalMatches >= opts.maxResults) limitHit = true;
      resolveResult({ files, totalMatches, limitHit });
    };
    const finishErr = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResult(error);
    };

    const onAbort = () => {
      killedForLimit = false;
      child.kill();
      finishErr(new FsSearchError(499, "REQUEST_ABORTED", "Request aborted."));
    };
    const cleanup = () => opts.signal?.removeEventListener("abort", onAbort);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line: string) => {
      if (settled || !line) return;
      let msg: { type?: string; data?: RgMatchData };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // begin/end/summary or a stray partial line — ignore
      }
      if (msg.type !== "match" || !msg.data) return;
      const data = msg.data;

      const relRaw = decodeRgText(data.path);
      const path = relRaw.startsWith("./") ? relRaw.slice(2) : relRaw;

      if (!current || current.path !== path) {
        if (current) files.push(current);
        current = { path, size: 0, matches: [], truncated: false };
      }
      if (current.truncated) return; // per-file cap already hit; ignore the rest

      const lineBytes = rgFieldBytes(data.lines);
      let lineText = lineBytes.toString("utf8");
      if (lineText.endsWith("\n")) lineText = lineText.slice(0, -1);
      if (lineText.endsWith("\r")) lineText = lineText.slice(0, -1);

      for (const sub of data.submatches) {
        if (totalMatches >= opts.maxResults) {
          limitHit = true;
          killedForLimit = true;
          child.kill();
          finishOk();
          return;
        }
        if (current.matches.length >= SEARCH_MATCHES_PER_FILE_LIMIT) {
          current.truncated = true;
          limitHit = true;
          break;
        }
        // rg submatch start/end are BYTE offsets into the line; convert to CHAR
        // (UTF-16 code unit) offsets the way VSCode does, so they index lineText.
        const start = lineBytes.subarray(0, sub.start).toString("utf8").length;
        const end = lineBytes.subarray(0, sub.end).toString("utf8").length;
        current.matches.push({ line: data.line_number, ...formatLineMatch(lineText, start, end) });
        totalMatches += 1;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
        if (settled) return;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderrBuf.length < 8192) stderrBuf += chunk;
    });

    // Spawn failure (rg vanished after the probe) — reject with a plain Error so the
    // caller falls back to the node engine instead of surfacing a 4xx.
    child.on("error", (error) => finishErr(error));

    child.on("close", (code) => {
      if (settled) return;
      if (killedForLimit) {
        finishOk();
        return;
      }
      if (stdoutBuf.length > 0) handleLine(stdoutBuf);
      if (settled) return;
      // 0 = matches, 1 = no matches (both success); 2 = error.
      if (code === 0 || code === 1) {
        finishOk();
        return;
      }
      const tail = stderrBuf.trim().split("\n").slice(-4).join(" ").slice(0, 500) || `ripgrep exited with code ${code}.`;
      const isRegexError = /regex parse error|error parsing/i.test(stderrBuf);
      finishErr(new FsSearchError(400, isRegexError ? "INVALID_REQUEST" : "FS_ERROR", tail));
    });
  });
}

async function walkProjectFiles(
  fsRoot: string,
  root: string,
  dir: string,
  files: FsProjectFile[],
  state: { truncated: boolean },
  maxFiles: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  if (state.truncated) return;

  const dirents = await readdir(dir, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  for (const dirent of dirents) {
    throwIfAborted(signal);
    if (state.truncated) return;
    if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;

    const candidate = join(dir, dirent.name);
    let safe: string;
    try {
      safe = await assertInsideFsRoot(fsRoot, candidate);
    } catch (error) {
      if (error instanceof FsSandboxError) continue;
      throw error;
    }

    const info = await stat(safe).catch(() => null);
    if (!info) continue;
    if (info.isDirectory() && dirent.isDirectory()) {
      await walkProjectFiles(fsRoot, root, safe, files, state, maxFiles, signal);
      continue;
    }
    if (!info.isFile()) continue;
    if (files.length >= maxFiles) {
      state.truncated = true;
      return;
    }

    const rel = relative(root, candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    files.push({ path: rel.split(sep).join("/"), size: info.size });
  }
}

interface Matcher {
  find(line: string): Array<{ start: number; end: number }>;
}

// Literal (non-regex) matcher only. Regex mode is served exclusively by ripgrep's
// non-backtracking engine (see searchProjectFiles); a JS RegExp is never built from
// user input here, so this path cannot be driven into catastrophic backtracking.
function createMatcher(query: string, caseSensitive: boolean): Matcher {
  const needle = caseSensitive ? query : query.toLowerCase();
  return {
    find(line) {
      const haystack = caseSensitive ? line : line.toLowerCase();
      const matches: Array<{ start: number; end: number }> = [];
      let index = 0;
      for (;;) {
        index = haystack.indexOf(needle, index);
        if (index === -1) return matches;
        matches.push({ start: index, end: index + query.length });
        index += Math.max(query.length, 1);
      }
    }
  };
}

function searchTextFile(
  content: string,
  path: string,
  size: number,
  matcher: Matcher,
  remainingBudget: number
): FsSearchFileResult | null {
  const matches: FsSearchMatch[] = [];
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    for (const match of matcher.find(line)) {
      if (matches.length >= SEARCH_MATCHES_PER_FILE_LIMIT || matches.length >= remainingBudget) {
        return { path, size, matches, truncated: true };
      }
      matches.push({ line: index + 1, ...formatLineMatch(line, match.start, match.end) });
    }
  }

  return matches.length > 0 ? { path, size, matches, truncated: false } : null;
}

function formatLineMatch(line: string, start: number, end: number): Omit<FsSearchMatch, "line"> {
  if (line.length <= SEARCH_LINE_TEXT_LIMIT) return { text: line, start, end };

  const matchLength = end - start;
  const windowStart = Math.max(0, Math.min(start - 80, line.length - SEARCH_LINE_TEXT_LIMIT));
  const adjustedStart = Math.max(0, start - windowStart);
  return {
    text: line.slice(windowStart, windowStart + SEARCH_LINE_TEXT_LIMIT),
    start: adjustedStart,
    end: Math.min(SEARCH_LINE_TEXT_LIMIT, adjustedStart + matchLength)
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsSearchError(499, "REQUEST_ABORTED", "Request aborted.");
}
