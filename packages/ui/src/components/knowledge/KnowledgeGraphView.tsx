// The Knowledge view's graph view: a search box (by meaning), a layer switch and collection
// filter chips above one canvas. The Concepts layer shows concepts coloured by collection: the
// full graph is the overview; when it is truncated, a selection or search hit shows that item's
// neighbourhood instead. The Similarity layer shows the entries themselves, joined by meaning
// (nearest neighbours and a spanning forest) and coloured by cluster or collection, with the
// pairs that disagree drawn in the destructive colour. The two layers lead into each other: a
// cluster's top concept opens in the Concepts layer, and a concept's entries are marked in the
// Similarity layer (asked for from the concept panel, which a phone shows over the graph).

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Settings, Share2, Sparkles, Waypoints } from "lucide-react";
import type {
  KnowledgeCollectionView,
  KnowledgeColor,
  KnowledgeConceptRef,
  KnowledgeGraphQuery,
  KnowledgeGraphResponse,
  KnowledgeSearchHit,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  KnowledgeSimilarityGraphQuery,
  KnowledgeSimilarityGraphResponse,
  KnowledgeStatus
} from "@orquester/api";

import { Button } from "../ui";
import { cn } from "../../lib/cn";
import { SegmentedControl } from "../settings/primitives";
import { knowledgeStore } from "../../lib/knowledge/store";
import { useAppStore } from "../../store/app";
import { CollectionChip, Centered, ErrorLine, PHONE_CHIP, PHONE_CHIP_ROW, TOOLBAR_SEGMENTED } from "./parts";
import {
  canvasNodes,
  collectionLegend,
  conceptMarksText,
  contradictingEdgeCount,
  drawnEntryIds,
  focusFor,
  graphQueryOf,
  graphScopeKey,
  isMissingRoute,
  legendMemberIds,
  searchSummary,
  similarityCanvasEdges,
  similarityCanvasNodes,
  similarityEmptyState,
  similarityLegend,
  similarityNote,
  similarityQueryOf,
  similaritySearchSummary,
  truncationNote,
  type CanvasEdge,
  type ConceptMarks,
  type GraphLayer,
  type SimilarityColorBy
} from "./graph.logic";
import { graphSearchRequest, searchIsNarrowed } from "./graph-search.logic";
import { knowledgeErrorCode, knowledgeErrorText } from "./knowledge.logic";
import { EMPTY_KNOWLEDGE_QUERY, type KnowledgeQuery } from "./query-state";
import { GraphSearchBox, type GraphSearchState } from "./GraphSearchBox";
import { SimilarityLegend } from "./SimilarityLegend";
import type { KnowledgeGraphCanvasProps } from "./KnowledgeGraphCanvas";
import type { KnowledgeSelection } from "./KnowledgePanel";

