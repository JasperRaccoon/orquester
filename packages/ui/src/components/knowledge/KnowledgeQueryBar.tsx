// The List view's query bar: the search box (debounced), the Kind / Author / Year filter chips
// (multi-select popovers listing facet values with counts), the sort, "Clear", and a "More like
// this" query's examples as removable chips. It edits the view's `KnowledgeQuery`; nothing here
// reads results.

import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Search, X } from "lucide-react";
import type { KnowledgeFacetCount, KnowledgeFacetsRequest, KnowledgeFacetsResponse, KnowledgeSearchSort } from "@orquester/api";

import { Button, Dropdown } from "../ui";
import { SegmentedControl } from "../settings/primitives";
import { cn } from "../../lib/cn";
import { useKnowledgeState } from "../../lib/knowledge/store";
import { ErrorLine } from "./parts";
import {
  KNOWLEDGE_FACET_FIELDS,
  SORT_LABEL,
  clearFilterField,
  facetFieldLabel,
  facetsRequestOf,
  filterChipLabel,
  filterHas,
  knowledgeErrorCode,
  knowledgeErrorText,
  queryIsEmpty,
  shownSort,
  sortOptionsFor,
  toggleFilterValue,
  withoutExample,
  type KnowledgeFacetField
} from "./knowledge.logic";
import { EMPTY_KNOWLEDGE_QUERY, type KnowledgeQuery } from "./query-state";

export const SEARCH_DEBOUNCE_MS = 250;

export interface KnowledgeFacetsApi {
  getKnowledgeFacets(req: KnowledgeFacetsRequest, signal?: AbortSignal): Promise<KnowledgeFacetsResponse>;
}

type FacetLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; values: KnowledgeFacetCount[] };

