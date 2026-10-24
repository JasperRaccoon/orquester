/**
 * Knowledge Graph — wire validation for every `knowledgeRoutes` answer and
 * `knowledge` event payload the Knowledge tab reads, before any of it reaches
 * shared UI state.
 *
 * The rule throughout (as in `lib/boxes/validate.ts`): a record this client
 * cannot reason about (no id, no name) is left out on its own; a bad optional
 * field is repaired to its empty value; a broken envelope (not an object, the
 * list not an array) makes the whole answer `null` so the caller keeps what it
 * holds. No React, no store.
 */

import {
  KNOWLEDGE_COLORS,
  KNOWLEDGE_CONCURRENCY_MAX,
  KNOWLEDGE_CONCURRENCY_MIN,
  KNOWLEDGE_DEFAULT_SETTINGS,
  knowledgeCitation,
  type KnowledgeChangedEvent,
  type KnowledgeCollection,
  type KnowledgeCollectionView,
  type KnowledgeCollectionsResponse,
  type KnowledgeColor,
  type KnowledgeConcept,
  type KnowledgeConceptDetail,
  type KnowledgeConceptRef,
  type KnowledgeEdge,
  type KnowledgeEntriesResponse,
  type KnowledgeEntry,
  type KnowledgeEntryDetail,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeGraphNode,
  type KnowledgeGraphResponse,
  type KnowledgeItemResponse,
  type KnowledgeLinkState,
  type KnowledgeLinkingState,
  type KnowledgePauseReason,
  type KnowledgeRebuildEstimate,
  type KnowledgeRunMode,
  type KnowledgeRunSummary,
  type KnowledgeSearchHit,
  type KnowledgeSearchResponse,
  type KnowledgeSettings,
  type KnowledgeStatus,
  type KnowledgeWorkerView
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const nullableStr = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const count = (value: unknown): number => Math.max(0, Math.floor(num(value)));
const bool = (value: unknown, fallback = false): boolean => (typeof value === "boolean" ? value : fallback);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Each item through `parse`, the unreadable ones left out; null when `value` is not an array. */
function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

const COLORS: ReadonlySet<string> = new Set(KNOWLEDGE_COLORS);

/** A palette key; an unknown one (a newer daemon's) reads as the first colour. */
export function parseKnowledgeColor(value: unknown): KnowledgeColor {
  return typeof value === "string" && COLORS.has(value) ? (value as KnowledgeColor) : KNOWLEDGE_COLORS[0]!;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function parseKnowledgeCollection(value: unknown): KnowledgeCollection | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "" || typeof value.name !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    description: str(value.description),
    color: parseKnowledgeColor(value.color),
    createdAt: str(value.createdAt),
    updatedAt: str(value.updatedAt)
  };
}

function parseProfileRef(value: unknown): { id: string; name: string } | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return { id: value.id, name: str(value.name, value.id) };
}

export function parseKnowledgeCollectionView(value: unknown): KnowledgeCollectionView | null {
  const base = parseKnowledgeCollection(value);
  if (!base || !isRecord(value)) return null;
  return { ...base, entryCount: count(value.entryCount), profiles: list(value.profiles, parseProfileRef) ?? [] };
}

export function parseKnowledgeCollectionsResponse(value: unknown): KnowledgeCollectionsResponse | null {
  if (!isRecord(value)) return null;
  const collections = list(value.collections, parseKnowledgeCollectionView);
  if (!collections) return null;
  const unfiledCount = count(value.unfiledCount);
  const fallbackTotal = collections.reduce((sum, c) => sum + c.entryCount, 0) + unfiledCount;
  return { collections, unfiledCount, totalEntries: typeof value.totalEntries === "number" ? count(value.totalEntries) : fallbackTotal };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const LINK_STATES: ReadonlySet<string> = new Set<KnowledgeLinkState>(["pending", "linked", "failed"]);

export function parseKnowledgeEntryMeta(value: unknown): KnowledgeEntryMeta | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  const source = isRecord(value.savedFrom) ? value.savedFrom : {};
  const savedFrom: KnowledgeEntryMeta["savedFrom"] = { by: source.by === "user" ? "user" : "agent" };
  if (typeof source.sessionId === "string") savedFrom.sessionId = source.sessionId;
  return {
    id: value.id,
    title: str(value.title),
    kind: str(value.kind) || "note",
    author: nullableStr(value.author),
    handle: nullableStr(value.handle),
    url: nullableStr(value.url),
    postedAt: nullableStr(value.postedAt),
    savedAt: str(value.savedAt),
    updatedAt: str(value.updatedAt),
    savedFrom,
    collections: strings(value.collections),
    contentHash: str(value.contentHash),
    linkState: typeof value.linkState === "string" && LINK_STATES.has(value.linkState) ? (value.linkState as KnowledgeLinkState) : "pending"
  };
}

