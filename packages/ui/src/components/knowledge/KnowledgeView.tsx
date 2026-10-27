// The Knowledge view (the Knowledge Graph plugin): the server-wide knowledge base,
// shown over the main area whatever project (or none) is open. Graph first, with
// List and (where the daemon serves them) Insights toggles; a side panel for the
// selected entry or concept; the status bar at the bottom.
// MainView lazy-loads this module, and the graph canvas (Cytoscape) loads with
// the first graph shown, so neither is in the app's main bundle.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lightbulb, List, Loader2, RefreshCw, Settings, Share2, Waypoints } from "lucide-react";
import { KNOWLEDGE_GRAPH_PLUGIN_ID, type KnowledgeCollectionView, type KnowledgeItemResponse } from "@orquester/api";

import { Button } from "../ui";
import { SegmentedControl } from "../settings/primitives";
import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import { useIsDesktop } from "../../hooks/use-media-query";
import { knowledgeStore, loadKnowledge, useKnowledgeState } from "../../lib/knowledge/store";
import { useAppStore, type KnowledgeFocus } from "../../store/app";
import { Centered, ErrorLine, TOOLBAR_SEGMENTED } from "./parts";
import { knowledgeErrorCode, knowledgeErrorText, pruneSelectionHistory } from "./knowledge.logic";
import { KnowledgeGraphView, type ConceptMarksRequest } from "./KnowledgeGraphView";
import type { ConceptMarks } from "./graph.logic";
import { KnowledgeInsightsView, useInsightsSupport } from "./KnowledgeInsightsView";
import { KnowledgeListView, type ListCollection } from "./KnowledgeListView";
import { KnowledgePanel, type KnowledgeSelectOptions, type KnowledgeSelection } from "./KnowledgePanel";
import { KnowledgeStatusBar } from "./KnowledgeStatusBar";
import { KnowledgeCollectionDialog } from "./KnowledgeCollectionDialog";
import { EMPTY_KNOWLEDGE_QUERY, type KnowledgeQuery, findSimilarQuery, withoutExamples } from "./query-state";
import type { KnowledgeGraphCanvasProps } from "./KnowledgeGraphCanvas";

const LazyCanvas = React.lazy(() => import("./KnowledgeGraphCanvas"));

type ViewMode = "graph" | "list" | "insights";

// On a phone the options show their icons only (their names stay for screen readers and tests),
// so the toggle shares a toolbar line with the layer switch at ~360 px.
const viewLabel = (label: string) => <span className="max-md:sr-only">{label}</span>;
const GRAPH_LIST_OPTIONS = [
  { value: "graph" as const, label: viewLabel("Graph"), icon: <Share2 size={12} />, title: "Graph" },
  { value: "list" as const, label: viewLabel("List"), icon: <List size={12} />, title: "List" }
];
const VIEW_OPTIONS: { value: ViewMode; label: React.ReactNode; icon: React.ReactNode; title: string }[] = [
  ...GRAPH_LIST_OPTIONS,
  { value: "insights" as const, label: viewLabel("Insights"), icon: <Lightbulb size={12} />, title: "Insights" }
];

const HISTORY_MAX = 20;
const NO_IDS: readonly string[] = [];

export interface KnowledgeViewProps {
  /** What the view was asked to show (a citation, `openKnowledgeEntry`); applied each time its nonce moves. */
  focus: KnowledgeFocus | null;
  active: boolean;
  /** The graph canvas; tests pass a stand-in (the default is Cytoscape, loaded on first use). */
  Canvas?: React.ComponentType<KnowledgeGraphCanvasProps>;
}

