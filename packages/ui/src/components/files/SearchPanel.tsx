import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  File as FileIcon,
  RefreshCw,
  Search,
  WholeWord,
  X
} from "lucide-react";
import fuzzysort from "fuzzysort";
import { matchesGlobList, mergeGlobLists, parseGlobList, type CompiledGlobList } from "@orquester/config/glob";
import { cn } from "../../lib/cn";
import { IconButton, Input } from "../ui";
import { useApi } from "../../context/orquester-context";
import { ApiError } from "../../lib/api-client";
import { loadSearchOptions, persistSearchOptions, type SearchOptions } from "../../lib/search-options";
import type { FsSearchResponse } from "@orquester/api";

type Prepared = ReturnType<typeof fuzzysort.prepare>;

interface FilesCache {
  root: string;
  prepared: Prepared[];
  sizeByPath: Map<string, number>;
  fetchedAt: number;
}

interface FileRow {
  path: string;
  size: number;
  indexes: ReadonlyArray<number>;
}

/** A flat, ordered navigable row (fuzzy hit, file header, or match line). */
type NavRow =
  | { key: string; kind: "fz"; path: string; size: number }
  | { key: string; kind: "fh"; path: string }
  | { key: string; kind: "fm"; path: string; size: number; index: number };

const FILES_CACHE_TTL_MS = 60_000;
// Trailing debounce with a hard maxWait so a fast typist still gets a search by
// CONTENT_MAX_WAIT_MS since their first deferred keystroke. Option toggles skip
// the debounce entirely and fire immediately.
const CONTENT_DEBOUNCE_MS = 120;
const CONTENT_MAX_WAIT_MS = 600;
const CONTENT_MIN_CHARS = 1;
const CONTENT_MAX_RESULTS = 500;

const baseName = (p: string) => {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(slash + 1) : p;
};
const dirName = (p: string) => {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(0, slash) : "";
};

// Wrap the fuzzy-matched characters of `text` (whose first char sits at global
// offset `offset` within the searched path) in a highlight span.
function renderFuzzy(text: string, offset: number, matched: Set<number>): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let run = "";
  let runMatched = false;
  const flush = (key: number) => {
    if (!run) return;
    out.push(
      runMatched ? (
        <span key={key} className="font-medium text-amber-300">
          {run}
        </span>
      ) : (
        <React.Fragment key={key}>{run}</React.Fragment>
      )
    );
    run = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const isMatch = matched.has(offset + i);
    if (run && isMatch !== runMatched) flush(offset + i);
    runMatched = isMatch;
    run += text[i];
  }
  flush(offset + text.length);
  return out;
}

/**
 * VSCode-like search over a project: a fuzzy quick-open "Files" section (instant,
 * per keystroke, glob-filtered client-side) plus a debounced full-text section
 * with case / whole-word / regex toggles and files-to-include/exclude globs. All
 * state is local except per-project options, which persist in localStorage.
 */