export function parseKnowledgeEntry(value: unknown): KnowledgeEntry | null {
  const meta = parseKnowledgeEntryMeta(value);
  if (!meta || !isRecord(value) || typeof value.body !== "string") return null;
  return { ...meta, body: value.body };
}

export function parseKnowledgeEntrySummary(value: unknown): KnowledgeEntrySummary | null {
  const meta = parseKnowledgeEntryMeta(value);
  if (!meta || !isRecord(value)) return null;
  return {
    ...meta,
    snippet: str(value.snippet),
    linkCount: count(value.linkCount),
    citation: typeof value.citation === "string" && value.citation ? value.citation : knowledgeCitation(meta)
  };
}

export function parseKnowledgeEntriesResponse(value: unknown): KnowledgeEntriesResponse | null {
  if (!isRecord(value)) return null;
  const entries = list(value.entries, parseKnowledgeEntrySummary);
  if (!entries) return null;
  return { entries, nextCursor: nullableStr(value.nextCursor) };
}

// ---------------------------------------------------------------------------
// Concepts and the graph
// ---------------------------------------------------------------------------

export function parseKnowledgeConceptRef(value: unknown): KnowledgeConceptRef | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  return { id: value.id, name: str(value.name, value.id) || value.id, type: str(value.type) || "concept" };
}

function parseAttributes(value: unknown): KnowledgeConcept["attributes"] {
  const out: KnowledgeConcept["attributes"] = {};
  if (!isRecord(value)) return out;
  for (const [key, attr] of Object.entries(value)) {
    if (isRecord(attr) && typeof attr.value === "string") out[key] = { value: attr.value, confidence: num(attr.confidence) };
  }
  return out;
}

export function parseKnowledgeConcept(value: unknown): KnowledgeConcept | null {
  const ref = parseKnowledgeConceptRef(value);
  if (!ref || !isRecord(value)) return null;
  return {
    ...ref,
    confidence: num(value.confidence),
    description: nullableStr(value.description),
    aliases: strings(value.aliases),
    attributes: parseAttributes(value.attributes)
  };
}

export function parseKnowledgeEdge(value: unknown): KnowledgeEdge | null {
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string") return null;
  return {
    id: str(value.id) || `${value.from}->${value.to}:${str(value.type)}`,
    type: str(value.type),
    from: value.from,
    to: value.to,
    confidence: num(value.confidence)
  };
}

export function parseKnowledgeGraphNode(value: unknown): KnowledgeGraphNode | null {
  const ref = parseKnowledgeConceptRef(value);
  if (!ref || !isRecord(value)) return null;
  return {
    ...ref,
    confidence: num(value.confidence),
    collections: strings(value.collections),
    entryCount: count(value.entryCount),
    degree: count(value.degree)
  };
}

/** Nodes deduplicated by id; edges whose ends are not both in the answer are left out. */
export function parseKnowledgeGraphResponse(value: unknown): KnowledgeGraphResponse | null {
  if (!isRecord(value)) return null;
  const rawNodes = list(value.nodes, parseKnowledgeGraphNode);
  const rawEdges = list(value.edges, parseKnowledgeEdge);
  if (!rawNodes || !rawEdges) return null;
  const ids = new Set<string>();
  const nodes: KnowledgeGraphNode[] = [];
  for (const node of rawNodes) {
    if (ids.has(node.id)) continue;
    ids.add(node.id);
    nodes.push(node);
  }
  const edgeIds = new Set<string>();
  const edges: KnowledgeEdge[] = [];
  for (const edge of rawEdges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edgeIds.has(edge.id)) continue;
    edgeIds.add(edge.id);
    edges.push(edge);
  }
  const totals = isRecord(value.totals) ? value.totals : {};
  return {
    nodes,
    edges,
    truncated: bool(value.truncated),
    totals: {
      nodes: typeof totals.nodes === "number" ? count(totals.nodes) : nodes.length,
      edges: typeof totals.edges === "number" ? count(totals.edges) : edges.length
    }
  };
}

