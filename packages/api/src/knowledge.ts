/**
 * Knowledge Graph — the built-in "Knowledge Graph" plugin (spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md).
 *
 * One server-wide knowledge base of **entries** (saved posts, threads,
 * articles, notes), labelled with **collections**. myKG extracts **concepts**
 * and the edges between them from the entries; the daemon serves search and
 * traversal itself, scoped to the collections the calling chat can see
 * (its Agent Profile's `knowledgeCollections`; a chat with no profile sees all).
 *
 * Indexing ("linking") runs myKG in its `agent-claude-code` inbox mode; the
 * daemon answers the inbox with ordinary Claude Code agent-chat sessions it
 * owns (`KnowledgeSessionOwner`), which work through the two worker tools.
 */

import type { AccountPolicy } from "@orquester/config";

// ---------------------------------------------------------------------------
// Limits (enforced by the daemon; the UI mirrors them)
// ---------------------------------------------------------------------------

/** One entry's body, in UTF-8 bytes. */
export const KNOWLEDGE_ENTRY_MAX_BYTES = 200_000;
/** Items in one save request (a bulk import is split by the agent). */
export const KNOWLEDGE_SAVE_MAX_ENTRIES = 100;
/** Entries one merge combines: 2..KNOWLEDGE_MERGE_MAX_ENTRIES. */
export const KNOWLEDGE_MERGE_MAX_ENTRIES = 10;
export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_COLLECTIONS_MAX = 100;
export const KNOWLEDGE_COLLECTION_NAME_MAX = 60;
export const KNOWLEDGE_COLLECTION_DESCRIPTION_MAX = 200;
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 8;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 25;
/** Entries one search can page through (all pages together). */
export const KNOWLEDGE_SEARCH_MAX_RESULTS = 200;
/** Example entries in `similarTo` / `unlike`. */
export const KNOWLEDGE_SIMILAR_MAX_EXAMPLES = 10;
/** Values in one filter list (`kinds`, `authors`). */
export const KNOWLEDGE_FILTER_MAX_VALUES = 20;
/** Values per facet (the most frequent first). */
export const KNOWLEDGE_FACET_MAX_VALUES = 30;
/** Entries in one similarity graph before it is truncated to the most recent. */
export const KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES = 2_000;
export const KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_NODES = 1_000;
/** Nearest neighbours drawn per entry in the similarity graph (1..KNOWLEDGE_SIMILARITY_GRAPH_MAX_K). */
export const KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_K = 3;
export const KNOWLEDGE_SIMILARITY_GRAPH_MAX_K = 8;
/** Concepts returned by one graph request before it is truncated to the most connected. */
export const KNOWLEDGE_GRAPH_MAX_NODES = 2_000;
export const KNOWLEDGE_CONCURRENCY_MIN = 1;
export const KNOWLEDGE_CONCURRENCY_MAX = 8;
export const KNOWLEDGE_CONCURRENCY_DEFAULT = 4;
/** Saves are coalesced: a run starts this long after the last save… */
export const KNOWLEDGE_LINK_DEBOUNCE_MS = 20_000;
/** …and never later than this after the first pending one. */
export const KNOWLEDGE_LINK_MAX_WAIT_MS = 120_000;

/**
 * Collection colours are palette keys, not CSS: the UI maps them to chart
 * tokens (`chart-1` … `chart-6`) so they follow the theme.
 */
