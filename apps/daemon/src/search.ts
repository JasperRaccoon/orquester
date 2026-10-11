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
import { lstatSync, type Dirent } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { onPath } from "./archive";

const FILE_LIST_LIMIT = 20_000;
// Upper bound on candidate paths gathered before the listing is selected, so a
// pathological tree (or `includeIgnored` over a huge build output) stays bounded.
const FILE_LIST_SCAN_CEILING = 200_000;
// Paths sized per synchronous lstat batch before yielding to the event loop. A sync
// lstat is several times cheaper than a threadpool round trip; batching keeps each
// event-loop stall to a few milliseconds.
const FILE_STAT_BATCH = 512;
// Concurrent readdir calls per BFS level of the fallback walker.
const WALK_READDIR_CONCURRENCY = 32;
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

/**
 * Recursive file listing for quick-open. Gitignored files are left out unless
 * `includeIgnored` is set; `.git` and `node_modules` are always left out.
 *
 * Sources, fastest first: `rg --files`, then (hiding ignored files) `git ls-files`,
 * then a breadth-first walk. When more than `maxFiles` files exist, non-ignored files
 * are kept first and then the shallowest ones (byte order within a depth), so a deep
 * vendored, generated or worktree tree can't crowd the project's own files out.
 */
export async function listProjectFiles(
  _fsRoot: string,
  root: string,
  options: { maxFiles?: number | string; includeIgnored?: boolean; signal?: AbortSignal } = {}
): Promise<FsFilesResponse> {
  // Probe before the first await, like searchProjectFiles.
  const useRg = resolveRg();
  const includeIgnored = Boolean(options.includeIgnored);
  const { signal, makeAbortError } = searchDeadline(options.signal);
  const checkAbort = (): void => {
    if (signal.aborted) throw makeAbortError();
  };
  checkAbort();

  const rootPath = resolve(root);
  const rootInfo = await stat(rootPath);
  if (!rootInfo.isDirectory()) throw new FsSearchError(400, "FS_ERROR", "Not a directory.");
  const maxFiles = clampInt(options.maxFiles, 1, FILE_LIST_LIMIT, FILE_LIST_LIMIT);

  let candidates: CandidatePaths | null = null;
  // With includeIgnored, the non-ignored files, which win a capped selection.
  let preferred: CandidatePaths | null = null;
  // git lists index entries, so a tracked directory that later became a symlink could
  // lead outside the root; rg and the walker never descend through symlinks.
  let verifyParent: ParentCheck | null = null;
  if (useRg) {
    try {
      [candidates, preferred] = await Promise.all([
        listWithRipgrep(rootPath, includeIgnored, signal),
        includeIgnored ? listWithRipgrep(rootPath, false, signal).catch(() => null) : null
      ]);
    } catch (error) {
      // A spawn or walk failure falls through to the slower sources.
      if (error instanceof FsSearchError) throw error;
    }
  }
  checkAbort();
  if (!candidates) {
    preferred = await listGitVisible(rootPath, signal);
    checkAbort();
    if (preferred) verifyParent = createParentCheck(rootPath);
    candidates = preferred && !includeIgnored ? preferred : await walkCandidates(rootPath, maxFiles, checkAbort);
  }

  let preferredSet: Set<string> | null = null;
  if (preferred && includeIgnored) {
    preferredSet = new Set(preferred.paths);
    if (candidates.truncated) {
      // A gather that stopped early (walk depth, scan ceiling) may have missed some.
      const gathered = new Set(candidates.paths);
      const missing = preferred.paths.filter((path) => !gathered.has(path));
      if (missing.length > 0) candidates = { paths: candidates.paths.concat(missing), truncated: true };
    }
  }
  const selected = selectListing(candidates.paths, maxFiles, preferredSet);
  const files = await statCandidates(rootPath, selected, verifyParent, checkAbort);
  checkAbort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: rootPath, files, truncated: candidates.truncated || candidates.paths.length > maxFiles };
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
    /** Search gitignored files too. `.git` and `node_modules` stay excluded. */
    includeIgnored?: boolean;
    signal?: AbortSignal;
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
  const includeIgnored = Boolean(options.includeIgnored);
  const { signal: composed, makeAbortError } = searchDeadline(options.signal);

  const useRg = resolveRg();

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
        includeIgnored,
        signal: composed,
        makeAbortError
      });
    } catch (error) {
      // Regex/glob/exit-2/abort surface as FsSearchError and must propagate. A spawn
      // failure at runtime (rg vanished after the probe) is any other error — fall
      // through to the node engine.
      if (error instanceof FsSearchError) throw error;
    }
  }

  // Regex requires ripgrep's non-backtracking engine. A JavaScript RegExp can
  // block the event loop indefinitely, so the Node fallback supports only literals.
  if (options.regex) {
    throw new FsSearchError(
      400,
      "REGEX_UNSUPPORTED",
      "Regex search requires ripgrep (rg) installed on the server. Turn off regex mode or install rg.",
      "query"
    );
  }

  return await searchWithNode(rootPath, {
    matcher: createMatcher(options.query, Boolean(options.caseSensitive), Boolean(options.wholeWord)),
    maxResults,
    globs,
    includeIgnored,
    signal: composed,
    makeAbortError
  });
}

