// The Knowledge view's side panel: one entry (full text as Markdown or plain,
// metadata, concepts, similar entries and possible duplicates; edit, delete,
// merge a duplicate, "More like this") or one concept (type and confidence,
// description, the entries behind it, the concepts it links to). Shared by the
// graph and list views.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Loader2, Pencil, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import type {
  KnowledgeCollectionView,
  KnowledgeConceptDetail,
  KnowledgeEntryDetail,
  KnowledgeEntrySummary,
  KnowledgeItemResponse,
  KnowledgeLinkState
} from "@orquester/api";

import { Button, IconButton } from "../ui";
// Directly, not through `../ui`: that index and confirm-dialog import each other, which a lazy chunk cannot split.
import { ConfirmDialog } from "../ui/confirm-dialog";
import { cn } from "../../lib/cn";
import { deleteKnowledgeEntry, knowledgeStore, mergeKnowledgeEntries, type KnowledgeApi } from "../../lib/knowledge/store";
import { CollectionChip, ErrorLine, Eyebrow, SectionLabel } from "./parts";
import { KnowledgeEntryEditor } from "./KnowledgeEntryEditor";
import { entryByline, entryDate, entryPostUrl, formatKnowledgeDate, knowledgeErrorCode, knowledgeErrorText } from "./knowledge.logic";
import { Disagreements, DuplicatesBanner, EntryBody, NoveltyLine, SimilarEntries } from "./KnowledgeEntrySections";
import { MergedFrom, SimilarConcepts, type KnowledgeConceptSectionsApi } from "./KnowledgeConceptSections";
import { entryPanelIds, type KnowledgeMergePlan } from "./panel.logic";
import { conceptMarksOf, type ConceptMarks } from "./graph.logic";

/** What the panel shows; `edit` opens an entry straight in its editor. */
export interface KnowledgeSelection {
  kind: "entry" | "concept";
  id: string;
  edit?: boolean;
}

/** How a selection moves: `replace` takes the current item's place instead of leaving it to go Back to. */
export interface KnowledgeSelectOptions {
  replace?: boolean;
}

/** The routes the panel reads, on top of the store's. `ApiClient` satisfies it. */
export interface KnowledgePanelApi extends KnowledgeConceptSectionsApi {
  getKnowledgeItem(id: string, signal?: AbortSignal): Promise<KnowledgeItemResponse>;
}

type Load =
  | { status: "loading"; item: KnowledgeItemResponse | null }
  | { status: "ready"; item: KnowledgeItemResponse }
  | { status: "gone" }
  | { status: "error"; message: string; item: KnowledgeItemResponse | null };

/** Ids whose change makes an item stale: the entry and the entries it shows, or the concept's entries. */
function relevantIds(item: KnowledgeItemResponse | null, id: string): Set<string> {
  const ids = new Set([id]);
  if (item?.kind === "entry") for (const shown of entryPanelIds(item.entry)) ids.add(shown);
  if (item?.kind === "concept") for (const e of item.concept.entries) ids.add(e.id);
  return ids;
}

/** The id of the item an answer holds (a concept asked for by a merged-away id answers as the kept one). */
function itemId(item: KnowledgeItemResponse): string {
  return item.kind === "entry" ? item.entry.entry.id : item.concept.concept.id;
}

/**
 * Read one item, and read it again when the store says it changed: the graph
 * was reloaded, or entries it shows were edited or deleted. `onRead` hears each
 * answer with the id it was read for.
 */
function useKnowledgeItem(
  api: KnowledgePanelApi | null,
  id: string,
  onRead?: (item: KnowledgeItemResponse, id: string) => void
): { load: Load; retry: () => void } {
  const [load, setLoad] = useState<Load>({ status: "loading", item: null });
  const [tick, setTick] = useState(0);
  const relevant = useRef<Set<string>>(new Set([id]));
  const held = useRef<KnowledgeItemResponse | null>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  useEffect(() => {
    // Moved to the id the held answer already is (a merged-away concept's kept one): keep showing it.
    if (held.current && itemId(held.current) === id) return;
    held.current = null;
    relevant.current = new Set([id]);
    setLoad({ status: "loading", item: null });
  }, [id]);

  useEffect(
    () =>
      knowledgeStore.subscribe((state, previous) => {
        const graph = state.graphRevision !== previous.graphRevision;
        const entries =
          state.entriesRevision !== previous.entriesRevision &&
          (state.changedEntryIds === null || state.changedEntryIds.some((changed) => relevant.current.has(changed)));
        if (graph || entries) setTick((t) => t + 1);
      }),
    []
  );

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    setLoad({ status: "loading", item: held.current });
    api
      .getKnowledgeItem(id, controller.signal)
      .then((item) => {
        if (controller.signal.aborted) return;
        held.current = item;
        relevant.current = relevantIds(item, id);
        setLoad({ status: "ready", item });
        onReadRef.current?.(item, id);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = (error as { status?: unknown } | null)?.status;
        if (knowledgeErrorCode(error) === "KNOWLEDGE_NOT_FOUND" || status === 404) {
          held.current = null;
          setLoad({ status: "gone" });
        } else setLoad({ status: "error", message: knowledgeErrorText(error), item: held.current });
      });
    return () => controller.abort();
  }, [api, id, tick]);

  return { load, retry: useCallback(() => setTick((t) => t + 1), []) };
}

