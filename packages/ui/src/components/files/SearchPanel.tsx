import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File as FileIcon, Search, X } from "lucide-react";
import fuzzysort from "fuzzysort";
import { cn } from "../../lib/cn";
import { Input } from "../ui";
import { useApi } from "../../context/orquester-context";
import { ApiError } from "../../lib/api-client";
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

const FILES_CACHE_TTL_MS = 60_000;
const CONTENT_DEBOUNCE_MS = 250;
const CONTENT_MIN_CHARS = 2;
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
 * per keystroke) plus a debounced full-text "Text matches" section. All state is
 * local; results call back to the browser to open + jump to a line.
 */
export const SearchPanel: React.FC<{
  root: string;
  onOpenFile: (path: string, size: number, line?: number) => void;
  onActiveChange: (active: boolean) => void;
}> = ({ root, onOpenFile, onActiveChange }) => {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [filesVersion, setFilesVersion] = useState(0);
  const [content, setContent] = useState<FsSearchResponse | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  // True from the keystroke until the debounced content search settles, so the
  // debounce window doesn't briefly read as "No results" before results arrive.
  const [contentPending, setContentPending] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filesCacheRef = useRef<FilesCache | null>(null);
  const filesLoadingRef = useRef(false);
  const contentAbortRef = useRef<AbortController | null>(null);
  const contentReqRef = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);

  const trimmed = query.trim();
  const active = trimmed.length > 0;

  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  // Reset the search when the project root changes (e.g. switching projects).
  useEffect(() => {
    setQuery("");
    setContent(null);
    setContentError(null);
    setContentLoading(false);
    setContentPending(false);
    contentAbortRef.current?.abort();
    contentAbortRef.current = null;
  }, [root]);

  // Lazily fetch (and cache) the recursive file listing for fuzzy quick-open the
  // first time a search session starts; refetch if the cache is stale (>60s).
  const ensureFiles = useCallback(() => {
    const cache = filesCacheRef.current;
    if (cache && cache.root === root && Date.now() - cache.fetchedAt < FILES_CACHE_TTL_MS) return;
    if (filesLoadingRef.current) return;
    filesLoadingRef.current = true;
    api
      .listProjectFiles(root)
      .then((res) => {
        const sizeByPath = new Map<string, number>();
        const prepared = res.files.map((f) => {
          sizeByPath.set(f.path, f.size);
          return fuzzysort.prepare(f.path);
        });
        filesCacheRef.current = { root, prepared, sizeByPath, fetchedAt: Date.now() };
        setFilesVersion((v) => v + 1);
      })
      .catch(() => {
        /* leave the files section empty; content search still works */
      })
      .finally(() => {
        filesLoadingRef.current = false;
      });
  }, [api, root]);

  // Trigger the fetch only when a search session begins (query empty -> non-empty),
  // not on every keystroke — so an in-flight listing is never aborted mid-type.
  useEffect(() => {
    if (active) ensureFiles();
  }, [active, ensureFiles]);

  const fileResults = useMemo<FileRow[]>(() => {
    const cache = filesCacheRef.current;
    if (!trimmed || !cache || cache.root !== root) return [];
    const results = fuzzysort.go(trimmed, cache.prepared, { limit: 30, threshold: 0.3 });
    return results.map((r) => ({
      path: r.target,
      size: cache.sizeByPath.get(r.target) ?? 0,
      indexes: r.indexes
    }));
  }, [trimmed, filesVersion, root]);

  const runContentSearch = useCallback(
    async (q: string) => {
      contentAbortRef.current?.abort();
      const controller = new AbortController();
      contentAbortRef.current = controller;
      const reqId = ++contentReqRef.current;
      setContentLoading(true);
      setContentError(null);
      try {
        const res = await api.searchFs(
          { path: root, q, caseSensitive, regex, maxResults: CONTENT_MAX_RESULTS },
          controller.signal
        );
        if (contentReqRef.current !== reqId) return; // stale response
        setContent(res);
        setCollapsed(new Set());
        setContentLoading(false);
        setContentPending(false);
      } catch (err) {
        if (controller.signal.aborted || contentReqRef.current !== reqId) return;
        const message = err instanceof ApiError ? err.serverMessage ?? "Search failed." : "Search failed.";
        setContentError(message);
        setContent(null);
        setContentLoading(false);
        setContentPending(false);
      }
    },
    [api, root, caseSensitive, regex]
  );

  // Debounced content search (min 2 chars). Aborts + clears below the threshold.
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (trimmed.length < CONTENT_MIN_CHARS) {
      contentAbortRef.current?.abort();
      contentAbortRef.current = null;
      contentReqRef.current += 1; // invalidate any in-flight response
      setContentLoading(false);
      setContentPending(false);
      setContent(null);
      setContentError(null);
      return;
    }
    // Mark pending synchronously (before the debounce fires) so "No results" can't
    // flash during the debounce window while the search hasn't started yet.
    setContentPending(true);
    debounceRef.current = window.setTimeout(() => void runContentSearch(trimmed), CONTENT_DEBOUNCE_MS);
    return () => window.clearTimeout(debounceRef.current);
  }, [trimmed, runContentSearch]);

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const contentFiles = content?.files ?? [];
  // Only claim "No results" once the file listing for this root has loaded AND the
  // content search has settled — otherwise it flashes during the initial listing
  // fetch or the debounce window before either can produce a match.
  const filesReady = !!filesCacheRef.current && filesCacheRef.current.root === root;
  const noResults =
    active &&
    filesReady &&
    !contentPending &&
    !contentLoading &&
    !contentError &&
    fileResults.length === 0 &&
    contentFiles.length === 0;

  return (
    <div className={cn("flex flex-col", active && "min-h-0 flex-1")}>
      <div className="flex items-center gap-1 p-2">
        <div className="relative flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
        <ToggleButton active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} label="Match case">
          Aa
        </ToggleButton>
        <ToggleButton active={regex} onClick={() => setRegex((v) => !v)} label="Use regular expression">
          .*
        </ToggleButton>
      </div>

      {active && (
        <div className="min-h-0 flex-1 overflow-auto pb-2">
          {fileResults.length > 0 && (
            <div className="mb-1">
              <SectionLabel>Files</SectionLabel>
              {fileResults.map((fr) => {
                const base = baseName(fr.path);
                const dir = dirName(fr.path);
                const baseOffset = dir ? dir.length + 1 : 0;
                const matched = new Set(fr.indexes);
                return (
                  <button
                    key={fr.path}
                    type="button"
                    onClick={() => onOpenFile(`${root}/${fr.path}`, fr.size)}
                    className="flex w-full items-center gap-1.5 px-2 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-900 md:py-1"
                  >
                    <FileIcon size={13} className="shrink-0 text-neutral-600" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="truncate text-neutral-100">{renderFuzzy(base, baseOffset, matched)}</span>
                      {dir && (
                        <span className="truncate text-xs text-neutral-500">{renderFuzzy(dir, 0, matched)}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {(contentLoading || contentError || content) && (
            <div>
              <SectionLabel>
                Text matches
                {contentLoading && <span className="ml-2 font-normal normal-case text-neutral-500">Searching…</span>}
              </SectionLabel>

              {contentError && <p className="px-3 py-1 text-xs text-red-400">{contentError}</p>}

              {content && !contentError && (
                <>
                  <p className="px-3 pb-1 text-[11px] text-neutral-500">
                    {content.totalMatches} {content.totalMatches === 1 ? "result" : "results"} in{" "}
                    {content.files.length} {content.files.length === 1 ? "file" : "files"}
                    {content.limitHit && " (limited)"}
                  </p>
                  {content.files.map((file) => {
                    const isCollapsed = collapsed.has(file.path);
                    const base = baseName(file.path);
                    const dir = dirName(file.path);
                    return (
                      <div key={file.path}>
                        <button
                          type="button"
                          onClick={() => toggleCollapse(file.path)}
                          className="flex w-full items-center gap-1 px-2 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-900 md:py-1"
                        >
                          <span className="shrink-0 text-neutral-500">
                            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            <span className="text-neutral-200">{base}</span>
                            {dir && <span className="ml-2 text-xs text-neutral-500">{dir}</span>}
                          </span>
                          <span className="ml-1 shrink-0 rounded bg-neutral-800 px-1.5 text-[10px] leading-4 text-neutral-400">
                            {file.matches.length}
                            {file.truncated && "+"}
                          </span>
                        </button>
                        {!isCollapsed &&
                          file.matches.map((m, i) => (
                            <button
                              key={`${file.path}:${m.line}:${i}`}
                              type="button"
                              onClick={() => onOpenFile(`${root}/${file.path}`, file.size, m.line)}
                              className="flex w-full items-start gap-2 py-2 pl-7 pr-2 text-left text-xs hover:bg-neutral-900 md:py-1"
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
                          ))}
                      </div>
                    );
                  })}
                </>
              )}
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
  children: React.ReactNode;
}> = ({ active, onClick, label, children }) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={active}
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

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
    {children}
  </p>
);