/**
 * Compose the 10s search backstop with the caller's signal. AbortSignal.timeout's
 * timer is unref'd, so a fast search doesn't keep the process alive waiting on it.
 */
function searchDeadline(signal?: AbortSignal): { signal: AbortSignal; makeAbortError: () => FsSearchError } {
  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return {
    signal: AbortSignal.any(signal ? [signal, timeoutSignal] : [timeoutSignal]),
    makeAbortError: () =>
      timeoutSignal.aborted
        ? new FsSearchError(504, "SEARCH_TIMEOUT", "Search timed out.")
        : new FsSearchError(499, "REQUEST_ABORTED", "Request aborted.")
  };
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
  includeIgnored: boolean;
  signal: AbortSignal;
  makeAbortError: () => FsSearchError;
}

/** One regular file offered to the node engine, in discovery order. */
interface NodeFileEntry {
  relPosix: string;
  safePath: string;
  size: number;
}

/**
 * Pure-Node search. Interleaves file discovery with a bounded pool of per-file scans
 * and stops discovery as soon as the committed budget is exhausted. Files come from
 * `git ls-files` (byte path order) when gitignored files are hidden and the root is
 * in a git work tree, otherwise from a sorted DFS walk.
 *
 * Aggregation is DETERMINISTIC: files are discovered in a fixed order, each
 * scheduled scan is stamped with a monotonic sequence number, and completed scans are
 * committed through a reorder buffer strictly in sequence order. Parallel IO is
 * preserved (scans still run concurrently), but the budget (`maxResults`, the per-file
 * clamp, `limitHit`) is consumed in a fixed path order, so two identical searches that
 * truncate at the same boundary always return the same files — no completion-order race.
 */
