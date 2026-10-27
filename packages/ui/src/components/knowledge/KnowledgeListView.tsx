// The Knowledge view's list view: collections down the left (All, each one with
// its entry count and the Agent Profiles that see it, Unfiled, "+ New
// collection"); on the right the query bar (search, filters, sort) over either
// the chosen collection's entries, newest first, paged — with a "Rediscover"
// strip above them — or, while searching, the search's hits, explained and paged.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Inbox, Loader2, Pencil, Plus, RefreshCw, SearchX } from "lucide-react";
import type {
  KnowledgeCollectionView,
  KnowledgeCollectionsResponse,
  KnowledgeEntriesQuery,
  KnowledgeEntriesResponse,
  KnowledgeEntrySummary,
  KnowledgeItemResponse,
  KnowledgeSearchHit,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse
} from "@orquester/api";

import { Button, IconButton } from "../ui";
import { cn } from "../../lib/cn";
import { knowledgeStore } from "../../lib/knowledge/store";
import { CollectionChip, CollectionDot, ErrorLine, PHONE_CHIP, PHONE_CHIP_ROW } from "./parts";
import {
  appendPage,
  collectionProfilesText,
  entriesKeyOf,
  entriesQueryOf,
  knowledgeErrorText,
  missingExamplesOf,
  rediscoverEntries,
  rediscoverRequestOf,
  rediscoverSeeds,
  resultsCountText,
  searchHitKey,
  searchKeyOf,
  searchPageOf,
  searchRequestOf,
  type PageAnswer,
  type Pages
} from "./knowledge.logic";
import { hasFilters, isSearching, withUnlike, type KnowledgeQuery } from "./query-state";
import { KnowledgeQueryBar, type KnowledgeFacetsApi } from "./KnowledgeQueryBar";
import { ConceptHitCard, EntryCard, RESULT_ATTRIBUTE, RediscoverStrip } from "./KnowledgeResultCards";
import type { KnowledgeSelection } from "./KnowledgePanel";

/** "all", "unfiled" or a collection id. */
export type ListCollection = string;

/** The routes the list reads. `ApiClient` satisfies it. */
export interface KnowledgeListApi extends KnowledgeFacetsApi {
  listKnowledgeEntries(query?: KnowledgeEntriesQuery, signal?: AbortSignal): Promise<KnowledgeEntriesResponse>;
  searchKnowledge(req: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResponse>;
  getKnowledgeItem(id: string, signal?: AbortSignal): Promise<KnowledgeItemResponse>;
}

type Paged<T> = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & Pages<T>);

/** Bumps whenever entries change (the store's `entriesRevision`): what shows them reads again. */
function useEntriesRevision(): number {
  const [tick, setTick] = useState(0);
  useEffect(
    () =>
      knowledgeStore.subscribe((state, previous) => {
        if (state.entriesRevision !== previous.entriesRevision) setTick((t) => t + 1);
      }),
    []
  );
  return tick;
}

/**
 * Pages of a list (entries, or a search's hits) identified by `key` (null: not shown — nothing is
 * read and what was read is kept). Whenever entries change it is read again as deep as the user had
 * paged ("Load more"), so loaded cards never drop away; a different key starts from a spinner.
 * "Load more" waits while such a refetch is in flight (`refetching`): its answer replaces the list,
 * so a page loaded meanwhile would drop away again.
 */
