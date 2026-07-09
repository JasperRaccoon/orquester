import type {
  FsFilesResponse,
  FsProjectFile,
  FsSearchFileResult,
  FsSearchMatch,
  FsSearchResponse
} from "@orquester/api";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import {
  CompiledGlobList,
  CompiledPattern,
  GlobError,
  matchesGlobList,
  mergeGlobLists,
  parseGlobList
} from "@orquester/config/glob";
import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { onPath } from "./archive";

const FILE_LIST_LIMIT = 5000;
const SEARCH_MATCH_DEFAULT_LIMIT = 200;
const SEARCH_MATCH_MAX_LIMIT = 1000;
const SEARCH_MATCHES_PER_FILE_LIMIT = 20;
const SEARCH_FILE_SIZE_LIMIT = 1024 * 1024;
const SEARCH_LINE_TEXT_LIMIT = 300;
const SEARCH_QUERY_LIMIT = 256;
// Bound the concurrent per-file scans of the node engine: enough to hide read
// latency without swamping the fd table on a large tree.
const SEARCH_CONCURRENCY = 8;
// Wall-clock backstop for a single search, composed with the request's own signal
// so a pathological tree can't pin the daemon indefinitely.
const SEARCH_TIMEOUT_MS = 10_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export class FsSearchError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Which request field the error is attributable to (for inline UI hints). */
    public readonly field?: "include" | "exclude" | "query"
  ) {
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
    wholeWord?: boolean;
    regex?: boolean;
    include?: string;
    exclude?: string;
    maxResults?: number | string;
    signal?: AbortSignal;
    /** Force a backend. Internal/test seam only — never plumbed through the route. */
    engine?: "auto" | "node" | "rg";
  }
): Promise<FsSearchResponse> {
  if (!options.query) throw new FsSearchError(400, "INVALID_REQUEST", "q required.", "query");
  if (options.query.length > SEARCH_QUERY_LIMIT) {
    throw new FsSearchError(400, "INVALID_REQUEST", `q must be ${SEARCH_QUERY_LIMIT} characters or fewer.`, "query");
  }
  // Short-circuit an already-cancelled request before spawning any work.
  if (options.signal?.aborted) throw new FsSearchError(499, "REQUEST_ABORTED", "Request aborted.");

  const maxResults = clampInt(options.maxResults, 1, SEARCH_MATCH_MAX_LIMIT, SEARCH_MATCH_DEFAULT_LIMIT);
  const globs = parseGlobs(options.include, options.exclude);
  const rootPath = resolve(root);

  // Compose a 10s timeout with the caller's signal. AbortSignal.timeout's timer is
  // unref'd, so a fast search doesn't keep the process alive waiting on it.
  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const composed = AbortSignal.any(options.signal ? [options.signal, timeoutSignal] : [timeoutSignal]);
  const makeAbortError = (): FsSearchError =>
    timeoutSignal.aborted
      ? new FsSearchError(504, "SEARCH_TIMEOUT", "Search timed out.")
      : new FsSearchError(499, "REQUEST_ABORTED", "Request aborted.");

  const engine = options.engine ?? "auto";
  const useRg = engine === "rg" || (engine === "auto" && resolveRg());

  // Optional ripgrep fast path. When `rg` is on PATH it walks + matches far faster
  // than the pure-Node engine; the engine below stays the fallback (and the tested
  // default on hosts without rg). A ReDoS check is unnecessary for rg — its Rust
  // regex engine is non-backtracking and rejects backreferences/lookarounds anyway.
  if (useRg) {
    try {
      return await searchWithRipgrep(fsRoot, rootPath, {
        query: options.query,
        caseSensitive: Boolean(options.caseSensitive),
        wholeWord: Boolean(options.wholeWord),
        regex: Boolean(options.regex),
        maxResults,
        globs,
        signal: composed,
        makeAbortError
      });
    } catch (error) {
      // Regex/glob/exit-2/abort surface as FsSearchError and must propagate. A spawn
      // failure at runtime (rg vanished after the probe) is any other error — fall
      // through to the node engine unless the caller explicitly forced "rg".
      if (error instanceof FsSearchError || engine === "rg") throw error;
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
      "Regex search requires ripgrep (rg) installed on the server. Turn off regex mode or install rg.",
      "query"
    );
  }

  return await searchWithNode(fsRoot, rootPath, {
    matcher: createMatcher(options.query, Boolean(options.caseSensitive), Boolean(options.wholeWord)),
    maxResults,
    globs,
    signal: composed,
    makeAbortError
  });
}

