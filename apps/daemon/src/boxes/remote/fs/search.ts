/**
 * Quick-open listing and content search for a box project (`/api/fs/files`,
 * `/api/fs/search`), run IN the box: the same `rg --files` / `git ls-files`
 * listers and the same ripgrep argument building and `--json` parsing as the
 * host (`search.ts`), spawned through the box link. Cancellation kills the box
 * process (the request's signal, composed with the 10 s backstop).
 *
 * What differs from the host is only how the daemon learns about files it did
 * not get from rg: sizes and the "no symlinked parent" check come from one
 * `fs.readdir` per directory (a box answers a directory's entries with their
 * kinds and sizes in one round trip), never one `lstat` per file.
 *
 * Without rg in the box: listing falls back to `git ls-files`, then a
 * breadth-first walk over `fs.readdir`. Literal search falls back to the node
 * engine over box reads, its files pre-filtered by `git grep -l` where git can
 * answer (so only files that contain the text are read over the link), else a
 * walk. Regex search needs rg, as on the host. `git grep -i` folds ASCII case
 * only, so a case-insensitive query with non-ASCII letters skips the pre-filter.
 */

import type { FsFilesResponse, FsProjectFile, FsSearchResponse } from "@orquester/api";

import {
  FILE_LIST_LIMIT,
  FILE_LIST_SCAN_CEILING,
  FsSearchError,
  SEARCH_FILE_SIZE_LIMIT,
  SEARCH_MATCH_DEFAULT_LIMIT,
  SEARCH_MATCH_MAX_LIMIT,
  SEARCH_QUERY_LIMIT,
  SKIP_DIRS,
  WALK_READDIR_CONCURRENCY,
  clampInt,
  compareBytes,
  createMatcher,
  listGitVisible,
  listWithRipgrep,
  parseGlobs,
  runPathLister,
  runRipgrep,
  searchDeadline,
  searchTextFile,
  searchWithNode,
  selectListing,
  type CandidatePaths,
  type NodeFileEntry,
  type NodeSearchSource,
  type SearchSpawn
} from "../../../search.ts";
import { boxSearchSpawn, boxTools } from "./exec.ts";
import { hostJoin } from "./paths.ts";
import type { BoxProjectFs, ProjectFsDirEntry } from "./project-fs.ts";

// ---------------------------------------------------------------------------
// Directory listings, one request per directory
// ---------------------------------------------------------------------------

/**
 * Directory entries under one root, fetched at most once per directory and at
 * most WALK_READDIR_CONCURRENCY at a time. A directory that cannot be read
 * answers null (its subtree is skipped, like the host walker does).
 */
class DirListings {
  private readonly listings = new Map<string, Promise<Map<string, ProjectFsDirEntry> | null>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly fs: BoxProjectFs,
    private readonly root: string
  ) {}

  /** Entries of `relDir` ("" = the root) by name; the root's own failure rejects. */
  get(relDir: string): Promise<Map<string, ProjectFsDirEntry> | null> {
    let listing = this.listings.get(relDir);
    if (!listing) {
      listing = this.fetch(relDir);
      this.listings.set(relDir, listing);
    }
    return listing;
  }

  private async fetch(relDir: string): Promise<Map<string, ProjectFsDirEntry> | null> {
    await this.acquire();
    try {
      const entries = await this.fs.readdir(hostJoin(this.root, relDir === "" ? [] : relDir.split("/")));
      return new Map(entries.map((entry) => [entry.name, entry]));
    } catch (error) {
      if (relDir === "") throw error;
      return null;
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < WALK_READDIR_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resume) => this.waiting.push(resume));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  /**
   * Whether every directory from the root down to `relPosix`'s parent is a real
   * directory (no symlink, which could lead outside the root), and the entry
   * for `relPosix` itself; null when either is not so.
   */
  async entry(relPosix: string): Promise<ProjectFsDirEntry | null> {
    const segments = relPosix.split("/");
    let relDir = "";
    for (let i = 0; i < segments.length - 1; i += 1) {
      const listing = await this.get(relDir);
      const child = listing?.get(segments[i]!);
      if (!child || child.kind !== "dir") return null;
      relDir = relDir === "" ? segments[i]! : `${relDir}/${segments[i]}`;
    }
    const listing = await this.get(relDir);
    return listing?.get(segments[segments.length - 1]!) ?? null;
  }
}