function usePaged<T>(
  key: string | null,
  read: ((cursor: string | null, signal?: AbortSignal) => Promise<PageAnswer<T>>) | null,
  idOf: (item: T) => string,
  /** A failure the caller mends by changing what is read (so `key` moves): true when it did, and no error shows. */
  recover?: (error: unknown) => boolean
) {
  const [page, setPage] = useState<Paged<T>>({ status: "loading" });
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [refetching, setRefetching] = useState(false);
  const revision = useEntriesRevision();
  const [retries, setRetries] = useState(0);
  const seq = useRef(0);
  const shown = useRef<string | null>(null);
  /** Pages shown (the first one plus each "Load more"); a refetch reads as many. */
  const depth = useRef(1);
  /** A "Load more" in flight: a refetch starting meanwhile drops its answer, so it reads that page too. */
  const loadingMore = useRef(false);
  const readRef = useRef(read);
  readRef.current = read;
  const idOfRef = useRef(idOf);
  idOfRef.current = idOf;
  const recoverRef = useRef(recover);
  recoverRef.current = recover;
  const ready = read !== null;

  useEffect(() => {
    const reader = readRef.current;
    if (key === null || !reader) return;
    const mine = ++seq.current;
    const controller = new AbortController();
    // A refetch keeps the cards up; something else to show starts from a spinner.
    if (shown.current !== key) {
      shown.current = key;
      depth.current = 1;
      setPage({ status: "loading" });
    } else setPage((p) => (p.status === "ready" ? p : { status: "loading" }));
    setMore({ busy: false, error: null });
    setRefetching(true);
    const wanted = depth.current + (loadingMore.current ? 1 : 0);
    loadingMore.current = false;
    void (async () => {
      let pages: Pages<T> | null = null;
      let count = 0;
      do {
        const answer = await reader(pages?.nextCursor ?? null, controller.signal);
        pages = appendPage(pages, answer, idOfRef.current);
        count += 1;
      } while (pages.nextCursor && count < wanted && mine === seq.current && !controller.signal.aborted);
      if (mine !== seq.current || controller.signal.aborted) return;
      depth.current = Math.max(1, count);
      setPage({ status: "ready", ...pages });
      setRefetching(false);
    })().catch((error: unknown) => {
      if (mine !== seq.current || controller.signal.aborted) return;
      if (recoverRef.current?.(error)) return;
      setPage({ status: "error", message: knowledgeErrorText(error) });
      setRefetching(false);
    });
    return () => controller.abort();
  }, [key, ready, revision, retries]);

  const loadMore = useCallback(async () => {
    const reader = readRef.current;
    if (!reader || page.status !== "ready" || !page.nextCursor || more.busy || refetching) return;
    const mine = seq.current;
    setMore({ busy: true, error: null });
    loadingMore.current = true;
    try {
      const answer = await reader(page.nextCursor);
      if (mine !== seq.current) return;
      depth.current += 1;
      setPage((p) => (p.status === "ready" ? { status: "ready", ...appendPage(p, answer, idOfRef.current) } : p));
      setMore({ busy: false, error: null });
    } catch (error) {
      if (mine === seq.current && !recoverRef.current?.(error)) setMore({ busy: false, error: knowledgeErrorText(error) });
    } finally {
      if (mine === seq.current) loadingMore.current = false;
    }
  }, [page, more.busy, refetching]);

  return { page, more, refetching, loadMore, retry: () => setRetries((r) => r + 1) };
}

/** Rediscover is dismissed for the rest of the app session (all Knowledge views). */
let rediscoverDismissed = false;