async function searchWithNode(root: string, opts: NodeSearchOpts): Promise<FsSearchResponse> {
  const results: FsSearchFileResult[] = [];
  let totalMatches = 0;
  let limitHit = false;
  let stop = false;
  let firstError: unknown = null;
  let sourcePartial = false;

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

  const discover = async (): Promise<void> => {
    checkAbort();
    const source = await nodeFileEntries(root, opts.includeIgnored, opts.signal, checkAbort);
    // A listing cut at its ceiling leaves files unsearched: report the limit.
    if (source.partial) sourcePartial = true;
    for await (const entry of source.entries) {
      if (stop) return;
      checkAbort();
      if (entry.size > SEARCH_FILE_SIZE_LIMIT) continue;
      if (opts.globs && !matchesGlobList(opts.globs, entry.relPosix)) continue;

      // Throttle the launch rate to the buffer window BEFORE consuming a permit, so a
      // stalled head-of-line scan parks discovery here instead of buffering the tree.
      await waitForBuffer();
      if (stop) return;
      await sem.acquire();
      if (stop) {
        sem.release();
        return;
      }
      const seq = nextSeq++; // stamp in discovery order BEFORE launching the async scan
      inFlight += 1;
      const p = scan(seq, entry.relPosix, entry.safePath, entry.size);
      active.add(p);
      void p.finally(() => active.delete(p));
    }
  };

  try {
    await discover();
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
  return { files: results, totalMatches, limitHit: limitHit || sourcePartial, tool: "node" };
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
  includeIgnored: boolean;
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
  // A positive rg glob overrides ignore rules (`-g '*.ts'` also searches a gitignored
  // `x.ts`). While ignored files are hidden, an include glob therefore needs the set of
  // visible files (`rg --files` with the same ignore rules, cheap next to the search)
  // to drop such matches before they count. Without that set (lister failed or hit its
  // ceiling) the includes are matched in Node instead: correct, but rg then reads every
  // visible file.
  let visible: Set<string> | null = null;
  let includesInNode = false;
  if (!opts.includeIgnored && opts.globs && opts.globs.include.length > 0) {
    const listing = await listWithRipgrep(root, false, opts.signal).catch(() => null);
    if (opts.signal.aborted) throw opts.makeAbortError();
    if (listing && !listing.truncated) visible = new Set(listing.paths);
    else includesInNode = true;
  }
  const collected = await runRipgrep(root, opts, visible, includesInNode);

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
  opts: RipgrepOpts,
  visible: Set<string> | null,
  includesInNode: boolean
): Promise<{ files: FsSearchFileResult[]; totalMatches: number; limitHit: boolean }> {
  return new Promise((resolveResult, rejectResult) => {
    if (opts.signal.aborted) {
      rejectResult(opts.makeAbortError());
      return;
    }

    const args = [
      "--json",
      "--hidden",
      "--no-config",
      "--crlf",
      // No `--sort path`: it forces a single-threaded walk (several times slower). rg
      // still writes each file's matches contiguously, and the result is sorted by
      // path below; only which files make it under a reached cap can vary run to run.
      "--max-filesize",
      String(SEARCH_FILE_SIZE_LIMIT),
      opts.caseSensitive ? "--case-sensitive" : "--ignore-case"
    ];
    // Without it rg honors .gitignore/.ignore, which is the default: a gitignored build
    // or worktree directory would otherwise dominate the search.
    if (opts.includeIgnored) args.push("--no-ignore");
    if (opts.wholeWord) args.push("-w");
    // Maps each emitted `-g` argument (exactly as rg receives it, `!`/anchor included) to
    // the raw user field it came from, so a glob-parse failure — whose stderr echoes that
    // same argument string — can be attributed back to "include"/"exclude" for the UI.
    const fieldByGlob = new Map<string, "include" | "exclude">();
    // See searchWithRipgrep: drop matches in files the ignore rules hide, or match the
    // includes here when they are not handed to rg. Exclusions only remove files, so
    // they always go to rg.
    const nodeGlobs = includesInNode ? opts.globs : null;
    let checkedPath: string | null = null;
    let checkedAllowed = true;
    const allowedPath = (path: string): boolean => {
      if (!visible && !nodeGlobs) return true;
      if (path !== checkedPath) {
        checkedPath = path;
        checkedAllowed = visible ? visible.has(path) : matchesGlobList(nodeGlobs!, path);
      }
      return checkedAllowed;
    };
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
      if (!includesInNode) for (const pattern of opts.globs.include) emit(pattern, false);
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
      if (!allowedPath(path)) return;

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

/** The node engine's files: git's visible files when ignored ones are hidden, else a DFS walk. */
async function nodeFileEntries(
  root: string,
  includeIgnored: boolean,
  signal: AbortSignal,
  checkAbort: () => void
): Promise<{ entries: AsyncIterable<NodeFileEntry>; partial: boolean }> {
  if (!includeIgnored) {
    const listed = await listGitVisible(root, signal);
    checkAbort();
    if (listed) {
      const entries = listedFileEntries(root, listed.paths, createParentCheck(root), checkAbort);
      return { entries, partial: listed.truncated };
    }
  }
  return { entries: walkFileEntries(root, root, checkAbort), partial: false };
}

/** Yield listed paths that are still regular files, in byte path order. */
async function* listedFileEntries(
  root: string,
  paths: string[],
  verifyParent: ParentCheck,
  checkAbort: () => void
): AsyncGenerator<NodeFileEntry> {
  for (const relPosix of [...paths].sort(compareBytes)) {
    checkAbort();
    const entry = await statCandidate(root, relPosix, verifyParent);
    if (entry) yield { relPosix, safePath: entry.abs, size: entry.size };
  }
}

/** Depth-first walk of every regular file under `dir`, siblings in byte order. */
async function* walkFileEntries(root: string, dir: string, checkAbort: () => void): AsyncGenerator<NodeFileEntry> {
  checkAbort();
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip its subtree
  }
  // Byte order (not localeCompare), like the git listing, so a capped search keeps a
  // stable path-order prefix. The final result listing is sorted by localeCompare.
  dirents.sort((a, b) => compareBytes(a.name, b.name));

  for (const dirent of dirents) {
    checkAbort();
    const resolved = await resolveDirent(dir, dirent);
    if (!resolved) continue;
    if (resolved.kind === "dir") {
      yield* walkFileEntries(root, resolved.dir, checkAbort);
      continue;
    }
    const rel = relative(root, resolved.candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    yield { relPosix: rel.split(sep).join("/"), safePath: resolved.safePath, size: resolved.size };
  }
}

// --- file listing sources --------------------------------------------------------

/** Root-relative POSIX paths gathered for the listing, before selection and sizing. */
interface CandidatePaths {
  paths: string[];
  /** True when gathering stopped at FILE_LIST_SCAN_CEILING. */
  truncated: boolean;
}

/** Resolves true when a listed path's parent directory has no symlink below the root. */
type ParentCheck = (relPosix: string) => Promise<boolean>;

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// An empty, `.` or `..` segment (anything that could escape the root or alias a path)
// or a SKIP_DIRS segment. One regex test per path is far cheaper than splitting it.
const UNLISTABLE_SEGMENT = /(?:^|\/)(?:|\.|\.\.|\.git|node_modules)(?:\/|$)/;

/**
 * Normalize one path printed by rg or git relative to the root, or null when it must
 * not be listed: anything escaping the root, and anything under `.git`/`node_modules`.
 */
function normalizeListedPath(raw: string): string | null {
  let rel = sep === "/" ? raw : raw.split(sep).join("/");
  if (rel.startsWith("./")) rel = rel.slice(2);
  // git prints an untracked nested repository as `dir/`; lstat later drops it.
  if (rel.endsWith("/")) rel = rel.slice(0, -1);
  if (!rel || UNLISTABLE_SEGMENT.test(rel)) return null;
  return rel;
}

/**
 * Run a lister that prints NUL-terminated paths relative to `root`, optionally
 * deduplicating them (git prints an unmerged path once per stage). Stops at
 * FILE_LIST_SCAN_CEILING with `truncated`. An abort kills the child and resolves with
 * `code: null`; callers re-check their signal. A spawn failure (missing binary) rejects.
 */
function runPathLister(
  command: string,
  args: string[],
  root: string,
  signal: AbortSignal,
  dedupe: boolean
): Promise<{ paths: string[]; truncated: boolean; code: number | null; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    if (signal.aborted) {
      resolveRun({ paths: [], truncated: false, code: null, stderr: "" });
      return;
    }
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const paths: string[] = [];
    const seen = dedupe ? new Set<string>() : null;
    let pending: Buffer = Buffer.alloc(0);
    let stderr = "";
    let settled = false;

    const finish = (code: number | null, truncated: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveRun({ paths, truncated, code, stderr });
    };
    const onAbort = (): void => {
      child.kill();
      finish(null, false);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      // Decode up to the last terminator in one go; a multi-byte character can't
      // straddle it, and the unterminated tail waits for the next chunk.
      const end = buffer.lastIndexOf(0);
      if (end === -1) {
        pending = buffer;
        return;
      }
      pending = buffer.subarray(end + 1);
      for (const raw of buffer.toString("utf8", 0, end).split("\0")) {
        const rel = normalizeListedPath(raw);
        if (rel === null) continue;
        if (seen) {
          if (seen.has(rel)) continue;
          seen.add(rel);
        }
        paths.push(rel);
        if (paths.length >= FILE_LIST_SCAN_CEILING) {
          child.kill();
          finish(0, true);
          return;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rejectRun(error);
    });
    child.on("close", (code) => finish(code, false));
  });
}

/**
 * `rg --files`: honors .gitignore/.ignore unless `includeIgnored`, never follows
 * symlinks. Exit 2 with some output means a subtree was unreadable — kept, like the
 * walker skipping it. Any other failure is a plain Error so the caller falls back.
 */
async function listWithRipgrep(root: string, includeIgnored: boolean, signal: AbortSignal): Promise<CandidatePaths> {
  const args = ["--files", "--null", "--hidden", "--no-config"];
  if (includeIgnored) args.push("--no-ignore");
  args.push("-g", "!.git", "-g", "!node_modules", ".");
  const run = await runPathLister("rg", args, root, signal, false);
  // A null code is our own abort (callers re-check the signal) or an outside kill.
  if (run.code === null && !signal.aborted) throw new Error("ripgrep was terminated.");
  if (run.code === null || run.code === 0 || run.code === 1 || (run.code === 2 && run.paths.length > 0)) {
    return { paths: run.paths, truncated: run.truncated };
  }
  throw new Error(run.stderr.trim() || `ripgrep exited with code ${run.code}.`);
}

/**
 * Tracked plus untracked-but-not-ignored files under `root` (`git ls-files` limits
 * itself to the working directory and prints paths relative to it). Null when git is
 * missing, `root` is not in a work tree, or nothing is listed — the caller then walks.
 */
async function listGitVisible(root: string, signal: AbortSignal): Promise<CandidatePaths | null> {
  try {
    const run = await runPathLister(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      root,
      signal,
      true
    );
    if (run.code !== 0 || run.paths.length === 0) return null;
    return { paths: run.paths, truncated: run.truncated };
  } catch {
    return null;
  }
}

/** Breadth-first walk for hosts without rg (or git), stopping after the level that passes `maxFiles`. */
async function walkCandidates(root: string, maxFiles: number, checkAbort: () => void): Promise<CandidatePaths> {
  const paths: string[] = [];
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += WALK_READDIR_CONCURRENCY) {
      checkAbort();
      const batch = level.slice(i, i + WALK_READDIR_CONCURRENCY);
      const listed = await Promise.all(
        batch.map((dir) =>
          readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
            if (dir === root) throw error;
            return null; // unreadable directory — skip its subtree
          })
        )
      );
      for (let j = 0; j < batch.length; j += 1) {
        const dirents = listed[j];
        if (!dirents) continue;
        for (const dirent of dirents) {
          if (dirent.isSymbolicLink()) continue; // never followed (parity with rg, sandbox, cycles)
          const abs = join(batch[j], dirent.name);
          if (dirent.isDirectory()) {
            if (!SKIP_DIRS.has(dirent.name)) next.push(abs);
            continue;
          }
          if (!dirent.isFile()) continue;
          paths.push(relative(root, abs).split(sep).join("/"));
          if (paths.length >= FILE_LIST_SCAN_CEILING) return { paths, truncated: true };
        }
      }
    }
    // Every file at this depth is in, so the shallowest-first selection is exact.
    if (paths.length > maxFiles) return { paths, truncated: true };
    level = next;
  }
  return { paths, truncated: false };
}