/** Size the selected paths, dropping any that are not regular files reachable without symlinks. */
async function sizeListed(dirs: DirListings, paths: string[], checkAbort: () => void): Promise<FsProjectFile[]> {
  const files: FsProjectFile[] = [];
  const BATCH = 512;
  for (let start = 0; start < paths.length; start += BATCH) {
    checkAbort();
    const batch = paths.slice(start, start + BATCH);
    const entries = await Promise.all(batch.map((path) => dirs.entry(path).catch(() => null)));
    batch.forEach((path, index) => {
      const entry = entries[index];
      if (entry?.kind === "file") files.push({ path, size: entry.size });
    });
  }
  return files;
}

/** Breadth-first walk (no rg, no git in the box), stopping after the level that passes `maxFiles`. */
async function walkCandidates(dirs: DirListings, maxFiles: number, checkAbort: () => void): Promise<CandidatePaths> {
  const paths: string[] = [];
  let level = [""];
  while (level.length > 0) {
    checkAbort();
    const next: string[] = [];
    const listings = await Promise.all(level.map((relDir) => dirs.get(relDir)));
    for (let i = 0; i < level.length; i += 1) {
      const listing = listings[i];
      if (!listing) continue;
      for (const entry of listing.values()) {
        const rel = level[i] === "" ? entry.name : `${level[i]}/${entry.name}`;
        if (entry.kind === "dir") {
          if (!SKIP_DIRS.has(entry.name)) next.push(rel);
          continue;
        }
        if (entry.kind !== "file") continue; // symlinks are never followed (parity with rg)
        paths.push(rel);
        if (paths.length >= FILE_LIST_SCAN_CEILING) return { paths, truncated: true };
      }
    }
    if (paths.length > maxFiles) return { paths, truncated: true };
    level = next;
  }
  return { paths, truncated: false };
}

// ---------------------------------------------------------------------------
// Quick-open listing
// ---------------------------------------------------------------------------

/** `listProjectFiles` for a box project; `root` is the contained host path of the listed directory. */
export async function listBoxProjectFiles(
  fs: BoxProjectFs,
  root: string,
  options: { maxFiles?: number | string; includeIgnored?: boolean; signal?: AbortSignal } = {}
): Promise<FsFilesResponse> {
  const includeIgnored = Boolean(options.includeIgnored);
  const { signal, makeAbortError } = searchDeadline(options.signal);
  const checkAbort = (): void => {
    if (signal.aborted) throw makeAbortError();
  };
  checkAbort();
  const tools = await boxTools(fs);
  checkAbort();

  const rootInfo = await fs.stat(root);
  if (!rootInfo || rootInfo.kind !== "dir") {
    if (!rootInfo) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${root}'`), { code: "ENOENT" });
    throw new FsSearchError(400, "FS_ERROR", "Not a directory.");
  }
  const maxFiles = clampInt(options.maxFiles, 1, FILE_LIST_LIMIT, FILE_LIST_LIMIT);
  const spawn = boxSearchSpawn(fs);
  const dirs = new DirListings(fs, root);

  let candidates: CandidatePaths | null = null;
  let preferred: CandidatePaths | null = null;
  if (tools.rg) {
    try {
      [candidates, preferred] = await Promise.all([
        listWithRipgrep(root, includeIgnored, signal, spawn),
        includeIgnored ? listWithRipgrep(root, false, signal, spawn).catch(() => null) : null
      ]);
    } catch (error) {
      if (error instanceof FsSearchError) throw error;
    }
  }
  checkAbort();
  if (!candidates) {
    preferred = tools.git ? await listGitVisible(root, signal, spawn) : null;
    checkAbort();
    candidates = preferred && !includeIgnored ? preferred : await walkCandidates(dirs, maxFiles, checkAbort);
  }

  let preferredSet: Set<string> | null = null;
  if (preferred && includeIgnored) {
    preferredSet = new Set(preferred.paths);
    if (candidates.truncated) {
      const gathered = new Set(candidates.paths);
      const missing = preferred.paths.filter((path) => !gathered.has(path));
      if (missing.length > 0) candidates = { paths: candidates.paths.concat(missing), truncated: true };
    }
  }
  const selected = selectListing(candidates.paths, maxFiles, preferredSet);
  const files = await sizeListed(dirs, selected, checkAbort);
  checkAbort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, truncated: candidates.truncated || candidates.paths.length > maxFiles };
}

