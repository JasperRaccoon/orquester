import React from "react";
import fuzzysort from "fuzzysort";

import { useApi } from "../../../context/orquester-context";

/**
 * The `@` menu's file search (spec §7.4: "`@` opens the existing file search
 * as a token overlay and inserts a canonical path").
 *
 * It reuses exactly what the file browser's quick-open uses — one recursive
 * `GET /api/fs/files` listing per project root, prepared once for fuzzysort
 * and then filtered in memory. That is deliberate: a per-keystroke request
 * would put a network round trip inside the caret's feedback loop, and the
 * listing is the same data the palette already pays for.
 *
 * The listing is fetched **on the first `@` of a session**, not on mount: a
 * chat tab that never types one should not walk the project tree.
 */

type Prepared = ReturnType<typeof fuzzysort.prepare>;

interface FilesCache {
  root: string;
  prepared: Prepared[];
  fetchedAt: number;
}

/** Same TTL the file browser uses, for the same reason: files appear mid-session. */
const FILES_CACHE_TTL_MS = 60_000;
const RESULT_LIMIT = 20;

export interface ComposerPathEntry {
  path: string;
  /** Everything before the last `/`, as the row's second line. */
  directory: string;
  name: string;
}

export interface ComposerPathSearch {
  entries: ComposerPathEntry[];
  loading: boolean;
}

function toEntry(path: string): ComposerPathEntry {
  const cut = path.lastIndexOf("/");
  return {
    path,
    directory: cut > 0 ? path.slice(0, cut) : "",
    name: cut >= 0 ? path.slice(cut + 1) : path
  };
}

export function useComposerPathSearch(
  root: string | null,
  query: string | null
): ComposerPathSearch {
  const api = useApi();
  const cacheRef = React.useRef<FilesCache | null>(null);
  const loadingRootRef = React.useRef<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const [version, setVersion] = React.useState(0);
  const [loading, setLoading] = React.useState(false);

  const active = root !== null && query !== null;

  React.useEffect(() => {
    if (!active || !root) return;
    const cache = cacheRef.current;
    if (cache && cache.root === root && Date.now() - cache.fetchedAt < FILES_CACHE_TTL_MS) return;
    if (loadingRootRef.current === root) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    loadingRootRef.current = root;
    setLoading(true);
    api
      .listProjectFiles(root, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        cacheRef.current = {
          root,
          prepared: response.files.map((file) => fuzzysort.prepare(file.path)),
          fetchedAt: Date.now()
        };
        setVersion((value) => value + 1);
      })
      .catch(() => {
        // A failed listing leaves the menu empty rather than erroring: the
        // user can still type the path by hand, which is the whole fallback.
        if (controller.signal.aborted) return;
        cacheRef.current = { root, prepared: [], fetchedAt: Date.now() };
        setVersion((value) => value + 1);
      })
      .finally(() => {
        if (loadingRootRef.current === root) loadingRootRef.current = null;
        if (!controller.signal.aborted) setLoading(false);
      });
    // `active` gates the fetch; the query itself must NOT re-trigger it, or a
    // fast typist aborts the listing they are waiting for.
  }, [active, api, root]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const entries = React.useMemo<ComposerPathEntry[]>(() => {
    const cache = cacheRef.current;
    if (!active || !cache || cache.root !== root) return [];
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      return cache.prepared.slice(0, RESULT_LIMIT).map((prepared) => toEntry(String(prepared.target)));
    }
    return fuzzysort
      .go(trimmed, cache.prepared, { limit: RESULT_LIMIT, threshold: 0.3 })
      .map((result) => toEntry(result.target));
  }, [active, query, root, version]);

  return { entries, loading: loading && entries.length === 0 };
}