/** "Rediscover": older entries like the ones saved this week; null while hidden. */
function useRediscover(api: KnowledgeListApi | null, seeds: readonly string[], collection: ListCollection, enabled: boolean): KnowledgeEntrySummary[] | null {
  const [entries, setEntries] = useState<KnowledgeEntrySummary[] | null>(null);
  const revision = useEntriesRevision();
  const request = enabled ? rediscoverRequestOf(seeds, collection, Date.now()) : null;
  const key = request ? JSON.stringify(request) : null;
  useEffect(() => {
    if (!api || !request) {
      setEntries(null);
      return;
    }
    const controller = new AbortController();
    const seedList = request.similarTo ?? [];
    api
      .searchKnowledge(request, controller.signal)
      .then((answer) => {
        if (!controller.signal.aborted) setEntries(rediscoverEntries(answer, seedList));
      })
      // An older daemon (no example search), or anything else: the strip stays hidden.
      .catch(() => {
        if (!controller.signal.aborted) setEntries(null);
      });
    return () => controller.abort();
    // `key` stands for `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, revision]);
  return key === null ? null : entries;
}

/**
 * Titles for the "More like this" examples: those of cards already read, else read once each
 * (undefined while unknown, null when the entry cannot be read).
 */
function useExampleTitles(api: KnowledgeListApi | null, ids: readonly string[], known: ReadonlyMap<string, string>) {
  const [read, setRead] = useState<Record<string, string | null>>({});
  const asked = useRef(new Set<string>());
  const idsKey = ids.join(",");
  // Entries changed: their titles are read again (an edit renames the chip).
  const revision = useEntriesRevision();
  useEffect(() => {
    const changed = knowledgeStore.getState().changedEntryIds;
    for (const id of [...asked.current]) if (changed === null || changed.includes(id)) asked.current.delete(id);
  }, [revision]);
  useEffect(() => {
    if (!api) return;
    for (const id of ids) {
      if (known.has(id) || asked.current.has(id)) continue;
      asked.current.add(id);
      api
        .getKnowledgeItem(id)
        .then((item) => setRead((r) => ({ ...r, [id]: item.kind === "entry" ? item.entry.entry.title : item.concept.concept.name })))
        .catch(() => setRead((r) => ({ ...r, [id]: null })));
    }
    // `idsKey` stands for `ids`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, idsKey, known, revision]);
  const remember = useCallback((id: string, title: string) => setRead((r) => ({ ...r, [id]: title })), []);
  const titleOf = useCallback((id: string): string | null | undefined => known.get(id) ?? read[id], [known, read]);
  return { titleOf, remember };
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

const EmptyResults: React.FC<{ icon: React.ReactNode; title: string; hint: string }> = ({ icon, title, hint }) => (
  <div className="flex flex-col items-center gap-2 py-12 text-center">
    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-500">{icon}</span>
    <p className="text-sm text-neutral-300">{title}</p>
    <p className="max-w-sm text-xs leading-relaxed text-neutral-500">{hint}</p>
  </div>
);

const MoreButton: React.FC<{
  nextCursor: string | null;
  more: { busy: boolean; error: string | null };
  /** A refetch of the list is in flight: its answer replaces the list, so no page is added meanwhile. */
  waiting: boolean;
  onMore: () => void;
}> = ({ nextCursor, more, waiting, onMore }) =>
  nextCursor || more.error ? (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-2 py-3">
      {more.error && <ErrorLine>{more.error}</ErrorLine>}
      {nextCursor && (
        <Button size="sm" variant="outline" onClick={onMore} disabled={more.busy || waiting}>
          {more.busy && <Loader2 size={12} className="motion-safe:animate-spin" />} Load more
        </Button>
      )}
    </div>
  ) : null;

const entryId = (entry: KnowledgeEntrySummary) => entry.id;

export interface KnowledgeListViewProps {
  api: KnowledgeListApi | null;
  collections: KnowledgeCollectionsResponse | null;
  collection: ListCollection;
  onCollection: (collection: ListCollection) => void;
  /** What the list searches for (owned by KnowledgeView, shared with the Graph view and the panel). */
  query: KnowledgeQuery;
  onQueryChange: (query: KnowledgeQuery) => void;
  /**
   * The search was refused because example entries are gone (deleted): let go of them (the query
   * moves on). Absent: the refusal shows as an error.
   */
  onExamplesGone?: (ids: string[]) => void;
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
  query,
  onQueryChange,
  onExamplesGone,
  selection,
  onSelect,
  onNewCollection,
  onEditCollection,
  toolbarEnd
}) => {
  const searching = isSearching(query);
  const filtered = hasFilters(query);

  const entries = usePaged<KnowledgeEntrySummary>(
    searching ? null : entriesKeyOf(collection, query.filters),
    api ? (cursor, signal) => api.listKnowledgeEntries(entriesQueryOf(collection, query.filters, { cursor }), signal).then((a) => ({ items: a.entries, nextCursor: a.nextCursor })) : null,
    entryId
  );
  const search = usePaged<KnowledgeSearchHit>(
    searching ? searchKeyOf(query, collection) : null,
    api ? (cursor, signal) => api.searchKnowledge(searchRequestOf(query, collection, { cursor }), signal).then(searchPageOf) : null,
    searchHitKey,
    // An example entry deleted: let go of it (nothing left to search: the plain list) rather than
    // asking again, forever, for a search the daemon must refuse.
    (error) => {
      const missing = onExamplesGone ? missingExamplesOf(error, query) : null;
      if (!missing || !onExamplesGone) return false;
      onExamplesGone(missing);
      return true;
    }
  );

  // Rediscover: seeded by this week's entries at the top of the plain, unfiltered list.
  const firstEntries = !searching && !filtered && entries.page.status === "ready" ? entries.page.items : null;
  const seeds = useMemo(() => (firstEntries ? rediscoverSeeds(firstEntries, Date.now()) : []), [firstEntries]);
  const [dismissed, setDismissed] = useState(rediscoverDismissed);
  const rediscover = useRediscover(api, seeds, collection, !searching && !filtered && !dismissed);

  // Titles of every card read so far, for the "Like: …" chips.
  const known = useMemo(() => {
    const titles = new Map<string, string>();
    if (entries.page.status === "ready") for (const e of entries.page.items) titles.set(e.id, e.title);
    if (search.page.status === "ready") {
      for (const hit of search.page.items) {
        if (hit.kind === "entry") titles.set(hit.entry.id, hit.entry.title);
        else for (const e of hit.entries ?? []) titles.set(e.id, e.title);
      }
    }
    for (const e of rediscover ?? []) titles.set(e.id, e.title);
    return titles;
  }, [entries.page, search.page, rediscover]);
  const exampleIds = useMemo(() => [...query.similarTo, ...query.unlike], [query.similarTo, query.unlike]);
  const { titleOf, remember } = useExampleTitles(api, exampleIds, known);

  const list = collections?.collections ?? [];
  const current = list.find((c) => c.id === collection);
  const heading = collection === "all" ? "All entries" : collection === "unfiled" ? "Unfiled" : (current?.name ?? "Collection");
  const selectedEntry = selection?.kind === "entry" ? selection.id : null;

  // Keyboard: ↓ from the search box to the first result, ↑/↓ between results (↑ from the first back
  // to the box), Enter opens (the card is a button), Esc in the box clears it.
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const resultsId = useId();
  const results = () => [...(resultsRef.current?.querySelectorAll<HTMLElement>(`[${RESULT_ATTRIBUTE}]`) ?? [])];
  const focusFirstResult = () => results()[0]?.focus();
  const onResultsKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const all = results();
    const index = all.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === "ArrowDown") all[Math.min(index + 1, all.length - 1)]?.focus();
    else if (index === 0) inputRef.current?.focus();
    else all[index - 1]?.focus();
  };

  const page = searching ? search.page : entries.page;
  const retry = searching ? search.retry : entries.retry;

  let body: React.ReactNode;
  if (page.status === "loading") {
    body = (
      <div className="flex items-center gap-2 py-8 text-sm text-neutral-500">
        <Loader2 size={14} className="motion-safe:animate-spin" /> {searching ? "Searching…" : "Loading entries…"}
      </div>
    );
  } else if (page.status === "error") {
    body = (
      <div className="space-y-3 py-6">
        <ErrorLine>{page.message}</ErrorLine>
        <Button size="sm" variant="outline" onClick={retry}>
          <RefreshCw size={13} /> Retry
        </Button>
      </div>
    );
  } else if (searching && search.page.status === "ready") {
    const hits = search.page.items;
    body = (
      <>
        <p aria-live="polite" className="mx-auto mb-2 max-w-3xl text-[11.5px] text-neutral-500">
          {resultsCountText(search.page.total, hits.length)}
        </p>
        {hits.length === 0 ? (
          <EmptyResults icon={<SearchX size={18} />} title="No results" hint="Try other words, fewer filters, or another collection." />
        ) : (
          <ul id={resultsId} ref={resultsRef} aria-label="Search results" onKeyDown={onResultsKeyDown} className="mx-auto max-w-3xl space-y-2">
            {hits.map((hit) =>
              hit.kind === "entry" ? (
                <EntryCard
                  key={searchHitKey(hit)}
                  entry={hit.entry}
                  collections={list}
                  selected={selectedEntry === hit.entry.id}
                  onSelect={() => onSelect({ kind: "entry", id: hit.entry.id })}
                  match={hit.match}
                  onLessLike={
                    query.similarTo.length > 0
                      ? () => {
                          remember(hit.entry.id, hit.entry.title);
                          onQueryChange(withUnlike(query, hit.entry.id));
                        }
                      : undefined
                  }
                />
              ) : (
                <ConceptHitCard
                  key={searchHitKey(hit)}
                  hit={hit}
                  selected={selection?.kind === "concept" && selection.id === hit.concept.id}
                  onSelect={() => onSelect({ kind: "concept", id: hit.concept.id })}
                />
              )
            )}
          </ul>
        )}
        <MoreButton nextCursor={search.page.nextCursor} more={search.more} waiting={search.refetching} onMore={() => void search.loadMore()} />
      </>
    );
  } else if (entries.page.status === "ready") {
    const items = entries.page.items;
    body = (
      <>
        {rediscover && !filtered && (
          <RediscoverStrip
            entries={rediscover}
            selectedId={selectedEntry}
            onSelect={(id) => onSelect({ kind: "entry", id })}
            onDismiss={() => {
              rediscoverDismissed = true;
              setDismissed(true);
            }}
          />
        )}
        {items.length === 0 ? (
          filtered ? (
            <EmptyResults icon={<SearchX size={18} />} title="No entries match these filters" hint="Choose other values, or Clear the filters." />
          ) : (
            <EmptyResults
              icon={<Inbox size={18} />}
              title={collection === "all" ? "No entries yet" : "No entries here"}
              hint="Paste a post into any chat and ask the agent to add it to the knowledge."
            />
          )
        ) : (
          <ul id={resultsId} ref={resultsRef} aria-label="Entries" onKeyDown={onResultsKeyDown} className="mx-auto max-w-3xl space-y-2">
            {items.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                collections={list}
                selected={selectedEntry === entry.id}
                onSelect={() => onSelect({ kind: "entry", id: entry.id })}
              />
            ))}
          </ul>
        )}
        <MoreButton nextCursor={entries.page.nextCursor} more={entries.more} waiting={entries.refetching} onMore={() => void entries.loadMore()} />
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* On a phone the sidebar gives way to a row of collection chips under the top bar. */}
      <nav aria-label="Collections" className="flex w-56 shrink-0 flex-col border-r border-neutral-800 max-md:hidden">
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
          {/* The sidebar's edit button, where the sidebar is hidden. */}
          {current && (
            <IconButton label={`Edit ${current.name}`} onClick={() => onEditCollection(current)} className="h-8 w-8 shrink-0 md:hidden">
              <Pencil size={13} />
            </IconButton>
          )}
          <span className="flex-1" />
          <div className="flex shrink-0 items-center">{toolbarEnd}</div>
        </div>
        <div role="group" aria-label="Choose a collection" className={cn("flex shrink-0 items-center gap-1 border-b border-neutral-800 px-4 py-2 md:hidden", PHONE_CHIP_ROW)}>
          <CollectionChip name="All" color={null} dot={false} active={collection === "all"} onClick={() => onCollection("all")} className={PHONE_CHIP} />
          {list.map((c) => (
            <CollectionChip key={c.id} name={c.name} color={c.color} active={collection === c.id} onClick={() => onCollection(c.id)} className={PHONE_CHIP} />
          ))}
          <CollectionChip name="Unfiled" color={null} active={collection === "unfiled"} onClick={() => onCollection("unfiled")} className={PHONE_CHIP} />
          <button
            type="button"
            onClick={onNewCollection}
            className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border border-dashed border-neutral-700 px-3 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          >
            <Plus size={12} /> New collection
          </button>
        </div>
        <KnowledgeQueryBar
          api={api}
          collection={collection}
          query={query}
          onQueryChange={onQueryChange}
          titleOf={titleOf}
          onFocusResults={focusFirstResult}
          inputRef={inputRef}
          resultsId={resultsId}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{body}</div>
      </div>
    </div>
  );
};