/** Parse the raw include/exclude fields into one matchable list (null when both empty). */
function parseGlobs(include?: string, exclude?: string): CompiledGlobList | null {
  const includeRaw = include?.trim();
  const excludeRaw = exclude?.trim();
  if (!includeRaw && !excludeRaw) return null;
  let field: "include" | "exclude" = "include";
  try {
    const inc = includeRaw ? parseGlobList(includeRaw, "include") : { include: [], exclude: [] };
    field = "exclude";
    const exc = excludeRaw ? parseGlobList(excludeRaw, "exclude") : { include: [], exclude: [] };
    return mergeGlobLists(inc, exc);
  } catch (error) {
    if (error instanceof GlobError) {
      throw new FsSearchError(400, "INVALID_GLOB", `${error.message}: ${error.pattern}`, field);
    }
    throw error;
  }
}

// --- node engine ---------------------------------------------------------------

interface NodeSearchOpts {
  matcher: Matcher;
  maxResults: number;
  globs: CompiledGlobList | null;
  signal: AbortSignal;
  makeAbortError: () => FsSearchError;
}

/**
 * Pure-Node search. Interleaves a sorted DFS walk with a bounded pool of per-file
 * scans (no full pre-listing) and stops the walk as soon as the committed budget is
 * exhausted.
 *
 * Aggregation is DETERMINISTIC: files are discovered in sorted DFS order, each
 * scheduled scan is stamped with a monotonic sequence number, and completed scans are
 * committed through a reorder buffer strictly in sequence order. Parallel IO is
 * preserved (scans still run concurrently), but the budget (`maxResults`, the per-file
 * clamp, `limitHit`) is consumed in a fixed path order, so two identical searches that
 * truncate at the same boundary always return the same files — no completion-order race.
 */
