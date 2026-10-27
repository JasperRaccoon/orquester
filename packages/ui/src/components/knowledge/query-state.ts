// What the Knowledge view is searching for (retrieval spec, "Search everywhere"): one value
// shared by the List view, the Graph view's search box and the side panel's "More like this",
// owned by KnowledgeView. Pure helpers; no React.

import type { KnowledgeSearchFilters, KnowledgeSearchSort } from "@orquester/api";

export interface KnowledgeQuery {
  /** The words typed (may be ""). */
  text: string;
  /** "More like these" entry ids. */
  similarTo: string[];
  /** "Less like these" entry ids (meaningful only with `similarTo`). */
  unlike: string[];
  filters: KnowledgeSearchFilters;
  /** Null: the default for the query (relevance when searching, newest when only filtering). */
  sort: KnowledgeSearchSort | null;
}

export const EMPTY_KNOWLEDGE_QUERY: KnowledgeQuery = Object.freeze({
  text: "",
  similarTo: [],
  unlike: [],
  filters: {},
  sort: null
}) as KnowledgeQuery;

/** True when the query asks the search endpoint for something (words or example entries). */
export function isSearching(query: KnowledgeQuery): boolean {
  return query.text.trim().length > 0 || query.similarTo.length > 0;
}

/** True when any filter is set. */
export function hasFilters(query: KnowledgeQuery): boolean {
  return Object.values(query.filters).some((value) => (Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0));
}

/** A "More like this" search for one entry, keeping nothing else. */
export function findSimilarQuery(entryId: string): KnowledgeQuery {
  return { ...EMPTY_KNOWLEDGE_QUERY, similarTo: [entryId], filters: {} };
}

/** Add an entry to "less like these" (and drop it from "more like these"). */
export function withUnlike(query: KnowledgeQuery, entryId: string): KnowledgeQuery {
  if (query.unlike.includes(entryId)) return query;
  return { ...query, similarTo: query.similarTo.filter((id) => id !== entryId), unlike: [...query.unlike, entryId] };
}

/**
 * Let go of example entries (deleted ones): out of "more like" and "less like"; with no "more like"
 * left, "less like" goes too (it means nothing alone), and a query with no words left is the plain
 * list again. The same query when none of `ids` is an example.
 */
export function withoutExamples(query: KnowledgeQuery, ids: Iterable<string>): KnowledgeQuery {
  const gone = new Set(ids);
  if (!query.similarTo.some((id) => gone.has(id)) && !query.unlike.some((id) => gone.has(id))) return query;
  const similarTo = query.similarTo.filter((id) => !gone.has(id));
  const unlike = similarTo.length === 0 ? [] : query.unlike.filter((id) => !gone.has(id));
  return { ...query, similarTo, unlike };
}

/** The effective sort: the explicit one, else relevance when searching and newest when not. */
export function effectiveSort(query: KnowledgeQuery): KnowledgeSearchSort {
  return query.sort ?? (isSearching(query) ? "relevance" : "newest");
}