function parseConceptDetail(value: unknown): KnowledgeConceptDetail | null {
  if (!isRecord(value)) return null;
  const concept = parseKnowledgeConcept(value.concept);
  if (!concept) return null;
  const neighbors =
    list(value.neighbors, (item) => {
      if (!isRecord(item)) return null;
      const edge = parseKnowledgeEdge(item.edge);
      const ref = parseKnowledgeConceptRef(item.concept);
      return edge && ref ? { edge, concept: ref } : null;
    }) ?? [];
  return {
    concept,
    collections: strings(value.collections),
    entries: list(value.entries, parseKnowledgeEntrySummary) ?? [],
    neighbors
  };
}

function parseEntryDetail(value: unknown): KnowledgeEntryDetail | null {
  if (!isRecord(value)) return null;
  const entry = parseKnowledgeEntry(value.entry);
  if (!entry) return null;
  return {
    entry,
    concepts: list(value.concepts, parseKnowledgeConceptRef) ?? [],
    related: (list(value.related, parseKnowledgeEntrySummary) ?? []).filter((r) => r.id !== entry.id),
    citation: typeof value.citation === "string" && value.citation ? value.citation : knowledgeCitation(entry)
  };
}

export function parseKnowledgeItemResponse(value: unknown): KnowledgeItemResponse | null {
  if (!isRecord(value)) return null;
  if (value.kind === "entry") {
    const entry = parseEntryDetail(value.entry);
    return entry ? { kind: "entry", entry } : null;
  }
  if (value.kind === "concept") {
    const concept = parseConceptDetail(value.concept);
    return concept ? { kind: "concept", concept } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function parseSearchHit(value: unknown): KnowledgeSearchHit | null {
  if (!isRecord(value)) return null;
  const score = num(value.score);
  if (value.kind === "entry") {
    const entry = parseKnowledgeEntrySummary(value.entry);
    return entry ? { kind: "entry", score, entry } : null;
  }
  if (value.kind === "concept") {
    const ref = parseKnowledgeConceptRef(value.concept);
    if (!ref) return null;
    const description = isRecord(value.concept) ? nullableStr(value.concept.description) : null;
    return { kind: "concept", score, concept: { ...ref, description }, entryIds: strings(value.entryIds) };
  }
  return null;
}

export function parseKnowledgeSearchResponse(value: unknown): KnowledgeSearchResponse | null {
  if (!isRecord(value)) return null;
  const hits = list(value.hits, parseSearchHit);
  if (!hits) return null;
  return { hits, searched: strings(value.searched) };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const RUN_MODES: ReadonlySet<string> = new Set<KnowledgeRunMode>(["full", "update", "grow-schema", "rebuild"]);
const PAUSE_REASONS: ReadonlySet<string> = new Set<KnowledgePauseReason>(["usage-limit", "no-account", "not-installed", "plugin-off", "error"]);
const OUTCOMES: ReadonlySet<string> = new Set<KnowledgeRunSummary["outcome"]>(["running", "ok", "failed", "cancelled"]);
const WORKER_STATES: ReadonlySet<string> = new Set<KnowledgeWorkerView["state"]>(["running", "done", "failed"]);

function parseProgress(value: unknown): { done: number; total: number } | null {
  if (!isRecord(value) || typeof value.done !== "number" || typeof value.total !== "number") return null;
  const total = count(value.total);
  return { done: Math.min(count(value.done), total), total };
}

/** The linking state; an unknown one (a newer daemon's) reads as idle rather than failing the status. */
export function parseKnowledgeLinkingState(value: unknown): KnowledgeLinkingState {
  if (!isRecord(value)) return { state: "idle" };
  switch (value.state) {
    case "queued":
      return { state: "queued", pendingEntries: count(value.pendingEntries), startsAt: str(value.startsAt) };
    case "running":
      return {
        state: "running",
        runId: str(value.runId),
        mode: typeof value.mode === "string" && RUN_MODES.has(value.mode) ? (value.mode as KnowledgeRunMode) : "update",
        step: str(value.step),
        progress: parseProgress(value.progress),
        pendingEntries: count(value.pendingEntries)
      };
    case "paused":
      return {
        state: "paused",
        reason: typeof value.reason === "string" && PAUSE_REASONS.has(value.reason) ? (value.reason as KnowledgePauseReason) : "error",
        message: str(value.message),
        resumesAt: nullableStr(value.resumesAt),
        pendingEntries: count(value.pendingEntries)
      };
    default:
      return { state: "idle" };
  }
}

function parseRunSummary(value: unknown): KnowledgeRunSummary | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    mode: typeof value.mode === "string" && RUN_MODES.has(value.mode) ? (value.mode as KnowledgeRunMode) : "update",
    startedAt: str(value.startedAt),
    finishedAt: nullableStr(value.finishedAt),
    durationMs: typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? value.durationMs : null,
    entries: count(value.entries),
    tasks: count(value.tasks),
    tokensIn: count(value.tokensIn),
    tokensOut: count(value.tokensOut),
    outcome: typeof value.outcome === "string" && OUTCOMES.has(value.outcome) ? (value.outcome as KnowledgeRunSummary["outcome"]) : "failed",
    error: nullableStr(value.error)
  };
}

function parseWorker(value: unknown): KnowledgeWorkerView | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") return null;
  return {
    sessionId: value.sessionId,
    accountId: str(value.accountId),
    runId: str(value.runId),
    state: typeof value.state === "string" && WORKER_STATES.has(value.state) ? (value.state as KnowledgeWorkerView["state"]) : "done",
    tasks: count(value.tasks),
    startedAt: str(value.startedAt),
    finishedAt: nullableStr(value.finishedAt)
  };
}

