// A Knowledge tab (the Knowledge Graph plugin): the server-wide knowledge base,
// whichever project the tab is in. Graph first, with a List toggle; a side
// panel for the selected entry or concept; the status bar at the bottom.
// MainView lazy-loads this module, and the graph canvas (Cytoscape) loads with
// the first graph shown, so neither is in the app's main bundle.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, Loader2, RefreshCw, Settings, Share2, Waypoints } from "lucide-react";
import { KNOWLEDGE_GRAPH_PLUGIN_ID, type KnowledgeCollectionView, type KnowledgeItemResponse } from "@orquester/api";

import { Button } from "../ui";
import { SegmentedControl } from "../settings/primitives";
import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import { loadKnowledge, useKnowledgeState } from "../../lib/knowledge/store";
import { useAppStore, type KnowledgeFocus } from "../../store/app";
import { Centered, ErrorLine } from "./parts";
import { knowledgeErrorText } from "./knowledge.logic";
import { KnowledgeGraphView } from "./KnowledgeGraphView";
import { KnowledgeListView, type ListCollection } from "./KnowledgeListView";
import { KnowledgePanel, type KnowledgeSelection } from "./KnowledgePanel";
import { KnowledgeStatusBar } from "./KnowledgeStatusBar";
import { KnowledgeCollectionDialog } from "./KnowledgeCollectionDialog";
import type { KnowledgeGraphCanvasProps } from "./KnowledgeGraphCanvas";

const LazyCanvas = React.lazy(() => import("./KnowledgeGraphCanvas"));

type ViewMode = "graph" | "list";

const VIEW_OPTIONS = [
  { value: "graph" as const, label: "Graph", icon: <Share2 size={12} /> },
  { value: "list" as const, label: "List", icon: <List size={12} /> }
];

const HISTORY_MAX = 20;
const NO_IDS: readonly string[] = [];

export interface KnowledgeViewProps {
  /** What the tab was asked to show (a citation, `openKnowledgeEntry`); applied each time its nonce moves. */
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

  // Through refs, so a select never runs inside another state update.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const historyRef = useRef(history);
  historyRef.current = history;
  const select = useCallback((next: KnowledgeSelection | null) => {
    const current = selectionRef.current;
    selectionRef.current = next;
    if (!next) {
      setHistory([]);
      setSelection(null);
      return;
    }
    if (current && (current.kind !== next.kind || current.id !== next.id)) {
      setHistory((h) => [...h.slice(-(HISTORY_MAX - 1)), { kind: current.kind, id: current.id }]);
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

  const toggle = <SegmentedControl value={view} options={VIEW_OPTIONS} onChange={setView} size="xs" ariaLabel="View" />;
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
                active={active}
                Canvas={Canvas}
                toolbarEnd={toggle}
              />
            ) : (
              <KnowledgeListView
                api={api}
                collections={collections}
                collection={listCollection}
                onCollection={setListCollection}
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