export interface KnowledgeGraphApi {
  getKnowledgeGraph(query?: KnowledgeGraphQuery, signal?: AbortSignal): Promise<KnowledgeGraphResponse>;
  searchKnowledge(req: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResponse>;
  /** Absent from a client without it: the Similarity layer is not offered. */
  getKnowledgeSimilarityGraph?(query?: KnowledgeSimilarityGraphQuery, signal?: AbortSignal): Promise<KnowledgeSimilarityGraphResponse>;
}

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 12;

const LAYER_OPTIONS = [
  { value: "concepts" as const, label: "Concepts", icon: <Waypoints size={12} /> },
  { value: "similarity" as const, label: "Similarity", icon: <Sparkles size={12} /> }
];

// Remembered for the app session (the view unmounts when the List view or another tab is shown).
let sessionLayer: GraphLayer = "concepts";
let sessionColorBy: SimilarityColorBy = "cluster";
/** Per client: whether its daemon serves the similarity graph (one that predates it answers 404). */
const similaritySupport = new WeakMap<object, boolean>();

type Load<G> = { status: "loading"; graph: G | null } | { status: "ready"; graph: G } | { status: "error"; message: string; graph: G | null };

/**
 * Reads one layer's graph while `enabled`: again when `read` (memoized on what it asks for) or
 * `tick` moves. Coming back to the layer reads again only when one of them moved meanwhile.
 * `onRefused` may take a refusal over (true: no error is shown).
 */
function useLayerLoad<G>(
  enabled: boolean,
  read: ((signal: AbortSignal) => Promise<G>) | null,
  tick: number,
  onRefused: (error: unknown) => boolean
): Load<G> {
  const [load, setLoad] = useState<Load<G>>({ status: "loading", graph: null });
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;
  const fetched = useRef<{ read: unknown; tick: number } | null>(null);
  useEffect(() => {
    if (!enabled || !read || (fetched.current?.read === read && fetched.current.tick === tick)) return;
    const controller = new AbortController();
    setLoad((l) => ({ status: "loading", graph: l.graph }));
    read(controller.signal)
      .then((graph) => {
        if (controller.signal.aborted) return;
        fetched.current = { read, tick };
        setLoad({ status: "ready", graph });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || onRefusedRef.current(error)) return;
        setLoad((l) => ({ status: "error", message: knowledgeErrorText(error), graph: l.graph }));
      });
    return () => controller.abort();
  }, [enabled, read, tick]);
  return load;
}

/** Bumped by `knowledge.changed` (through the store's revisions): `graph` for the graph, `entries` too for entries. */
function useRevisionTick(entriesToo: boolean): [number, () => void] {
  const [tick, setTick] = useState(0);
  useEffect(
    () =>
      knowledgeStore.subscribe((state, previous) => {
        if (state.graphRevision !== previous.graphRevision || (entriesToo && state.entriesRevision !== previous.entriesRevision)) setTick((t) => t + 1);
      }),
    [entriesToo]
  );
  return [tick, useCallback(() => setTick((t) => t + 1), [])];
}

/** Whether the daemon serves the similarity graph: null until known. A one-entry read asks, unless the layer's own read will. */
function useSimilaritySupport(api: KnowledgeGraphApi | null, layerReads: boolean): [boolean | null, (supported: boolean) => void] {
  const [known, setKnown] = useState<boolean | null>(() => (api ? (api.getKnowledgeSimilarityGraph ? (similaritySupport.get(api) ?? null) : false) : null));
  const record = useCallback(
    (supported: boolean) => {
      if (api) similaritySupport.set(api, supported);
      setKnown(supported);
    },
    [api]
  );
  useEffect(() => {
    const cached = api ? similaritySupport.get(api) : undefined;
    if (!api || !api.getKnowledgeSimilarityGraph || cached !== undefined) {
      setKnown(api ? (api.getKnowledgeSimilarityGraph ? (cached ?? null) : false) : null);
      return;
    }
    setKnown(null);
    if (layerReads) return;
    const controller = new AbortController();
    api
      .getKnowledgeSimilarityGraph({ limit: 1, k: 1 }, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) record(true);
      })
      .catch((error: unknown) => {
        // Any answer but "no such route" means the daemon has it (a refusal shows when it is used).
        if (!controller.signal.aborted) record(!isMissingRoute(error));
      });
    return () => controller.abort();
  }, [api, layerReads, record]);
  return [known, record];
}

function useSearch(api: KnowledgeGraphApi | null, req: KnowledgeSearchRequest | null): GraphSearchState {
  const [state, setState] = useState<GraphSearchState>({ status: "idle" });
  const key = req ? JSON.stringify(req) : "";
  const reqRef = useRef(req);
  reqRef.current = req;
  useEffect(() => {
    const request = reqRef.current;
    if (!api || !request) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "searching" });
    const timer = setTimeout(() => {
      api
        .searchKnowledge(request, controller.signal)
        .then((answer) => {
          if (!controller.signal.aborted) setState({ status: "done", answer });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ status: "error", message: knowledgeErrorText(error) });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, key]);
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
  /** The Knowledge view's shared query (the search box edits its words); absent: the view keeps its own. */
  query?: KnowledgeQuery;
  onQueryChange?: (query: KnowledgeQuery) => void;
  /** "Show all N results": the List view with the same query (the line is hidden without it). */
  onOpenInList?: () => void;
  /**
   * The concept panel's "Show its entries in Similarity": applied once per nonce (the Similarity
   * layer, with those entries marked), then `onConceptMarksShown` lets the Knowledge view drop it.
   */
  conceptMarks?: ConceptMarksRequest | null;
  onConceptMarksShown?: () => void;
  /** Whether the daemon serves the Similarity layer (null: not known yet), each time that is learnt. */
  onSimilaritySupport?: (supported: boolean | null) => void;
}