function parseTokens(value: unknown): { in: number; out: number } {
  return isRecord(value) ? { in: count(value.in), out: count(value.out) } : { in: 0, out: 0 };
}

/** A status the tab can render, or null without `enabled` / `installed`. */
export function parseKnowledgeStatus(value: unknown): KnowledgeStatus | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || typeof value.installed !== "boolean") return null;
  const tokens = isRecord(value.tokens) ? value.tokens : {};
  const lastError =
    isRecord(value.lastError) && typeof value.lastError.message === "string"
      ? { message: value.lastError.message, at: str(value.lastError.at) }
      : null;
  return {
    enabled: value.enabled,
    installed: value.installed,
    entries: count(value.entries),
    concepts: count(value.concepts),
    edges: count(value.edges),
    collections: count(value.collections),
    failedEntries: count(value.failedEntries),
    linking: parseKnowledgeLinkingState(value.linking),
    lastRun: parseRunSummary(value.lastRun),
    recentRuns: list(value.recentRuns, parseRunSummary) ?? [],
    workers: list(value.workers, parseWorker) ?? [],
    tokens: { week: parseTokens(tokens.week), total: parseTokens(tokens.total) },
    lastError
  };
}

/** `knowledge.changed`'s payload, or null when it is not an object. */
export function parseKnowledgeChangedEvent(value: unknown): KnowledgeChangedEvent | null {
  if (!isRecord(value)) return null;
  const event: KnowledgeChangedEvent = {};
  if (Array.isArray(value.entryIds)) event.entryIds = strings(value.entryIds);
  if (value.collections === true) event.collections = true;
  if (value.graph === true) event.graph = true;
  return event;
}

// ---------------------------------------------------------------------------
// Settings and the rebuild estimate (Settings → Plugins)
// ---------------------------------------------------------------------------

/**
 * The indexing settings, field by field (an older or newer daemon's answer may
 * lack one or carry another type): a bad field reads as its default, as the
 * daemon reads its own stored record. Null when it is not an object.
 */
export function parseKnowledgeSettings(value: unknown): KnowledgeSettings | null {
  if (!isRecord(value)) return null;
  const accountId = typeof value.accountId === "string" && value.accountId.trim() !== "" ? value.accountId : null;
  const model = typeof value.model === "string" && value.model.trim() !== "" ? value.model : null;
  const concurrency =
    typeof value.concurrency === "number" &&
    Number.isInteger(value.concurrency) &&
    value.concurrency >= KNOWLEDGE_CONCURRENCY_MIN &&
    value.concurrency <= KNOWLEDGE_CONCURRENCY_MAX
      ? value.concurrency
      : KNOWLEDGE_DEFAULT_SETTINGS.concurrency;
  return { accountId, model, concurrency };
}

/** A rebuild estimate: both counts must be numbers (an estimate missing one is no estimate). */
export function parseKnowledgeRebuildEstimate(value: unknown): KnowledgeRebuildEstimate | null {
  if (!isRecord(value)) return null;
  const isCount = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!isCount(value.entries) || !isCount(value.tasks)) return null;
  return { entries: count(value.entries), tasks: count(value.tasks) };
}