/**
 * Keep every path when they fit. Otherwise keep `preferred` paths first, then fill
 * the remaining room shallowest-first (byte order within the boundary depth).
 */
function selectListing(paths: string[], maxFiles: number, preferred: Set<string> | null): string[] {
  if (paths.length <= maxFiles) return paths;
  let tiers = [paths];
  if (preferred) {
    const first: string[] = [];
    const rest: string[] = [];
    for (const path of paths) (preferred.has(path) ? first : rest).push(path);
    tiers = [first, rest];
  }
  const selected: string[] = [];
  for (const tier of tiers) {
    appendShallowest(selected, tier, maxFiles - selected.length);
    if (selected.length >= maxFiles) break;
  }
  return selected;
}

/** Append up to `room` paths of `paths` to `out`, shallowest first. */
function appendShallowest(out: string[], paths: string[], room: number): void {
  if (room <= 0) return;
  const byDepth = new Map<number, string[]>();
  for (const path of paths) {
    let depth = 1;
    for (let i = 0; i < path.length; i += 1) if (path.charCodeAt(i) === 47) depth += 1; // "/"
    const bucket = byDepth.get(depth);
    if (bucket) bucket.push(path);
    else byDepth.set(depth, [path]);
  }
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const bucket = byDepth.get(depth)!;
    if (bucket.length > room) {
      // Only the boundary depth needs a stable order to pick its members.
      bucket.sort(compareBytes);
      bucket.length = room;
    }
    for (const path of bucket) out.push(path);
    room -= bucket.length;
    if (room === 0) return;
  }
}

