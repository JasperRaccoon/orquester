/**
 * The Knowledge view's pure rules: colours, error and status text, and the
 * collection and entry forms. No React, no store.
 */

import {
  KNOWLEDGE_COLLECTION_DESCRIPTION_MAX,
  KNOWLEDGE_COLLECTION_NAME_MAX,
  KNOWLEDGE_ENTRY_MAX_BYTES,
  KNOWLEDGE_FILTER_MAX_VALUES,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SEARCH_MAX_RESULTS,
  KNOWLEDGE_SIMILAR_MAX_EXAMPLES,
  KNOWLEDGE_TITLE_MAX,
  type KnowledgeCollection,
  type KnowledgeCollectionView,
  type KnowledgeColor,
  type KnowledgeEntriesQuery,
  type KnowledgeEntry,
  type KnowledgeEntryMatch,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeErrorCode,
  type KnowledgeFacetsRequest,
  type KnowledgeLinkingState,
  type KnowledgeMatchBand,
  type KnowledgePauseReason,
  type KnowledgeRunSummary,
  type KnowledgeSearchFilters,
  type KnowledgeSearchHit,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResponse,
  type KnowledgeSearchSort,
  type KnowledgeStatus,
  type UpdateKnowledgeEntryRequest,
  encodeKnowledgeFilterList
} from "@orquester/api";