/** A request to mark a concept's entries on the Similarity layer; a new nonce asks again. */
export interface ConceptMarksRequest {
  marks: ConceptMarks;
  nonce: number;
}

const NO_IDS: ReadonlySet<string> = new Set();

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
  toolbarEnd,
  query: sharedQuery,
  onQueryChange,
  onOpenInList,
  conceptMarks: marksRequest = null,
  onConceptMarksShown,
  onSimilaritySupport
}) => {
  const openSettings = useAppStore((s) => s.openSettings);

  // The layer, remembered for the session; Similarity only where the daemon serves it.
  const [layerChoice, setLayerChoice] = useState<GraphLayer>(sessionLayer);
  const [supported, recordSupport] = useSimilaritySupport(api, layerChoice === "similarity");
  const layer: GraphLayer = layerChoice === "similarity" && supported !== false ? "similarity" : "concepts";
  useEffect(() => {
    if (supported === false && sessionLayer === "similarity") sessionLayer = "concepts";
  }, [supported]);
  const onSimilaritySupportRef = useRef(onSimilaritySupport);
  onSimilaritySupportRef.current = onSimilaritySupport;
  useEffect(() => onSimilaritySupportRef.current?.(supported), [supported]);
  const [colorBy, setColorByState] = useState<SimilarityColorBy>(sessionColorBy);
  const setColorBy = (next: SimilarityColorBy) => {
    sessionColorBy = next;
    setColorByState(next);
    setPicked(null);
  };
  /** The legend line whose entries are marked. */
  const [picked, setPicked] = useState<string | null>(null);
  /** A concept's entries marked on the Similarity layer ("Show its entries in Similarity"). */
  const [conceptMarks, setConceptMarks] = useState<ConceptMarks | null>(null);
  const chooseLayer = (next: GraphLayer) => {
    sessionLayer = next;
    setLayerChoice(next);
    setPicked(null);
    setConceptMarks(null);
  };
  // Cross navigation (phase 2 spec): a cluster's concept opens in the Concepts layer, through the
  // selection (the panel opens it; the canvas moves to its neighbourhood when it is not shown)…
  const openConcept = (concept: KnowledgeConceptRef) => {
    chooseLayer("concepts");
    onSelect({ kind: "concept", id: concept.id });
    // Also when it is selected already (the selection does not move, so its effect does not run).
    const target = { kind: "concept" as const, id: concept.id };
    setFocus((current) => focusFor(target, graphRef.current, current));
  };
  // …and a concept's entries are marked on the Similarity layer (the concept panel asks, below).

  // --- Concepts layer ---
  const [focus, setFocus] = useState<string | null>(null);
  const [conceptTick, retryConcepts] = useRevisionTick(false);
  const scopeKey = graphScopeKey({ collections: filter, focus });
  const readConcepts = useMemo(
    () => (api ? (signal: AbortSignal) => api.getKnowledgeGraph(graphQueryOf({ collections: filter, focus }), signal) : null),
    // `scopeKey` stands for `filter` and `focus`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, scopeKey]
  );
  const load = useLayerLoad<KnowledgeGraphResponse>(layer === "concepts", readConcepts, conceptTick, (error) => {
    // The item the canvas centred on is gone (deleted, or dropped by a run): back to the overview.
    if (focus !== null && knowledgeErrorCode(error) === "KNOWLEDGE_NOT_FOUND") {
      setFocus(null);
      return true;
    }
    return false;
  });
  const graph = load.graph;

  // --- Similarity layer ---
  const [similarityTick, retrySimilarity] = useRevisionTick(true);
  const filterKey = [...filter].sort().join(",");
  const readSimilarity = useMemo(() => {
    const read = api?.getKnowledgeSimilarityGraph;
    return api && read ? (signal: AbortSignal) => read.call(api, similarityQueryOf(filter), signal) : null;
    // `filterKey` stands for `filter`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filterKey]);
  const similarityLoad = useLayerLoad<KnowledgeSimilarityGraphResponse>(layer === "similarity", readSimilarity, similarityTick, (error) => {
    if (!isMissingRoute(error)) return false;
    recordSupport(false);
    return true;
  });
  const similarity = similarityLoad.graph;
  useEffect(() => {
    if (similarityLoad.status === "ready") recordSupport(true);
  }, [similarityLoad.status, recordSupport]);

  // --- The search (the shared query's words) ---
  const [ownQuery, setOwnQuery] = useState<KnowledgeQuery>(EMPTY_KNOWLEDGE_QUERY);
  const query = sharedQuery ?? ownQuery;
  const setText = (text: string) => {
    const next = { ...query, text };
    if (sharedQuery === undefined) setOwnQuery(next);
    onQueryChange?.(next);
  };
  const [resultsOpen, setResultsOpen] = useState(false);
  const searchRequest = useMemo(() => graphSearchRequest(query, filter, SEARCH_LIMIT), [query, filter]);
  const search = useSearch(api, searchRequest);
  const hits = search.status === "done" ? search.answer.hits : null;

  // A new selection (a node, a hit, the panel, a citation) moves the concepts canvas to it when it is not shown.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const selectionKey = selection ? `${selection.kind}:${selection.id}` : "";
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // A selection made before any graph was read (a citation opening the view, the List view
  // switched back to the graph) is placed once the first graph arrives.
  const placeLater = useRef(false);
  useEffect(() => {
    if (!selection) return;
    if (!graphRef.current) {
      placeLater.current = true;
      return;
    }
    placeLater.current = false;
    setFocus((current) => focusFor(selection, graphRef.current, current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  useEffect(() => {
    if (!graph || !placeLater.current) return;
    placeLater.current = false;
    const pending = selectionRef.current;
    if (pending) setFocus((current) => focusFor(pending, graph, current));
  }, [graph]);
  // A filter change returns to the overview of those collections.
  useEffect(() => {
    setFocus(null);
    setPicked(null);
    setConceptMarks(null);
  }, [filterKey]);
  // The concept panel's "Show its entries in Similarity" (after the filter's reset above, which also
  // runs on mount: a request that mounted this view is applied, not cleared). Once per nonce.
  const onMarksShownRef = useRef(onConceptMarksShown);
  onMarksShownRef.current = onConceptMarksShown;
  const marksNonce = marksRequest?.nonce;
  useEffect(() => {
    if (!marksRequest) return;
    chooseLayer("similarity");
    setConceptMarks(marksRequest.marks);
    onMarksShownRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksNonce]);

  const colorOf = useMemo(() => new Map<string, KnowledgeColor>(collections.map((c) => [c.id, c.color])), [collections]);
  const knownCollections = useMemo(() => new Set(collections.map((c) => c.id)), [collections]);

  // What each layer draws.
  const conceptNodes = useMemo(() => (graph ? canvasNodes(graph, colorOf, filter) : []), [graph, colorOf, filter]);
  const conceptEdges = useMemo<readonly CanvasEdge[]>(() => graph?.edges ?? [], [graph]);
  const similarityNodes = useMemo(() => (similarity ? similarityCanvasNodes(similarity, colorBy, colorOf, filter) : []), [similarity, colorBy, colorOf, filter]);
  const similarityEdges = useMemo(() => (similarity ? similarityCanvasEdges(similarity) : []), [similarity]);
  const legend = useMemo(
    () => (similarity ? (colorBy === "cluster" ? similarityLegend(similarity) : collectionLegend(similarity, collections, filter)) : { items: [], more: 0 }),
    [similarity, colorBy, collections, filter]
  );
  const pickedItem = legend.items.find((item) => item.key === picked) ?? null;
  // A picked line gone from a newer answer (its cluster broke up, its collection emptied) lets go,
  // rather than coming back on whatever later takes its key.
  const pickedGone = picked !== null && similarityLoad.status === "ready" && pickedItem === null;
  useEffect(() => {
    if (pickedGone) setPicked(null);
  }, [pickedGone]);
  const pickedIds = useMemo(
    () => (similarity && pickedItem ? legendMemberIds(similarity, pickedItem.members, knownCollections) : NO_IDS),
    [similarity, pickedItem, knownCollections]
  );

  const conceptHighlights = useMemo(() => {
    const ids = new Set<string>(selection?.kind === "entry" ? entryConceptIds : []);
    for (const hit of hits ?? []) if (hit.kind === "concept") ids.add(hit.concept.id);
    return ids;
  }, [selection?.kind, entryConceptIds, hits]);
  const markedConceptIds = useMemo(() => (conceptMarks ? drawnEntryIds(conceptMarks.entryIds, similarity) : []), [conceptMarks, similarity]);
  const similarityHighlights = useMemo(() => {
    const ids = new Set<string>(pickedIds);
    for (const id of markedConceptIds) ids.add(id);
    for (const hit of hits ?? []) if (hit.kind === "entry") ids.add(hit.entry.id);
    return ids;
  }, [pickedIds, markedConceptIds, hits]);
  const contradictions = useMemo(() => (similarity ? contradictingEdgeCount(similarity) : 0), [similarity]);

  const onCanvasIds = useMemo(
    () => new Set(layer === "concepts" ? (graph?.nodes.map((n) => n.id) ?? []) : (similarity?.nodes.map((n) => n.id) ?? [])),
    [layer, graph, similarity]
  );
  // With the results closed, a line says what the search found (so no hit is out of sight).
  const searchNote =
    !resultsOpen && query.text.trim() && hits
      ? ((layer === "concepts" ? searchSummary(hits, onCanvasIds) : similaritySearchSummary(hits, onCanvasIds)) ?? "Nothing matches.")
      : null;

  const toggleFilter = (id: string) => onFilter(filter.includes(id) ? filter.filter((f) => f !== id) : [...filter, id]);
  const pick = (hit: KnowledgeSearchHit) => {
    setResultsOpen(false);
    onSelect(hit.kind === "entry" ? { kind: "entry", id: hit.entry.id } : { kind: "concept", id: hit.concept.id });
  };

  // The active layer's read; the canvas keeps the other layer's picture (and its own memory of
  // both) mounted while this one loads for the first time.
  const current = layer === "concepts" ? load : similarityLoad;
  const ready = (l: GraphLayer) => (l === "concepts" ? graph !== null : similarity !== null);
  const canvasLayer: GraphLayer | null = ready(layer) ? layer : ready(layer === "concepts" ? "similarity" : "concepts") ? (layer === "concepts" ? "similarity" : "concepts") : null;

  // The counts read 0 also while the knowledge base cannot be opened: a refused graph read shows
  // its error instead of the empty state.
  const noEntries = status.entries === 0 && !(current.status === "error" && !current.graph);
  const unlinked = layer === "concepts" && graph !== null && graph.nodes.length === 0 && filter.length === 0 && focus === null;
  const empty = layer === "similarity" && similarity ? similarityEmptyState(similarity, status.embeddingModelReady) : null;
  const note = layer === "concepts" ? (graph ? truncationNote(graph, focus !== null) : null) : similarity && !empty ? similarityNote(similarity) : null;
  const canvasShown = canvasLayer === layer && !unlinked && !empty;
  // The canvas (and Cytoscape with it) loads the first time there is something to draw; after
  // that it stays mounted, hidden while this layer has nothing to show.
  const canvasLoaded = useRef(false);
  if (canvasShown) canvasLoaded.current = true;
  const retry = layer === "concepts" ? retryConcepts : retrySimilarity;
  const showLayerSwitch = supported === true || layer === "similarity";

  let overlay: React.ReactNode = null;
  if (!ready(layer)) {
    overlay =
      current.status === "error" ? (
        <Centered>
          <ErrorLine>{current.message}</ErrorLine>
          <Button size="sm" variant="outline" onClick={retry}>
            <RefreshCw size={13} /> Retry
          </Button>
        </Centered>
      ) : (
        <Centered>
          <Loader2 size={16} className="motion-safe:animate-spin" /> {layer === "concepts" ? "Loading the graph…" : "Loading the similarity graph…"}
        </Centered>
      );
  } else if (unlinked) {
    overlay = (
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
    );
  } else if (empty) {
    overlay = (
      <Centered>
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-500">
          {empty === "computing" ? <Loader2 size={18} className="motion-safe:animate-spin" /> : <Sparkles size={18} />}
        </span>
        {empty === "no-entries" ? (
          <p className="text-neutral-300">No entries in {filter.length === 1 ? "this collection" : "these collections"} yet.</p>
        ) : empty === "computing" ? (
          <>
            <p className="text-neutral-300">Embeddings are being computed…</p>
            <p className="max-w-sm text-xs leading-relaxed text-neutral-500">Entries appear here once their meaning has been computed.</p>
            <Button size="sm" variant="outline" onClick={retrySimilarity}>
              <RefreshCw size={13} /> Check again
            </Button>
          </>
        ) : (
          <>
            <p className="text-neutral-300">The embedding model is still being downloaded</p>
            <p className="max-w-sm text-xs leading-relaxed text-neutral-500">
              Entries appear here once it is installed and their meaning has been computed. Search matches the words meanwhile.
            </p>
            <Button size="sm" variant="outline" onClick={() => openSettings("plugins")}>
              <Settings size={13} /> Open Plugins
            </Button>
          </>
        )}
      </Centered>
    );
  }

  let canvasProps: KnowledgeGraphCanvasProps | null = null;
  if (canvasLayer === "concepts") {
    canvasProps = {
      layer: "concepts",
      itemNoun: "concepts",
      nodes: conceptNodes,
      edges: conceptEdges,
      selectedId: selection?.kind === "concept" ? selection.id : null,
      highlightIds: conceptHighlights,
      onSelect: (id) => onSelect(id ? { kind: "concept", id } : null),
      active: active && canvasShown
    };
  } else if (canvasLayer === "similarity") {
    canvasProps = {
      layer: "similarity",
      itemNoun: "entries",
      nodes: similarityNodes,
      edges: similarityEdges,
      selectedId: selection?.kind === "entry" ? selection.id : null,
      highlightIds: similarityHighlights,
      onSelect: (id) => onSelect(id ? { kind: "entry", id } : null),
      active: active && canvasShown
    };
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <GraphSearchBox
          text={query.text}
          onText={setText}
          state={search}
          open={resultsOpen}
          onOpen={setResultsOpen}
          collections={collections}
          onPick={pick}
          onShowAll={onOpenInList}
          filter={filter}
          narrowed={searchIsNarrowed(query)}
        />
        {searchNote && (
          <span role="status" className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px] text-neutral-400 max-md:basis-full">
            <span className="truncate">{searchNote}</span>
            {hits && hits.length > 0 && (
              <button type="button" className="shrink-0 font-medium text-neutral-200 hover:underline" onClick={() => setResultsOpen(true)}>
                Show results
              </button>
            )}
          </span>
        )}
        {showLayerSwitch && (
          <SegmentedControl value={layer} options={LAYER_OPTIONS} onChange={chooseLayer} size="xs" ariaLabel="Layer" className={TOOLBAR_SEGMENTED} />
        )}
        {/* Never narrower than its widest chip (a flex-1 group may otherwise share a line squeezed
            to nothing, its chips spilling under the controls after it). On a phone: its own last
            line, scrolling sideways. */}
        <div
          role="group"
          aria-label="Filter by collection"
          className={cn("flex min-w-0 items-center gap-1 md:min-w-[12rem] md:flex-1 md:flex-wrap max-md:order-last max-md:basis-full", PHONE_CHIP_ROW)}
        >
          <CollectionChip name="All" color={null} active={filter.length === 0} onClick={() => onFilter([])} dot={false} className={PHONE_CHIP} />
          {collections.map((c) => (
            <CollectionChip
              key={c.id}
              name={c.name}
              color={c.color}
              active={filter.includes(c.id)}
              onClick={() => toggleFilter(c.id)}
              title={c.description || undefined}
              className={PHONE_CHIP}
            />
          ))}
        </div>
        {toolbarEnd && <div className="ml-auto flex shrink-0 items-center">{toolbarEnd}</div>}
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
        ) : (
          <>
            {canvasProps && canvasLoaded.current && (
              // One canvas for both layers, kept mounted (hidden while it has nothing to show for
              // this layer), so each layer finds its positions and viewport as it left them.
              <div className={canvasShown ? "absolute inset-0" : "invisible absolute inset-0"} aria-hidden={!canvasShown || undefined}>
                <Suspense
                  fallback={
                    <Centered>
                      <Loader2 size={16} className="motion-safe:animate-spin" /> Loading the graph…
                    </Centered>
                  }
                >
                  <Canvas {...canvasProps} />
                </Suspense>
              </div>
            )}
            {overlay && <div className="absolute inset-0">{overlay}</div>}
            {canvasShown && layer === "concepts" && graph && graph.nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
                No concepts in {filter.length === 1 ? "this collection" : "these collections"} yet.
              </div>
            )}
            {canvasShown && (
              <div className="pointer-events-none absolute left-3 right-3 top-3 flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
                  {note && (
                    <span className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/90 px-3 py-1 text-[11.5px] text-neutral-400 shadow-sm">
                      {note}
                      {layer === "concepts" && focus !== null && (
                        <button type="button" className="font-medium text-neutral-200 hover:underline" onClick={() => setFocus(null)}>
                          Back to the overview
                        </button>
                      )}
                      {layer === "similarity" && similarity && similarity.totals.entries > similarity.totals.embedded && (
                        <button type="button" className="font-medium text-neutral-200 hover:underline" onClick={retrySimilarity}>
                          Refresh
                        </button>
                      )}
                    </span>
                  )}
                  {layer === "similarity" && conceptMarks && similarity && (
                    <span
                      role="status"
                      className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/90 px-3 py-1 text-[11.5px] text-neutral-400 shadow-sm"
                    >
                      <span className="min-w-0 truncate">{conceptMarksText(conceptMarks, markedConceptIds.length)}</span>
                      <button type="button" className="shrink-0 font-medium text-neutral-200 hover:underline" onClick={() => setConceptMarks(null)}>
                        Clear
                      </button>
                    </span>
                  )}
                  {current.status === "loading" && <Loader2 size={14} className="mt-1 text-neutral-500 motion-safe:animate-spin" />}
                  {current.status === "error" && (
                    <span className="pointer-events-auto rounded-full border border-danger-900/60 bg-neutral-900/90 px-3 py-1 text-[11.5px] text-danger">
                      {current.message}
                    </span>
                  )}
                </div>
                {layer === "similarity" && similarity && (
                  <div className="flex max-h-[calc(100%-1.5rem)] shrink-0">
                    <SimilarityLegend
                      colorBy={colorBy}
                      onColorBy={setColorBy}
                      legend={legend}
                      picked={pickedItem ? pickedItem.key : null}
                      onPick={setPicked}
                      onConcept={openConcept}
                      contradictions={contradictions}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
