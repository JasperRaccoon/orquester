// The Graph view's search box and its results dropdown: ↑/↓ move the highlight (wrapping),
// Enter opens the highlighted hit (the first by default), Escape closes the list and then
// clears the words. Entry hits show their match band, how they were found, and the query
// terms highlighted; "Show all N results" opens the List view on the same query.

import React, { useEffect, useId, useReducer, useRef } from "react";
import { ArrowRight, FileText, Loader2, Search, Waypoints, X } from "lucide-react";
import type { KnowledgeCollectionView, KnowledgeMatchBand, KnowledgeSearchHit, KnowledgeSearchResponse } from "@orquester/api";

import { cn } from "../../lib/cn";
import { ErrorLine } from "./parts";
import { entryByline, searchHitKey, viaBadges } from "./knowledge.logic";
import {
  bandLabel,
  highlightParts,
  readEntryMatch,
  SEARCH_NAV_EMPTY,
  searchNavReducer,
  showAllLabel
} from "./graph-search.logic";

export type GraphSearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "done"; answer: KnowledgeSearchResponse }
  | { status: "error"; message: string };

export interface GraphSearchBoxProps {
  text: string;
  onText: (text: string) => void;
  state: GraphSearchState;
  open: boolean;
  onOpen: (open: boolean) => void;
  collections: readonly KnowledgeCollectionView[];
  onPick: (hit: KnowledgeSearchHit) => void;
  /** "Show all N results" (hidden when absent). */
  onShowAll?: () => void;
  /** The collection chips the search is narrowed to (empty: all), for the "Show all" line's wording. */
  filter: readonly string[];
  /** The List view's filters or examples narrow the results too. */
  narrowed: boolean;
}