// ---------------------------------------------------------------------------
// Content search
// ---------------------------------------------------------------------------

export interface BoxSearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string;
  exclude?: string;
  maxResults?: number | string;
  includeIgnored?: boolean;
  signal?: AbortSignal;
}

/** `searchProjectFiles` for a box project; `root` is the contained host path of the searched directory. */
export async function searchBoxProjectFiles(fs: BoxProjectFs, root: string, options: BoxSearchOptions): Promise<FsSearchResponse> {
  if (!options.query) throw new FsSearchError(400, "INVALID_REQUEST", "q required.", "query");
  if (options.query.length > SEARCH_QUERY_LIMIT) {
    throw new FsSearchError(400, "INVALID_REQUEST", `q must be ${SEARCH_QUERY_LIMIT} characters or fewer.`, "query");
  }
  if (options.signal?.aborted) throw new FsSearchError(499, "REQUEST_ABORTED", "Request aborted.");

  const maxResults = clampInt(options.maxResults, 1, SEARCH_MATCH_MAX_LIMIT, SEARCH_MATCH_DEFAULT_LIMIT);
  const globs = parseGlobs(options.include, options.exclude);
  const includeIgnored = Boolean(options.includeIgnored);
  const { signal, makeAbortError } = searchDeadline(options.signal);
  const throwIfAborted = (): void => {
    if (signal.aborted) throw makeAbortError();
  };
  const tools = await boxTools(fs);
  throwIfAborted();
  const spawn = boxSearchSpawn(fs);
  const dirs = new DirListings(fs, root);

  if (tools.rg) {
    try {
      return await searchWithBoxRipgrep(root, spawn, dirs, {
        query: options.query,
        caseSensitive: Boolean(options.caseSensitive),
        wholeWord: Boolean(options.wholeWord),
        regex: Boolean(options.regex),
        maxResults,
        globs,
        includeIgnored,
        signal,
        makeAbortError
      });
    } catch (error) {
      // As on the host: a spawn failure falls through to the node engine; rg's own errors surface.
      if (error instanceof FsSearchError) throw error;
    }
  }

  if (options.regex) {
    throw new FsSearchError(
      400,
      "REGEX_UNSUPPORTED",
      "Regex search requires ripgrep (rg) installed in the project's box. Turn off regex mode or install rg there.",
      "query"
    );
  }

  const caseSensitive = Boolean(options.caseSensitive);
  return await searchWithNode(root, {
    matcher: createMatcher(options.query, caseSensitive, Boolean(options.wholeWord)),
    maxResults,
    globs,
    includeIgnored,
    signal,
    makeAbortError,
    source: boxNodeSource(fs, root, dirs, spawn, signal, {
      git: tools.git && !includeIgnored,
      query: options.query,
      caseSensitive
    })
  });
}