const LINK_STATE_TEXT: Record<KnowledgeLinkState, string> = {
  pending: "Not linked yet",
  linked: "Linked",
  failed: "Linking failed"
};

export interface KnowledgePanelProps {
  api: KnowledgePanelApi | null;
  selection: KnowledgeSelection;
  collections: readonly KnowledgeCollectionView[];
  onSelect: (selection: KnowledgeSelection, options?: KnowledgeSelectOptions) => void;
  onClose: () => void;
  /** Shown when there is somewhere to go back to. */
  onBack?: () => void;
  /** The item as last read (null while none is), e.g. for the canvas to mark an entry's concepts. */
  onItem?: (item: KnowledgeItemResponse | null) => void;
  /** "More like this" on an entry: search for entries similar to it (hidden when absent). */
  onFindSimilar?: (entryId: string) => void;
  /** "Show its entries in Similarity" on a concept: mark them on the graph's Similarity layer (hidden when absent). */
  onShowConceptEntries?: (marks: ConceptMarks) => void;
}

export const KnowledgePanel: React.FC<KnowledgePanelProps> = ({
  api,
  selection,
  collections,
  onSelect,
  onClose,
  onBack,
  onItem,
  onFindSimilar,
  onShowConceptEntries
}) => {
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // The daemon answers a merged-away concept id with the concept kept in its place: the selection
  // takes the kept id (the graph selects, centres and marks by it), leaving no way Back to the old one.
  const resolved = useCallback((item: KnowledgeItemResponse, id: string) => {
    const current = selectionRef.current;
    if (item.kind !== "concept" || current.kind !== "concept" || current.id !== id) return;
    const kept = item.concept.concept.id;
    if (kept !== id) onSelectRef.current({ kind: "concept", id: kept }, { replace: true });
  }, []);
  const { load, retry } = useKnowledgeItem(api, selection.id, resolved);
  const item = load.status === "gone" ? null : load.item;
  const onItemRef = useRef(onItem);
  onItemRef.current = onItem;
  useEffect(() => onItemRef.current?.(item), [item]);
  const label = selection.kind === "entry" ? "Entry" : "Concept";

  // A merge that deletes the open entry moves to the kept one once done; until then its
  // "deleted" read is no news.
  const [merging, setMerging] = useState(false);
  const selectedId = useRef(selection.id);
  selectedId.current = selection.id;
  const merge = useCallback(
    async (plan: KnowledgeMergePlan) => {
      if (!api) throw new Error("Not connected.");
      const from = selectedId.current;
      setMerging(true);
      try {
        await mergeKnowledgeEntries(api, { ids: [plan.keep.id, plan.remove.id], keep: plan.keep.id });
        const kept = plan.keep.id;
        // Unless the user moved on meanwhile. The open entry is gone: Back must not lead to it.
        if (kept !== from && selectedId.current === from) onSelectRef.current({ kind: "entry", id: kept }, { replace: true });
      } finally {
        setMerging(false);
      }
    },
    [api]
  );

  return (
    <aside
      aria-label={`${label} details`}
      className="flex h-full w-full min-w-0 flex-col border-l border-neutral-800 bg-neutral-950"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
        {onBack && (
          <IconButton label="Back" onClick={onBack}>
            <ArrowLeft size={14} />
          </IconButton>
        )}
        <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-neutral-400">{label}</span>
        {load.status === "loading" && load.item && <Loader2 size={13} className="text-neutral-500 motion-safe:animate-spin" />}
        <IconButton label="Close panel" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {load.status === "gone" && merging ? (
          <div className="flex items-center gap-2 py-6 text-sm text-neutral-500">
            <Loader2 size={14} className="motion-safe:animate-spin" /> Merging…
          </div>
        ) : load.status === "gone" ? (
          <p className="py-6 text-center text-sm text-neutral-500">
            {selection.kind === "entry" ? "This entry was deleted." : "This concept is no longer in the graph."}
          </p>
        ) : !item ? (
          load.status === "error" ? (
            <div className="space-y-3 py-4">
              <ErrorLine>{load.message}</ErrorLine>
              <Button size="sm" variant="outline" onClick={retry}>
                <RefreshCw size={13} /> Retry
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 py-6 text-sm text-neutral-500">
              <Loader2 size={14} className="motion-safe:animate-spin" /> Loading…
            </div>
          )
        ) : (
          <>
            {load.status === "error" && <ErrorLine className="mb-3">{load.message}</ErrorLine>}
            {item.kind === "entry" ? (
              <EntryDetailView
                key={item.entry.entry.id}
                api={api}
                detail={item.entry}
                collections={collections}
                startEditing={selection.edit === true}
                onSelect={onSelect}
                onDeleted={onClose}
                onMerge={merge}
                onFindSimilar={onFindSimilar}
              />
            ) : (
              <ConceptDetailView
                key={item.concept.concept.id}
                api={api}
                detail={item.concept}
                collections={collections}
                onSelect={onSelect}
                onRefresh={retry}
                onShowEntries={onShowConceptEntries}
              />
            )}
          </>
        )}
      </div>
    </aside>
  );
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function CollectionChips({ ids, collections }: { ids: readonly string[]; collections: readonly KnowledgeCollectionView[] }) {
  const known = ids.map((id) => collections.find((c) => c.id === id)).filter((c): c is KnowledgeCollectionView => !!c);
  if (known.length === 0) return <CollectionChip name="Unfiled" color={null} />;
  return (
    <>
      {known.map((c) => (
        <CollectionChip key={c.id} name={c.name} color={c.color} title={c.description || undefined} />
      ))}
    </>
  );
}

/** Open post / Edit / Delete for one entry, with the delete confirmation. */
const EntryActions: React.FC<{
  api: KnowledgeApi | null;
  entry: Pick<KnowledgeEntrySummary, "id" | "title" | "url">;
  onEdit: () => void;
  onDeleted?: () => void;
  compact?: boolean;
}> = ({ api, entry, onEdit, onDeleted, compact }) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = entryPostUrl(entry);
  const remove = async () => {
    if (!api) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await deleteKnowledgeEntry(api, entry.id);
      onDeleted?.();
    } catch (err) {
      setError(knowledgeErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <div className={cn("flex flex-wrap items-center", compact ? "gap-1" : "gap-1.5")}>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800"
          >
            <ExternalLink size={12} /> Open post
          </a>
        )}
        <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
          <Pencil size={12} /> Edit
        </Button>
        <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setConfirming(true)} disabled={busy || !api}>
          {busy ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <Trash2 size={12} />} Delete
        </Button>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
      <ConfirmDialog
        open={confirming}
        title="Delete this entry?"
        message={`“${entry.title || "Untitled"}” is removed from the knowledge base, and its concepts from the graph at the next linking run. Chats can no longer find it.`}
        onConfirm={() => void remove()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
};