export const KnowledgeView: React.FC<KnowledgeViewProps> = ({ focus, active, Canvas = LazyCanvas }) => {
  const api = useAppStore((s) => s.api);
  const pluginsLoaded = useAppStore((s) => s.plugins !== null);
  const plugin = useAppStore((s) => s.plugins?.find((p) => p.id === KNOWLEDGE_GRAPH_PLUGIN_ID) ?? null);
  const openSettings = useAppStore((s) => s.openSettings);
  const on = plugin !== null && plugin.scope === "global" && plugin.enabled;
  const status = useKnowledgeState((s) => s.status);
  const statusError = useKnowledgeState((s) => s.statusError);
  const collections = useKnowledgeState((s) => s.collections);
  const collectionsError = useKnowledgeState((s) => s.collectionsError);

  const [view, setView] = useState<ViewMode>("graph");
  const [selection, setSelection] = useState<KnowledgeSelection | null>(null);
  const [history, setHistory] = useState<KnowledgeSelection[]>([]);
  const [graphFilter, setGraphFilter] = useState<string[]>([]);
  const [listCollection, setListCollection] = useState<ListCollection>("all");
  const [dialog, setDialog] = useState<{ open: boolean; collection: KnowledgeCollectionView | null }>({ open: false, collection: null });
  const [panelItem, setPanelItem] = useState<KnowledgeItemResponse | null>(null);
  /** What the List view searches for; shared with the Graph view's search and the panel's "More like this". */
  const [query, setQuery] = useState<KnowledgeQuery>(EMPTY_KNOWLEDGE_QUERY);

  /**
   * Switch to the List view searching `next` — the panel's "More like this"
   * (`openList(findSimilarQuery(id))`) and the Graph view's "Show all results"
   * (`openList(query)`). `collection`, when given, also narrows the list to it.
   */
  const openList = useCallback((next: KnowledgeQuery, collection?: ListCollection) => {
    setQuery(next);
    if (collection !== undefined) setListCollection(collection);
    setView("list");
  }, []);

  // Through refs, so a select never runs inside another state update.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const historyRef = useRef(history);
  historyRef.current = history;
  const select = useCallback((next: KnowledgeSelection | null, options?: KnowledgeSelectOptions) => {
    const current = selectionRef.current;
    selectionRef.current = next;
    if (!next) {
      setHistory([]);
      setSelection(null);
      return;
    }
    if (current && (current.kind !== next.kind || current.id !== next.id)) {
      // `replace` (a merge moved off the entry it deleted): the current item leaves no way back to it.
      if (options?.replace) setHistory((h) => pruneSelectionHistory(h, new Set(), next));
      else setHistory((h) => [...h.slice(-(HISTORY_MAX - 1)), { kind: current.kind, id: current.id }]);
    }
    setSelection(next);
  }, []);
  const back = useCallback(() => {
    const h = historyRef.current;
    const previous = h[h.length - 1] ?? null;
    selectionRef.current = previous;
    setHistory(h.slice(0, -1));
    setSelection(previous);
  }, []);

  // Entries deleted (here, by a merge, or elsewhere) let go of the shared query's examples (a search
  // naming one would only be refused) and of the Back history. An entries change names what changed
  // (an edit or a delete alike): those of them still in use are asked about, and the gone dropped.
  const queryRef = useRef(query);
  queryRef.current = query;
  const forgetEntries = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    setQuery((q) => withoutExamples(q, gone));
    setHistory((h) => {
      const next = pruneSelectionHistory(h, gone, selectionRef.current);
      historyRef.current = next;
      return next;
    });
  }, []);
  // A search refused for a gone example names it (else every example is in doubt): only the query lets go.
  const dropExamples = useCallback((ids: readonly string[]) => setQuery((q) => withoutExamples(q, ids)), []);
  useEffect(() => {
    if (!api) return;
    let live = true;
    const unsubscribe = knowledgeStore.subscribe((state, previous) => {
      if (state.entriesRevision <= previous.entriesRevision) return;
      const named = state.changedEntryIds;
      const q = queryRef.current;
      const inUse = new Set([...q.similarTo, ...q.unlike, ...historyRef.current.filter((s) => s.kind === "entry").map((s) => s.id)]);
      const asked = [...inUse].filter((id) => named === null || named.includes(id));
      if (asked.length === 0) return;
      void Promise.all(
        asked.map((id) =>
          api.getKnowledgeItem(id).then(
            () => null,
            (error: unknown) => (knowledgeErrorCode(error) === "KNOWLEDGE_NOT_FOUND" ? id : null)
          )
        )
      ).then((answers) => {
        if (live) forgetEntries(answers.filter((id): id is string => id !== null));
      });
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api, forgetEntries]);

  // A focus request (a citation clicked, `openKnowledgeEntry`) selects its item.
  useEffect(() => {
    if (focus) select({ kind: focus.kind, id: focus.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Filters naming a collection that no longer exists let go of it: at once for one this client
  // deleted (before anything refetches with it), else when the collections are read again.
  const collectionDeleted = useCallback((id: string) => {
    setListCollection((c) => (c === id ? "all" : c));
    setGraphFilter((f) => (f.includes(id) ? f.filter((other) => other !== id) : f));
  }, []);
  const list = collections?.collections;
  useEffect(() => {
    if (!list) return;
    const ids = new Set(list.map((c) => c.id));
    setGraphFilter((f) => (f.every((id) => ids.has(id)) ? f : f.filter((id) => ids.has(id))));
    setListCollection((c) => (c === "all" || c === "unfiled" || ids.has(c) ? c : "all"));
  }, [list]);

  const entryConceptIds = useMemo(
    () => (panelItem?.kind === "entry" && selection?.kind === "entry" && panelItem.entry.entry.id === selection.id ? panelItem.entry.concepts.map((c) => c.id) : NO_IDS),
    [panelItem, selection]
  );

  // The concept panel's "Show its entries in Similarity": the graph's Similarity layer with them
  // marked. On a phone the panel covers the graph, so it closes to show it.
  const isDesktop = useIsDesktop();
  const [similaritySupported, setSimilaritySupported] = useState<boolean | null>(null);
  const [conceptMarks, setConceptMarks] = useState<ConceptMarksRequest | null>(null);
  const marksNonce = useRef(0);
  const showConceptEntries = useCallback(
    (marks: ConceptMarks) => {
      marksNonce.current += 1;
      setConceptMarks({ marks, nonce: marksNonce.current });
      setView("graph");
      if (!isDesktop) select(null);
    },
    [isDesktop, select]
  );
  const conceptMarksShown = useCallback(() => setConceptMarks(null), []);
  // Known once a graph view asked (it stays known while the List or Insights view is shown).
  const onSimilaritySupport = useCallback((supported: boolean | null) => {
    if (supported !== null) setSimilaritySupported(supported);
  }, []);

  // Insights only where the daemon serves them (one that predates them answers 404).
  const ready = on && status !== null && status.installed;
  const [insightsSupported, recordInsights] = useInsightsSupport(api, ready, view === "insights");
  useEffect(() => {
    if (insightsSupported === false) setView((v) => (v === "insights" ? "graph" : v));
  }, [insightsSupported]);
  const viewOptions = insightsSupported === true || view === "insights" ? VIEW_OPTIONS : GRAPH_LIST_OPTIONS;
  const toggle = <SegmentedControl value={view} options={viewOptions} onChange={setView} size="xs" ariaLabel="View" className={TOOLBAR_SEGMENTED} />;
  const openPlugins = () => openSettings("plugins");

  let body: React.ReactNode;
  if (!pluginsLoaded) {
    body = (
      <Centered>
        <Loader2 size={16} className="motion-safe:animate-spin" /> Loading…
      </Centered>
    );
  } else if (!on) {
    body = (
      <PluginState
        title="Knowledge Graph is off"
        description="Turn the Knowledge Graph plugin on in Settings → Plugins to save posts and notes from chats and browse them here."
        action={
          <Button size="sm" variant="outline" onClick={openPlugins}>
            <Settings size={13} /> Open Plugins
          </Button>
        }
      />
    );
  } else if (plugin?.job === "installing" || (status !== null && !status.installed)) {
    const installing = plugin?.job === "installing";
    const lastError = plugin?.lastError?.message ?? status?.lastError?.message ?? null;
    body = (
      <PluginState
        busy={installing}
        title={installing ? "Installing Knowledge Graph…" : "Knowledge Graph is not installed yet"}
        description={
          installing
            ? "Downloading myKG and the search model. The knowledge base opens here when it is ready."
            : "The plugin downloads its tools when it is turned on. Check Settings → Plugins for its progress."
        }
        error={installing ? null : lastError}
        action={
          installing ? null : (
            <Button size="sm" variant="outline" onClick={openPlugins}>
              <Settings size={13} /> Open Plugins
            </Button>
          )
        }
      />
    );
  } else if (status === null) {
    body =
      statusError !== null ? (
        <Centered>
          <ErrorLine>{knowledgeErrorText(statusError)}</ErrorLine>
          <Button size="sm" variant="outline" onClick={() => api && void loadKnowledge(api).catch(() => undefined)}>
            <RefreshCw size={13} /> Retry
          </Button>
        </Centered>
      ) : (
        <Centered>
          <Loader2 size={16} className="motion-safe:animate-spin" /> Opening the knowledge…
        </Centered>
      );
  } else {
    const collectionList = collections?.collections ?? [];
    body = (
      <>
        {collectionsError !== null && collections === null && (
          <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-4 py-1.5">
            <ErrorLine className="flex-1">Could not read the collections: {knowledgeErrorText(collectionsError)}</ErrorLine>
            <Button size="sm" variant="ghost" onClick={() => api && void loadKnowledge(api).catch(() => undefined)}>
              <RefreshCw size={12} /> Retry
            </Button>
          </div>
        )}
        <div className="relative flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {view === "graph" ? (
              <KnowledgeGraphView
                api={api}
                status={status}
                collections={collectionList}
                filter={graphFilter}
                onFilter={setGraphFilter}
                selection={selection}
                onSelect={select}
                entryConceptIds={entryConceptIds}
                onShowList={() => setView("list")}
                query={query}
                onQueryChange={setQuery}
                // The graph's one collection chip, when exactly one is on, narrows the list the same way.
                onOpenInList={() => openList(query, graphFilter.length === 1 ? graphFilter[0] : "all")}
                conceptMarks={conceptMarks}
                onConceptMarksShown={conceptMarksShown}
                onSimilaritySupport={onSimilaritySupport}
                active={active}
                Canvas={Canvas}
                toolbarEnd={toggle}
              />
            ) : view === "insights" ? (
              <KnowledgeInsightsView
                api={api}
                collections={collectionList}
                // The graph's collection chips: insights are scoped like the similarity graph.
                filter={graphFilter}
                onFilter={setGraphFilter}
                selection={selection}
                onSelect={select}
                onUnsupported={() => recordInsights(false)}
                onSupported={() => recordInsights(true)}
                toolbarEnd={toggle}
              />
            ) : (
              <KnowledgeListView
                api={api}
                collections={collections}
                collection={listCollection}
                onCollection={setListCollection}
                query={query}
                onQueryChange={setQuery}
                onExamplesGone={dropExamples}
                selection={selection}
                onSelect={select}
                onNewCollection={() => setDialog({ open: true, collection: null })}
                onEditCollection={(collection) => setDialog({ open: true, collection })}
                toolbarEnd={toggle}
              />
            )}
          </div>
          {selection && (
            <div className="w-[380px] max-w-[45%] shrink-0 max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-full max-md:max-w-none">
              <KnowledgePanel
                api={api}
                selection={selection}
                collections={collectionList}
                onSelect={select}
                onClose={() => select(null)}
                onBack={history.length > 0 ? back : undefined}
                onItem={setPanelItem}
                onFindSimilar={(id) => openList(findSimilarQuery(id), "all")}
                onShowConceptEntries={similaritySupported === true ? showConceptEntries : undefined}
              />
            </div>
          )}
        </div>
        <KnowledgeStatusBar status={status} />
        <KnowledgeCollectionDialog
          api={api}
          open={dialog.open}
          collection={dialog.collection}
          collections={collectionList}
          onClose={() => setDialog((d) => ({ ...d, open: false }))}
          onDeleted={collectionDeleted}
        />
      </>
    );
  }

  return (
    <div {...KEYBOARD_SURFACE_PROPS} className="flex h-full w-full min-w-0 flex-col bg-neutral-950">
      {body}
    </div>
  );
};

const PluginState: React.FC<{
  title: string;
  description: string;
  action?: React.ReactNode;
  error?: string | null;
  busy?: boolean;
}> = ({ title, description, action, error, busy }) => (
  <Centered>
    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-500">
      {busy ? <Loader2 size={18} className="motion-safe:animate-spin" /> : <Waypoints size={18} />}
    </span>
    <p className="text-neutral-300">{title}</p>
    <p className="max-w-sm text-xs leading-relaxed text-neutral-500">{description}</p>
    {error && <ErrorLine className="max-w-md">{error}</ErrorLine>}
    {action}
  </Centered>
);

export default KnowledgeView;
