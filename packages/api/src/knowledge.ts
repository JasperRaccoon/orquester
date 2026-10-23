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

// ---------------------------------------------------------------------------
// Limits (enforced by the daemon; the UI mirrors them)
// ---------------------------------------------------------------------------

/** One entry's body, in UTF-8 bytes. */
export const KNOWLEDGE_ENTRY_MAX_BYTES = 200_000;
/** Items in one save request (a bulk import is split by the agent). */
export const KNOWLEDGE_SAVE_MAX_ENTRIES = 100;
export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_COLLECTIONS_MAX = 100;
export const KNOWLEDGE_COLLECTION_NAME_MAX = 60;
export const KNOWLEDGE_COLLECTION_DESCRIPTION_MAX = 200;
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 8;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 25;
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
  /** Collection ids. Changing only these never queues a linking run. */
  collections?: string[];
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
}

export interface KnowledgeEntryDetail {
  entry: KnowledgeEntry;
  concepts: KnowledgeConceptRef[];
  /** Other visible entries sharing concepts with this one, most shared first. */
  related: KnowledgeEntrySummary[];
  citation: string;
}

/** GET /api/knowledge/items/:id — an entry id (`ke_…`) or a concept id. */
export type KnowledgeItemResponse =
  | { kind: "entry"; entry: KnowledgeEntryDetail }
  | { kind: "concept"; concept: KnowledgeConceptDetail };

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface KnowledgeSearchRequest {
  query: string;
  /** Narrow to these (ids or names); always intersected with what the caller can see. */
  collections?: string[];
  limit?: number;
  /** The calling chat (set by the daemon for tool calls). */
  sessionId?: string;
}

export type KnowledgeSearchHit =
  | { kind: "entry"; score: number; entry: KnowledgeEntrySummary }
  | {
      kind: "concept";
      score: number;
      concept: KnowledgeConceptRef & { description: string | null };
      /** Up to 3 visible entries behind it, best first. */
      entryIds: string[];
    };

export interface KnowledgeSearchResponse {
  hits: KnowledgeSearchHit[];
  /** The collection ids the search ran over. */
  searched: string[];
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
  linking: KnowledgeLinkingState;
  lastRun: KnowledgeRunSummary | null;
  recentRuns: KnowledgeRunSummary[];
  workers: KnowledgeWorkerView[];
  tokens: { week: { in: number; out: number }; total: { in: number; out: number } };
  lastError: { message: string; at: string } | null;
}

export interface KnowledgeRebuildEstimate {
  entries: number;
  /** Expected myKG tasks (LLM calls) for a full re-extraction. */
  tasks: number;
}

// ---------------------------------------------------------------------------
// Settings (stored on the plugin's plugins.json record)
// ---------------------------------------------------------------------------

export interface KnowledgeSettings {
  /** Claude account for worker sessions; null = automatic (first usable, with failover). */
  accountId: string | null;
  /** Model for worker sessions; null = the default (a Sonnet-class model). */
  model: string | null;
  /** Worker sessions at once, KNOWLEDGE_CONCURRENCY_MIN..MAX. */
  concurrency: number;
}

export const KNOWLEDGE_DEFAULT_SETTINGS: KnowledgeSettings = {
  accountId: null,
  model: null,
  concurrency: KNOWLEDGE_CONCURRENCY_DEFAULT
};

export type UpdateKnowledgeSettingsRequest = Partial<KnowledgeSettings>;

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
  item: (id: string): string => `/api/knowledge/items/${enc(id)}`,
  graph: "/api/knowledge/graph",
  search: "/api/knowledge/search",
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
  | "KNOWLEDGE_TOO_LARGE"
  | "KNOWLEDGE_NOT_A_WORKER"
  | "KNOWLEDGE_BUSY";
