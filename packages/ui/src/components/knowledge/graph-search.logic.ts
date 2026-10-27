/**
 * The Graph view's search dropdown rules: the request it sends for the shared
 * Knowledge query, the keyboard highlight, the match explanation it shows
 * (band, via badges, highlighted terms) and its "Show all" line. Pure — no
 * React, no store.
 */

import type {
  KnowledgeConceptRef,
  KnowledgeEntryMatch,
  KnowledgeMatchBand,
  KnowledgeMatchSignal,
  KnowledgeSearchHit,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse
} from "@orquester/api";

import { hasFilters, type KnowledgeQuery } from "./query-state";

/**
 * The search the dropdown runs for `query`, or null when nothing is typed (a
 * "More like this" query without words is the List view's). The query's
 * filters, examples and sort go with it, so "Show all N results" opens the
 * List view on the same results.
 */
export function graphSearchRequest(query: KnowledgeQuery, collections: readonly string[], limit: number): KnowledgeSearchRequest | null {
  const text = query.text.trim();
  if (!text) return null;
  const req: KnowledgeSearchRequest = { query: text, limit };
  if (collections.length > 0) req.collections = [...collections];
  if (hasFilters(query)) req.filters = { ...query.filters };
  if (query.similarTo.length > 0) {
    req.similarTo = [...query.similarTo];
    if (query.unlike.length > 0) req.unlike = [...query.unlike];
  }
  if (query.sort) req.sort = query.sort;
  return req;
}

/** Whether the dropdown's results are narrowed by more than the words (filters or examples set in the List view). */
export function searchIsNarrowed(query: KnowledgeQuery): boolean {
  return hasFilters(query) || query.similarTo.length > 0;
}

// ---------------------------------------------------------------------------
// Keyboard highlight
// ---------------------------------------------------------------------------

export interface SearchNavState {
  /** Options in the list. */
  count: number;
  /** The highlighted option; -1 with none. */
  index: number;
}

export type SearchNavAction =
  /** New results: the first is highlighted (Enter opens it). */
  | { type: "results"; count: number }
  | { type: "down" }
  | { type: "up" }
  /** The pointer moved over an option. */
  | { type: "point"; index: number };

export const SEARCH_NAV_EMPTY: SearchNavState = { count: 0, index: -1 };

/** ↑/↓ move the highlight round the list (wrapping). */
export function searchNavReducer(state: SearchNavState, action: SearchNavAction): SearchNavState {
  if (action.type === "results") {
    const count = Math.max(0, Math.floor(action.count));
    return { count, index: count > 0 ? 0 : -1 };
  }
  const { count, index } = state;
  if (count === 0) return state.index === -1 ? state : { count, index: -1 };
  switch (action.type) {
    case "down":
      return { count, index: index < 0 ? 0 : (index + 1) % count };
    case "up":
      return { count, index: index < 0 ? count - 1 : (index - 1 + count) % count };
    case "point":
      return action.index >= 0 && action.index < count && action.index !== index ? { count, index: action.index } : state;
  }
}

// ---------------------------------------------------------------------------
// Match explanation
// ---------------------------------------------------------------------------

const BANDS: ReadonlySet<string> = new Set<KnowledgeMatchBand>(["strong", "good", "weak"]);
const SIGNAL_ORDER: readonly KnowledgeMatchSignal[] = ["keyword", "meaning", "similar", "concept"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An entry hit's match explanation, read defensively (a daemon that predates
 * it sends none; a newer one may send more): null without a readable band,
 * unknown signals left out, `via` in the fixed order.
 */
export function readEntryMatch(hit: KnowledgeSearchHit): KnowledgeEntryMatch | null {
  if (hit.kind !== "entry") return null;
  const raw: unknown = (hit as { match?: unknown }).match;
  if (!isRecord(raw) || typeof raw.band !== "string" || !BANDS.has(raw.band)) return null;
  const via = Array.isArray(raw.via) ? SIGNAL_ORDER.filter((signal) => (raw.via as unknown[]).includes(signal)) : [];
  const terms = Array.isArray(raw.terms) ? raw.terms.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
  const concepts: KnowledgeConceptRef[] = Array.isArray(raw.concepts)
    ? raw.concepts.flatMap((c) => (isRecord(c) && typeof c.id === "string" && c.id !== "" ? [{ id: c.id, name: typeof c.name === "string" && c.name ? c.name : c.id, type: typeof c.type === "string" ? c.type : "concept" }] : []))
    : [];
  const p = raw.passage;
  const passage =
    isRecord(p) && [p.start, p.end, p.chunk, p.chunks].every((n) => typeof n === "number" && Number.isFinite(n))
      ? { start: p.start as number, end: p.end as number, chunk: p.chunk as number, chunks: p.chunks as number }
      : null;
  return { band: raw.band as KnowledgeMatchBand, via, terms, passage, concepts };
}

const BAND_LABEL: Record<KnowledgeMatchBand, string> = { strong: "Strong", good: "Good", weak: "Weak" };

export function bandLabel(band: KnowledgeMatchBand): string {
  return BAND_LABEL[band];
}

export interface TextPart {
  text: string;
  /** A query term (drawn highlighted). */
  hit: boolean;
}

const MAX_TERMS = 20;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` cut into plain and highlighted parts, at every case-insensitive
 * occurrence of a term (the longest first where terms overlap). Parts are
 * plain strings for React to render as text: nothing here is ever HTML.
 */
export function highlightParts(text: string, terms: readonly string[]): TextPart[] {
  const words = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TERMS).sort((a, b) => b.length - a.length);
  if (!text || words.length === 0) return text ? [{ text, hit: false }] : [];
  const pattern = new RegExp(words.map(escapeRegExp).join("|"), "giu");
  const parts: TextPart[] = [];
  let at = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index ?? 0;
    if (found[0].length === 0) continue;
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: found[0], hit: true });
    at = start + found[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * The dropdown's last line: "Show all 31 results" (the response's total when the daemon sends one).
 * The List view narrows to one collection at most, so with two or more collection chips on (`filter`)
 * it opens on every collection: no count is promised then.
 */
export function showAllLabel(answer: Pick<KnowledgeSearchResponse, "total" | "hits">, filter: readonly string[] = []): string {
  if (filter.length > 1) return "Show in List (all collections)";
  const total = typeof answer.total === "number" && Number.isFinite(answer.total) ? Math.max(0, Math.floor(answer.total)) : null;
  if (total === null) return "Show all results";
  return `Show all ${total.toLocaleString("en-US")} ${total === 1 ? "result" : "results"}`;
}