async function searchWithNode(_fsRoot: string, root: string, opts: NodeSearchOpts): Promise<FsSearchResponse> {
  const results: FsSearchFileResult[] = [];
  let totalMatches = 0;
  let limitHit = false;
  let stop = false;
  let firstError: unknown = null;

  const sem = new Semaphore(SEARCH_CONCURRENCY);
  const active = new Set<Promise<void>>();

  // Reorder buffer: completed scans park here keyed by their scheduling sequence number
  // until every earlier scan has committed, so commit order == discovery (path) order.
  const pending = new Map<number, FsSearchFileResult | null>();
  let nextSeq = 0; // next sequence number to hand a scheduled scan
  let commitSeq = 0; // next sequence number eligible to commit

  // Backpressure for the reorder buffer. A permit-releasing scan lets the walker launch
  // the next one, so if the head-of-line (lowest-seq) scan is slow, later scans complete,
  // park in `pending`, and the walker races ahead — buffering the whole tree behind one
  // stall. Cap the in-window work at SEARCH_CONCURRENCY * 2 (running + parked): never
  // launch a new scan while the buffer is full, keeping memory and wasted scan work
  // O(concurrency) near the budget's edge. Commit order (hence determinism) is untouched.
  const MAX_BUFFERED = SEARCH_CONCURRENCY * 2;
  let inFlight = 0; // scans launched but not yet settled (holding a permit / mid-read)
  let bufferWaiter: (() => void) | null = null;
  const bufferFull = (): boolean => pending.size + inFlight >= MAX_BUFFERED;
  const waitForBuffer = (): Promise<void> => {
    if (stop || !bufferFull()) return Promise.resolve();
    return new Promise<void>((resolveWaiter) => {
      bufferWaiter = resolveWaiter;
    });
  };
  // Wake a parked walker once the buffer has room (or the search is stopping, so it can
  // unwind). Single waiter: the DFS walk launches scans one at a time, never concurrently.
  const releaseBuffer = (): void => {
    if (bufferWaiter && (stop || !bufferFull())) {
      const resume = bufferWaiter;
      bufferWaiter = null;
      resume();
    }
  };

  const checkAbort = (): void => {
    if (opts.signal.aborted) throw opts.makeAbortError();
  };
  const fail = (error: unknown): void => {
    if (firstError === null) firstError = error;
    stop = true;
  };

  // Commit every contiguous ready scan starting at `commitSeq`. Runs synchronously (no
  // await), so budget accounting is atomic and totalMatches can never overshoot the cap.
  const drainCommits = (): void => {
    while (pending.has(commitSeq)) {
      const result = pending.get(commitSeq)!;
      pending.delete(commitSeq);
      commitSeq += 1;
      if (!result || stop) continue; // no matches, or budget already spent — drop
      const budget = opts.maxResults - totalMatches;
      if (budget <= 0) {
        limitHit = true;
        stop = true;
        continue;
      }
      if (result.matches.length > budget) {
        result.matches = result.matches.slice(0, budget);
        result.truncated = true;
      }
      totalMatches += result.matches.length;
      results.push(result);
      if (result.truncated || totalMatches >= opts.maxResults) limitHit = true;
      if (totalMatches >= opts.maxResults) stop = true;
    }
  };

  const scan = async (seq: number, relPath: string, safePath: string, size: number): Promise<void> => {
    let result: FsSearchFileResult | null = null;
    try {
      if (!stop) {
        checkAbort();
        result = await scanOneFile(safePath, relPath, size, opts.matcher, checkAbort);
        // A request aborted/timed-out during the read must not fold into a success payload.
        checkAbort();
      }
    } catch (error) {
      // Abort/timeout must surface; a single vanished/unreadable file is skipped so
      // one transient FS error can't fail the whole search (rg behaves the same way).
      if (error instanceof FsSearchError) fail(error);
      result = null;
    } finally {
      // Always record the slot (even null) so the reorder buffer can advance past it.
      pending.set(seq, result);
      inFlight -= 1;
      sem.release();
      drainCommits();
      releaseBuffer(); // buffer may now have room (or stop is set) — wake a parked walker
    }
  };

  const walk = async (dir: string): Promise<void> => {
    if (stop) return;
    checkAbort();
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip its subtree
    }
    // Walk order is BYTE-ordered (not localeCompare) to match rg's `--sort path`, so a
    // capped search selects the same path-order prefix across both engines. (A residual
    // divergence remains only when one entry name is a strict prefix of a sibling's, where
    // node's dirent-name compare and rg's full-path '/' vs '.' compare can disagree — an
    // acceptable edge.) The final result listing is still sorted by localeCompare below.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const dirent of dirents) {
      if (stop) return;
      checkAbort();

      const resolved = await resolveDirent(dir, dirent);
      if (!resolved) continue;
      if (resolved.kind === "dir") {
        await walk(resolved.dir);
        continue;
      }
      if (resolved.size > SEARCH_FILE_SIZE_LIMIT) continue;

      const rel = relative(root, resolved.candidate);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) continue;
      const relPosix = rel.split(sep).join("/");
      if (opts.globs && !matchesGlobList(opts.globs, relPosix)) continue;

      // Throttle the launch rate to the buffer window BEFORE consuming a permit, so a
      // stalled head-of-line scan parks the walker here instead of buffering the tree.
      await waitForBuffer();
      if (stop) return;
      await sem.acquire();
      if (stop) {
        sem.release();
        return;
      }
      const seq = nextSeq++; // stamp in discovery order BEFORE launching the async scan
      inFlight += 1;
      const p = scan(seq, relPosix, resolved.safePath, resolved.size);
      active.add(p);
      void p.finally(() => active.delete(p));
    }
  };

  try {
    await walk(root);
  } catch (error) {
    fail(error);
  }
  await Promise.allSettled([...active]);
  drainCommits(); // flush any scans that settled out of order after the walk finished
  if (firstError !== null) throw firstError;
  // Final backstop: a request that aborted/timed-out just as the last scans settled
  // (nothing left to re-check it) must surface 499/504, never a success payload.
  checkAbort();

  results.sort((a, b) => a.path.localeCompare(b.path));
  return { files: results, totalMatches, limitHit, tool: "node" };
}

