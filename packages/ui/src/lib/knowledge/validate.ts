/**
 * Knowledge Graph — wire validation for every `knowledgeRoutes` answer and
 * `knowledge` event payload the Knowledge view reads, before any of it reaches
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
  type KnowledgeEntryMatch,
  type KnowledgeEntrySummary,
  type KnowledgeFacetCount,
  type KnowledgeFacets,
  type KnowledgeFacetsResponse,
  type KnowledgeGraphNode,
  type KnowledgeGraphResponse,
  type KnowledgeItemResponse,
  type KnowledgeLinkState,
  type KnowledgeLinkingState,
  type KnowledgeMatchBand,
  type KnowledgeMatchSignal,
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
import { readAccountPolicy, type AccountPolicy } from "@orquester/config";
import type { KnowledgeNovelty, KnowledgeRelatedReason, KnowledgeSimilarEntry } from "@orquester/api";
import type { KnowledgeSimilarityCluster, KnowledgeSimilarityEdge, KnowledgeSimilarityGraphResponse, KnowledgeSimilarityNode } from "@orquester/api";
import type {
  KnowledgeBridge,
  KnowledgeConceptMerge,
  KnowledgeConceptMergesResponse,
  KnowledgeContradiction,
  KnowledgeInsightsResponse,
  KnowledgeLinkGap,
  KnowledgeSingleSource
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

/** Concept refs, each once (and never `exceptId`); null when `value` is not an array. */
function conceptRefs(value: unknown, exceptId?: string): KnowledgeConceptRef[] | null {
  const refs = list(value, parseKnowledgeConceptRef);
  if (!refs) return null;
  const seen = new Set<string>(exceptId === undefined ? [] : [exceptId]);
  return refs.filter((ref) => !seen.has(ref.id) && (seen.add(ref.id), true));
}