/**
 * Check that every directory between the root and a listed path is a real directory
 * (lstat, so a symlinked directory fails), which keeps the path inside the root.
 * Verdicts are cached per directory.
 */
function createParentCheck(root: string): ParentCheck {
  const verdicts = new Map<string, Promise<boolean>>();
  const directoryOk = (dir: string): Promise<boolean> => {
    let verdict = verdicts.get(dir);
    if (!verdict) {
      const cut = dir.lastIndexOf("/");
      const parentOk = cut < 0 ? Promise.resolve(true) : directoryOk(dir.slice(0, cut));
      verdict = parentOk.then(async (ok) => {
        if (!ok) return false;
        const info = await lstat(join(root, ...dir.split("/"))).catch(() => null);
        return Boolean(info?.isDirectory());
      });
      verdicts.set(dir, verdict);
    }
    return verdict;
  };
  return (relPosix) => {
    const cut = relPosix.lastIndexOf("/");
    return cut < 0 ? Promise.resolve(true) : directoryOk(relPosix.slice(0, cut));
  };
}

/** lstat one listed path; null unless it is (still) a regular file reachable without symlinks. */
async function statCandidate(
  root: string,
  relPosix: string,
  verifyParent: ParentCheck | null
): Promise<{ abs: string; size: number } | null> {
  if (verifyParent && !(await verifyParent(relPosix))) return null;
  const abs = join(root, ...relPosix.split("/"));
  const info = await lstat(abs).catch(() => null);
  return info?.isFile() ? { abs, size: info.size } : null;
}

/** Size the selected paths, dropping any that are no longer regular files. */
async function statCandidates(
  root: string,
  paths: string[],
  verifyParent: ParentCheck | null,
  checkAbort: () => void
): Promise<FsProjectFile[]> {
  const files: FsProjectFile[] = [];
  for (let start = 0; start < paths.length; start += FILE_STAT_BATCH) {
    if (start > 0) await new Promise<void>((resume) => setImmediate(resume));
    checkAbort();
    for (const path of paths.slice(start, start + FILE_STAT_BATCH)) {
      if (verifyParent && !(await verifyParent(path))) continue;
      let info;
      try {
        info = lstatSync(join(root, ...path.split("/")), { throwIfNoEntry: false });
      } catch {
        continue; // e.g. a parent replaced by a file mid-listing
      }
      if (info?.isFile()) files.push({ path, size: info.size });
    }
  }
  return files;
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