/** Read one file, sniffing for binary content before decoding the remainder. */
async function scanOneFile(
  safePath: string,
  relPath: string,
  size: number,
  matcher: Matcher,
  checkAbort: () => void
): Promise<FsSearchFileResult | null> {
  if (size === 0) return null;
  const fh = await open(safePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(size);
    // Read the first 8 KiB and skip the file if it looks binary BEFORE reading the
    // rest — reusing the single fd (explicit positions, no reopen).
    const headLen = Math.min(size, 8192);
    const head = await fh.read(buffer, 0, headLen, 0);
    if (buffer.subarray(0, head.bytesRead).includes(0)) return null;
    let filled = head.bytesRead;
    while (filled < size) {
      checkAbort(); // bail out of a large multi-chunk read the moment the request is cancelled
      const chunk = await fh.read(buffer, filled, size - filled, filled);
      if (chunk.bytesRead === 0) break;
      filled += chunk.bytesRead;
    }
    return searchTextFile(buffer.subarray(0, filled).toString("utf8"), relPath, size, matcher);
  } finally {
    await fh.close();
  }
}

/** Minimal FIFO semaphore bounding the number of concurrent file scans. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise((resolveWaiter) => this.waiters.push(resolveWaiter));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }
}

// --- ripgrep fast path ---------------------------------------------------------

let resolvedRg: boolean | undefined;
let resolvedRgAt = 0;
// A negative probe is only trusted for 30s so `rg` installed after boot is picked up
// without a daemon restart; a positive probe is cached forever.
const RG_NEGATIVE_TTL_MS = 30_000;

/** Probe for `rg` on PATH, caching a hit forever and a miss for RG_NEGATIVE_TTL_MS. */
function resolveRg(): boolean {
  if (resolvedRg === true) return true;
  if (resolvedRg === false && Date.now() - resolvedRgAt < RG_NEGATIVE_TTL_MS) return false;
  resolvedRg = onPath("rg");
  resolvedRgAt = Date.now();
  return resolvedRg;
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

interface RipgrepOpts {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  maxResults: number;
  globs: CompiledGlobList | null;
  signal: AbortSignal;
  makeAbortError: () => FsSearchError;
}

/**
 * Escape `[` and `]` for ripgrep's glob parser so they match literally. Our glob grammar
 * has no `[]` character classes (they are literal path chars), but rg treats `[...]` as a
 * class; without escaping, `file[1].ts` would silently change meaning and `file[.ts` would
 * be a parse error. rg escapes a bracket as a single-char class: `[` → `[[]`, `]` → `[]]`
 * (verified against rg 14.1.0). Replacement scans the ORIGINAL string, so the `[`/`]` the
 * escapes introduce are not re-escaped.
 */
function escapeRgBrackets(source: string): string {
  return source.replace(/[[\]]/g, (ch) => (ch === "[" ? "[[]" : "[]]"));
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
async function searchWithRipgrep(fsRoot: string, root: string, opts: RipgrepOpts): Promise<FsSearchResponse> {
  const collected = await runRipgrep(root, opts);

  // A request aborted/timed-out AFTER runRipgrep resolves (e.g. during the stat loop
  // below) has no other checkpoint — without these the engine would still resolve a
  // success payload for a cancelled request. Check the same signal the rest of the
  // engine uses and throw the identical 499/504 FsSearchError.
  const throwIfAborted = (): void => {
    if (opts.signal.aborted) throw opts.makeAbortError();
  };
  throwIfAborted();

  // ripgrep's match events carry no file size; stat each matched file so `size`
  // matches the node path. Files live under `root` (already sandboxed); guard anyway.
  for (const file of collected.files) {
    throwIfAborted();
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
  throwIfAborted();

  // rg streams files in traversal order; the node engine returns them sorted by path.
  // Sort here (same localeCompare) so both engines produce identical, stable output.
  collected.files.sort((a, b) => a.path.localeCompare(b.path));
  return { files: collected.files, totalMatches: collected.totalMatches, limitHit: collected.limitHit, tool: "rg" };
}

function runRipgrep(
  root: string,
  opts: RipgrepOpts
): Promise<{ files: FsSearchFileResult[]; totalMatches: number; limitHit: boolean }> {
  return new Promise((resolveResult, rejectResult) => {
    if (opts.signal.aborted) {
      rejectResult(opts.makeAbortError());
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
      // Force single-threaded path-order traversal. Without it rg walks in parallel and
      // stops at the global cap in nondeterministic completion order, so a capped search
      // returns a different (non-prefix) file subset run to run. `--sort path` makes the
      // cap a deterministic path-order prefix, matching the node engine's reorder buffer.
      "--sort",
      "path",
      "--max-filesize",
      String(SEARCH_FILE_SIZE_LIMIT),
      opts.caseSensitive ? "--case-sensitive" : "--ignore-case"
    ];
    if (opts.wholeWord) args.push("-w");
    // Maps each emitted `-g` argument (exactly as rg receives it, `!`/anchor included) to
    // the raw user field it came from, so a glob-parse failure — whose stderr echoes that
    // same argument string — can be attributed back to "include"/"exclude" for the UI.
    const fieldByGlob = new Map<string, "include" | "exclude">();
    // Glob ORDER: user includes, then user excludes, then the built-in `!.git`/
    // `!node_modules` LAST. rg applies "later glob wins", so the built-ins always
    // override any user glob (parity with the node walker, which cannot descend into
    // SKIP_DIRS). This diverges from VS Code, where the user could re-include
    // node_modules; here they cannot — a deliberate round-1 non-goal.
    if (opts.globs) {
      const emit = (pattern: CompiledPattern, negate: boolean): void => {
        // Restore the root-anchor that `source` drops: a slash-less rg glob matches the
        // basename at any depth, so an anchored `/keep.ts` would widen to `**/keep.ts`
        // and diverge from the node matcher (which anchors). Prefixing `/` keeps rg's
        // gitignore-style anchoring aligned with the node engine. Escape `[`/`]` so rg
        // treats them as literals — our glob grammar has no `[]` classes, so `file[1].ts`
        // must match a literal `file[1].ts` on BOTH engines (and `file[.ts` must not
        // become an rg parse error). rg 14 escapes a bracket as its own one-char class.
        const body = escapeRgBrackets(pattern.source);
        const glob = `${negate ? "!" : ""}${pattern.anchored ? "/" : ""}${body}`;
        fieldByGlob.set(glob, pattern.field ?? "include");
        args.push("-g", glob);
      };
      for (const pattern of opts.globs.include) emit(pattern, false);
      for (const pattern of opts.globs.exclude) emit(pattern, true);
    }
    args.push("-g", "!.git", "-g", "!node_modules");
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
      finishErr(opts.makeAbortError());
    };
    const cleanup = () => opts.signal.removeEventListener("abort", onAbort);
    opts.signal.addEventListener("abort", onAbort, { once: true });

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
          // Global cap reached mid-stream. If this file already has accepted matches we
          // are dropping a real pending submatch → mark it truncated and keep it (parity
          // with the node engine's clamp). If it has none, this is the file just PAST the
          // boundary — drop it entirely so both engines return the same file set.
          if (current.matches.length > 0) current.truncated = true;
          else current = null;
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
      // A bad `-g` glob and a bad regex both exit 2; distinguish by stderr so the
      // client can annotate the right field. Check glob first — rg's glob error text
      // ("error parsing glob '…'") also matches the regex pattern below.
      if (/glob/i.test(stderrBuf)) {
        // rg echoes the offending glob verbatim ("error parsing glob '<g>': …"); map it
        // back to the raw field so the UI can flag the right input (fallback "include").
        const offending = stderrBuf.match(/error parsing glob '(.+?)':/)?.[1];
        const field = (offending && fieldByGlob.get(offending)) || "include";
        finishErr(new FsSearchError(400, "INVALID_GLOB", tail, field));
        return;
      }
      const isRegexError = /regex parse error|error parsing/i.test(stderrBuf);
      finishErr(new FsSearchError(400, isRegexError ? "INVALID_REQUEST" : "FS_ERROR", tail));
    });
  });
}