/** A 0..1 similarity, clamped; null when it is not a finite number. */
function unitSimilarity(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

/**
 * A similarity-cluster reference (`{ label, size }`); null when it is not an object or its size is
 * not a whole number of one or more (no cluster to name: "a cluster of 0 entries").
 */
export function parseKnowledgeClusterRef(value: unknown): { label: string | null; size: number } | null {
  if (!isRecord(value) || typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 1) return null;
  return { label: typeof value.label === "string" && value.label.trim() !== "" ? value.label : null, size: value.size };
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

// ---------------------------------------------------------------------------
// The similarity graph
// ---------------------------------------------------------------------------

function parseKnowledgeSimilarityNode(value: unknown): KnowledgeSimilarityNode | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  return {
    id: value.id,
    title: str(value.title),
    kind: str(value.kind) || "note",
    author: nullableStr(value.author),
    handle: nullableStr(value.handle),
    savedAt: str(value.savedAt),
    collections: strings(value.collections),
    // Unreadable: -1, an index no cluster has (drawn like a singleton, as one the answer lacks).
    cluster: typeof value.cluster === "number" && Number.isInteger(value.cluster) && value.cluster >= 0 ? value.cluster : -1,
    degree: count(value.degree)
  };
}

function parseKnowledgeSimilarityEdge(value: unknown): KnowledgeSimilarityEdge | null {
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string" || value.from === value.to) return null;
  const edge: KnowledgeSimilarityEdge = { from: value.from, to: value.to, similarity: num(value.similarity), tree: bool(value.tree) };
  // Phase 2 fields: absent from an older daemon (and anything unreadable reads as absent).
  if (typeof value.sharedConcepts === "number" && Number.isFinite(value.sharedConcepts)) edge.sharedConcepts = count(value.sharedConcepts);
  if (typeof value.contradicts === "boolean") edge.contradicts = value.contradicts;
  return edge;
}

/** A cluster's concepts the contract allows (its best first). */
const CLUSTER_CONCEPTS_MAX = 5;

/**
 * Nodes deduplicated by id; an edge whose ends are not both in the answer is left out, and two
 * edges between the same pair (either direction) are one, a tree edge when either was. Clusters
 * keep their positions (nodes index into them): an unreadable one reads as an empty, unlabelled
 * cluster, and an absent list as none. Null for a broken envelope (no node or edge list).
 */
export function parseKnowledgeSimilarityGraphResponse(value: unknown): KnowledgeSimilarityGraphResponse | null {
  if (!isRecord(value)) return null;
  const rawNodes = list(value.nodes, parseKnowledgeSimilarityNode);
  const rawEdges = list(value.edges, parseKnowledgeSimilarityEdge);
  if (!rawNodes || !rawEdges) return null;
  const nodes: KnowledgeSimilarityNode[] = [];
  const ids = new Set<string>();
  for (const node of rawNodes) {
    if (ids.has(node.id)) continue;
    ids.add(node.id);
    nodes.push(node);
  }
  const edges: KnowledgeSimilarityEdge[] = [];
  const byPair = new Map<string, KnowledgeSimilarityEdge>();
  for (const edge of rawEdges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    const pair = edge.from < edge.to ? `${edge.from}\u0000${edge.to}` : `${edge.to}\u0000${edge.from}`;
    const seen = byPair.get(pair);
    if (seen) {
      if (edge.tree) seen.tree = true;
      if (edge.contradicts) seen.contradicts = true;
      continue;
    }
    byPair.set(pair, edge);
    edges.push(edge);
  }
  const clusters: KnowledgeSimilarityCluster[] = Array.isArray(value.clusters)
    ? value.clusters.map((item: unknown, index: number) => {
        if (!isRecord(item)) return { id: index, size: nodes.filter((n) => n.cluster === index).length, label: null };
        const cluster: KnowledgeSimilarityCluster = {
          id: typeof item.id === "number" ? count(item.id) : index,
          size: typeof item.size === "number" ? count(item.size) : nodes.filter((n) => n.cluster === index).length,
          label: typeof item.label === "string" && item.label.trim() !== "" ? item.label : null
        };
        // Absent from an older daemon.
        const concepts = conceptRefs(item.concepts);
        if (concepts) cluster.concepts = concepts.slice(0, CLUSTER_CONCEPTS_MAX);
        return cluster;
      })
    : [];
  const totals = isRecord(value.totals) ? value.totals : {};
  const embedded = typeof totals.embedded === "number" ? count(totals.embedded) : nodes.length;
  return {
    nodes,
    edges,
    clusters,
    truncated: bool(value.truncated),
    totals: { entries: Math.max(typeof totals.entries === "number" ? count(totals.entries) : embedded, embedded), embedded }
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
  const detail: KnowledgeConceptDetail = {
    concept,
    collections: strings(value.collections),
    entries: list(value.entries, parseKnowledgeEntrySummary) ?? [],
    neighbors
  };
  // Phase 2 (absent from an older daemon): never the concept itself, each concept once.
  const mergedFrom = conceptRefs(value.mergedFrom, concept.id);
  if (mergedFrom) detail.mergedFrom = mergedFrom;
  const similar = list(value.similarConcepts, parseSimilarConcept);
  if (similar) {
    const seen = new Set<string>([concept.id]);
    detail.similarConcepts = similar.filter((item) => !seen.has(item.concept.id) && (seen.add(item.concept.id), true));
  }
  // Every visible entry id (newest first), where `entries` holds the newest 50 in full.
  if (Array.isArray(value.entryIds)) detail.entryIds = [...new Set(strings(value.entryIds).filter((id) => id !== ""))];
  return detail;
}

function parseSimilarConcept(value: unknown): { concept: KnowledgeConceptRef; similarity: number } | null {
  if (!isRecord(value)) return null;
  const concept = parseKnowledgeConceptRef(value.concept);
  const similarity = unitSimilarity(value.similarity);
  return concept && similarity !== null ? { concept, similarity } : null;
}

function parseConceptPair(value: unknown): { from: KnowledgeConceptRef; to: KnowledgeConceptRef } | null {
  if (!isRecord(value)) return null;
  const from = parseKnowledgeConceptRef(value.from);
  const to = parseKnowledgeConceptRef(value.to);
  return from && to ? { from, to } : null;
}

/** Where a contradiction comes from; an unknown source (a newer daemon's) reads as the concept graph's. */
const contradictionSource = (value: unknown): "graph" | "checked" => (value === "checked" ? "checked" : "graph");

/** A daemon note, shown as text; null when empty. */
const noteOf = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * Why an entry is shown beside another; null for one this client cannot read (an unknown kind from
 * a newer daemon, a meaning without a similarity, an author without a value).
 */
function parseKnowledgeRelatedReason(value: unknown): KnowledgeRelatedReason | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "meaning":
      return typeof value.similarity === "number" && Number.isFinite(value.similarity)
        ? { kind: "meaning", similarity: Math.min(1, Math.max(-1, value.similarity)) }
        : null;
    case "concepts": {
      const concepts = list(value.concepts, parseKnowledgeConceptRef) ?? [];
      const reason: KnowledgeRelatedReason = { kind: "concepts", concepts, shared: Math.max(count(value.shared), concepts.length) };
      // Absent from an older daemon.
      const distinctive = conceptRefs(value.distinctive);
      if (distinctive) reason.distinctive = distinctive;
      return reason;
    }
    case "contradicts":
      return { kind: "contradicts", source: contradictionSource(value.source), pairs: list(value.pairs, parseConceptPair) ?? [], note: noteOf(value.note) };
    case "author":
      return typeof value.value === "string" && value.value.trim() !== "" ? { kind: "author", value: value.value } : null;
    default:
      return null;
  }
}

