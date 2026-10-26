// The Knowledge view's list view: collections down the left (All, each one with
// its entry count and the Agent Profiles that see it, Unfiled, "+ New
// collection"), the entries of the chosen one as cards, newest first, paged.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Inbox, Link2, Loader2, Pencil, Plus, RefreshCw } from "lucide-react";
import type { KnowledgeCollectionView, KnowledgeCollectionsResponse, KnowledgeEntriesQuery, KnowledgeEntriesResponse, KnowledgeEntrySummary } from "@orquester/api";

import { Button, IconButton } from "../ui";
import { cn } from "../../lib/cn";
import { knowledgeStore } from "../../lib/knowledge/store";
import { CollectionChip, CollectionDot, ErrorLine } from "./parts";
import { collectionProfilesText, entryByline, entryDate, knowledgeErrorText } from "./knowledge.logic";
import type { KnowledgeSelection } from "./KnowledgePanel";

/** "all", "unfiled" or a collection id. */
export type ListCollection = string;

export interface KnowledgeListApi {
  listKnowledgeEntries(query?: KnowledgeEntriesQuery, signal?: AbortSignal): Promise<KnowledgeEntriesResponse>;
}

const PAGE = 50;

type Page = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; entries: KnowledgeEntrySummary[]; nextCursor: string | null };

/**
 * The entries of one collection. Whenever entries change they are read again
 * as deep as the user had paged ("Load more"), so loaded cards never drop away.
 */
function useEntries(api: KnowledgeListApi | null, collection: ListCollection) {
  const [page, setPage] = useState<Page>({ status: "loading" });
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const shown = useRef(collection);
  /** Pages shown (the first one plus each "Load more"); a refetch reads as many. */
  const depth = useRef(1);

  useEffect(
    () =>
      knowledgeStore.subscribe((state, previous) => {
        if (state.entriesRevision !== previous.entriesRevision) setTick((t) => t + 1);
      }),
    []
  );

  useEffect(() => {
    if (!api) return;
    const mine = ++seq.current;
    const controller = new AbortController();
    // A refetch keeps the cards up; a different collection starts from a spinner.
    if (shown.current !== collection) {
      shown.current = collection;
      depth.current = 1;
      setPage({ status: "loading" });
    } else setPage((p) => (p.status === "ready" ? p : { status: "loading" }));
    setMore({ busy: false, error: null });
    const wanted = depth.current;
    const query = collection === "all" ? undefined : collection;
    void (async () => {
      const entries: KnowledgeEntrySummary[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const answer: KnowledgeEntriesResponse = await api.listKnowledgeEntries(
          { collection: query, limit: PAGE, ...(cursor ? { cursor } : {}) },
          controller.signal
        );
        for (const entry of answer.entries) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          entries.push(entry);
        }
        cursor = answer.nextCursor;
        pages += 1;
      } while (cursor && pages < wanted && mine === seq.current && !controller.signal.aborted);
      if (mine !== seq.current || controller.signal.aborted) return;
      depth.current = Math.max(1, pages);
      setPage({ status: "ready", entries, nextCursor: cursor });
    })().catch((error: unknown) => {
      if (mine === seq.current && !controller.signal.aborted) setPage({ status: "error", message: knowledgeErrorText(error) });
    });
    return () => controller.abort();
  }, [api, collection, tick]);

  const loadMore = useCallback(async () => {
    if (!api || page.status !== "ready" || !page.nextCursor || more.busy) return;
    const mine = seq.current;
    setMore({ busy: true, error: null });
    try {
      const answer = await api.listKnowledgeEntries({
        collection: collection === "all" ? undefined : collection,
        cursor: page.nextCursor,
        limit: PAGE
      });
      if (mine !== seq.current) return;
      depth.current += 1;
      setPage((p) => {
        if (p.status !== "ready") return p;
        const seen = new Set(p.entries.map((e) => e.id));
        return { status: "ready", entries: [...p.entries, ...answer.entries.filter((e) => !seen.has(e.id))], nextCursor: answer.nextCursor };
      });
      setMore({ busy: false, error: null });
    } catch (error) {
      if (mine === seq.current) setMore({ busy: false, error: knowledgeErrorText(error) });
    }
  }, [api, collection, page, more.busy]);

  return { page, more, loadMore, retry: () => setTick((t) => t + 1) };
}

const CollectionRow: React.FC<{
  name: string;
  count: number;
  /** The dot's colour (null: neutral); absent: no dot. */
  color?: KnowledgeCollectionView["color"] | null;
  profiles?: string | null;
  active: boolean;
  onClick: () => void;
  onEdit?: () => void;
}> = ({ name, count, color, profiles, active, onClick, onEdit }) => (
  <li className="group relative">
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
        active ? "bg-neutral-800/80 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"
      )}
    >
      {color !== undefined && <CollectionDot color={color} className="mt-1.5" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{name}</span>
        {profiles && <span className="block truncate text-[10.5px] text-neutral-500" title={profiles}>{profiles}</span>}
      </span>
      <span className={cn("mt-px shrink-0 text-[11px] tabular-nums text-neutral-500", onEdit ? "group-focus-within:invisible group-hover:invisible" : null)}>{count}</span>
    </button>
    {/* Faded, not `invisible`: a hidden button could never take keyboard focus. */}
    {onEdit && (
      <IconButton label={`Edit ${name}`} onClick={onEdit} className="absolute right-0.5 top-0.5 h-6 w-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100">
        <Pencil size={12} />
      </IconButton>
    )}
  </li>
);