/**
 * Classify one dirent of an already-inside-root directory into a directory to
 * descend or a regular file to process, preserving the sandbox invariant WITHOUT any
 * realpath chain (the walk hotspot).
 *
 * Symlinks are SKIPPED entirely — files and directories alike — matching ripgrep's
 * default (no `-L`), so the two engines see the identical file set. This is also the
 * sandbox guarantee (a symlink is the only dirent that could point outside the root)
 * AND the cycle guard: a self-referential link (`self -> .`) or an in-tree link
 * (`docs-link -> docs`) would otherwise re-walk the tree, re-emitting the same files
 * until the cap. A non-symlink child of an inside-root directory cannot escape the
 * root — its realpath is `realpath(dir)` joined with the name, still under the root —
 * so such dirents are trusted via `dirent.isFile()`/`isDirectory()` (no realpath,
 * files `stat`'d only for their size).
 */
type DirentResolution =
  | { kind: "dir"; dir: string }
  | { kind: "file"; safePath: string; candidate: string; size: number }
  | null;

async function resolveDirent(dir: string, dirent: Dirent): Promise<DirentResolution> {
  if (dirent.isSymbolicLink()) return null; // never follow symlinks (parity, sandbox, cycle guard)
  if (dirent.isDirectory()) {
    if (SKIP_DIRS.has(dirent.name)) return null;
    return { kind: "dir", dir: join(dir, dirent.name) };
  }
  if (dirent.isFile()) {
    const candidate = join(dir, dirent.name);
    const info = await stat(candidate).catch(() => null); // regular file — stat only for size
    if (!info) return null;
    return { kind: "file", safePath: candidate, candidate, size: info.size };
  }
  return null; // fifo/socket/blockdev/etc.
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
  // Walk order is BYTE-ordered (not localeCompare) to match rg's `--sort path`, so a
  // capped listing selects the same path-order prefix across engines. The returned
  // listing is re-sorted by localeCompare on return, so this only affects cap membership.
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Resolve (stat) all of a directory's dirents in parallel — the per-file stat is the
  // walk's dominant cost, and libuv dispatches these across its threadpool. Order is
  // preserved (results align with the sorted dirents), and the listing is re-sorted by
  // path on return regardless, so this changes only timing, not output.
  const resolvedAll = await Promise.all(dirents.map((dirent) => resolveDirent(dir, dirent)));

  for (const resolved of resolvedAll) {
    throwIfAborted(signal);
    if (state.truncated) return;

    if (!resolved) continue;
    if (resolved.kind === "dir") {
      await walkProjectFiles(fsRoot, root, resolved.dir, files, state, maxFiles, signal);
      continue;
    }
    if (files.length >= maxFiles) {
      state.truncated = true;
      return;
    }

    const rel = relative(root, resolved.candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    files.push({ path: rel.split(sep).join("/"), size: resolved.size });
  }
}

interface Matcher {
  find(line: string): Array<{ start: number; end: number }>;
}

// The single word-character class used for whole-word boundary tests. It is a STATIC
// pattern applied to one code point at a time — never built from user input — so it
// cannot be driven into catastrophic backtracking.
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

/** The code point that STARTS at `index`, or null when out of range. */
function wordCharAt(line: string, index: number): boolean {
  if (index < 0 || index >= line.length) return false;
  return WORD_CHAR.test(String.fromCodePoint(line.codePointAt(index)!));
}

/** The code point ENDING just before `index` (surrogate-aware), or null at the start. */
function wordCharBefore(line: string, index: number): boolean {
  if (index <= 0) return false;
  const low = line.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index - 2 >= 0) {
    const high = line.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return WORD_CHAR.test(line.slice(index - 2, index));
  }
  return WORD_CHAR.test(String.fromCharCode(low));
}