/** One similar entry: null without a readable entry; unreadable reasons are left out (a reason kind repeats once). */
function parseKnowledgeSimilarEntry(value: unknown): KnowledgeSimilarEntry | null {
  if (!isRecord(value)) return null;
  const entry = parseKnowledgeEntrySummary(value.entry);
  if (!entry) return null;
  const similarity =
    typeof value.similarity === "number" && Number.isFinite(value.similarity) ? Math.min(1, Math.max(-1, value.similarity)) : null;
  const seen = new Set<string>();
  const reasons = (list(value.reasons, parseKnowledgeRelatedReason) ?? []).filter((reason) => {
    if (seen.has(reason.kind)) return false;
    seen.add(reason.kind);
    return true;
  });
  return { entry, similarity, reasons };
}

/** A similar-entries list: absent (an older daemon) when it is not an array; never the entry itself, each entry once. */
function parseSimilarList(value: unknown, selfId: string): KnowledgeSimilarEntry[] | undefined {
  const items = list(value, parseKnowledgeSimilarEntry);
  if (!items) return undefined;
  const ids = new Set<string>([selfId]);
  return items.filter((item) => {
    if (ids.has(item.entry.id)) return false;
    ids.add(item.entry.id);
    return true;
  });
}

function parseEntryDetail(value: unknown): KnowledgeEntryDetail | null {
  if (!isRecord(value)) return null;
  const entry = parseKnowledgeEntry(value.entry);
  if (!entry) return null;
  const detail: KnowledgeEntryDetail = {
    entry,
    concepts: list(value.concepts, parseKnowledgeConceptRef) ?? [],
    related: (list(value.related, parseKnowledgeEntrySummary) ?? []).filter((r) => r.id !== entry.id),
    citation: typeof value.citation === "string" && value.citation ? value.citation : knowledgeCitation(entry)
  };
  const similar = parseSimilarList(value.similar, entry.id);
  if (similar) detail.similar = similar;
  const possibleDuplicates = parseSimilarList(value.possibleDuplicates, entry.id);
  if (possibleDuplicates) detail.possibleDuplicates = possibleDuplicates;
  const novelty = parseKnowledgeNovelty(value.novelty);
  if (novelty) detail.novelty = novelty;
  return detail;
}

/** What an entry adds; null (absent, as from an older daemon) when it is not an object. */
export function parseKnowledgeNovelty(value: unknown): KnowledgeNovelty | null {
  if (!isRecord(value)) return null;
  return { newConcepts: conceptRefs(value.newConcepts) ?? [], cluster: parseKnowledgeClusterRef(value.cluster) };
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
// Concept merges (phase 2 spec, "Concept merges")
// ---------------------------------------------------------------------------

/** One merge: null without an id or a concept kept; unreadable merged concepts are left out. */
export function parseKnowledgeConceptMerge(value: unknown): KnowledgeConceptMerge | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  const into = parseKnowledgeConceptRef(value.into);
  if (!into) return null;
  return {
    id: value.id,
    into,
    merged: conceptRefs(value.merged, into.id) ?? [],
    similarity: unitSimilarity(value.similarity) ?? 0,
    createdAt: str(value.createdAt)
  };
}