const EntryCard: React.FC<{
  entry: KnowledgeEntrySummary;
  collections: readonly KnowledgeCollectionView[];
  selected: boolean;
  onSelect: () => void;
}> = ({ entry, collections, selected, onSelect }) => {
  const byline = entryByline(entry);
  const date = entryDate(entry);
  const chips = entry.collections.map((id) => collections.find((c) => c.id === id)).filter((c): c is KnowledgeCollectionView => !!c);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "w-full space-y-1.5 rounded-lg border px-3.5 py-3 text-left transition-colors",
          selected ? "border-neutral-600 bg-neutral-900" : "border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/60"
        )}
      >
        <span className="block text-[13px] font-medium leading-snug text-neutral-100">{entry.title || "Untitled"}</span>
        {(byline || date) && <span className="block text-[11.5px] text-neutral-500">{[byline, date].filter(Boolean).join(" · ")}</span>}
        {entry.snippet && <span className="line-clamp-2 block text-xs leading-relaxed text-neutral-400">{entry.snippet}</span>}
        <span className="flex flex-wrap items-center gap-1 pt-0.5">
          {chips.length === 0 ? <CollectionChip name="Unfiled" color={null} /> : chips.map((c) => <CollectionChip key={c.id} name={c.name} color={c.color} />)}
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-neutral-500">
            {entry.linkState === "pending" ? (
              "Not linked yet"
            ) : entry.linkState === "failed" ? (
              <span className="text-warn">Linking failed</span>
            ) : (
              <>
                <Link2 size={11} /> {entry.linkCount} {entry.linkCount === 1 ? "link" : "links"}
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  );
};

export interface KnowledgeListViewProps {
  api: KnowledgeListApi | null;
  collections: KnowledgeCollectionsResponse | null;
  collection: ListCollection;
  onCollection: (collection: ListCollection) => void;
  selection: KnowledgeSelection | null;
  onSelect: (selection: KnowledgeSelection) => void;
  onNewCollection: () => void;
  onEditCollection: (collection: KnowledgeCollectionView) => void;
  /** The Graph / List toggle, at the end of the top bar. */
  toolbarEnd: React.ReactNode;
}

export const KnowledgeListView: React.FC<KnowledgeListViewProps> = ({
  api,
  collections,
  collection,
  onCollection,
  selection,
  onSelect,
  onNewCollection,
  onEditCollection,
  toolbarEnd
}) => {
  const { page, more, loadMore, retry } = useEntries(api, collection);
  const list = collections?.collections ?? [];
  const current = list.find((c) => c.id === collection);
  const heading = collection === "all" ? "All entries" : collection === "unfiled" ? "Unfiled" : (current?.name ?? "Collection");

  return (
    <div className="flex h-full min-h-0 w-full">
      <nav aria-label="Collections" className="flex w-56 shrink-0 flex-col border-r border-neutral-800 max-sm:w-40">
        <div className="flex h-11 shrink-0 items-center px-3 text-[11px] font-medium uppercase tracking-wide text-neutral-500">Collections</div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
          <CollectionRow name="All" count={collections?.totalEntries ?? 0} active={collection === "all"} onClick={() => onCollection("all")} />
          {list.map((c) => (
            <CollectionRow
              key={c.id}
              name={c.name}
              count={c.entryCount}
              color={c.color}
              profiles={collectionProfilesText(c)}
              active={collection === c.id}
              onClick={() => onCollection(c.id)}
              onEdit={() => onEditCollection(c)}
            />
          ))}
          <CollectionRow name="Unfiled" count={collections?.unfiledCount ?? 0} color={null} profiles="Global chats only" active={collection === "unfiled"} onClick={() => onCollection("unfiled")} />
        </ul>
        <div className="shrink-0 border-t border-neutral-800 p-1.5">
          <Button size="sm" variant="ghost" className="w-full justify-start" onClick={onNewCollection}>
            <Plus size={13} /> New collection
          </Button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-800 px-4">
          <h2 className="min-w-0 truncate text-sm font-medium text-neutral-100">{heading}</h2>
          {current?.description && <span className="hidden min-w-0 truncate text-xs text-neutral-500 md:inline">{current.description}</span>}
          <span className="flex-1" />
          {toolbarEnd}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {page.status === "loading" ? (
            <div className="flex items-center gap-2 py-8 text-sm text-neutral-500">
              <Loader2 size={14} className="motion-safe:animate-spin" /> Loading entries…
            </div>
          ) : page.status === "error" ? (
            <div className="space-y-3 py-6">
              <ErrorLine>{page.message}</ErrorLine>
              <Button size="sm" variant="outline" onClick={retry}>
                <RefreshCw size={13} /> Retry
              </Button>
            </div>
          ) : page.entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-500">
                <Inbox size={18} />
              </span>
              <p className="text-sm text-neutral-300">{collection === "all" ? "No entries yet" : "No entries here"}</p>
              <p className="max-w-sm text-xs leading-relaxed text-neutral-500">
                Paste a post into any chat and ask the agent to add it to the knowledge.
              </p>
            </div>
          ) : (
            <>
              <ul className="mx-auto max-w-3xl space-y-2">
                {page.entries.map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    collections={list}
                    selected={selection?.kind === "entry" && selection.id === entry.id}
                    onSelect={() => onSelect({ kind: "entry", id: entry.id })}
                  />
                ))}
              </ul>
              {(page.nextCursor || more.error) && (
                <div className="mx-auto flex max-w-3xl flex-col items-center gap-2 py-3">
                  {more.error && <ErrorLine>{more.error}</ErrorLine>}
                  {page.nextCursor && (
                    <Button size="sm" variant="outline" onClick={() => void loadMore()} disabled={more.busy}>
                      {more.busy && <Loader2 size={12} className="motion-safe:animate-spin" />} Load more
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