export type KnowledgeColor = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5" | "chart-6";
export const KNOWLEDGE_COLORS: readonly KnowledgeColor[] = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"];

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface KnowledgeCollection {
  /** `kc_` + 10 lowercase base32 chars; stable across renames. */
  id: string;
  /** Unique (case-insensitive), trimmed, 1..KNOWLEDGE_COLLECTION_NAME_MAX. */
  name: string;
  /** One line, ≤ KNOWLEDGE_COLLECTION_DESCRIPTION_MAX. May be "". */
  description: string;
  color: KnowledgeColor;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeCollectionView extends KnowledgeCollection {
  entryCount: number;
  /** Agent Profiles whose `knowledgeCollections` include this collection. */
  profiles: { id: string; name: string }[];
}

export interface KnowledgeCollectionsResponse {
  collections: KnowledgeCollectionView[];
  /** Entries with no collection ("Unfiled"; only Global chats see them). */
  unfiledCount: number;
  totalEntries: number;
}

export interface CreateKnowledgeCollectionRequest {
  name: string;
  description?: string;
  color?: KnowledgeColor;
}

export interface UpdateKnowledgeCollectionRequest {
  name?: string;
  description?: string;
  color?: KnowledgeColor;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * How far an entry is in the graph:
 * - `pending` — saved and searchable by text and meaning; not linked yet.
 * - `linked` — its concepts are in the graph.
 * - `failed` — the last run could not extract it (see the status's `lastError`).
 */
export type KnowledgeLinkState = "pending" | "linked" | "failed";

export interface KnowledgeEntrySource {
  by: "agent" | "user";
  /** The chat that saved it (`by: "agent"`). */
  sessionId?: string;
}

export interface KnowledgeEntryMeta {
  /** `ke_` + 12 lowercase base32 chars. Also the myKG input file stem. */
  id: string;
  title: string;
  /** Free-form: "post", "thread", "article", "note", "case study"… Default "note". */
  kind: string;
  /** Display name, e.g. "Om Patel". */
  author: string | null;
  /** Without the "@", e.g. "om_patel5". */
  handle: string | null;
  url: string | null;
  /** When the original was posted (ISO date or date-time), if known. */
  postedAt: string | null;
  savedAt: string;
  updatedAt: string;
  savedFrom: KnowledgeEntrySource;
  /** Collection ids; may be empty (Unfiled). */
  collections: string[];
  /** sha256 hex of the normalized body (dedup and embedding cache key). */
  contentHash: string;
  linkState: KnowledgeLinkState;
}

export interface KnowledgeEntry extends KnowledgeEntryMeta {
  /** The verbatim text (site chrome stripped, never paraphrased). */
  body: string;
}

export interface KnowledgeEntrySummary extends KnowledgeEntryMeta {
  /** One or two lines from the body (the best-matching passage in search results). */
  snippet: string;
  /** Concepts linked to this entry that the caller can see. */
  linkCount: number;
  /** Ready-made Markdown citation; see {@link knowledgeCitation}. */
  citation: string;
}

export interface KnowledgeEntriesQuery {
  /** Collection id, or "unfiled", or absent for every visible entry. */
  collection?: string;
  /** Newest first. */
  cursor?: string;
  limit?: number;
  /**
   * {@link KnowledgeSearchFilters} lists on the query string (`kinds`, `authors`, `years`): comma-separated,
   * or a JSON array of strings (a value starting with "[") when a value itself holds a comma — see
   * {@link encodeKnowledgeFilterList}. Plus ISO bounds (`postedAfter`, `postedBefore`, `savedAfter`,
   * `savedBefore`); same meaning as in search.
   */
  kinds?: string;
  authors?: string;
  years?: string;
  postedAfter?: string;
  postedBefore?: string;
  savedAfter?: string;
  savedBefore?: string;
}

export interface KnowledgeEntriesResponse {
  entries: KnowledgeEntrySummary[];
  nextCursor: string | null;
}

export interface UpdateKnowledgeEntryRequest {
  title?: string;
  body?: string;
  kind?: string;
  author?: string | null;
  handle?: string | null;
  url?: string | null;
  postedAt?: string | null;
  /** Collection ids or names. Changing only these never queues a linking run. */
  collections?: string[];
}

/**
 * POST /api/knowledge/entries/merge — duplicates into one entry, in one step. The kept entry gets
 * the union of every merged entry's collections (its own first, then the others' in `ids` order),
 * and `title`/`body` when given; the others are deleted. Every id must be visible to the caller
 * (else `KNOWLEDGE_NOT_FOUND`), and everything is checked before anything changes.
 */
export interface KnowledgeMergeRequest {
  /** 2..KNOWLEDGE_MERGE_MAX_ENTRIES distinct entry ids. */
  ids: string[];
  /** The entry kept, one of `ids`; absent: {@link knowledgeMergeKeep}. */
  keep?: string;
  title?: string;
  /** The combined text when the caller rewrote it; absent: the kept entry's text stays. */
  body?: string;
  /** The calling chat (set by the daemon for tool calls). */
  sessionId?: string;
}

export interface KnowledgeMergeResponse {
  /** The kept entry, as an entry edit answers it. */
  kept: KnowledgeEntryDetail;
  /** The other ids, all deleted. */
  deleted: string[];
}

/**
 * The entry a merge keeps when the caller names none: the oldest by `savedAt` (an unreadable date
 * counts as oldest), the same instant keeping the smaller id. The daemon and the Knowledge tab's
 * duplicate banner both use it, so the banner's confirmation names the entry the daemon keeps.
 */
export function knowledgeMergeKeep<T extends Pick<KnowledgeEntryMeta, "id" | "savedAt">>(entries: readonly T[]): T | null {
  const time = (iso: string): number => {
    const at = Date.parse(iso);
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
  };
  let keep: T | null = null;
  for (const entry of entries) {
    if (!keep) {
      keep = entry;
      continue;
    }
    const a = time(entry.savedAt);
    const b = time(keep.savedAt);
    if (a < b || (a === b && entry.id < keep.id)) keep = entry;
  }
  return keep;
}

// ---------------------------------------------------------------------------
// Saving (agents; the UI edits through UpdateKnowledgeEntryRequest)
// ---------------------------------------------------------------------------

export interface KnowledgeSaveItem {
  body: string;
  title?: string;
  kind?: string;
  author?: string;
  handle?: string;
  url?: string;
  postedAt?: string;
  /** At least one. Each is a collection id or an exact (case-insensitive) collection name. */
  collections: string[];
}

export interface KnowledgeSaveRequest {
  entries: KnowledgeSaveItem[];
  /** Collections to create first; `entries[].collections` may then name them. */
  newCollections?: { name: string; description: string }[];
  /** The calling chat (set by the daemon for tool calls). */
  sessionId?: string;
}

export interface KnowledgeSaveResult {
  entryId: string;
  /**
   * `saved` — a new entry. `duplicate` — same URL or near-identical text as
   * `entryId`, which was kept; any new collections were added to it.
   */
  status: "saved" | "duplicate";
  title: string;
  collections: string[];
  citation: string;
  /**
   * A `saved` entry's possible duplicates already in the knowledge base (similar in meaning at or
   * above the model's `duplicate` threshold, any collection the caller can see), closest first, up
   * to 3. Empty when none, or when the entry could not be embedded within the save's wait.
   * Absent from an older daemon.
   */
  similar?: { entryId: string; title: string; similarity: number; citation: string }[];
  /**
   * The similarity cluster a `saved` entry joins, by its nearest embedded neighbours (phase 2 spec,
   * "Novelty"); null when none or not embedded within the save's wait. Absent from an older daemon.
   */
  cluster?: { label: string | null; size: number } | null;
}

export interface KnowledgeSaveResponse {
  results: KnowledgeSaveResult[];
  createdCollections: KnowledgeCollection[];
  /** Whether a linking run is now queued or already running. */
  linking: "queued" | "running" | "not-needed";
}

// ---------------------------------------------------------------------------
// Concepts and the graph
// ---------------------------------------------------------------------------

export interface KnowledgeConceptRef {
  /** myKG's node id (`<type>-<slug>`). */
  id: string;
  name: string;
  type: string;
}

export interface KnowledgeConcept extends KnowledgeConceptRef {
  confidence: number;
  description: string | null;
  aliases: string[];
  attributes: Record<string, { value: string; confidence: number }>;
}

export interface KnowledgeEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  confidence: number;
}

export interface KnowledgeGraphNode extends KnowledgeConceptRef {
  confidence: number;
  /** Visible collections of the visible entries behind it (colouring). */
  collections: string[];
  /** Visible entries behind it. */
  entryCount: number;
  /** Visible edges touching it. */
  degree: number;
}

export interface KnowledgeGraphQuery {
  /** Comma-separated collection ids; absent = every visible collection. */
  collections?: string;
  /** A concept or entry id: return its neighbourhood instead of the whole graph. */
  focus?: string;
  /** Hops around `focus` (1..3, default 2). */
  depth?: number;
  limit?: number;
}

export interface KnowledgeGraphResponse {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeEdge[];
  /** True when the visible graph had more than `limit` nodes and the most connected were kept. */
  truncated: boolean;
  totals: { nodes: number; edges: number };
}

export interface KnowledgeConceptDetail {
  concept: KnowledgeConcept;
  collections: string[];
  entries: KnowledgeEntrySummary[];
  neighbors: { edge: KnowledgeEdge; concept: KnowledgeConceptRef }[];
  /** Concepts merged into this one as duplicates (phase 2 spec, "Concept merges"). Absent from an older daemon. */
  mergedFrom?: KnowledgeConceptRef[];
  /** Other concepts of the same type close in meaning but below the merge bar, closest first, up to 5. Absent from an older daemon. */
  similarConcepts?: { concept: KnowledgeConceptRef; similarity: number }[];
}

/** One automatic concept merge (phase 2 spec, "Concept merges"). */
export interface KnowledgeConceptMerge {
  /** Stable id of the merge (undo with DELETE `knowledgeRoutes.conceptMerge(id)`). */
  id: string;
  /** The concept kept. */
  into: KnowledgeConceptRef;
  /** The concepts folded into it. */
  merged: KnowledgeConceptRef[];
  /** Lowest pairwise similarity of the names that justified it. */
  similarity: number;
  createdAt: string;
}

export interface KnowledgeConceptMergesResponse {
  merges: KnowledgeConceptMerge[];
}

/** Why another entry is shown next to this one (labelled in the UI, spec "Similar entries"). */
export type KnowledgeRelatedReason =
  /** Close in meaning (embeddings). */
  | { kind: "meaning"; similarity: number }
  /**
   * Shares concepts from linking (up to 3 named). `distinctive`: those of them that few entries
   * have (phase 2 spec, "Hybrid similarity"); absent from an older daemon.
   */
  | { kind: "concepts"; concepts: KnowledgeConceptRef[]; shared: number; distinctive?: KnowledgeConceptRef[] }
  /**
   * The two entries disagree (phase 2 spec, "Contradictions"): `graph` when a concept of one
   * contradicts a concept of the other in the concept graph, `checked` when an LLM pair check said so.
   */
  | { kind: "contradicts"; source: "graph" | "checked"; pairs: { from: KnowledgeConceptRef; to: KnowledgeConceptRef }[]; note: string | null }
  /** Same author or handle. */
  | { kind: "author"; value: string };

export interface KnowledgeSimilarEntry {
  entry: KnowledgeEntrySummary;
  /** Cosine similarity of the two entries' mean vectors; null when either has no vectors yet. */
  similarity: number | null;
  /** At least one reason; meaning first when present. */
  reasons: KnowledgeRelatedReason[];
}

export interface KnowledgeEntryDetail {
  entry: KnowledgeEntry;
  concepts: KnowledgeConceptRef[];
  /** Other visible entries sharing concepts with this one, most shared first. */
  related: KnowledgeEntrySummary[];
  /**
   * Visible entries related by meaning, shared concepts or author, best first, each with its
   * reasons (up to 8). Absent from a daemon that predates the retrieval spec.
   */
  similar?: KnowledgeSimilarEntry[];
  /**
   * Visible entries so close in meaning they may be the same content (similarity ≥ the model's
   * `duplicate` threshold), closest first, up to 3. Absent from an older daemon.
   */
  possibleDuplicates?: KnowledgeSimilarEntry[];
  /**
   * What this entry adds (phase 2 spec, "Novelty"): its concepts no other visible entry has, and the
   * similarity cluster it sits in. Absent from an older daemon, or before the entry has vectors.
   */
  novelty?: KnowledgeNovelty;
  citation: string;
}

export interface KnowledgeNovelty {
  /** Concepts linked only to this entry among visible entries (up to 8). */
  newConcepts: KnowledgeConceptRef[];
  /** The similarity-graph cluster the entry falls in (null: none yet, or a singleton). */
  cluster: { label: string | null; size: number } | null;
}

/** GET /api/knowledge/items/:id — an entry id (`ke_…`) or a concept id. */
export type KnowledgeItemResponse =
  | { kind: "entry"; entry: KnowledgeEntryDetail }
  | { kind: "concept"; concept: KnowledgeConceptDetail };

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Metadata filters, applied while ranking (like visibility). Every list matches any of its values
 * (case-insensitive); different fields must all match. Date bounds are inclusive ISO dates or
 * date-times compared on the first 10 characters (YYYY-MM-DD) when either side is a bare date; an
 * entry with no `postedAt` never passes a `posted…` bound.
 */
export interface KnowledgeSearchFilters {
  /** Entry kinds ("thread", "article", …). */
  kinds?: string[];
  /** Author display names or handles (with or without "@"). */
  authors?: string[];
  /** Years ("2026") of `postedAt`, else `savedAt` — the same rule as the `years` facet. */
  years?: string[];
  postedAfter?: string;
  postedBefore?: string;
  savedAfter?: string;
  savedBefore?: string;
}

/**
 * - `relevance` — best match first (the default).
 * - `recent` — best match first with a recency boost (newer `postedAt`, else `savedAt`, ranks higher).
 * - `newest` — every match, newest saved first.
 */
export type KnowledgeSearchSort = "relevance" | "recent" | "newest";

export interface KnowledgeSearchRequest {
  /** Words to search by meaning and keywords. At least one of `query` and `similarTo`. */
  query?: string;
  /** Narrow to these (ids or names); always intersected with what the caller can see. */
  collections?: string[];
  limit?: number;
  /** The calling chat (set by the daemon for tool calls). */
  sessionId?: string;
  filters?: KnowledgeSearchFilters;
  /** "More like these" entry ids (visible ones; ≤ KNOWLEDGE_SIMILAR_MAX_EXAMPLES). Never returned themselves. */
  similarTo?: string[];
  /** "Less like these" entry ids, with `similarTo` (≤ KNOWLEDGE_SIMILAR_MAX_EXAMPLES). Never returned themselves. */
  unlike?: string[];
  sort?: KnowledgeSearchSort;
  /** Spread near-identical results apart (maximal marginal relevance). Default true. */
  diverse?: boolean;
  /** The previous page's `nextCursor`; the rest of the request must be the same. */
  cursor?: string;
  /** Also count kinds, authors, collections and years over every match. */
  facets?: boolean;
}

/** Which signals found an entry. */
export type KnowledgeMatchSignal = "keyword" | "meaning" | "concept" | "similar";

/** How strong a hit is, from the model's thresholds and keyword coverage (spec "Match bands"). */
export type KnowledgeMatchBand = "strong" | "good" | "weak";

export interface KnowledgeEntryMatch {
  band: KnowledgeMatchBand;
  /** At least one; in this order when several. */
  via: KnowledgeMatchSignal[];
  /** Query words found in the entry (lowercased as typed, for highlighting). */
  terms: string[];
  /** The best-matching chunk: character offsets into the body, its index and the entry's chunk count. Null when no chunk matched by meaning. */
  passage: { start: number; end: number; chunk: number; chunks: number } | null;
  /** Concepts through which the graph expansion found it (up to 3). */
  concepts: KnowledgeConceptRef[];
}

export type KnowledgeSearchHit =
  | {
      kind: "entry";
      score: number;
      entry: KnowledgeEntrySummary;
      /** Absent from a daemon that predates the retrieval spec. */
      match?: KnowledgeEntryMatch;
    }
  | {
      kind: "concept";
      score: number;
      concept: KnowledgeConceptRef & { description: string | null };
      /** Up to 3 visible entries behind it, best first. */
      entryIds: string[];
      /** The same entries with their titles (absent from an older daemon). */
      entries?: { id: string; title: string }[];
    };

export interface KnowledgeFacetCount {
  /** The value to filter by (a kind, an author's handle or name, a collection id, a year). */
  value: string;
  /** How to show it ("Om Patel (@om_patel5)", a collection's name, "2026"). */
  label: string;
  count: number;
}

/** Counts over a set of entries, most frequent first, up to KNOWLEDGE_FACET_MAX_VALUES each. */
export interface KnowledgeFacets {
  kinds: KnowledgeFacetCount[];
  authors: KnowledgeFacetCount[];
  /** Visible collections only; Unfiled as value "unfiled" for callers that see it. */
  collections: KnowledgeFacetCount[];
  /** By `postedAt`, else `savedAt`, newest year first. */
  years: KnowledgeFacetCount[];
}

export interface KnowledgeSearchResponse {
  hits: KnowledgeSearchHit[];
  /** The collection ids the search ran over. */
  searched: string[];
  /** Entries matching in all (every page; capped at KNOWLEDGE_SEARCH_MAX_RESULTS). Absent from an older daemon. */
  total?: number;
  /** Pass as `cursor` for the next page; null on the last. Absent from an older daemon. */
  nextCursor?: string | null;
  /** With `facets: true`. */
  facets?: KnowledgeFacets;
}

/** POST /api/knowledge/facets: counts over every visible entry the narrowing and filters keep. */
export interface KnowledgeFacetsRequest {
  collections?: string[];
  filters?: KnowledgeSearchFilters;
  sessionId?: string;
}

export interface KnowledgeFacetsResponse {
  facets: KnowledgeFacets;
  total: number;
}

// ---------------------------------------------------------------------------
// Similarity graph (spec "Similarity layer")
// ---------------------------------------------------------------------------

export interface KnowledgeSimilarityGraphQuery {
  /** Comma-separated collection ids; absent = every visible collection. */
  collections?: string;
  /** Neighbours per entry, 1..KNOWLEDGE_SIMILARITY_GRAPH_MAX_K (default KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_K). */
  k?: number;
  /** Most recent embedded entries kept, 1..KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES. */
  limit?: number;
}

export interface KnowledgeSimilarityNode {
  /** The entry id. */
  id: string;
  title: string;
  kind: string;
  author: string | null;
  handle: string | null;
  savedAt: string;
  /** Visible collections. */
  collections: string[];
  /** Index into `clusters`. */
  cluster: number;
  degree: number;
}

export interface KnowledgeSimilarityEdge {
  from: string;
  to: string;
  similarity: number;
  /** Part of the maximum spanning forest (keeps every component connected); the rest are k-NN edges. */
  tree: boolean;
  /** Concepts the two entries share (phase 2 spec, "Hybrid similarity"). Absent from an older daemon. */
  sharedConcepts?: number;
  /** True when the two entries contradict each other (phase 2 spec, "Contradictions"). Absent from an older daemon. */
  contradicts?: boolean;
}

export interface KnowledgeSimilarityCluster {
  id: number;
  /** Entries in it. */
  size: number;
  /** Its most distinctive topic concept, else its most distinctive title words; null for singletons. */
  label: string | null;
  /** Its most distinctive concepts, best first, up to 5 (phase 2 spec, "Cross navigation"). Absent from an older daemon. */
  concepts?: KnowledgeConceptRef[];
}

export interface KnowledgeSimilarityGraphResponse {
  nodes: KnowledgeSimilarityNode[];
  edges: KnowledgeSimilarityEdge[];
  /** Largest first; a cluster = entries joined by edges at or above the model's `good` threshold. */
  clusters: KnowledgeSimilarityCluster[];
  /** True when more embedded entries were visible than `limit` (the most recent were kept). */
  truncated: boolean;
  /** Visible entries, and how many of them have vectors (only those can be drawn). */
  totals: { entries: number; embedded: number };
}

// ---------------------------------------------------------------------------
// Insights (phase 2 spec, "Insights")
// ---------------------------------------------------------------------------

export interface KnowledgeInsightsQuery {
  /** Comma-separated collection ids or names (`unfiled` for entries in none); default every visible one. */
  collections?: string;
  /** Up to this many items per list (1–50, default 20). */
  limit?: number;
}

export interface KnowledgeContradiction {
  a: KnowledgeEntrySummary;
  b: KnowledgeEntrySummary;
  /** Similarity of the two entries; null when either has no vectors. */
  similarity: number | null;
  source: "graph" | "checked";
  /** The contradicting concept pairs (graph), possibly empty for `checked`. */
  pairs: { from: KnowledgeConceptRef; to: KnowledgeConceptRef }[];
  /** The checker's one-line explanation, or the graph edge's context; null when none. */
  note: string | null;
}

export interface KnowledgeBridge {
  entry: KnowledgeEntrySummary;
  /** The similarity clusters it links (its own first). */
  clusters: { label: string | null; size: number }[];
  /** The concepts that tie it to the other clusters. */
  concepts: KnowledgeConceptRef[];
}

export interface KnowledgeSingleSource {
  concept: KnowledgeConceptRef;
  /** The only visible entry behind it. */
  entry: KnowledgeEntrySummary;
  /** The entry's cluster, when it has one. */
  cluster: { label: string | null; size: number } | null;
}

export interface KnowledgeLinkGap {
  a: KnowledgeEntrySummary;
  b: KnowledgeEntrySummary;
  similarity: number;
  /** True when both are queued for re-linking. */
  queued: boolean;
}

/** GET /api/knowledge/insights */
export interface KnowledgeInsightsResponse {
  contradictions: KnowledgeContradiction[];
  bridges: KnowledgeBridge[];
  singleSource: KnowledgeSingleSource[];
  gaps: KnowledgeLinkGap[];
  /** Totals before `limit`. */
  totals: { contradictions: number; bridges: number; singleSource: number; gaps: number };
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * What a caller sees. `all` — a chat with no profile, or the user in the UI
 * (includes Unfiled). Otherwise exactly these collection ids (no Unfiled).
 */
export type KnowledgeVisibility = { kind: "all" } | { kind: "collections"; ids: string[] };

// ---------------------------------------------------------------------------
// Linking (status, runs, workers)
// ---------------------------------------------------------------------------

export type KnowledgeRunMode = "full" | "update" | "grow-schema" | "rebuild";

export type KnowledgePauseReason = "usage-limit" | "no-account" | "not-installed" | "plugin-off" | "error";

export type KnowledgeLinkingState =
  | { state: "idle" }
  | { state: "queued"; pendingEntries: number; startsAt: string }
  | {
      state: "running";
      runId: string;
      mode: KnowledgeRunMode;
      /** myKG step name, e.g. "pass2". */
      step: string;
      /** Tasks answered / created so far in this run, when known. */
      progress: { done: number; total: number } | null;
      /** Entries saved since the run started (they go in the next run). */
      pendingEntries: number;
    }
  | { state: "paused"; reason: KnowledgePauseReason; message: string; resumesAt: string | null; pendingEntries: number };

export interface KnowledgeRunSummary {
  id: string;
  mode: KnowledgeRunMode;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  entries: number;
  tasks: number;
  tokensIn: number;
  tokensOut: number;
  outcome: "running" | "ok" | "failed" | "cancelled";
  error: string | null;
}

export interface KnowledgeWorkerView {
  sessionId: string;
  accountId: string;
  runId: string;
  state: "running" | "done" | "failed";
  tasks: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface KnowledgeStatus {
  enabled: boolean;
  installed: boolean;
  entries: number;
  concepts: number;
  edges: number;
  collections: number;
  /** Entries whose last run could not link them (`linkState: "failed"`); see `lastError`. 0 from a daemon that predates it. */
  failedEntries: number;
  linking: KnowledgeLinkingState;
  lastRun: KnowledgeRunSummary | null;
  recentRuns: KnowledgeRunSummary[];
  workers: KnowledgeWorkerView[];
  tokens: { week: { in: number; out: number }; total: { in: number; out: number } };
  lastError: { message: string; at: string } | null;
  /**
   * Whether the embedding model is installed and loadable: false while an install still has to fetch
   * it (search then ranks on text only, and nothing gets embedded). Absent from a daemon that predates it.
   */
  embeddingModelReady?: boolean;
  /**
   * Automatic re-linking (phase 2 spec, "Re-linking"): entries still to re-link with neighbour
   * context or as link gaps; null when nothing is left. Absent from an older daemon.
   */
  relink?: { pending: number; done: number; total: number } | null;
  /** Automatic concept merges in effect (phase 2 spec). Absent from an older daemon. */
  conceptMerges?: number;
}

export interface KnowledgeRebuildEstimate {
  entries: number;
  /** Expected myKG tasks (LLM calls) for a full re-extraction: an approximation (`KnowledgeLinkingService.rebuildEstimate`). */
  tasks: number;
}

// ---------------------------------------------------------------------------
// Settings (stored on the plugin's plugins.json record)
// ---------------------------------------------------------------------------

export interface KnowledgeSettings {
  /**
   * Which Claude accounts the indexing sessions use, chosen like a workflow Agent block's chain
   * entry (strategy, allow-list or fixed order, the System login, usage caps, unknown usage), with
   * the same failover and shared cooldowns. A record with no policy (written before policies
   * existed) answers the policy its legacy `accountId` meant ({@link knowledgeLegacyAccountPolicy}).
   */
  accountPolicy: AccountPolicy;
  /**
   * Legacy, for older clients: the account a fixed policy tries first, else null (automatic) —
   * {@link knowledgeLegacyAccountId} of `accountPolicy`.
   */
  accountId: string | null;
  /** Model for worker sessions; null = the default (a Sonnet-class model). */
  model: string | null;
  /** Worker sessions at once, KNOWLEDGE_CONCURRENCY_MIN..MAX. */
  concurrency: number;
}

/** `SYSTEM_ACCOUNT_ID` (index.ts) — restated so this module does not import the root at load. */
const SYSTEM_ACCOUNT = "system";

/** Automatic on a host with Claude accounts: the least used of them (the policy schema's defaults). */
export const KNOWLEDGE_DEFAULT_ACCOUNT_POLICY: AccountPolicy = {
  strategy: "least-used",
  includeSystem: false,
  soonestResetWindow: "weekly",
  leastUsedMetric: "max",
  unknownUsage: "last"
};

export const KNOWLEDGE_DEFAULT_SETTINGS: KnowledgeSettings = {
  accountPolicy: KNOWLEDGE_DEFAULT_ACCOUNT_POLICY,
  accountId: null,
  model: null,
  concurrency: KNOWLEDGE_CONCURRENCY_DEFAULT
};

/**
 * A partial update. `accountPolicy` is validated with the workflow policy schema, and no account
 * it lists may be another agent's (an id no account has is kept and skipped at run time, as in a
 * workflow; `SYSTEM_ACCOUNT_ID` is the System login). `accountId` is the legacy
 * field an older client sends: ignored when `accountPolicy` is sent too, else it replaces the
 * stored policy with the one it means (null, or a Claude account id).
 */
export interface UpdateKnowledgeSettingsRequest {
  accountPolicy?: AccountPolicy;
  /** @deprecated Send `accountPolicy`. */
  accountId?: string | null;
  model?: string | null;
  concurrency?: number;
}

/**
 * The policy a legacy `accountId` means, over the host's Claude account ids in their order, exactly
 * as the plugin chose before policies existed: null (automatic) is the least used Claude account,
 * with the System login only while there is no Claude account; an id is a fixed order with that
 * account first and every other Claude account after it.
 */
export function knowledgeLegacyAccountPolicy(accountId: string | null, claudeAccountIds: readonly string[]): AccountPolicy {
  if (accountId === null) return { ...KNOWLEDGE_DEFAULT_ACCOUNT_POLICY, includeSystem: claudeAccountIds.length === 0 };
  return {
    ...KNOWLEDGE_DEFAULT_ACCOUNT_POLICY,
    strategy: "fixed",
    accounts: [accountId, ...claudeAccountIds.filter((id) => id !== accountId)],
    includeSystem: accountId === SYSTEM_ACCOUNT
  };
}

/**
 * The legacy `accountId` written beside a policy, so a build that predates policies still runs
 * sensibly: a fixed order's first account (that build tries it first, then every other Claude
 * account), else null (automatic: the least used Claude account). A reader also compares it with
 * the stored `accountId` to tell that an older build changed the account after the policy was saved.
 */
export function knowledgeLegacyAccountId(policy: AccountPolicy): string | null {
  return policy.strategy === "fixed" ? (policy.accounts?.[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Worker protocol (only sessions owned by the plugin)
// ---------------------------------------------------------------------------

/** `owner` of a worker agent-chat session the plugin started. */
export interface KnowledgeSessionOwner {
  kind: "knowledge-indexer";
  runId: string;
}

export interface KnowledgeWorkerTask {
  taskId: string;
  /** myKG step, e.g. "pass1", "pass2", "normalize_names". */
  step: string;
  /**
   * The task's instructions (myKG's system prompt). `null` when identical to
   * the instructions of `sameInstructionsAs`, which this session already received.
   */
  instructions: string | null;
  sameInstructionsAs: string | null;
  /** The task's input (myKG's user prompt). */
  input: string;
  maxTokens: number;
  /** Tasks still waiting after this one (a hint; more may arrive). */
  remaining: number;
}

export type KnowledgeWorkerNextResponse =
  | { kind: "task"; task: KnowledgeWorkerTask }
  /** No task now and the run is finishing, or this session reached its budget: end the turn. */
  | { kind: "done"; reason: "run-finished" | "session-budget" | "run-cancelled" };

export interface KnowledgeWorkerSubmitRequest {
  sessionId?: string;
  taskId: string;
  /** The raw answer: the JSON text myKG expects. */
  answer: string;
}

export type KnowledgeWorkerSubmitResponse =
  | { accepted: true; next: KnowledgeWorkerNextResponse }
  | { accepted: false; error: string };

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** Link scheme of an entry citation: `[Title · @handle](orquester-knowledge:entry/<id>)`. */
export const KNOWLEDGE_CITATION_SCHEME = "orquester-knowledge:";

const CITATION_LABEL_MAX = 80;

/** The Markdown citation agents paste verbatim. Readable as plain text. */
export function knowledgeCitation(entry: Pick<KnowledgeEntryMeta, "id" | "title" | "author" | "handle">): string {
  const who = entry.handle ? `@${entry.handle}` : entry.author;
  let label = entry.title.replace(/\s+/g, " ").trim() || entry.id;
  if (label.length > CITATION_LABEL_MAX) label = `${label.slice(0, CITATION_LABEL_MAX - 1)}…`;
  if (who) label = `${label} · ${who}`;
  label = label.replace(/[[\]\\]/g, (ch) => `\\${ch}`);
  return `[${label}](${KNOWLEDGE_CITATION_SCHEME}entry/${entry.id})`;
}

/** The entry id of a citation href, or null if it is not one. */
export function parseKnowledgeCitationHref(href: string): { kind: "entry"; id: string } | null {
  if (!href.startsWith(KNOWLEDGE_CITATION_SCHEME)) return null;
  const match = /^entry\/(ke_[a-z0-9]{12})$/.exec(href.slice(KNOWLEDGE_CITATION_SCHEME.length));
  return match ? { kind: "entry", id: match[1]! } : null;
}

// ---------------------------------------------------------------------------
// Routes and events
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export const knowledgeRoutes = {
  status: "/api/knowledge/status",
  settings: "/api/knowledge/settings",
  collections: "/api/knowledge/collections",
  collection: (id: string): string => `/api/knowledge/collections/${enc(id)}`,
  entries: "/api/knowledge/entries",
  entry: (id: string): string => `/api/knowledge/entries/${enc(id)}`,
  /** POST; static, so it never reaches `entries/:id` (entry ids are `ke_…`). */
  entriesMerge: "/api/knowledge/entries/merge",
  item: (id: string): string => `/api/knowledge/items/${enc(id)}`,
  graph: "/api/knowledge/graph",
  similarityGraph: "/api/knowledge/similarity-graph",
  insights: "/api/knowledge/insights",
  conceptMerges: "/api/knowledge/concepts/merges",
  conceptMerge: (id: string): string => `/api/knowledge/concepts/merges/${enc(id)}`,
  search: "/api/knowledge/search",
  facets: "/api/knowledge/facets",
  save: "/api/knowledge/save",
  rebuild: "/api/knowledge/rebuild",
  rebuildEstimate: "/api/knowledge/rebuild/estimate",
  workerNext: "/api/knowledge/worker/next",
  workerSubmit: "/api/knowledge/worker/submit"
} as const;

/** The `/events` channel. */
export const KNOWLEDGE_CHANNEL = "knowledge";
/** Payload: `KnowledgeStatus`. */
export const KNOWLEDGE_STATUS_EVENT = "knowledge.status";
/** Payload: `KnowledgeChangedEvent` — refetch what it names. */
export const KNOWLEDGE_CHANGED_EVENT = "knowledge.changed";

export interface KnowledgeChangedEvent {
  /** Entries added, edited, relabelled or deleted. */
  entryIds?: string[];
  collections?: boolean;
  /** The graph was reloaded after a run. */
  graph?: boolean;
}

/** Error codes the knowledge routes answer with (`{ code, message }`). */
export type KnowledgeErrorCode =
  | "KNOWLEDGE_DISABLED"
  | "KNOWLEDGE_NOT_INSTALLED"
  | "KNOWLEDGE_NOT_FOUND"
  | "KNOWLEDGE_INVALID"
  | "KNOWLEDGE_COLLECTION_EXISTS"
  | "KNOWLEDGE_UNKNOWN_COLLECTION"
  /** Settings: the indexing policy lists another agent's account, or a legacy `accountId` is no Claude account. */
  | "KNOWLEDGE_UNKNOWN_ACCOUNT"
  | "KNOWLEDGE_TOO_LARGE"
  | "KNOWLEDGE_NOT_A_WORKER"
  | "KNOWLEDGE_BUSY"
  /** An unexpected failure (500). */
  | "KNOWLEDGE_ERROR";

/**
 * A filter list as sent on the entries route's query string: comma-separated, or a JSON array when a
 * value holds a comma (so "Smith, John" stays one author). Undefined for an empty list.
 */
export function encodeKnowledgeFilterList(values: readonly string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values.some((value) => value.includes(",") || value.trimStart().startsWith("[")) ? JSON.stringify(values) : values.join(",");
}