/** The concept-merges answer; null without a merge list. */
export function parseKnowledgeConceptMergesResponse(value: unknown): KnowledgeConceptMergesResponse | null {
  if (!isRecord(value)) return null;
  const merges = list(value.merges, parseKnowledgeConceptMerge);
  return merges ? { merges } : null;
}

// ---------------------------------------------------------------------------
// Insights (phase 2 spec, "Insights")
// ---------------------------------------------------------------------------

/** Two different readable entries, or null. */
function entryPair(a: unknown, b: unknown): { a: KnowledgeEntrySummary; b: KnowledgeEntrySummary } | null {
  const first = parseKnowledgeEntrySummary(a);
  const second = parseKnowledgeEntrySummary(b);
  return first && second && first.id !== second.id ? { a: first, b: second } : null;
}

export function parseKnowledgeContradiction(value: unknown): KnowledgeContradiction | null {
  if (!isRecord(value)) return null;
  const pair = entryPair(value.a, value.b);
  if (!pair) return null;
  return {
    ...pair,
    similarity: unitSimilarity(value.similarity),
    source: contradictionSource(value.source),
    pairs: list(value.pairs, parseConceptPair) ?? [],
    note: noteOf(value.note)
  };
}

export function parseKnowledgeBridge(value: unknown): KnowledgeBridge | null {
  if (!isRecord(value)) return null;
  const entry = parseKnowledgeEntrySummary(value.entry);
  if (!entry) return null;
  return { entry, clusters: list(value.clusters, parseKnowledgeClusterRef) ?? [], concepts: conceptRefs(value.concepts) ?? [] };
}

export function parseKnowledgeSingleSource(value: unknown): KnowledgeSingleSource | null {
  if (!isRecord(value)) return null;
  const concept = parseKnowledgeConceptRef(value.concept);
  const entry = parseKnowledgeEntrySummary(value.entry);
  if (!concept || !entry) return null;
  return { concept, entry, cluster: parseKnowledgeClusterRef(value.cluster) };
}

export function parseKnowledgeLinkGap(value: unknown): KnowledgeLinkGap | null {
  if (!isRecord(value)) return null;
  const pair = entryPair(value.a, value.b);
  const similarity = unitSimilarity(value.similarity);
  if (!pair || similarity === null) return null;
  return { ...pair, similarity, queued: bool(value.queued) };
}

/**
 * The insights answer. An item this client cannot read is left out, and a missing list reads as
 * empty; a total reads as its list's length when unreadable, and never as less. Null when it is not
 * an object or carries none of the four lists.
 */