import { effectiveSort, isSearching, type KnowledgeQuery } from "./query-state";

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** The theme custom property behind a palette key (`chart-N` is the app's `--lane-N`). */
export function knowledgeColorProperty(color: KnowledgeColor): string {
  return `--lane-${color.slice("chart-".length)}`;
}

/** CSS colour of a palette key, following the theme (light/dark, scheme). */
export function knowledgeColorCss(color: KnowledgeColor): string {
  return `rgb(var(${knowledgeColorProperty(color)}))`;
}

/** The palette key a new collection gets: the first one no collection uses yet, else round-robin. */
export function nextKnowledgeColor(collections: readonly Pick<KnowledgeCollection, "color">[], palette: readonly KnowledgeColor[]): KnowledgeColor {
  const used = new Set(collections.map((c) => c.color));
  return palette.find((c) => !used.has(c)) ?? palette[collections.length % palette.length]!;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_CODES: ReadonlySet<string> = new Set<KnowledgeErrorCode>([
  "KNOWLEDGE_DISABLED",
  "KNOWLEDGE_NOT_INSTALLED",
  "KNOWLEDGE_NOT_FOUND",
  "KNOWLEDGE_INVALID",
  "KNOWLEDGE_COLLECTION_EXISTS",
  "KNOWLEDGE_UNKNOWN_COLLECTION",
  "KNOWLEDGE_UNKNOWN_ACCOUNT",
  "KNOWLEDGE_TOO_LARGE",
  "KNOWLEDGE_NOT_A_WORKER",
  "KNOWLEDGE_BUSY"
]);

const FALLBACK_TEXT: Partial<Record<KnowledgeErrorCode, string>> = {
  KNOWLEDGE_DISABLED: "The Knowledge Graph plugin is off.",
  KNOWLEDGE_NOT_INSTALLED: "The Knowledge Graph plugin is not installed yet.",
  KNOWLEDGE_NOT_FOUND: "It no longer exists.",
  KNOWLEDGE_COLLECTION_EXISTS: "A collection with that name already exists.",
  KNOWLEDGE_UNKNOWN_COLLECTION: "One of the collections no longer exists.",
  KNOWLEDGE_UNKNOWN_ACCOUNT: "One of the accounts is not a Claude account on this server.",
  KNOWLEDGE_TOO_LARGE: "The text is too long.",
  KNOWLEDGE_BUSY: "The knowledge base is busy; try again in a moment."
};

/** The `{ code, message }` (or `{ error: { code, message } }`) a refused route sent, when any. */
function errorBody(error: unknown): { code?: unknown; message?: unknown } | null {
  const body = (error as { body?: unknown } | null)?.body;
  if (!body || typeof body !== "object") return null;
  const inner = (body as { error?: unknown }).error;
  if (inner && typeof inner === "object") return inner as { code?: unknown; message?: unknown };
  return body as { code?: unknown; message?: unknown };
}

/** The knowledge error code of a refused request, or null. */
export function knowledgeErrorCode(error: unknown): KnowledgeErrorCode | null {
  const code = errorBody(error)?.code;
  return typeof code === "string" && ERROR_CODES.has(code) ? (code as KnowledgeErrorCode) : null;
}

/** What to show for a failed knowledge request: the daemon's message, else a text for its code, else the error's own. */
export function knowledgeErrorText(error: unknown): string {
  const body = errorBody(error);
  if (typeof body?.message === "string" && body.message.trim()) return body.message;
  const code = knowledgeErrorCode(error);
  if (code && FALLBACK_TEXT[code]) return FALLBACK_TEXT[code]!;
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "12 entries · 340 concepts · 5 collections". */
export function knowledgeCountsText(status: Pick<KnowledgeStatus, "entries" | "concepts" | "collections">): string {
  return [
    plural(status.entries, "entry", "entries"),
    plural(status.concepts, "concept", "concepts"),
    plural(status.collections, "collection", "collections")
  ].join(" · ");
}

const PAUSE_TEXT: Record<KnowledgePauseReason, string> = {
  "usage-limit": "every Claude account is at its usage limit",
  "no-account": "no Claude account can run it",
  "not-installed": "the plugin is not installed",
  "plugin-off": "the plugin is off",
  error: "the last run failed"
};

export interface LinkingView {
  /** `failed`: idle, but some entries' last run could not link them. */
  tone: "idle" | "queued" | "running" | "paused" | "failed";
  /** The short line the status bar shows. */
  label: string;
  /** More context (a tooltip / second line), or null. */
  detail: string | null;
  /** 0..1 while running with known progress, else null. */
  progress: number | null;
}

function clock(iso: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/**
 * How the status bar describes linking; `runs` gives the running run's entry count, and
 * `failedEntries` the entries a run could not link (an idle state then says so, never "Every entry
 * is linked.").
 */
export function linkingView(
  linking: KnowledgeLinkingState,
  runs: readonly KnowledgeRunSummary[] = [],
  now = Date.now(),
  failedEntries = 0
): LinkingView {
  switch (linking.state) {
    case "idle":
      if (failedEntries > 0) {
        return {
          tone: "failed",
          label: `${plural(failedEntries, "entry", "entries")} could not be linked`,
          detail: "See Settings → Plugins → Knowledge Graph for the last error.",
          progress: null
        };
      }
      return { tone: "idle", label: "Linking idle", detail: "Every entry is linked.", progress: null };
    case "queued": {
      const startsIn = Math.round((new Date(linking.startsAt).getTime() - now) / 1000);
      const when = Number.isFinite(startsIn) && startsIn > 0 ? `starts in ${startsIn < 60 ? `${startsIn}s` : `${Math.ceil(startsIn / 60)} min`}` : "starts shortly";
      return {
        tone: "queued",
        label: `Linking queued · ${plural(linking.pendingEntries, "entry", "entries")}`,
        detail: `Linking ${when}.`,
        progress: null
      };
    }
    case "running": {
      const run = runs.find((r) => r.id === linking.runId);
      const what = run && run.entries > 0 ? `Linking ${plural(run.entries, "entry", "entries")}…` : "Linking…";
      const progress = linking.progress && linking.progress.total > 0 ? linking.progress.done / linking.progress.total : null;
      const parts: string[] = [];
      if (linking.progress && linking.progress.total > 0) parts.push(`${linking.progress.done} of ${linking.progress.total} steps`);
      if (linking.step) parts.push(`step ${linking.step}`);
      if (linking.mode === "rebuild" || linking.mode === "full") parts.push("full extraction");
      if (linking.pendingEntries > 0) parts.push(`${plural(linking.pendingEntries, "entry", "entries")} waiting for the next run`);
      return { tone: "running", label: what, detail: parts.length ? parts.join(" · ") : null, progress };
    }
    case "paused": {
      const resumes = linking.resumesAt ? clock(linking.resumesAt) : null;
      const parts = [linking.message || null, resumes ? `Resumes at ${resumes}.` : null].filter((p): p is string => p !== null);
      return {
        tone: "paused",
        label: `Linking paused: ${PAUSE_TEXT[linking.reason]}`,
        detail: parts.length ? parts.join(" ") : null,
        progress: null
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface CollectionForm {
  name: string;
  description: string;
  color: KnowledgeColor;
}

/** Why a collection form cannot be saved, or null. `editingId` is the collection being edited. */
export function collectionFormError(
  form: Pick<CollectionForm, "name" | "description">,
  collections: readonly Pick<KnowledgeCollection, "id" | "name">[],
  editingId: string | null
): string | null {
  const name = form.name.trim();
  if (!name) return "Give the collection a name.";
  if (name.length > KNOWLEDGE_COLLECTION_NAME_MAX) return `Names are at most ${KNOWLEDGE_COLLECTION_NAME_MAX} characters.`;
  if (/[\r\n]/.test(form.description)) return "The description is one line.";
  if (form.description.trim().length > KNOWLEDGE_COLLECTION_DESCRIPTION_MAX) {
    return `Descriptions are at most ${KNOWLEDGE_COLLECTION_DESCRIPTION_MAX} characters.`;
  }
  const lower = name.toLowerCase();
  if (collections.some((c) => c.id !== editingId && c.name.trim().toLowerCase() === lower)) return `There is already a collection named “${name}”.`;
  return null;
}

/** "SEO · SaaS expert, Mobile expert" — the profiles that see a collection, or null when none does. */
export function collectionProfilesText(collection: Pick<KnowledgeCollectionView, "profiles">): string | null {
  return collection.profiles.length > 0 ? collection.profiles.map((p) => p.name).join(", ") : null;
}

/** The delete confirmation's explanation. */
export function deleteCollectionMessage(collection: Pick<KnowledgeCollectionView, "name" | "entryCount">): string {
  const entries =
    collection.entryCount === 0
      ? "It has no entries."
      : `Its ${plural(collection.entryCount, "entry", "entries")} lose the label; an entry with no other collection becomes Unfiled, which only Global chats see.`;
  return `Delete the collection “${collection.name}”? ${entries} No entry is deleted.`;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** "Om Patel · @om_patel5", "@om_patel5", "Om Patel", or null. */
export function entryByline(entry: Pick<KnowledgeEntryMeta, "author" | "handle">): string | null {
  const parts = [entry.author, entry.handle ? `@${entry.handle}` : null].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

/** A short date ("Oct 11, 2026") for an ISO date or date-time; the raw text when it does not parse. */
export function formatKnowledgeDate(iso: string | null): string | null {
  if (!iso) return null;
  // A bare date is the author's calendar day: never shift it by the viewer's zone.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const at = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  if (!Number.isFinite(at.getTime())) return iso;
  return at.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) });
}

/** The date an entry card shows: when it was posted, else when it was saved. */
export function entryDate(entry: Pick<KnowledgeEntryMeta, "postedAt" | "savedAt">): string | null {
  return formatKnowledgeDate(entry.postedAt ?? entry.savedAt);
}

/** Only an http(s) URL is offered as "Open post". */
export function entryPostUrl(entry: Pick<KnowledgeEntryMeta, "url">): string | null {
  return entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null;
}

export interface EntryForm {
  title: string;
  body: string;
  kind: string;
  author: string;
  handle: string;
  url: string;
  postedAt: string;
  collections: string[];
}

export function entryFormOf(entry: KnowledgeEntry): EntryForm {
  return {
    title: entry.title,
    body: entry.body,
    kind: entry.kind,
    author: entry.author ?? "",
    handle: entry.handle ?? "",
    url: entry.url ?? "",
    postedAt: entry.postedAt ?? "",
    collections: [...entry.collections]
  };
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** An ISO date (`2026-10-11`) or date-time, as the daemon accepts for `postedAt`. */
function isIsoDate(text: string): boolean {
  const dateOnly = ISO_DATE.test(text);
  if (!dateOnly && !ISO_DATE_TIME.test(text)) return false;
  return Number.isFinite(Date.parse(dateOnly ? `${text}T00:00:00Z` : text));
}
const optional = (value: string): string | null => (value.trim() ? value.trim() : null);

/**
 * The PATCH an edited form makes — only the fields that changed — or the reason
 * it cannot be saved. An empty optional field clears it; a handle loses its "@".
 */
export function entryFormPatch(entry: KnowledgeEntry, form: EntryForm): { patch: UpdateKnowledgeEntryRequest } | { error: string } {
  const title = form.title.trim();
  if (!title) return { error: "Give the entry a title." };
  if (title.length > KNOWLEDGE_TITLE_MAX) return { error: `Titles are at most ${KNOWLEDGE_TITLE_MAX} characters.` };
  if (!form.body.trim()) return { error: "The text cannot be empty." };
  if (utf8Bytes(form.body) > KNOWLEDGE_ENTRY_MAX_BYTES) return { error: "The text is too long." };
  const url = optional(form.url);
  if (url && !/^https?:\/\/\S+$/i.test(url)) return { error: "The URL must start with http:// or https://." };
  const postedAt = optional(form.postedAt);
  if (postedAt && !isIsoDate(postedAt)) return { error: "The date is not a date (use YYYY-MM-DD)." };

  const patch: UpdateKnowledgeEntryRequest = {};
  if (title !== entry.title) patch.title = title;
  if (form.body !== entry.body) patch.body = form.body;
  const kind = form.kind.trim() || "note";
  if (kind !== entry.kind) patch.kind = kind;
  const author = optional(form.author);
  if (author !== entry.author) patch.author = author;
  const handle = optional(form.handle.trim().replace(/^@+/, ""));
  if (handle !== entry.handle) patch.handle = handle;
  if (url !== entry.url) patch.url = url;
  if (postedAt !== entry.postedAt) patch.postedAt = postedAt;
  const before = [...entry.collections].sort().join("\n");
  const after = [...new Set(form.collections)].sort();
  if (after.join("\n") !== before) patch.collections = after;
  return { patch };
}

/**
 * Whether a PATCH changes what the graph reads (anything but collections and the URL, which the
 * myKG input never carries — the daemon files those as a relabel): saving it queues linking.
 */
export function patchNeedsLinking(patch: UpdateKnowledgeEntryRequest): boolean {
  return Object.keys(patch).some((key) => key !== "collections" && key !== "url");
}

/** Kinds offered while editing (free-form: any other text is kept). */
export const KNOWLEDGE_KIND_SUGGESTIONS = ["post", "thread", "article", "case study", "note"] as const;

// ---------------------------------------------------------------------------
// The List view: requests, filters, results (retrieval spec, "List view (U1)")
// ---------------------------------------------------------------------------

/** Entries per page of the plain list. */
export const KNOWLEDGE_LIST_PAGE = 50;
/** Hits per page of a search (the daemon's maximum). */
export const KNOWLEDGE_SEARCH_PAGE = KNOWLEDGE_SEARCH_MAX_LIMIT;

/** The filters the List view's chips set (multi-select over facet values). */
export type KnowledgeFacetField = "kinds" | "authors" | "years";
export const KNOWLEDGE_FACET_FIELDS: readonly KnowledgeFacetField[] = ["kinds", "authors", "years"];

const BOUNDS = ["postedAfter", "postedBefore", "savedAfter", "savedBefore"] as const;

/** A search's or facets' narrowing for the List view's collection ("all", "unfiled" or an id). */
function narrowingOf(collection: string): string[] | undefined {
  return collection === "all" ? undefined : [collection];
}

/** How a filter value is compared (as the daemon does): trimmed, whitespace collapsed, case-insensitive; authors without a leading "@". */
function filterKey(field: KnowledgeFacetField, value: string): string {
  const key = value.replace(/\s+/g, " ").trim().toLowerCase();
  return field === "authors" ? key.replace(/^@+/, "") : key;
}

/**
 * The filters as the daemon takes them: list values trimmed, empty ones and repeats (as compared)
 * dropped, at most KNOWLEDGE_FILTER_MAX_VALUES each; bounds trimmed; empty fields left out.
 * Undefined when nothing is left.
 */
export function cleanFilters(filters: KnowledgeSearchFilters): KnowledgeSearchFilters | undefined {
  const out: KnowledgeSearchFilters = {};
  for (const field of KNOWLEDGE_FACET_FIELDS) {
    const values = filters[field];
    if (!values) continue;
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of values) {
      const value = raw.trim();
      const key = filterKey(field, value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      kept.push(value);
    }
    if (kept.length > 0) out[field] = kept.slice(0, KNOWLEDGE_FILTER_MAX_VALUES);
  }
  for (const bound of BOUNDS) {
    const value = filters[bound]?.trim();
    if (value) out[bound] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The sorts offered: all three while searching; only "Newest" for the plain list. */
export function sortOptionsFor(query: KnowledgeQuery): KnowledgeSearchSort[] {
  return isSearching(query) ? ["relevance", "recent", "newest"] : ["newest"];
}

/** The sort the control shows (the plain list is always newest first). */
export function shownSort(query: KnowledgeQuery): KnowledgeSearchSort {
  return isSearching(query) ? effectiveSort(query) : "newest";
}

export const SORT_LABEL: Record<KnowledgeSearchSort, string> = { relevance: "Relevance", recent: "Recent", newest: "Newest" };

/** "More like these" and "less like these" ids as sent: distinct, capped, an id never in both (like wins), no "less like" alone. */
function examplesOf(query: KnowledgeQuery): { similarTo: string[]; unlike: string[] } {
  const similarTo = [...new Set(query.similarTo)].slice(0, KNOWLEDGE_SIMILAR_MAX_EXAMPLES);
  const unlike =
    similarTo.length === 0 ? [] : [...new Set(query.unlike)].filter((id) => !similarTo.includes(id)).slice(0, KNOWLEDGE_SIMILAR_MAX_EXAMPLES);
  return { similarTo, unlike };
}

/** The search a query makes in a collection, for one page (`cursor` from the previous one). */
export function searchRequestOf(
  query: KnowledgeQuery,
  collection: string,
  page: { cursor?: string | null; limit?: number } = {}
): KnowledgeSearchRequest {
  const request: KnowledgeSearchRequest = { limit: page.limit ?? KNOWLEDGE_SEARCH_PAGE };
  const text = query.text.trim();
  if (text) request.query = text;
  const { similarTo, unlike } = examplesOf(query);
  if (similarTo.length > 0) request.similarTo = similarTo;
  if (unlike.length > 0) request.unlike = unlike;
  const collections = narrowingOf(collection);
  if (collections) request.collections = collections;
  const filters = cleanFilters(query.filters);
  if (filters) request.filters = filters;
  request.sort = effectiveSort(query);
  if (page.cursor) request.cursor = page.cursor;
  return request;
}

/** What identifies a search apart from its page: a change starts over from the first page. */
export function searchKeyOf(query: KnowledgeQuery, collection: string): string {
  return JSON.stringify(searchRequestOf(query, collection));
}

/** The plain list's query string: the collection and the filters (lists as `encodeKnowledgeFilterList` writes them, ISO bounds). */
export function entriesQueryOf(
  collection: string,
  filters: KnowledgeSearchFilters,
  page: { cursor?: string | null; limit?: number } = {}
): KnowledgeEntriesQuery {
  const query: KnowledgeEntriesQuery = { limit: page.limit ?? KNOWLEDGE_LIST_PAGE };
  if (collection !== "all") query.collection = collection;
  if (page.cursor) query.cursor = page.cursor;
  const clean = cleanFilters(filters) ?? {};
  for (const field of KNOWLEDGE_FACET_FIELDS) {
    const encoded = encodeKnowledgeFilterList(clean[field]);
    if (encoded) query[field] = encoded;
  }
  for (const bound of BOUNDS) {
    const value = clean[bound];
    if (value) query[bound] = value;
  }
  return query;
}

/** What identifies the plain list apart from its page. */
export function entriesKeyOf(collection: string, filters: KnowledgeSearchFilters): string {
  return JSON.stringify(entriesQueryOf(collection, filters));
}

/** The counts one filter chip lists: scoped to the collection and every *other* filter (its own choices never hide its options). */
export function facetsRequestOf(collection: string, filters: KnowledgeSearchFilters, field: KnowledgeFacetField): KnowledgeFacetsRequest {
  const request: KnowledgeFacetsRequest = {};
  const collections = narrowingOf(collection);
  if (collections) request.collections = collections;
  const others: KnowledgeSearchFilters = { ...filters };
  delete others[field];
  const clean = cleanFilters(others);
  if (clean) request.filters = clean;
  return request;
}

/** Whether `value` is chosen for `field` (compared as the daemon compares). */
export function filterHas(filters: KnowledgeSearchFilters, field: KnowledgeFacetField, value: string): boolean {
  const key = filterKey(field, value);
  return (filters[field] ?? []).some((v) => filterKey(field, v) === key);
}

/** Choose or let go of one filter value; a list at KNOWLEDGE_FILTER_MAX_VALUES takes no more. */
export function toggleFilterValue(query: KnowledgeQuery, field: KnowledgeFacetField, value: string): KnowledgeQuery {
  const current = query.filters[field] ?? [];
  const key = filterKey(field, value);
  let next: string[];
  if (current.some((v) => filterKey(field, v) === key)) next = current.filter((v) => filterKey(field, v) !== key);
  else if (!key || current.length >= KNOWLEDGE_FILTER_MAX_VALUES) return query;
  else next = [...current, value.trim()];
  const filters = { ...query.filters };
  if (next.length > 0) filters[field] = next;
  else delete filters[field];
  return { ...query, filters };
}

/** Let go of every value of one filter. */
export function clearFilterField(query: KnowledgeQuery, field: KnowledgeFacetField): KnowledgeQuery {
  if (!query.filters[field]) return query;
  const filters = { ...query.filters };
  delete filters[field];
  return { ...query, filters };
}

const FIELD_LABEL: Record<KnowledgeFacetField, string> = { kinds: "Kind", authors: "Author", years: "Year" };

export function facetFieldLabel(field: KnowledgeFacetField): string {
  return FIELD_LABEL[field];
}

/** A filter chip's text: "Kind", "Kind: thread", "Kind: 3". */
export function filterChipLabel(field: KnowledgeFacetField, filters: KnowledgeSearchFilters): string {
  const values = filters[field] ?? [];
  if (values.length === 0) return FIELD_LABEL[field];
  return values.length === 1 ? `${FIELD_LABEL[field]}: ${values[0]}` : `${FIELD_LABEL[field]}: ${values.length}`;
}

/** Drop an example ("Like: …" or "Not like: …" ×); with no "more like" example left, the "less like" ones go too. */
export function withoutExample(query: KnowledgeQuery, entryId: string): KnowledgeQuery {
  const similarTo = query.similarTo.filter((id) => id !== entryId);
  const unlike = similarTo.length === 0 ? [] : query.unlike.filter((id) => id !== entryId);
  if (similarTo.length === query.similarTo.length && unlike.length === query.unlike.length) return query;
  return { ...query, similarTo, unlike };
}

/** True when "Clear" has nothing to clear. */
export function queryIsEmpty(query: KnowledgeQuery): boolean {
  return query.text.trim() === "" && query.similarTo.length === 0 && query.unlike.length === 0 && query.sort === null && cleanFilters(query.filters) === undefined;
}

// --- Results -----------------------------------------------------------------

/** One stretch of text, highlighted or not. */
export interface HighlightPart {
  text: string;
  match: boolean;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` split around the matched query `terms` (case-insensitive; the longest term first, so
 * "pages" is one highlight, not "page" + "s"), for rendering highlights as elements — never as
 * HTML. A lone ASCII letter or digit is not highlighted (it would light up everything).
 */
export function highlightParts(text: string, terms: readonly string[]): HighlightPart[] {
  if (!text) return [];
  const usable = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t !== "" && !/^[a-z0-9]$/.test(t)))].sort(
    (a, b) => b.length - a.length
  );
  if (usable.length === 0) return [{ text, match: false }];
  const pattern = new RegExp(usable.map(escapeRegExp).join("|"), "giu");
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index ?? 0;
    if (found[0].length === 0) continue;
    if (start > last) parts.push({ text: text.slice(last, start), match: false });
    const previous = parts[parts.length - 1];
    // Adjacent matches read as one highlight.
    if (previous?.match && start === last) previous.text += found[0];
    else parts.push({ text: found[0], match: true });
    last = start + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}

export const BAND_LABEL: Record<KnowledgeMatchBand, string> = { strong: "Strong match", good: "Good match", weak: "Weak match" };

/** A hit's "via" badges: Keyword, Meaning, Similar, and "Concept <name>" for each concept that led to it. */
export function viaBadges(match: Pick<KnowledgeEntryMatch, "via" | "concepts">): { key: string; label: string }[] {
  const badges: { key: string; label: string }[] = [];
  for (const signal of match.via) {
    if (signal === "keyword") badges.push({ key: "keyword", label: "Keyword" });
    else if (signal === "meaning") badges.push({ key: "meaning", label: "Meaning" });
    else if (signal === "similar") badges.push({ key: "similar", label: "Similar" });
    else if (match.concepts.length === 0) badges.push({ key: "concept", label: "Concept" });
    else for (const concept of match.concepts.slice(0, 3)) badges.push({ key: `concept:${concept.id}`, label: `Concept ${concept.name}` });
  }
  return badges;
}

/** "passage 3 of 12" for an entry long enough to have several chunks (`chunk` is 0-based), else null. */
export function passageText(match: Pick<KnowledgeEntryMatch, "passage">): string | null {
  const passage = match.passage;
  if (!passage || passage.chunks < 2) return null;
  return `passage ${Math.min(passage.chunk + 1, passage.chunks)} of ${passage.chunks}`;
}

/** "31 results", "1 result"; the daemon stops counting at KNOWLEDGE_SEARCH_MAX_RESULTS ("Top 200 results"). Without a total (an older daemon), the hits shown. */
export function resultsCountText(total: number | null, shown: number): string {
  if (total !== null && total >= KNOWLEDGE_SEARCH_MAX_RESULTS) return `Top ${KNOWLEDGE_SEARCH_MAX_RESULTS.toLocaleString("en-US")} results`;
  const n = total ?? shown;
  return `${n.toLocaleString("en-US")} ${n === 1 ? "result" : "results"}`;
}

/** A search hit's identity across pages. */
export function searchHitKey(hit: KnowledgeSearchHit): string {
  return hit.kind === "entry" ? `entry:${hit.entry.id}` : `concept:${hit.concept.id}`;
}

/** Results paged so far (entries or search hits). `total` is null when the daemon gave none (the plain list; an older daemon's search). */
export interface Pages<T> {
  items: T[];
  total: number | null;
  nextCursor: string | null;
}

/** One page as read: a search answer's `hits`, `total` and `nextCursor`, or an entries page's `entries` and `nextCursor`. */
export interface PageAnswer<T> {
  items: readonly T[];
  nextCursor?: string | null;
  total?: number;
}

export function searchPageOf(answer: KnowledgeSearchResponse): PageAnswer<KnowledgeSearchHit> {
  return { items: answer.hits, nextCursor: answer.nextCursor, ...(answer.total !== undefined ? { total: answer.total } : {}) };
}

/**
 * The pages so far plus one more answer: an item already shown (by `idOf`) is not repeated; the
 * total and cursor come from the newest page (no cursor — an older daemon's search — is the last page).
 */
export function appendPage<T>(previous: Pages<T> | null, answer: PageAnswer<T>, idOf: (item: T) => string): Pages<T> {
  const items = previous ? [...previous.items] : [];
  const seen = new Set(items.map(idOf));
  for (const item of answer.items) {
    const key = idOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return { items, total: answer.total ?? previous?.total ?? null, nextCursor: answer.nextCursor ?? null };
}

// --- Rediscover ----------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Entries saved in this many days seed "Rediscover"… */
export const REDISCOVER_RECENT_DAYS = 7;
/** …which shows entries saved longer ago than this. */
export const REDISCOVER_OLDER_THAN_DAYS = 30;
export const REDISCOVER_MAX = 5;

/** Up to five entries saved in the last week, most recent first: the "Rediscover" examples. */
export function rediscoverSeeds(entries: readonly Pick<KnowledgeEntryMeta, "id" | "savedAt">[], now: number): string[] {
  const since = now - REDISCOVER_RECENT_DAYS * DAY_MS;
  return entries
    .map((entry) => ({ id: entry.id, at: Date.parse(entry.savedAt) }))
    .filter((e) => Number.isFinite(e.at) && e.at >= since)
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, REDISCOVER_MAX)
    .map((e) => e.id);
}

/**
 * The "Rediscover" search: entries like the seeds, saved more than 30 days ago; null without seeds.
 * The bound is a bare date (inclusive, the same all day): the day before the one 30 days ago, so
 * nothing on it is younger than 30 days.
 */
export function rediscoverRequestOf(seeds: readonly string[], collection: string, now: number): KnowledgeSearchRequest | null {
  if (seeds.length === 0) return null;
  const request: KnowledgeSearchRequest = {
    similarTo: seeds.slice(0, KNOWLEDGE_SIMILAR_MAX_EXAMPLES),
    filters: { savedBefore: new Date(now - (REDISCOVER_OLDER_THAN_DAYS + 1) * DAY_MS).toISOString().slice(0, 10) },
    sort: "relevance",
    limit: REDISCOVER_MAX
  };
  const collections = narrowingOf(collection);
  if (collections) request.collections = collections;
  return request;
}

/** The entries "Rediscover" shows, or null when it stays hidden: an older daemon (no `total`), or nothing found. */
export function rediscoverEntries(answer: KnowledgeSearchResponse, seeds: readonly string[]): KnowledgeEntrySummary[] | null {
  if (answer.total === undefined) return null;
  const skip = new Set(seeds);
  const entries: KnowledgeEntrySummary[] = [];
  for (const hit of answer.hits) {
    if (hit.kind !== "entry" || skip.has(hit.entry.id)) continue;
    skip.add(hit.entry.id);
    entries.push(hit.entry);
    if (entries.length === REDISCOVER_MAX) break;
  }
  return entries.length > 0 ? entries : null;
}