export const SearchPanel: React.FC<{
  root: string;
  onOpenFile: (path: string, size: number, line?: number, column?: number, matchLength?: number) => void;
  onActiveChange: (active: boolean) => void;
}> = ({ root, onOpenFile, onActiveChange }) => {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(() => loadSearchOptions(root));
  const { caseSensitive, wholeWord, regex, include, exclude, filtersExpanded } = options;
  const [filesVersion, setFilesVersion] = useState(0);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [content, setContent] = useState<FsSearchResponse | null>(null);
  // True from a query≥min keystroke (or an option change) until the search settles,
  // covering the debounce window AND the fetch so "No results" can't flash early.
  const [contentBusy, setContentBusy] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ include?: string; exclude?: string }>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const filesCacheRef = useRef<FilesCache | null>(null);
  const filesAbortRef = useRef<AbortController | null>(null);
  // The root a listing is currently in flight for, so a switch mid-listing can't
  // wedge ensureFiles (the old panel-global boolean stayed true for the new root).
  const filesLoadingRootRef = useRef<string | null>(null);
  const contentAbortRef = useRef<AbortController | null>(null);
  const contentReqRef = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);
  // Timestamp of the first deferred keystroke in the current debounce burst, for
  // the maxWait clamp; null between bursts.
  const firstDeferredAtRef = useRef<number | null>(null);
  // Set by option toggles / Refresh to bypass the trailing debounce.
  const immediateRef = useRef(false);
  // Suppress the persist effect on the render that reloads options for a new root.
  const skipNextPersistRef = useRef(false);
  const prevQueryRef = useRef(query);

  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerRow = (key: string) => (el: HTMLElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  };

  const trimmed = query.trim();
  const active = trimmed.length > 0;

  const setOption = useCallback(
    (patch: Partial<SearchOptions>) => setOptions((o) => ({ ...o, ...patch })),
    []
  );

  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  // Reset the search and reload persisted options when the project root changes.
  useEffect(() => {
    setQuery("");
    setContent(null);
    setContentError(null);
    setFieldErrors({});
    setContentBusy(false);
    setCollapsed(new Set());
    setActiveKey(null);
    contentAbortRef.current?.abort();
    contentAbortRef.current = null;
    contentReqRef.current += 1; // invalidate any in-flight response for the old root
    filesAbortRef.current?.abort();
    filesAbortRef.current = null;
    filesLoadingRootRef.current = null;
    setFilesError(null);
    setOptions(loadSearchOptions(root));
    skipNextPersistRef.current = true;
    prevQueryRef.current = "";
  }, [root]);

  // Persist option changes (never the query text). Skipped on the root-change
  // reload so freshly loaded options aren't written back under the wrong project.
  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    persistSearchOptions(root, options);
  }, [root, options]);

  // Reset collapse state only when the query text changes — preserved across
  // same-query refreshes and option changes.
  useEffect(() => {
    if (prevQueryRef.current !== query) {
      setCollapsed(new Set());
      prevQueryRef.current = query;
    }
  }, [query]);

  // Lazily fetch (and cache) the recursive file listing for fuzzy quick-open the
  // first time a search session starts; refetch if the cache is stale (>60s).
  const ensureFiles = useCallback(() => {
    const cache = filesCacheRef.current;
    if (cache && cache.root === root && Date.now() - cache.fetchedAt < FILES_CACHE_TTL_MS) return;
    if (filesLoadingRootRef.current === root) return;
    filesAbortRef.current?.abort();
    const controller = new AbortController();
    filesAbortRef.current = controller;
    filesLoadingRootRef.current = root;
    setFilesError(null);
    api
      .listProjectFiles(root, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        const sizeByPath = new Map<string, number>();
        const prepared = res.files.map((f) => {
          sizeByPath.set(f.path, f.size);
          return fuzzysort.prepare(f.path);
        });
        filesCacheRef.current = { root, prepared, sizeByPath, fetchedAt: Date.now() };
        setFilesVersion((v) => v + 1);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFilesError("Could not list files for quick-open.");
      })
      .finally(() => {
        if (filesLoadingRootRef.current === root) filesLoadingRootRef.current = null;
      });
  }, [api, root]);

  // Trigger the fetch only when a search session begins (query empty -> non-empty),
  // not on every keystroke — so an in-flight listing is never aborted mid-type.
  useEffect(() => {
    if (active) ensureFiles();
  }, [active, ensureFiles]);

  // Parse the glob fields once for the client-side fuzzy filter. Invalid globs
  // leave the fuzzy list unfiltered (the server reports the field error for the
  // content search); an empty parse matches everything.
  const fuzzyGlob = useMemo<CompiledGlobList | null>(() => {
    try {
      return mergeGlobLists(parseGlobList(include, "include"), parseGlobList(exclude, "exclude"));
    } catch {
      return null;
    }
  }, [include, exclude]);

  const fileResults = useMemo<FileRow[]>(() => {
    const cache = filesCacheRef.current;
    if (!trimmed || !cache || cache.root !== root) return [];
    const results = fuzzysort.go(trimmed, cache.prepared, { limit: 30, threshold: 0.3 });
    let rows = results.map((r) => ({
      path: r.target,
      size: cache.sizeByPath.get(r.target) ?? 0,
      indexes: r.indexes
    }));
    if (fuzzyGlob) rows = rows.filter((r) => matchesGlobList(fuzzyGlob, r.path));
    return rows;
  }, [trimmed, filesVersion, root, fuzzyGlob]);

  const runContentSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < CONTENT_MIN_CHARS) return;
    contentAbortRef.current?.abort();
    const controller = new AbortController();
    contentAbortRef.current = controller;
    const reqId = ++contentReqRef.current;
    setContentBusy(true);
    setContentError(null);
    try {
      const res = await api.searchFs(
        { path: root, q, caseSensitive, wholeWord, regex, include, exclude, maxResults: CONTENT_MAX_RESULTS },
        controller.signal
      );
      if (contentReqRef.current !== reqId || controller.signal.aborted) return; // stale response
      setContent(res);
      setFieldErrors({});
      setContentBusy(false);
    } catch (err) {
      if (controller.signal.aborted || contentReqRef.current !== reqId) return;
      const field = err instanceof ApiError ? err.serverField : null;
      const message = err instanceof ApiError ? err.serverMessage ?? "Search failed." : "Search failed.";
      if (field === "include" || field === "exclude") {
        // A bad glob: annotate the offending field and drop the (now mismatched)
        // results rather than surface a full-width error banner.
        setFieldErrors({ [field]: message });
        setContent(null);
      } else {
        setContentError(message);
        setContent(null);
      }
      setContentBusy(false);
    }
  }, [api, root, query, caseSensitive, wholeWord, regex, include, exclude]);

  // Schedule the content search: immediate for option toggles/Refresh, otherwise a
  // 120ms trailing debounce clamped to a 600ms maxWait.
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (trimmed.length < CONTENT_MIN_CHARS) {
      contentAbortRef.current?.abort();
      contentAbortRef.current = null;
      contentReqRef.current += 1; // invalidate any in-flight response
      firstDeferredAtRef.current = null;
      immediateRef.current = false;
      setContentBusy(false);
      setContent(null);
      setContentError(null);
      setFieldErrors({});
      return;
    }
    setContentBusy(true);
    if (immediateRef.current) {
      immediateRef.current = false;
      firstDeferredAtRef.current = null;
      void runContentSearch();
      return;
    }
    const now = Date.now();
    if (firstDeferredAtRef.current === null) firstDeferredAtRef.current = now;
    const wait = Math.max(0, Math.min(CONTENT_DEBOUNCE_MS, CONTENT_MAX_WAIT_MS - (now - firstDeferredAtRef.current)));
    debounceRef.current = window.setTimeout(() => {
      firstDeferredAtRef.current = null;
      void runContentSearch();
    }, wait);
    return () => window.clearTimeout(debounceRef.current);
  }, [trimmed, runContentSearch]);

  // Abort any in-flight requests on unmount.
  useEffect(
    () => () => {
      contentAbortRef.current?.abort();
      filesAbortRef.current?.abort();
      window.clearTimeout(debounceRef.current);
    },
    []
  );

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleOption = (key: "caseSensitive" | "wholeWord" | "regex") => {
    immediateRef.current = true; // option changes re-search immediately
    setOption({ [key]: !options[key] });
  };

  const onRefresh = () => {
    window.clearTimeout(debounceRef.current);
    firstDeferredAtRef.current = null;
    void runContentSearch();
  };

  const contentFiles = content?.files ?? [];

  const allCollapsed = contentFiles.length > 0 && contentFiles.every((f) => collapsed.has(f.path));
  const toggleCollapseAll = () => {
    setCollapsed(allCollapsed ? new Set() : new Set(contentFiles.map((f) => f.path)));
  };

  const clearSearch = () => {
    setQuery("");
    setContent(null);
    setContentError(null);
    inputRef.current?.focus();
  };

  // Flat navigable row list (fuzzy rows, then per file: header + visible matches).
  const navRows = useMemo<NavRow[]>(() => {
    const rows: NavRow[] = [];
    for (const fr of fileResults) rows.push({ key: `fz:${fr.path}`, kind: "fz", path: fr.path, size: fr.size });
    for (const file of contentFiles) {
      rows.push({ key: `fh:${file.path}`, kind: "fh", path: file.path });
      if (!collapsed.has(file.path)) {
        file.matches.forEach((_, index) =>
          rows.push({ key: `fm:${file.path}#${index}`, kind: "fm", path: file.path, size: file.size, index })
        );
      }
    }
    return rows;
  }, [fileResults, contentFiles, collapsed]);

  const rowKeys = useMemo(() => navRows.map((r) => r.key), [navRows]);
  // The row that owns tabIndex 0: the tracked one if still present, else the first.
  const activeRowKey = activeKey && rowKeys.includes(activeKey) ? activeKey : rowKeys[0] ?? null;

  const focusKey = (key: string) => {
    setActiveKey(key);
    rowRefs.current.get(key)?.focus();
  };

  const activateRow = (row: NavRow) => {
    if (row.kind === "fz") {
      onOpenFile(`${root}/${row.path}`, row.size);
    } else if (row.kind === "fh") {
      toggleCollapse(row.path);
    } else {
      const file = contentFiles.find((f) => f.path === row.path);
      const m = file?.matches[row.index];
      if (m) onOpenFile(`${root}/${row.path}`, row.size, m.line, m.column, m.matchLength);
    }
  };

  const onRowKeyDown = (e: React.KeyboardEvent, key: string) => {
    const idx = navRows.findIndex((r) => r.key === key);
    if (idx === -1) return;
    const row = navRows[idx];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (idx + 1 < navRows.length) focusKey(navRows[idx + 1].key);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (idx > 0) focusKey(navRows[idx - 1].key);
        else inputRef.current?.focus();
        break;
      case "Home":
        e.preventDefault();
        if (navRows.length) focusKey(navRows[0].key);
        break;
      case "End":
        e.preventDefault();
        if (navRows.length) focusKey(navRows[navRows.length - 1].key);
        break;
      case "Enter":
        e.preventDefault();
        activateRow(row);
        break;
      case "Escape":
        e.preventDefault();
        inputRef.current?.focus();
        break;
      case "ArrowRight":
        if (row.kind === "fh" && collapsed.has(row.path)) {
          e.preventDefault();
          toggleCollapse(row.path);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row.kind === "fh") {
          if (!collapsed.has(row.path)) toggleCollapse(row.path);
        } else if (row.kind === "fm") {
          focusKey(`fh:${row.path}`);
        }
        break;
      default:
        break;
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && navRows.length) {
      e.preventDefault();
      focusKey(navRows[0].key);
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
    }
  };

  const rowFocusRing =
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500";

  const filesReady = !!filesCacheRef.current && filesCacheRef.current.root === root;
  const hasFieldError = !!(fieldErrors.include || fieldErrors.exclude);
  // Force the filters row open whenever a glob is invalid: its error message lives inside
  // that row, and both `filtersExpanded=false` and the bad glob persist across reloads, so
  // otherwise a collapsed row would blank the text-match section with no visible reason.
  const showFilters = filtersExpanded || hasFieldError;
  const noResults =
    active &&
    filesReady &&
    !contentBusy &&
    !contentError &&
    !hasFieldError &&
    fileResults.length === 0 &&
    contentFiles.length === 0;
  const contentStarted = content !== null || contentBusy || contentError !== null;

  return (
    <div className={cn("flex flex-col", active && "min-h-0 flex-1")}>
      {/* Scoped indeterminate-progress keyframe (self-contained; no global CSS). */}
      <style>{"@keyframes orq-search-indeterminate{0%{transform:translateX(-120%)}100%{transform:translateX(420%)}}"}</style>
      <div className="relative">
        <div className="flex items-center gap-1 p-2">
          <div className="relative flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
            />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search files…"
              aria-label="Search files"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              // 16px on mobile (text-base) prevents iOS from zooming on focus.
              className="pl-7 pr-7 text-base md:text-sm"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                title="Clear"
                onClick={() => setQuery("")}
                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <ToggleButton active={caseSensitive} onClick={() => toggleOption("caseSensitive")} label="Match case">
            Aa
          </ToggleButton>
          <ToggleButton active={wholeWord} onClick={() => toggleOption("wholeWord")} label="Match whole word">
            <WholeWord size={15} />
          </ToggleButton>
          <ToggleButton active={regex} onClick={() => toggleOption("regex")} label="Use regular expression">
            .*
          </ToggleButton>
          <ToggleButton
            active={showFilters}
            onClick={() => setOption({ filtersExpanded: !filtersExpanded })}
            label="Toggle search details"
            ariaExpanded={showFilters}
          >
            <Ellipsis size={15} />
          </ToggleButton>
        </div>

        {showFilters && (
          <div className="flex flex-col gap-1.5 px-2 pb-2" aria-live="polite">
            <GlobField
              label="files to include"
              placeholder="e.g. *.ts, src/**"
              value={include}
              error={fieldErrors.include}
              onChange={(v) => setOption({ include: v })}
            />
            <GlobField
              label="files to exclude"
              placeholder="e.g. **/dist/**"
              value={exclude}
              error={fieldErrors.exclude}
              onChange={(v) => setOption({ exclude: v })}
            />
          </div>
        )}

        {/* 2px indeterminate bar; absolutely positioned so it never reflows the list. */}
        {contentBusy && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
            <div
              className="h-full w-1/4 rounded-full bg-neutral-400/70"
              style={{ animation: "orq-search-indeterminate 1s ease-in-out infinite" }}
            />
          </div>
        )}
      </div>

      {active && (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2" aria-busy={contentBusy}>
          {filesError && <p className="px-3 py-1 text-xs text-red-400">{filesError}</p>}

          {fileResults.length > 0 && (
            <div className="mb-1">
              <SectionLabel>Files</SectionLabel>
              {fileResults.map((fr) => {
                const base = baseName(fr.path);
                const dir = dirName(fr.path);
                const baseOffset = dir ? dir.length + 1 : 0;
                const matched = new Set(fr.indexes);
                const key = `fz:${fr.path}`;
                return (
                  <button
                    key={key}
                    ref={registerRow(key)}
                    type="button"
                    tabIndex={key === activeRowKey ? 0 : -1}
                    onFocus={() => setActiveKey(key)}
                    onKeyDown={(e) => onRowKeyDown(e, key)}
                    onClick={() => onOpenFile(`${root}/${fr.path}`, fr.size)}
                    className={cn(
                      "flex w-full items-center gap-1.5 px-2 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-900 md:py-1",
                      rowFocusRing
                    )}
                  >
                    <FileIcon size={13} className="shrink-0 text-neutral-600" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="truncate text-neutral-100" title={fr.path}>
                        {renderFuzzy(base, baseOffset, matched)}
                      </span>
                      {dir && (
                        <span className="truncate text-xs text-neutral-500" title={fr.path}>
                          {renderFuzzy(dir, 0, matched)}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {contentStarted && (
            <div className={cn(contentBusy && content && "opacity-70")}>
              {/* Fixed-height header so its appearance never shifts the list. */}
              <div className="flex h-8 items-center gap-1 px-2">
                <p className="min-w-0 flex-1 truncate text-[11px] text-neutral-500">
                  {content ? (
                    <>
                      {content.totalMatches} {content.totalMatches === 1 ? "result" : "results"} in{" "}
                      {content.files.length} {content.files.length === 1 ? "file" : "files"}
                      {content.limitHit && " (limited)"}
                    </>
                  ) : (
                    <span className="uppercase tracking-wide text-neutral-600">Text matches</span>
                  )}
                </p>
                <IconButton label="Refresh search" className="h-6 w-6" onClick={onRefresh}>
                  <RefreshCw size={13} />
                </IconButton>
                <IconButton
                  label={allCollapsed ? "Expand all" : "Collapse all"}
                  className="h-6 w-6"
                  disabled={contentFiles.length === 0}
                  onClick={toggleCollapseAll}
                >
                  {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
                </IconButton>
                <IconButton label="Clear search" className="h-6 w-6" onClick={clearSearch}>
                  <X size={13} />
                </IconButton>
              </div>

              {contentError && <p className="px-3 py-1 text-xs text-red-400">{contentError}</p>}

              {content &&
                !contentError &&
                content.files.map((file) => {
                  const isCollapsed = collapsed.has(file.path);
                  const base = baseName(file.path);
                  const dir = dirName(file.path);
                  const headKey = `fh:${file.path}`;
                  return (
                    <div key={file.path}>
                      <button
                        ref={registerRow(headKey)}
                        type="button"
                        tabIndex={headKey === activeRowKey ? 0 : -1}
                        aria-expanded={!isCollapsed}
                        onFocus={() => setActiveKey(headKey)}
                        onKeyDown={(e) => onRowKeyDown(e, headKey)}
                        onClick={() => toggleCollapse(file.path)}
                        className={cn(
                          "flex w-full items-center gap-1 px-2 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-900 md:py-1",
                          rowFocusRing
                        )}
                      >
                        <span className="shrink-0 text-neutral-500">
                          {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate" title={file.path}>
                          <span className="text-neutral-200">{base}</span>
                          {dir && <span className="ml-2 text-xs text-neutral-500">{dir}</span>}
                        </span>
                        <span className="ml-1 shrink-0 rounded bg-neutral-800 px-1.5 text-[10px] leading-4 text-neutral-400">
                          {file.matches.length}
                          {file.truncated && "+"}
                        </span>
                      </button>
                      {!isCollapsed &&
                        file.matches.map((m, i) => {
                          const matchKey = `fm:${file.path}#${i}`;
                          return (
                            <button
                              key={matchKey}
                              ref={registerRow(matchKey)}
                              type="button"
                              tabIndex={matchKey === activeRowKey ? 0 : -1}
                              onFocus={() => setActiveKey(matchKey)}
                              onKeyDown={(e) => onRowKeyDown(e, matchKey)}
                              onClick={() => onOpenFile(`${root}/${file.path}`, file.size, m.line, m.column, m.matchLength)}
                              className={cn(
                                "flex w-full items-start gap-2 py-2 pl-7 pr-2 text-left text-xs hover:bg-neutral-900 md:py-1",
                                rowFocusRing
                              )}
                            >
                              <span className="w-9 shrink-0 text-right tabular-nums text-neutral-600">{m.line}</span>
                              <span className="min-w-0 flex-1 truncate font-mono text-neutral-400">
                                {m.text.slice(0, m.start)}
                                <span className="rounded-sm bg-amber-500/30 text-amber-50">
                                  {m.text.slice(m.start, m.end)}
                                </span>
                                {m.text.slice(m.end)}
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  );
                })}
            </div>
          )}

          {noResults && <p className="px-3 py-3 text-xs text-neutral-600">No results</p>}
        </div>
      )}
    </div>
  );
};

const ToggleButton: React.FC<{
  active: boolean;
  onClick: () => void;
  label: string;
  ariaExpanded?: boolean;
  children: React.ReactNode;
}> = ({ active, onClick, label, ariaExpanded, children }) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={active}
    aria-expanded={ariaExpanded}
    title={label}
    onClick={onClick}
    className={cn(
      "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold transition-colors",
      "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
      active
        ? "bg-neutral-700 text-neutral-100"
        : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
    )}
  >
    {children}
  </button>
);

const GlobField: React.FC<{
  label: string;
  placeholder: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}> = ({ label, placeholder, value, error, onChange }) => (
  <div>
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className={cn("h-7 text-base md:text-xs", error && "border-red-500/60 ring-1 ring-red-500/60")}
    />
    {error && <p className="px-1 pt-0.5 text-[10px] text-red-400">{error}</p>}
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
    {children}
  </p>
);