/** A match [start,end) is a whole word iff neither adjacent code point is a word char. */
function isWordBoundary(line: string, start: number, end: number): boolean {
  return !wordCharBefore(line, start) && !wordCharAt(line, end);
}

/**
 * Case-fold a needle per code point (consistent with foldLine below), so folded
 * lengths line up between the needle and the haystack it is searched in.
 */
function foldString(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out += ch.toLowerCase();
    i += ch.length;
  }
  return out;
}

/**
 * Case-fold a line and record, for each folded UTF-16 unit, the ORIGINAL start/end
 * indices of the code point it came from. Lowercasing can change length (İ → i̇, two
 * units), so a hit in the folded string must be mapped back through these tables.
 * `start[f]` is the original START index of the source code point; `end[f]` is its
 * original END index. Mapping a match END through `end[...]` snaps a boundary that
 * lands INSIDE a multi-unit fold expansion to the end of that original code point,
 * so e.g. folded needle "i" matched against İ → "i̇" reports length 1, not 0.
 * `start[folded.length]` is a sentinel equal to `line.length`.
 */
function foldLine(line: string): { folded: string; start: number[]; end: number[] } {
  let folded = "";
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  while (i < line.length) {
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const low = ch.toLowerCase();
    const cpEnd = i + ch.length;
    for (let k = 0; k < low.length; k += 1) {
      folded += low[k];
      start.push(i);
      end.push(cpEnd);
    }
    i = cpEnd;
  }
  start.push(line.length);
  end.push(line.length);
  return { folded, start, end };
}