export const GraphSearchBox: React.FC<GraphSearchBoxProps> = ({ text, onText, state, open, onOpen, collections, onPick, onShowAll, filter, narrowed }) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();
  const hits = state.status === "done" ? state.answer.hits : null;
  const [nav, dispatch] = useReducer(searchNavReducer, SEARCH_NAV_EMPTY);
  useEffect(() => dispatch({ type: "results", count: hits?.length ?? 0 }), [hits]);
  const showing = open && text.trim() !== "";
  const optionId = (index: number) => `${listId}-option-${index}`;

  // Keep the highlighted option in view as the keyboard moves it.
  useEffect(() => {
    if (!showing || nav.index < 0) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${nav.index}"]`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [showing, nav.index]);

  // Clicking outside the search closes its results (the words stay, their concept hits stay marked).
  useEffect(() => {
    if (!showing) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showing, onOpen]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      // A search input clears itself on Escape (Chromium, Electron): the first press only closes the list.
      event.preventDefault();
      if (showing) onOpen(false);
      else onText("");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!text.trim()) return;
      event.preventDefault();
      // The first press on a closed list opens it on the first hit.
      if (!showing) onOpen(true);
      else dispatch({ type: event.key === "ArrowDown" ? "down" : "up" });
      return;
    }
    if (event.key === "Enter" && hits && hits.length > 0) {
      event.preventDefault();
      const hit = hits[nav.index >= 0 && nav.index < hits.length ? nav.index : 0];
      if (hit) onPick(hit);
    }
  };

  return (
    <div ref={rootRef} className="relative w-72 max-w-full max-md:w-full">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
      <input
        type="search"
        role="combobox"
        aria-label="Search the knowledge"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showing && hits && nav.index >= 0 && nav.index < hits.length ? optionId(nav.index) : undefined}
        placeholder="Search by meaning…"
        value={text}
        onChange={(e) => {
          onText(e.target.value);
          onOpen(true);
        }}
        onFocus={() => text.trim() && onOpen(true)}
        onKeyDown={onKeyDown}
        className="h-8 w-full rounded-md border border-neutral-700 bg-neutral-900 pl-8 pr-7 text-[13px] text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear the search"
          onClick={() => {
            onText("");
            onOpen(false);
          }}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-500 hover:text-neutral-200"
        >
          <X size={12} />
        </button>
      )}
      {showing && (
        <div className="absolute left-0 top-full z-30 mt-1 flex max-h-[60vh] w-[28rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl shadow-black/30">
          {narrowed && <p className="shrink-0 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-500">Narrowed by the List view's filters.</p>}
          <ul ref={listRef} id={listId} role="listbox" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto p-1">
            {state.status === "searching" || state.status === "idle" ? (
              <li role="presentation" className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500">
                <Loader2 size={12} className="motion-safe:animate-spin" /> Searching…
              </li>
            ) : state.status === "error" ? (
              <li role="presentation" className="px-3 py-2">
                <ErrorLine>{state.message}</ErrorLine>
              </li>
            ) : state.answer.hits.length === 0 ? (
              <li role="presentation" className="px-3 py-2 text-xs text-neutral-500">
                Nothing matches.
              </li>
            ) : (
              state.answer.hits.map((hit, index) => (
                <SearchOption
                  key={searchHitKey(hit)}
                  id={optionId(index)}
                  index={index}
                  hit={hit}
                  selected={index === nav.index}
                  collections={collections}
                  onPick={onPick}
                  onPoint={() => dispatch({ type: "point", index })}
                />
              ))
            )}
          </ul>
          {onShowAll && state.status === "done" && state.answer.hits.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onOpen(false);
                onShowAll();
              }}
              className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-800 px-3 py-2 text-left text-xs font-medium text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
            >
              {showAllLabel(state.answer, filter)}
              <ArrowRight size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const BAND_CLASS: Record<KnowledgeMatchBand, string> = {
  strong: "border-neutral-500 text-neutral-100",
  good: "border-neutral-700 text-neutral-300",
  weak: "border-neutral-800 text-neutral-500"
};

/** Text with the query terms marked; every part is rendered as text, never as HTML. */
const Highlighted: React.FC<{ text: string; terms: readonly string[] }> = ({ text, terms }) => (
  <>
    {highlightParts(text, terms).map((part, i) =>
      part.hit ? (
        <mark key={i} className="rounded-sm bg-warn-500/20 text-warn-300">
          {part.text}
        </mark>
      ) : (
        <React.Fragment key={i}>{part.text}</React.Fragment>
      )
    )}
  </>
);

const SearchOption: React.FC<{
  id: string;
  index: number;
  hit: KnowledgeSearchHit;
  selected: boolean;
  collections: readonly KnowledgeCollectionView[];
  onPick: (hit: KnowledgeSearchHit) => void;
  onPoint: () => void;
}> = ({ id, index, hit, selected, collections, onPick, onPoint }) => {
  const match = readEntryMatch(hit);
  const terms = match?.terms ?? [];
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      data-index={index}
      // Keep the focus in the search field (its keyboard drives the list).
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onPoint}
      onClick={() => onPick(hit)}
      className={cn("flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-left", selected ? "bg-neutral-800" : "hover:bg-neutral-800/60")}
    >
      {hit.kind === "entry" ? (
        <FileText size={13} className="mt-0.5 shrink-0 text-neutral-500" />
      ) : (
        <Waypoints size={13} className="mt-0.5 shrink-0 text-neutral-500" />
      )}
      <span className="min-w-0 flex-1">
        {hit.kind === "entry" ? (
          <>
            <span className="block truncate text-[13px] text-neutral-100">
              <Highlighted text={hit.entry.title || "Untitled"} terms={terms} />
            </span>
            {match && (
              <span className="mt-0.5 flex flex-wrap items-center gap-1">
                <span className={cn("rounded border px-1 text-[10px] font-medium leading-4", BAND_CLASS[match.band])}>{bandLabel(match.band)}</span>
                {viaBadges(match).map((badge) => (
                  <span key={badge.key} className="max-w-[10rem] truncate rounded bg-neutral-800 px-1 text-[10px] leading-4 text-neutral-400">
                    {badge.label}
                  </span>
                ))}
              </span>
            )}
            <span className="block truncate text-[11px] text-neutral-500">
              {[entryByline(hit.entry), ...hit.entry.collections.map((cid) => collections.find((c) => c.id === cid)?.name).filter(Boolean)].filter(Boolean).join(" · ")}
            </span>
            {hit.entry.snippet && (
              <span className="line-clamp-2 block text-xs text-neutral-400">
                <Highlighted text={hit.entry.snippet} terms={terms} />
              </span>
            )}
          </>
        ) : (
          <>
            <span className="block truncate text-[13px] text-neutral-100">{hit.concept.name}</span>
            <span className="block truncate text-[11px] text-neutral-500">
              {hit.concept.type}
              {hit.concept.description ? ` · ${hit.concept.description}` : ""}
            </span>
            {hit.entries && hit.entries.length > 0 && (
              <span className="block truncate text-[11px] text-neutral-500">In: {hit.entries.map((e) => e.title || "Untitled").join(", ")}</span>
            )}
          </>
        )}
      </span>
    </li>
  );
};