async function searchWithBoxRipgrep(
  root: string,
  spawn: SearchSpawn,
  dirs: DirListings,
  opts: Parameters<typeof runRipgrep>[1]
): Promise<FsSearchResponse> {
  // Same rule as the host engine: an include glob while ignored files are hidden needs the
  // visible-file set (or matches the includes in Node when that set is unavailable).
  let visible: Set<string> | null = null;
  let includesInNode = false;
  if (!opts.includeIgnored && opts.globs && opts.globs.include.length > 0) {
    const listing = await listWithRipgrep(root, false, opts.signal, spawn).catch(() => null);
    if (opts.signal.aborted) throw opts.makeAbortError();
    if (listing && !listing.truncated) visible = new Set(listing.paths);
    else includesInNode = true;
  }
  const collected = await runRipgrep(root, opts, visible, includesInNode, spawn);
  const throwIfAborted = (): void => {
    if (opts.signal.aborted) throw opts.makeAbortError();
  };
  throwIfAborted();
  // rg reports no sizes: the directory listings give them (0 behind a symlinked folder, as the host's sandbox guard does).
  const entries = await Promise.all(collected.files.map((file) => dirs.entry(file.path).catch(() => null)));
  collected.files.forEach((file, index) => {
    const entry = entries[index];
    file.size = entry?.kind === "file" ? entry.size : 0;
  });
  throwIfAborted();
  collected.files.sort((a, b) => a.path.localeCompare(b.path));
  return { files: collected.files, totalMatches: collected.totalMatches, limitHit: collected.limitHit, tool: "rg" };
}

/**
 * The node engine's files in a box: `git grep -l` candidates (byte path order)
 * when git can answer and ignored files are hidden, else a depth-first walk over
 * the directory listings (siblings in byte order, like the host walker).
 */
function boxNodeSource(
  fs: BoxProjectFs,
  root: string,
  dirs: DirListings,
  spawn: SearchSpawn,
  signal: AbortSignal,
  prefilter: { git: boolean; query: string; caseSensitive: boolean }
): NodeSearchSource {
  return {
    async entries(checkAbort) {
      // eslint-disable-next-line no-control-regex
      const asciiOnly = /^[\x00-\x7f]*$/.test(prefilter.query);
      if (prefilter.git && (prefilter.caseSensitive || asciiOnly)) {
        const args = ["grep", "-l", "-z", "-I", "--untracked", "--no-color", "-F"];
        if (!prefilter.caseSensitive) args.push("-i");
        args.push("-e", prefilter.query, "--", ".");
        const run = await runPathLister("git", args, root, signal, true, spawn).catch(() => null);
        checkAbort();
        // 0 = files listed, 1 = no file contains the text; anything else (not a work tree) walks.
        if (run && (run.code === 0 || run.code === 1)) {
          return { entries: listedEntries(root, dirs, run.paths, checkAbort), partial: run.truncated };
        }
      }
      return { entries: walkEntries(root, dirs, "", checkAbort), partial: false };
    },
    async scan(entry, matcher, checkAbort) {
      if (entry.size === 0) return null;
      checkAbort();
      const bytes = await fs.read(entry.safePath, { length: Math.min(entry.size, SEARCH_FILE_SIZE_LIMIT), signal });
      if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) return null;
      return searchTextFile(bytes.toString("utf8"), entry.relPosix, entry.size, matcher);
    }
  };
}

async function* listedEntries(root: string, dirs: DirListings, paths: string[], checkAbort: () => void): AsyncGenerator<NodeFileEntry> {
  for (const relPosix of [...paths].sort(compareBytes)) {
    checkAbort();
    const entry = await dirs.entry(relPosix).catch(() => null);
    if (entry?.kind === "file") yield { relPosix, safePath: hostJoin(root, relPosix.split("/")), size: entry.size };
  }
}

async function* walkEntries(root: string, dirs: DirListings, relDir: string, checkAbort: () => void): AsyncGenerator<NodeFileEntry> {
  checkAbort();
  const listing = await dirs.get(relDir).catch(() => null);
  if (!listing) return;
  const names = [...listing.keys()].sort(compareBytes);
  for (const name of names) {
    checkAbort();
    const entry = listing.get(name)!;
    const rel = relDir === "" ? name : `${relDir}/${name}`;
    if (entry.kind === "dir") {
      if (!SKIP_DIRS.has(name)) yield* walkEntries(root, dirs, rel, checkAbort);
      continue;
    }
    if (entry.kind === "file") yield { relPosix: rel, safePath: hostJoin(root, rel.split("/")), size: entry.size };
  }
}