export function parseKnowledgeInsightsResponse(value: unknown): KnowledgeInsightsResponse | null {
  if (!isRecord(value)) return null;
  const contradictions = list(value.contradictions, parseKnowledgeContradiction);
  const bridges = list(value.bridges, parseKnowledgeBridge);
  const singleSource = list(value.singleSource, parseKnowledgeSingleSource);
  const gaps = list(value.gaps, parseKnowledgeLinkGap);
  if (!contradictions && !bridges && !singleSource && !gaps) return null;
  const totals = isRecord(value.totals) ? value.totals : {};
  const total = (field: unknown, shown: number) => Math.max(typeof field === "number" && Number.isFinite(field) ? count(field) : 0, shown);
  return {
    contradictions: contradictions ?? [],
    bridges: bridges ?? [],
    singleSource: singleSource ?? [],
    gaps: gaps ?? [],
    totals: {
      contradictions: total(totals.contradictions, contradictions?.length ?? 0),
      bridges: total(totals.bridges, bridges?.length ?? 0),
      singleSource: total(totals.singleSource, singleSource?.length ?? 0),
      gaps: total(totals.gaps, gaps?.length ?? 0)
    }
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const BANDS: ReadonlySet<string> = new Set<KnowledgeMatchBand>(["strong", "good", "weak"]);
/** The contract's fixed order for `via`. */
const SIGNAL_ORDER: readonly KnowledgeMatchSignal[] = ["keyword", "meaning", "similar", "concept"];

const isIndex = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function parseMatchPassage(value: unknown): KnowledgeEntryMatch["passage"] {
  if (!isRecord(value)) return null;
  const { start, end, chunk, chunks } = value;
  if (!isIndex(start) || !isIndex(end) || !isIndex(chunk) || !isIndex(chunks)) return null;
  if (end < start || chunks < 1 || chunk >= chunks) return null;
  return { start, end, chunk, chunks };
}

/**
 * Why a search found an entry. Null — the hit then carries no `match`, as from a daemon that
 * predates it — when it is not an object, its band is not one this client knows, or it names no
 * signal this client knows; a bad passage reads as none, and unreadable terms or concepts are left out.
 */
function parseKnowledgeEntryMatch(value: unknown): KnowledgeEntryMatch | null {
  if (!isRecord(value) || typeof value.band !== "string" || !BANDS.has(value.band)) return null;
  const named = new Set(strings(value.via));
  const via = SIGNAL_ORDER.filter((signal) => named.has(signal));
  if (via.length === 0) return null;
  const terms = [...new Set(strings(value.terms).map((term) => term.trim()).filter((term) => term !== ""))];
  return {
    band: value.band as KnowledgeMatchBand,
    via,
    terms,
    passage: parseMatchPassage(value.passage),
    concepts: list(value.concepts, parseKnowledgeConceptRef) ?? []
  };
}

function parseIdTitle(value: unknown): { id: string; title: string } | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  return { id: value.id, title: str(value.title) };
}

function parseSearchHit(value: unknown): KnowledgeSearchHit | null {
  if (!isRecord(value)) return null;
  const score = num(value.score);
  if (value.kind === "entry") {
    const entry = parseKnowledgeEntrySummary(value.entry);
    if (!entry) return null;
    const match = parseKnowledgeEntryMatch(value.match);
    return match ? { kind: "entry", score, entry, match } : { kind: "entry", score, entry };
  }
  if (value.kind === "concept") {
    const ref = parseKnowledgeConceptRef(value.concept);
    if (!ref) return null;
    const description = isRecord(value.concept) ? nullableStr(value.concept.description) : null;
    const hit: KnowledgeSearchHit = { kind: "concept", score, concept: { ...ref, description }, entryIds: strings(value.entryIds) };
    const entries = list(value.entries, parseIdTitle);
    if (entries) hit.entries = entries;
    return hit;
  }
  return null;
}

function parseFacetCount(value: unknown): KnowledgeFacetCount | null {
  if (!isRecord(value) || typeof value.value !== "string" || value.value === "") return null;
  return { value: value.value, label: str(value.label) || value.value, count: count(value.count) };
}

/** Facet counts, each value once; a list that is missing or not an array reads as empty. Null when it is not an object. */
function parseKnowledgeFacets(value: unknown): KnowledgeFacets | null {
  if (!isRecord(value)) return null;
  const facet = (field: unknown): KnowledgeFacetCount[] => {
    const seen = new Set<string>();
    const out: KnowledgeFacetCount[] = [];
    for (const c of list(field, parseFacetCount) ?? []) {
      if (seen.has(c.value)) continue;
      seen.add(c.value);
      out.push(c);
    }
    return out;
  };
  return { kinds: facet(value.kinds), authors: facet(value.authors), collections: facet(value.collections), years: facet(value.years) };
}

/** POST /facets' answer; null without readable `facets`. A missing total reads as the kinds' sum (every entry has one kind). */
export function parseKnowledgeFacetsResponse(value: unknown): KnowledgeFacetsResponse | null {
  if (!isRecord(value)) return null;
  const facets = parseKnowledgeFacets(value.facets);
  if (!facets) return null;
  const total = typeof value.total === "number" && Number.isFinite(value.total) ? count(value.total) : facets.kinds.reduce((sum, c) => sum + c.count, 0);
  return { facets, total };
}

/**
 * A search answer. `total`, `nextCursor` and `facets` stay absent when the daemon sent none (one
 * that predates paging): callers tell an older daemon by the missing `total`.
 */
export function parseKnowledgeSearchResponse(value: unknown): KnowledgeSearchResponse | null {
  if (!isRecord(value)) return null;
  const hits = list(value.hits, parseSearchHit);
  if (!hits) return null;
  const answer: KnowledgeSearchResponse = { hits, searched: strings(value.searched) };
  if (typeof value.total === "number" && Number.isFinite(value.total)) answer.total = count(value.total);
  if (typeof value.nextCursor === "string" && value.nextCursor !== "") answer.nextCursor = value.nextCursor;
  else if (value.nextCursor === null || value.nextCursor === "") answer.nextCursor = null;
  const facets = value.facets === undefined ? null : parseKnowledgeFacets(value.facets);
  if (facets) answer.facets = facets;
  return answer;
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

/** A status the view can render, or null without `enabled` / `installed`. */
export function parseKnowledgeStatus(value: unknown): KnowledgeStatus | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || typeof value.installed !== "boolean") return null;
  const tokens = isRecord(value.tokens) ? value.tokens : {};
  const lastError =
    isRecord(value.lastError) && typeof value.lastError.message === "string"
      ? { message: value.lastError.message, at: str(value.lastError.at) }
      : null;
  const status: KnowledgeStatus = {
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
  // Absent from a daemon that predates it (and anything not a boolean reads as absent).
  if (typeof value.embeddingModelReady === "boolean") status.embeddingModelReady = value.embeddingModelReady;
  // Phase 2 (absent from an older daemon); `relink` null means nothing is left to re-link.
  if (value.relink === null) status.relink = null;
  else if (isRecord(value.relink) && typeof value.relink.total === "number") {
    const total = count(value.relink.total);
    status.relink = { pending: Math.min(count(value.relink.pending), total), done: Math.min(count(value.relink.done), total), total };
  }
  if (typeof value.conceptMerges === "number" && Number.isFinite(value.conceptMerges)) status.conceptMerges = count(value.conceptMerges);
  return status;
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
 * The indexing settings as this client read a daemon's answer. `accountPolicy` is null when the
 * answer carried none: that daemon predates account policies, ignores one sent to it and takes
 * only `accountId` (null = automatic, or a Claude account id).
 */
export type KnowledgeSettingsAnswer = Omit<KnowledgeSettings, "accountPolicy"> & { accountPolicy: AccountPolicy | null };

/**
 * The indexing settings, field by field (an older or newer daemon's answer may
 * lack one or carry another type): a bad field reads as its default, as the
 * daemon reads its own stored record; the account policy field by field too,
 * and null when the answer has none (see {@link KnowledgeSettingsAnswer}).
 * Null when it is not an object.
 */
export function parseKnowledgeSettings(value: unknown): KnowledgeSettingsAnswer | null {
  if (!isRecord(value)) return null;
  const accountId = typeof value.accountId === "string" && value.accountId.trim() !== "" ? value.accountId : null;
  const accountPolicy = readAccountPolicy(value.accountPolicy) ?? null;
  const model = typeof value.model === "string" && value.model.trim() !== "" ? value.model : null;
  const concurrency =
    typeof value.concurrency === "number" &&
    Number.isInteger(value.concurrency) &&
    value.concurrency >= KNOWLEDGE_CONCURRENCY_MIN &&
    value.concurrency <= KNOWLEDGE_CONCURRENCY_MAX
      ? value.concurrency
      : KNOWLEDGE_DEFAULT_SETTINGS.concurrency;
  return { accountPolicy, accountId, model, concurrency };
}

/** A rebuild estimate: both counts must be numbers (an estimate missing one is no estimate). */
export function parseKnowledgeRebuildEstimate(value: unknown): KnowledgeRebuildEstimate | null {
  if (!isRecord(value)) return null;
  const isCount = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!isCount(value.entries) || !isCount(value.tasks)) return null;
  return { entries: count(value.entries), tasks: count(value.tasks) };
}