// Literal (non-regex) matcher only. Regex mode is served exclusively by ripgrep's
// non-backtracking engine (see searchProjectFiles); a JS RegExp is never built from
// user input here, so this path cannot be driven into catastrophic backtracking.
function createMatcher(query: string, caseSensitive: boolean, wholeWord: boolean): Matcher {
  if (caseSensitive) {
    return {
      find(line) {
        const out: Array<{ start: number; end: number }> = [];
        if (!query) return out;
        let index = 0;
        for (;;) {
          index = line.indexOf(query, index);
          if (index === -1) return out;
          const end = index + query.length;
          if (!wholeWord || isWordBoundary(line, index, end)) out.push({ start: index, end });
          index += Math.max(query.length, 1);
        }
      }
    };
  }

  const needle = foldString(query);
  return {
    find(line) {
      const out: Array<{ start: number; end: number }> = [];
      if (!needle) return out;
      const { folded, start: startMap, end: endMap } = foldLine(line);
      let index = 0;
      for (;;) {
        index = folded.indexOf(needle, index);
        if (index === -1) return out;
        // Map the folded hit back to the original line's offsets before recording it.
        // The START uses the source code point's start; the END uses the LAST matched
        // folded unit's source-code-point END, so a boundary falling inside an expanded
        // fold (İ → "i̇") snaps to the code point's end instead of collapsing to zero.
        const start = startMap[index];
        const end = endMap[index + needle.length - 1];
        if (!wholeWord || isWordBoundary(line, start, end)) out.push({ start, end });
        index += Math.max(needle.length, 1);
      }
    }
  };
}

function searchTextFile(
  content: string,
  path: string,
  size: number,
  matcher: Matcher
): FsSearchFileResult | null {
  const matches: FsSearchMatch[] = [];
  const lines = content.split("\n");

  // Collect up to the per-file cap only; the GLOBAL maxResults budget is applied
  // deterministically at commit time (searchWithNode), not here, so a file's match
  // count never depends on how many sibling scans happened to finish first.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    for (const match of matcher.find(line)) {
      if (matches.length >= SEARCH_MATCHES_PER_FILE_LIMIT) {
        return { path, size, matches, truncated: true };
      }
      matches.push({ line: index + 1, ...formatLineMatch(line, match.start, match.end) });
    }
  }

  return matches.length > 0 ? { path, size, matches, truncated: false } : null;
}

function formatLineMatch(line: string, start: number, end: number): Omit<FsSearchMatch, "line"> {
  // `column`/`matchLength` are the offsets into the FULL original line (for editor jumps);
  // `start`/`end` are windowed into `text` for snippet rendering and can diverge on long lines.
  const matchLength = end - start;
  if (line.length <= SEARCH_LINE_TEXT_LIMIT) return { text: line, start, end, column: start, matchLength };

  const windowStart = Math.max(0, Math.min(start - 80, line.length - SEARCH_LINE_TEXT_LIMIT));
  const adjustedStart = Math.max(0, start - windowStart);
  return {
    text: line.slice(windowStart, windowStart + SEARCH_LINE_TEXT_LIMIT),
    start: adjustedStart,
    end: Math.min(SEARCH_LINE_TEXT_LIMIT, adjustedStart + matchLength),
    column: start,
    matchLength
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