const EntryDetailView: React.FC<{
  api: KnowledgePanelApi | null;
  detail: KnowledgeEntryDetail;
  collections: readonly KnowledgeCollectionView[];
  startEditing: boolean;
  onSelect: (selection: KnowledgeSelection) => void;
  onDeleted: () => void;
  onMerge: (plan: KnowledgeMergePlan) => Promise<void>;
  onFindSimilar?: ((entryId: string) => void) | undefined;
}> = ({ api, detail, collections, startEditing, onSelect, onDeleted, onMerge, onFindSimilar }) => {
  const { entry } = detail;
  const [editing, setEditing] = useState(startEditing);
  useEffect(() => {
    if (startEditing) setEditing(true);
  }, [startEditing]);
  const byline = entryByline(entry);
  const date = entryDate(entry);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Eyebrow>
          {entry.kind} · {LINK_STATE_TEXT[entry.linkState]}
        </Eyebrow>
        <h2 className="text-base font-semibold leading-snug text-neutral-100">{entry.title || "Untitled"}</h2>
        {(byline || date) && <p className="text-xs text-neutral-400">{[byline, date].filter(Boolean).join(" · ")}</p>}
        <div className="flex flex-wrap gap-1 pt-0.5">
          <CollectionChips ids={entry.collections} collections={collections} />
        </div>
      </div>

      <DuplicatesBanner
        entry={entry}
        detail={detail}
        canMerge={api !== null}
        onOpen={(id) => onSelect({ kind: "entry", id })}
        onMerge={onMerge}
      />

      {editing ? (
        <KnowledgeEntryEditor api={api} entry={entry} collections={collections} onDone={() => setEditing(false)} />
      ) : (
        <>
          <EntryActions api={api} entry={entry} onEdit={() => setEditing(true)} onDeleted={onDeleted} />
          <EntryBody body={entry.body} />
        </>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-neutral-500">Saved</dt>
        <dd className="text-neutral-300">
          {formatKnowledgeDate(entry.savedAt) ?? "—"} {entry.savedFrom.by === "agent" ? "by an agent" : "by you"}
        </dd>
        {entry.url && (
          <>
            <dt className="text-neutral-500">URL</dt>
            <dd className="truncate text-neutral-300" title={entry.url}>
              {entry.url}
            </dd>
          </>
        )}
      </dl>

      <section>
        <SectionLabel>Concepts</SectionLabel>
        {detail.concepts.length === 0 ? (
          <p className="text-xs text-neutral-500">
            {entry.linkState === "linked" ? "No concepts were found in it." : "Its concepts appear once linking finishes."}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {detail.concepts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect({ kind: "concept", id: c.id })}
                className="rounded-full border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-600 hover:text-neutral-100"
                title={c.type}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
        <NoveltyLine novelty={detail.novelty} onOpenConcept={(id) => onSelect({ kind: "concept", id })} />
      </section>

      <Disagreements detail={detail} onOpen={(id) => onSelect({ kind: "entry", id })} onOpenConcept={(id) => onSelect({ kind: "concept", id })} />
      <SimilarEntries detail={detail} onOpen={(id) => onSelect({ kind: "entry", id })} onFindSimilar={onFindSimilar} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Concept
// ---------------------------------------------------------------------------

const ConceptDetailView: React.FC<{
  api: KnowledgePanelApi | null;
  detail: KnowledgeConceptDetail;
  collections: readonly KnowledgeCollectionView[];
  onSelect: (selection: KnowledgeSelection) => void;
  /** Read the concept again (a merge it lists is no longer in effect). */
  onRefresh: () => void;
  /** "Show its entries in Similarity" (hidden when absent). */
  onShowEntries?: ((marks: ConceptMarks) => void) | undefined;
}> = ({ api, detail, collections, onSelect, onRefresh, onShowEntries }) => {
  const { concept } = detail;
  const confidence = Math.round(Math.min(1, Math.max(0, concept.confidence)) * 100);
  // Every entry from `entryIds` (an older daemon: the newest 50 it details).
  const marks = conceptMarksOf(detail);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Eyebrow>
          {concept.type} · {confidence}% confidence
        </Eyebrow>
        <h2 className="text-base font-semibold leading-snug text-neutral-100">{concept.name}</h2>
        {concept.description && <p className="text-[13px] leading-relaxed text-neutral-300">{concept.description}</p>}
        {concept.aliases.length > 0 && <p className="text-xs text-neutral-500">Also: {concept.aliases.join(", ")}</p>}
        {detail.collections.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            <CollectionChips ids={detail.collections} collections={collections} />
          </div>
        )}
      </div>

      {onShowEntries && marks.entryIds.length > 0 && (
        <Button size="sm" variant="outline" className="max-w-full" onClick={() => onShowEntries(marks)}>
          <Sparkles size={12} className="shrink-0" /> <span className="truncate">Show its entries in Similarity</span>
        </Button>
      )}

      <section>
        <SectionLabel>Entries ({detail.entries.length})</SectionLabel>
        {detail.entries.length === 0 ? (
          <p className="text-xs text-neutral-500">No entry you can see is behind it.</p>
        ) : (
          <ul className="space-y-2">
            {detail.entries.map((entry) => (
              <li key={entry.id} className="space-y-1.5 rounded-md border border-neutral-800 px-3 py-2">
                <button type="button" className="block w-full text-left" onClick={() => onSelect({ kind: "entry", id: entry.id })}>
                  <span className="block text-xs font-medium text-neutral-200 hover:underline">{entry.title || "Untitled"}</span>
                  {entryByline(entry) && <span className="block text-[11px] text-neutral-500">{entryByline(entry)}</span>}
                </button>
                {entry.snippet && (
                  <blockquote className="border-l-2 border-neutral-700 pl-2 text-xs italic leading-relaxed text-neutral-400">
                    {entry.snippet}
                  </blockquote>
                )}
                <EntryActions api={api} entry={entry} compact onEdit={() => onSelect({ kind: "entry", id: entry.id, edit: true })} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionLabel>Linked to</SectionLabel>
        {detail.neighbors.length === 0 ? (
          <p className="text-xs text-neutral-500">No other concept.</p>
        ) : (
          <ul className="space-y-0.5">
            {detail.neighbors.map(({ edge, concept: other }) => (
              <li key={edge.id}>
                <button
                  type="button"
                  onClick={() => onSelect({ kind: "concept", id: other.id })}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-neutral-900"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">{other.name}</span>
                  {edge.type && <span className="shrink-0 text-[10.5px] text-neutral-500">{edge.type.replace(/_/g, " ").toLowerCase()}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SimilarConcepts detail={detail} onOpen={(id) => onSelect({ kind: "concept", id })} />
      <MergedFrom api={api} detail={detail} onRefresh={onRefresh} />
    </div>
  );
};
