// The Knowledge tab's graph view: a search box (by meaning) and collection
// filter chips above a canvas of concepts coloured by collection. The full
// graph is the overview; when it is truncated, a selection or search hit shows
// that item's neighbourhood instead.

import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2, RefreshCw, Search, Share2, Waypoints, X } from "lucide-react";
import type {
  KnowledgeCollectionView,
  KnowledgeColor,
  KnowledgeGraphQuery,
  KnowledgeGraphResponse,
  KnowledgeSearchHit,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  KnowledgeStatus
} from "@orquester/api";

import { Button } from "../ui";
import { cn } from "../../lib/cn";
import { knowledgeStore } from "../../lib/knowledge/store";
import { CollectionChip, Centered, ErrorLine } from "./parts";
import { canvasNodes, focusFor, graphQueryOf, graphScopeKey, truncationNote } from "./graph.logic";
import { entryByline, knowledgeErrorText } from "./knowledge.logic";
import type { KnowledgeGraphCanvasProps } from "./KnowledgeGraphCanvas";
import type { KnowledgeSelection } from "./KnowledgePanel";

export interface KnowledgeGraphApi {
  getKnowledgeGraph(query?: KnowledgeGraphQuery, signal?: AbortSignal): Promise<KnowledgeGraphResponse>;
  searchKnowledge(req: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResponse>;
}

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 12;

type GraphLoad =
  | { status: "loading"; graph: KnowledgeGraphResponse | null }
  | { status: "ready"; graph: KnowledgeGraphResponse }
  | { status: "error"; message: string; graph: KnowledgeGraphResponse | null };

function useGraph(api: KnowledgeGraphApi | null, collections: readonly string[], focus: string | null) {
  const [load, setLoad] = useState<GraphLoad>({ status: "loading", graph: null });
  const [tick, setTick] = useState(0);
  const key = graphScopeKey({ collections, focus });
  useEffect(
    () =>
      knowledgeStore.subscribe((state, previous) => {
        if (state.graphRevision !== previous.graphRevision) setTick((t) => t + 1);
      }),
    []
  );
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    setLoad((l) => ({ status: "loading", graph: l.graph }));
    api
      .getKnowledgeGraph(graphQueryOf({ collections, focus }), controller.signal)
      .then((graph) => {
        if (!controller.signal.aborted) setLoad({ status: "ready", graph });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad((l) => ({ status: "error", message: knowledgeErrorText(error), graph: l.graph }));
      });
    return () => controller.abort();
    // `key` stands for `collections` and `focus`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, tick]);
  return { load, retry: () => setTick((t) => t + 1) };
}

type SearchState = { status: "idle" } | { status: "searching" } | { status: "done"; hits: KnowledgeSearchHit[] } | { status: "error"; message: string };

function useSearch(api: KnowledgeGraphApi | null, query: string, collections: readonly string[]): SearchState {
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const scope = collections.join(",");
  useEffect(() => {
    const text = query.trim();
    if (!api || !text) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "searching" });
    const timer = setTimeout(() => {
      api
        .searchKnowledge({ query: text, limit: SEARCH_LIMIT, ...(collections.length > 0 ? { collections: [...collections] } : {}) }, controller.signal)
        .then((answer) => {
          if (!controller.signal.aborted) setState({ status: "done", hits: answer.hits });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ status: "error", message: knowledgeErrorText(error) });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, query, scope]);
  return state;
}

export interface KnowledgeGraphViewProps {
  api: KnowledgeGraphApi | null;
  status: KnowledgeStatus;
  collections: readonly KnowledgeCollectionView[];
  /** Collection ids the graph is filtered to; empty = all. */
  filter: readonly string[];
  onFilter: (filter: string[]) => void;
  selection: KnowledgeSelection | null;
  onSelect: (selection: KnowledgeSelection | null) => void;
  /** Concepts of the selected entry, once the panel has read it (they are marked on the canvas). */
  entryConceptIds: readonly string[];
  onShowList: () => void;
  active: boolean;
  Canvas: React.ComponentType<KnowledgeGraphCanvasProps>;
  toolbarEnd: React.ReactNode;
}

export const KnowledgeGraphView: React.FC<KnowledgeGraphViewProps> = ({
  api,
  status,
  collections,
  filter,
  onFilter,
  selection,
  onSelect,
  entryConceptIds,
  onShowList,
  active,
  Canvas,
  toolbarEnd
}) => {
  const [focus, setFocus] = useState<string | null>(null);
  const { load, retry } = useGraph(api, filter, focus);
  const graph = load.graph;
  const [query, setQuery] = useState("");
  const [resultsOpen, setResultsOpen] = useState(false);
  const search = useSearch(api, query, filter);
  const searchRef = useRef<HTMLDivElement | null>(null);

  // A new selection (a node, a hit, the panel, a citation) moves the canvas to it when it is not shown.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const selectionKey = selection ? `${selection.kind}:${selection.id}` : "";
  useEffect(() => {
    if (!selection) return;
    setFocus((current) => focusFor(selection, graphRef.current, current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  // A filter change returns to the overview of those collections.
  const filterKey = filter.join(",");
  useEffect(() => setFocus(null), [filterKey]);

  const colorOf = useMemo(() => new Map<string, KnowledgeColor>(collections.map((c) => [c.id, c.color])), [collections]);
  const nodes = useMemo(() => (graph ? canvasNodes(graph, colorOf, filter) : []), [graph, colorOf, filter]);
  const edges = useMemo(() => graph?.edges ?? [], [graph]);
  const highlightIds = useMemo(() => {
    const ids = new Set<string>(selection?.kind === "entry" ? entryConceptIds : []);
    if (search.status === "done") for (const hit of search.hits) if (hit.kind === "concept") ids.add(hit.concept.id);
    return ids;
  }, [selection?.kind, entryConceptIds, search]);
  const selectedId = selection?.kind === "concept" ? selection.id : null;

  // Clicking outside the search closes its results (the query stays, its concept hits stay marked).
  useEffect(() => {
    if (!resultsOpen) return;
    const onDown = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) setResultsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [resultsOpen]);

  const toggleFilter = (id: string) => onFilter(filter.includes(id) ? filter.filter((f) => f !== id) : [...filter, id]);
  const pick = (hit: KnowledgeSearchHit) => {
    setResultsOpen(false);
    onSelect(hit.kind === "entry" ? { kind: "entry", id: hit.entry.id } : { kind: "concept", id: hit.concept.id });
  };

  const note = graph ? truncationNote(graph, focus !== null) : null;
  const noEntries = status.entries === 0;
  const unlinked = graph !== null && graph.nodes.length === 0 && filter.length === 0 && focus === null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <div ref={searchRef} className="relative w-72 max-w-full">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            aria-label="Search the knowledge"
            placeholder="Search by meaning…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setResultsOpen(true);
            }}
            onFocus={() => query.trim() && setResultsOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (resultsOpen) setResultsOpen(false);
                else setQuery("");
              } else if (e.key === "Enter" && search.status === "done" && search.hits[0]) pick(search.hits[0]);
            }}
            className="h-8 w-full rounded-md border border-neutral-700 bg-neutral-900 pl-8 pr-7 text-[13px] text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear the search"
              onClick={() => {
                setQuery("");
                setResultsOpen(false);
              }}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-500 hover:text-neutral-200"
            >
              <X size={12} />
            </button>
          )}
          {resultsOpen && query.trim() && <SearchResults state={search} collections={collections} onPick={pick} />}
        </div>
        <div role="group" aria-label="Filter by collection" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <CollectionChip name="All" color={null} active={filter.length === 0} onClick={() => onFilter([])} dot={false} />
          {collections.map((c) => (
            <CollectionChip key={c.id} name={c.name} color={c.color} active={filter.includes(c.id)} onClick={() => toggleFilter(c.id)} title={c.description || undefined} />
          ))}
        </div>
        {toolbarEnd}
      </div>

      <div className="relative min-h-0 flex-1">
        {noEntries ? (
          <Centered>
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-500">
              <Share2 size={18} />
            </span>
            <p className="text-neutral-300">No entries yet</p>
            <p className="max-w-sm text-xs leading-relaxed text-neutral-500">Paste a post into any chat and ask the agent to add it to the knowledge.</p>
          </Centered>
        ) : !graph ? (
          load.status === "error" ? (
            <Centered>
              <ErrorLine>{load.message}</ErrorLine>
              <Button size="sm" variant="outline" onClick={retry}>
                <RefreshCw size={13} /> Retry
              </Button>
            </Centered>
          ) : (
            <Centered>
              <Loader2 size={16} className="motion-safe:animate-spin" /> Loading the graph…
            </Centered>
          )
        ) : unlinked ? (
          <Centered>
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-500">
              <Waypoints size={18} />
            </span>
            <p className="text-neutral-300">Not linked yet</p>
            <p className="max-w-sm text-xs leading-relaxed text-neutral-500">
              {status.entries.toLocaleString("en-US")} {status.entries === 1 ? "entry is" : "entries are"} saved and searchable. Their concepts appear here once
              linking finishes.
            </p>
            <Button size="sm" variant="outline" onClick={onShowList}>
              Show the list
            </Button>
          </Centered>
        ) : (
          <>
            <Suspense
              fallback={
                <Centered>
                  <Loader2 size={16} className="motion-safe:animate-spin" /> Loading the graph…
                </Centered>
              }
            >
              <Canvas
                nodes={nodes}
                edges={edges}
                selectedId={selectedId}
                highlightIds={highlightIds}
                onSelect={(id) => onSelect(id ? { kind: "concept", id } : null)}
                active={active}
              />
            </Suspense>
            {graph.nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
                No concepts in {filter.length === 1 ? "this collection" : "these collections"} yet.
              </div>
            )}
            <div className="pointer-events-none absolute left-3 right-3 top-3 flex flex-wrap items-start gap-2">
              {note && (
                <span className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/90 px-3 py-1 text-[11.5px] text-neutral-400 shadow-sm">
                  {note}
                  {focus !== null && (
                    <button type="button" className="font-medium text-neutral-200 hover:underline" onClick={() => setFocus(null)}>
                      Back to the overview
                    </button>
                  )}
                </span>
              )}
              {load.status === "loading" && <Loader2 size={14} className="mt-1 text-neutral-500 motion-safe:animate-spin" />}
              {load.status === "error" && (
                <span className="pointer-events-auto rounded-full border border-danger-900/60 bg-neutral-900/90 px-3 py-1 text-[11.5px] text-danger">
                  {load.message}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const SearchResults: React.FC<{
  state: SearchState;
  collections: readonly KnowledgeCollectionView[];
  onPick: (hit: KnowledgeSearchHit) => void;
}> = ({ state, collections, onPick }) => (
  <div
    role="listbox"
    aria-label="Search results"
    className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 p-1 shadow-xl shadow-black/30"
  >
    {state.status === "searching" || state.status === "idle" ? (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500">
        <Loader2 size={12} className="motion-safe:animate-spin" /> Searching…
      </div>
    ) : state.status === "error" ? (
      <ErrorLine className="px-3 py-2">{state.message}</ErrorLine>
    ) : state.hits.length === 0 ? (
      <p className="px-3 py-2 text-xs text-neutral-500">Nothing matches.</p>
    ) : (
      state.hits.map((hit) => {
        const key = hit.kind === "entry" ? hit.entry.id : hit.concept.id;
        return (
          <button
            key={`${hit.kind}:${key}`}
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => onPick(hit)}
            className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-neutral-800"
          >
            {hit.kind === "entry" ? (
              <FileText size={13} className="mt-0.5 shrink-0 text-neutral-500" />
            ) : (
              <Waypoints size={13} className="mt-0.5 shrink-0 text-neutral-500" />
            )}
            <span className="min-w-0 flex-1">
              {hit.kind === "entry" ? (
                <>
                  <span className="block truncate text-[13px] text-neutral-100">{hit.entry.title || "Untitled"}</span>
                  <span className="block truncate text-[11px] text-neutral-500">
                    {[entryByline(hit.entry), ...hit.entry.collections.map((id) => collections.find((c) => c.id === id)?.name).filter(Boolean)].filter(Boolean).join(" · ")}
                  </span>
                  {hit.entry.snippet && <span className="line-clamp-2 block text-xs text-neutral-400">{hit.entry.snippet}</span>}
                </>
              ) : (
                <>
                  <span className="block truncate text-[13px] text-neutral-100">{hit.concept.name}</span>
                  <span className={cn("block truncate text-[11px] text-neutral-500")}>
                    {hit.concept.type}
                    {hit.concept.description ? ` · ${hit.concept.description}` : ""}
                  </span>
                </>
              )}
            </span>
          </button>
        );
      })
    )}
  </div>
);