/** One filter's values with their counts (read when its popover opens, and again when entries change). */
const FacetOptions: React.FC<{
  api: KnowledgeFacetsApi | null;
  collection: string;
  query: KnowledgeQuery;
  field: KnowledgeFacetField;
  onQueryChange: (query: KnowledgeQuery) => void;
}> = ({ api, collection, query, field, onQueryChange }) => {
  const [load, setLoad] = useState<FacetLoad>({ status: "loading" });
  const revision = useKnowledgeState((s) => s.entriesRevision);
  const request = facetsRequestOf(collection, query.filters, field);
  const key = JSON.stringify(request);
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    setLoad((l) => (l.status === "ready" ? l : { status: "loading" }));
    api
      .getKnowledgeFacets(request, controller.signal)
      .then((answer) => {
        if (!controller.signal.aborted) setLoad({ status: "ready", values: answer.facets[field] });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // An older daemon has no facets route.
        const status = (error as { status?: unknown } | null)?.status;
        const message = status === 404 && knowledgeErrorCode(error) === null ? "Filters need a newer Orquester server." : knowledgeErrorText(error);
        setLoad({ status: "error", message });
      });
    return () => controller.abort();
    // `key` stands for `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, field, revision]);

  const chosen = query.filters[field] ?? [];
  const listed = load.status === "ready" ? load.values : [];
  // A chosen value the counts no longer list (nothing left with it) stays, so it can be let go of.
  const missing = chosen.filter((value) => !listed.some((c) => filterHas({ [field]: [value] }, field, c.value)));
  const options: KnowledgeFacetCount[] = [...missing.map((value) => ({ value, label: value, count: 0 })), ...listed];

  return (
    <div className="space-y-1">
      {load.status === "loading" && options.length === 0 ? (
        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-neutral-500">
          <Loader2 size={12} className="motion-safe:animate-spin" /> Counting…
        </p>
      ) : load.status === "error" && options.length === 0 ? (
        <ErrorLine className="px-2 py-1.5">{load.message}</ErrorLine>
      ) : options.length === 0 ? (
        <p className="px-2 py-1.5 text-xs italic text-neutral-500">Nothing to filter by here.</p>
      ) : (
        <ul className="max-h-72 overflow-y-auto">
          {options.map((option) => {
            const on = filterHas(query.filters, field, option.value);
            return (
              <li key={option.value}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onQueryChange(toggleFilterValue(query, field, option.value))}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px]",
                    "focus:outline-none focus-visible:bg-neutral-800",
                    on ? "text-neutral-100" : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border", on ? "border-neutral-300 bg-neutral-200 text-neutral-900" : "border-neutral-600")}
                  >
                    {on && <Check size={10} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-neutral-500">{option.count}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {load.status === "error" && options.length > 0 && <ErrorLine className="px-2 py-1">{load.message}</ErrorLine>}
      {chosen.length > 0 && (
        <div className="border-t border-neutral-800 pt-1">
          <button
            type="button"
            onClick={() => onQueryChange(clearFilterField(query, field))}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:bg-neutral-800"
          >
            Any {facetFieldLabel(field).toLowerCase()}
          </button>
        </div>
      )}
    </div>
  );
};

const FilterChip: React.FC<{
  api: KnowledgeFacetsApi | null;
  collection: string;
  query: KnowledgeQuery;
  field: KnowledgeFacetField;
  onQueryChange: (query: KnowledgeQuery) => void;
}> = ({ api, collection, query, field, onQueryChange }) => {
  const active = (query.filters[field]?.length ?? 0) > 0;
  return (
    <Dropdown
      role="dialog"
      ariaLabel={`Filter by ${facetFieldLabel(field).toLowerCase()}`}
      focusOnOpen
      width="w-64"
      trigger={
        <span
          className={cn(
            "inline-flex max-w-[12rem] items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11.5px]",
            active ? "border-neutral-500 bg-neutral-800 text-neutral-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          )}
        >
          <span className="truncate">{filterChipLabel(field, query.filters)}</span>
          <ChevronDown size={11} className="shrink-0" />
        </span>
      }
    >
      <FacetOptions api={api} collection={collection} query={query} field={field} onQueryChange={onQueryChange} />
    </Dropdown>
  );
};

const ExampleChip: React.FC<{ label: string; title: string | null | undefined; onRemove: () => void }> = ({ label, title, onRemove }) => {
  const name = title === undefined ? "…" : title === null ? "an entry that cannot be read" : title || "Untitled";
  return (
    <span className="inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-neutral-700 bg-neutral-900 py-0.5 pl-2.5 pr-1 text-[11.5px] text-neutral-300">
      <span className="truncate">
        <span className="text-neutral-500">{label}</span> {name}
      </span>
      <button
        type="button"
        aria-label={`Remove “${label} ${name}”`}
        onClick={onRemove}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
      >
        <X size={10} />
      </button>
    </span>
  );
};

export interface KnowledgeQueryBarProps {
  api: KnowledgeFacetsApi | null;
  /** "all", "unfiled" or a collection id: the facets' narrowing. */
  collection: string;
  query: KnowledgeQuery;
  onQueryChange: (query: KnowledgeQuery) => void;
  /** An example entry's title: undefined while unknown, null when it cannot be read. */
  titleOf: (entryId: string) => string | null | undefined;
  /** ↓ in the search box: move to the first result. */
  onFocusResults: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
  /** The results list the search box controls. */
  resultsId: string;
}

export const KnowledgeQueryBar: React.FC<KnowledgeQueryBarProps> = ({ api, collection, query, onQueryChange, titleOf, onFocusResults, inputRef, resultsId }) => {
  // The box answers every keystroke; the query (and so the search) follows 250 ms after the last.
  const [text, setText] = useState(query.text);
  const sent = useRef(query.text);
  const queryRef = useRef(query);
  queryRef.current = query;
  const onChangeRef = useRef(onQueryChange);
  onChangeRef.current = onQueryChange;

  // The query changed from elsewhere ("More like this", "Clear", another view): the box follows.
  useEffect(() => {
    if (query.text !== sent.current) {
      sent.current = query.text;
      setText(query.text);
    }
  }, [query.text]);

  useEffect(() => {
    if (text === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = text;
      onChangeRef.current({ ...queryRef.current, text });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const commit = (next: string) => {
    setText(next);
    if (next === sent.current) return;
    sent.current = next;
    onQueryChange({ ...query, text: next });
  };

  // What the bar shows is the box's text, even before it reaches the query.
  const shown: KnowledgeQuery = { ...query, text };
  const sorts = sortOptionsFor(shown);
  const sortOptions = sorts.map((value) => ({ value, label: SORT_LABEL[value] }));
  const examples = query.similarTo.length + query.unlike.length > 0;

  return (
    <div className="shrink-0 space-y-2 border-b border-neutral-800 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 basis-64">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            ref={inputRef}
            type="text"
            role="searchbox"
            aria-label="Search entries"
            aria-controls={resultsId}
            placeholder="Search by meaning or words…"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && text !== "") {
                e.preventDefault();
                e.stopPropagation();
                commit("");
              } else if (e.key === "Enter") {
                e.preventDefault();
                commit(text);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                commit(text);
                onFocusResults();
              }
            }}
            className="h-8 w-full rounded-md border border-neutral-700 bg-neutral-900 pl-8 pr-7 text-[13px] text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          />
          {text && (
            <button
              type="button"
              aria-label="Clear the search"
              onClick={() => {
                commit("");
                inputRef.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-500 hover:text-neutral-200"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-1.5">
          {KNOWLEDGE_FACET_FIELDS.map((field) => (
            <FilterChip key={field} api={api} collection={collection} query={query} field={field} onQueryChange={onQueryChange} />
          ))}
        </div>
        <SegmentedControl<KnowledgeSearchSort>
          value={shownSort(shown)}
          options={sortOptions}
          onChange={(sort) => onQueryChange({ ...queryRef.current, text: sent.current, sort })}
          size="xs"
          ariaLabel="Sort"
        />
        {!queryIsEmpty(shown) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText("");
              sent.current = "";
              onQueryChange(EMPTY_KNOWLEDGE_QUERY);
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {examples && (
        <div role="group" aria-label="More like this" className="flex flex-wrap items-center gap-1.5">
          {query.similarTo.map((id) => (
            <ExampleChip key={`like:${id}`} label="Like:" title={titleOf(id)} onRemove={() => onQueryChange(withoutExample(query, id))} />
          ))}
          {query.unlike.map((id) => (
            <ExampleChip key={`unlike:${id}`} label="Not like:" title={titleOf(id)} onRemove={() => onQueryChange(withoutExample(query, id))} />
          ))}
        </div>
      )}
    </div>
  );
};
