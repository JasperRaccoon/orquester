import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  KNOWLEDGE_GRAPH_MAX_NODES,
  type KnowledgeConcept,
  type KnowledgeConceptRef,
  type KnowledgeEdge,
  type KnowledgeEntryMeta,
  type KnowledgeGraphNode,
  type KnowledgeGraphResponse
} from "@orquester/api";
import { isKnowledgeEntryId } from "@orquester/config";
import type { KnowledgeGraphPort, KnowledgeStorePort } from "../ports.ts";
import type { KnowledgeLogger } from "../store/errors.ts";
import { Bm25Index } from "./bm25.ts";
import type { KnowledgeConceptFamiliesPort } from "./concept-families.ts";
import { isSurveyEntry } from "./contradictions.ts";
import { tokenize } from "./text.ts";
import { type KnowledgeScope, entryInScope, visibleCollections } from "./visibility.ts";

/** A concept as held in memory: the contract's fields plus the entries it came from. */
export interface GraphConcept extends KnowledgeConcept {
  /** Entry ids from the node's `source_files` (only files named `<entryId>.md`). */
  entryIds: readonly string[];
  /**
   * Set on a concept other concepts were merged into (phase 2 spec, "Concept merges"): every concept
   * of the merge as myKG wrote it, the kept one first, each with the entries it came from. A scoped
   * caller is shown only what the sources a visible entry backs say (their names, descriptions,
   * attributes, aliases, confidence; `View.present`): the fields above are the unions, read by
   * unscoped callers only.
   */
  merge?: { id: string; sources: readonly GraphConceptSource[] };
}

/** One concept of a merge as myKG wrote it: what it brought, and the entries behind it. */
export interface GraphConceptSource extends KnowledgeConcept {
  entryIds: readonly string[];
}

/** One of myKG's edges a merged-graph edge stands for (a merge folds repeated edges into one). */
export interface GraphEdgeSource {
  id: string;
  confidence: number;
  entryIds: readonly string[] | null;
  context?: string;
}

/** An edge as held in memory. */
export interface GraphEdge extends KnowledgeEdge {
  /**
   * Entry ids from the edge's `source_files`, or `null` when the edge carries no provenance at all
   * (then it is visible iff both ends are). An edge whose files map to no entry has `[]` and is
   * never visible.
   */
  entryIds: readonly string[] | null;
  /** myKG's `context` attribute of a `contradicts` edge (what the two disagree on); absent otherwise. */
  context?: string;
  /**
   * Set when a merge folded repeated edges into this one: each with its own provenance, so a scoped
   * caller gets the id, confidence and context of the ones it can see only (the fields above are
   * the first one's id and the unions).
   */
  sources?: readonly GraphEdgeSource[];
}

/**
 * A merge the overlay applies (`concept-merges.json`, phase 2 spec "Concept merges"): `merged`
 * concepts of `type` folded into `into`.
 */
export interface ConceptMergeOverlay {
  id: string;
  type: string;
  into: string;
  merged: readonly string[];
  similarity: number;
  createdAt: string;
}

/** A merge in effect on the current graph: only its concepts that exist (at least one folded one). */
export interface EffectiveConceptMerge {
  id: string;
  type: string;
  into: KnowledgeConceptRef;
  merged: KnowledgeConceptRef[];
  similarity: number;
  createdAt: string;
}

/** myKG's graph as read, before the merge overlay: valid concepts and edges only. */
interface BaseGraph {
  concepts: ReadonlyMap<string, GraphConcept>;
  edges: readonly GraphEdge[];
}

interface Snapshot {
  concepts: ReadonlyMap<string, GraphConcept>;
  edges: readonly GraphEdge[];
  adjacency: ReadonlyMap<string, readonly GraphEdge[]>;
  entryConcepts: ReadonlyMap<string, readonly string[]>;
  /** Unmerged concepts by id; a merged concept per source ({@link sourceKey}). */
  bm25: Bm25Index;
  /** BM25 keys beyond one per concept (a search asks for that many more, then folds sources). */
  extraSearchKeys: number;
  /** Folded concept id → the concept it was merged into. */
  mergedInto: ReadonlyMap<string, string>;
  merges: readonly EffectiveConceptMerge[];
}

const EMPTY_BASE: BaseGraph = { concepts: new Map(), edges: [] };
const EMPTY: Snapshot = {
  concepts: new Map(),
  edges: [],
  adjacency: new Map(),
  entryConcepts: new Map(),
  bm25: new Bm25Index(),
  extraSearchKeys: 0,
  mergedInto: new Map(),
  merges: []
};

/** Similar concepts of a concept (by meaning), best first; ids of concepts in the current graph. */
export type SimilarConceptsProvider = (conceptId: string) => readonly { id: string; similarity: number }[];

/** Similar concepts a concept detail lists. */
const SIMILAR_CONCEPTS_LIMIT = 5;
/**
 * A name of at most this many words is short: its vector says little more than its type, so
 * "TikTok" (Channel) scores 0.95–0.96 against ChatGPT, Snapchat and iOS. Two concepts one of
 * which is short are listed as similar only when their names are related ({@link namesRelated})
 * or their similarity is at least {@link SHORT_NAME_SIMILAR_MIN}.
 */
const SHORT_NAME_WORDS = 3;
/**
 * 4,161 real concepts: 4,543 similar pairs with a short name, 2,287 with no related name; 347 of
 * those at 0.95 or more, nearly all siblings (Statsig ~ Optimizely 0.984, Supabase ~ Convex 0.984,
 * Reddit ~ Google 0.957); 3 at 0.985 or more (GBRAID ~ WBRAID 0.994).
 */
const SHORT_NAME_SIMILAR_MIN = 0.985;

/** `ke_xxx.md`, `input/ke_xxx.md`, `session_a/ke_xxx.md`, `ke_xxx.md::3` → `ke_xxx`. */
function entryIdOfSourceFile(sourceFile: string): string | null {
  const file = basename(sourceFile.split("::")[0]!.replace(/\\/g, "/"));
  const stem = file.endsWith(".md") ? file.slice(0, -3) : file;
  return isKnowledgeEntryId(stem) ? stem : null;
}

/** `null` only when the record carries no `source_files` list at all; an empty list is `[]`. */
function entryIdsOf(sourceFiles: unknown): string[] | null {
  if (!Array.isArray(sourceFiles)) return null;
  const ids = new Set<string>();
  for (const file of sourceFiles) {
    if (typeof file !== "string") continue;
    for (const part of file.split("|")) {
      const id = entryIdOfSourceFile(part);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function confidenceOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function attributeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(attributeText).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

/** The attribute's `{value, confidence}` with a text value, or null (myKG writes nulls for unknown attributes). */
function attributeOf(raw: unknown): { value: string; confidence: number } | null {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
    const value = attributeText((raw as { value: unknown }).value);
    return value === null ? null : { value, confidence: confidenceOf((raw as { confidence?: unknown }).confidence ?? 0.5) };
  }
  const value = attributeText(raw);
  return value === null ? null : { value, confidence: 0.5 };
}

function parseConcept(raw: unknown): GraphConcept | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const node = raw as Record<string, unknown>;
  if (typeof node.id !== "string" || node.id.length === 0 || typeof node.type !== "string") return null;
  const rawAttributes = node.attributes !== null && typeof node.attributes === "object" ? (node.attributes as Record<string, unknown>) : {};
  const attributes: Record<string, { value: string; confidence: number }> = Object.create(null);
  let name: string | null = null;
  let description: string | null = null;
  for (const [key, value] of Object.entries(rawAttributes)) {
    const attribute = attributeOf(value);
    if (!attribute) continue;
    if (key === "name") name = attribute.value;
    else if (key === "description") description = attribute.value;
    else attributes[key] = attribute;
  }
  if (typeof node.description === "string" && node.description.trim()) description = node.description.trim();
  const aliases = Array.isArray(node.aliases) ? node.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0) : [];
  return {
    id: node.id,
    name: name ?? node.id,
    type: node.type,
    confidence: confidenceOf(node.confidence),
    description,
    aliases,
    attributes: { ...attributes },
    entryIds: entryIdsOf(node.source_files) ?? []
  };
}

function parseEdge(raw: unknown): GraphEdge | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const edge = raw as Record<string, unknown>;
  if (typeof edge.id !== "string" || typeof edge.type !== "string" || typeof edge.from !== "string" || typeof edge.to !== "string") {
    return null;
  }
  const parsed: GraphEdge = { id: edge.id, type: edge.type, from: edge.from, to: edge.to, confidence: confidenceOf(edge.confidence), entryIds: entryIdsOf(edge.source_files) };
  if (edge.type === "contradicts" && edge.attributes !== null && typeof edge.attributes === "object") {
    const context = attributeOf((edge.attributes as Record<string, unknown>).context);
    if (context) parsed.context = context.value;
  }
  return parsed;
}

async function readJsonl(path: string, logger: KnowledgeLogger, what: string, digest?: ReturnType<typeof createHash>): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  digest?.update(`${text.length}\u0000`).update(text);
  const out: unknown[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) logger.warn(`knowledge: skipped ${bad} unreadable line(s) in ${what}`);
  return out;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false
  );
}

/** myKG's records parsed: the valid concepts and the edges between them. */
function parseGraph(nodes: readonly unknown[], edges: readonly unknown[]): { base: BaseGraph; skipped: number } {
  let skipped = 0;
  const concepts = new Map<string, GraphConcept>();
  for (const raw of nodes) {
    const concept = parseConcept(raw);
    if (!concept || concepts.has(concept.id)) {
      skipped += 1;
      continue;
    }
    concepts.set(concept.id, concept);
  }
  const edgeList: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const raw of edges) {
    const edge = parseEdge(raw);
    // myKG can leave an endpoint unresolved (an id no node has); such an edge is not a link.
    if (!edge || seen.has(edge.id) || edge.from === edge.to || !concepts.has(edge.from) || !concepts.has(edge.to)) {
      skipped += 1;
      continue;
    }
    seen.add(edge.id);
    edgeList.push(edge);
  }
  return { base: { concepts, edges: edgeList }, skipped };
}

function unionIds(lists: readonly (readonly string[])[]): string[] {
  const out = new Set<string>();
  for (const list of lists) for (const id of list) out.add(id);
  return [...out];
}

/** Names folded in become aliases of the kept concept: case-insensitively distinct, never its own name. */
function unionAliases(name: string, lists: readonly (readonly string[])[]): string[] {
  const seen = new Set([name.trim().toLowerCase()]);
  const out: string[] = [];
  for (const list of lists) {
    for (const alias of list) {
      const key = alias.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(alias);
    }
  }
  return out;
}

/**
 * What a merged concept says, from these of its sources (the visible ones, in merge order: the kept
 * concept first): the first one's id and name, the highest confidence, the first description, the
 * attributes (an earlier source's win), and every other name and alias as aliases.
 */
function combineSources(sources: readonly GraphConceptSource[]): KnowledgeConcept {
  const first = sources[0]!;
  const attributes: KnowledgeConcept["attributes"] = {};
  for (const source of [...sources].reverse()) Object.assign(attributes, source.attributes);
  return {
    id: first.id,
    name: first.name,
    type: first.type,
    confidence: Math.max(...sources.map((s) => s.confidence)),
    description: sources.find((s) => s.description !== null)?.description ?? null,
    aliases: unionAliases(first.name, [first.aliases, ...sources.slice(1).flatMap((s) => [[s.name], s.aliases])]),
    attributes
  };
}

/** An edge source as it stands alone. */
function edgeSourceOf(edge: GraphEdge): GraphEdgeSource {
  return { id: edge.id, confidence: edge.confidence, entryIds: edge.entryIds, ...(edge.context !== undefined ? { context: edge.context } : {}) };
}

/**
 * The merge overlay over myKG's graph (phase 2 spec, "Concept merges"): each merge whose kept
 * concept exists folds in its other concepts that exist (same type, not claimed by an earlier
 * merge). The kept concept gets the union of their entries, their names and aliases as aliases,
 * and its edges; edges are re-pointed, and self-loops and repeated (type, from, to) edges dropped.
 */
function applyConceptMerges(
  base: BaseGraph,
  merges: readonly ConceptMergeOverlay[]
): { concepts: Map<string, GraphConcept>; edges: GraphEdge[]; mergedInto: Map<string, string>; effective: EffectiveConceptMerge[] } {
  const claimed = new Set<string>();
  const mergedInto = new Map<string, string>();
  const effective: EffectiveConceptMerge[] = [];
  const replaced = new Map<string, GraphConcept>();
  for (const merge of merges) {
    const keep = base.concepts.get(merge.into);
    if (!keep || keep.type !== merge.type || claimed.has(keep.id)) continue;
    const members: GraphConcept[] = [];
    for (const id of merge.merged) {
      const member = base.concepts.get(id);
      if (!member || member.type !== merge.type || claimed.has(id) || id === keep.id || members.includes(member)) continue;
      members.push(member);
    }
    if (members.length === 0) continue;
    claimed.add(keep.id);
    for (const member of members) {
      claimed.add(member.id);
      mergedInto.set(member.id, keep.id);
    }
    const sources: GraphConceptSource[] = [keep, ...members].map(({ merge: _merge, ...source }) => ({
      ...source,
      aliases: [...source.aliases],
      attributes: { ...source.attributes }
    }));
    replaced.set(keep.id, { ...combineSources(sources), entryIds: unionIds(sources.map((s) => s.entryIds)), merge: { id: merge.id, sources } });
    effective.push({
      id: merge.id,
      type: merge.type,
      into: toRef(keep),
      merged: members.map(toRef),
      similarity: merge.similarity,
      createdAt: merge.createdAt
    });
  }
  if (effective.length === 0) return { concepts: new Map(base.concepts), edges: [...base.edges], mergedInto, effective };
  const concepts = new Map<string, GraphConcept>();
  for (const [id, concept] of base.concepts) {
    if (mergedInto.has(id)) continue;
    concepts.set(id, replaced.get(id) ?? concept);
  }
  const edges: GraphEdge[] = [];
  const byKey = new Map<string, GraphEdge>();
  for (const edge of base.edges) {
    const from = mergedInto.get(edge.from) ?? edge.from;
    const to = mergedInto.get(edge.to) ?? edge.to;
    if (from === to) continue;
    const key = `${edge.type}\u0000${from}\u0000${to}`;
    const same = byKey.get(key);
    if (same) {
      // One edge for the pair: the first's id, every source (none at all wins: visible iff both ends
      // are). Each source keeps its own provenance: a scoped caller sees only the visible ones'.
      same.sources = [...(same.sources ?? [edgeSourceOf(same)]), edgeSourceOf(edge)];
      same.entryIds = same.entryIds === null || edge.entryIds === null ? null : unionIds([same.entryIds, edge.entryIds]);
      same.confidence = Math.max(same.confidence, edge.confidence);
      if (same.context === undefined && edge.context !== undefined) same.context = edge.context;
      continue;
    }
    const next: GraphEdge = from === edge.from && to === edge.to ? { ...edge } : { ...edge, from, to };
    byKey.set(key, next);
    edges.push(next);
  }
  return { concepts, edges, mergedInto, effective };
}

/** Build a snapshot from myKG's parsed graph and the merge overlay. */
function buildGraphSnapshot(base: BaseGraph, merges: readonly ConceptMergeOverlay[]): Snapshot {
  const { concepts, edges: edgeList, mergedInto, effective } = applyConceptMerges(base, merges);
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of edgeList) {
    for (const end of [edge.from, edge.to]) {
      let list = adjacency.get(end);
      if (!list) adjacency.set(end, (list = []));
      list.push(edge);
    }
  }
  const entryConcepts = new Map<string, string[]>();
  const bm25 = new Bm25Index();
  let sourceKeys = 0;
  for (const concept of concepts.values()) {
    for (const entryId of concept.entryIds) {
      let list = entryConcepts.get(entryId);
      if (!list) entryConcepts.set(entryId, (list = []));
      list.push(concept.id);
    }
    if (concept.merge) {
      // Each source on its own: a scoped search matches only what a source it can see says.
      concept.merge.sources.forEach((source, index) => bm25.add(sourceKey(concept.id, index), conceptFields(source)));
      sourceKeys += concept.merge.sources.length - 1;
    } else {
      bm25.add(concept.id, conceptFields(concept));
    }
  }
  return { concepts, edges: edgeList, adjacency, entryConcepts, bm25, extraSearchKeys: sourceKeys, mergedInto, merges: effective };
}

function conceptFields(concept: KnowledgeConcept): { tokens: string[]; weight: number }[] {
  return [
    { tokens: tokenize(concept.name), weight: 3 },
    { tokens: tokenize(concept.aliases.join(" ")), weight: 2 },
    { tokens: tokenize(Object.values(concept.attributes).map((a) => a.value).join(" ")), weight: 1 },
    { tokens: tokenize(concept.description ?? ""), weight: 1 }
  ];
}

/** The BM25 key of one source of a merged concept (an unmerged concept's key is its id). */
function sourceKey(conceptId: string, index: number): string {
  return `${conceptId}\u0000${index}`;
}

/**
 * Visibility of one request over one snapshot, memoized: an entry is visible iff it exists in
 * the store and is in scope; a concept iff at least one of its entries is visible; an edge iff
 * both ends are visible and — when it carries provenance — at least one of its entries is.
 */
class View {
  private readonly entries = new Map<string, boolean>();
  private readonly concepts = new Map<string, boolean>();
  private readonly degrees = new Map<string, number>();
  private readonly conceptEntries = new Map<string, string[]>();
  private readonly sources = new Map<string, readonly GraphConceptSource[]>();
  private readonly presented = new Map<string, KnowledgeConcept>();
  private readonly surveys = new Map<string, boolean>();

  constructor(
    readonly snapshot: Snapshot,
    private readonly getMeta: (id: string) => KnowledgeEntryMeta | null,
    readonly scope: KnowledgeScope
  ) {}

  entry(id: string): boolean {
    let visible = this.entries.get(id);
    if (visible === undefined) {
      const meta = this.getMeta(id);
      visible = meta !== null && entryInScope(meta, this.scope);
      this.entries.set(id, visible);
    }
    return visible;
  }

  concept(id: string): boolean {
    let visible = this.concepts.get(id);
    if (visible === undefined) {
      const concept = this.snapshot.concepts.get(id);
      visible = concept !== undefined && concept.entryIds.some((entryId) => this.entry(entryId));
      this.concepts.set(id, visible);
    }
    return visible;
  }

  edge(edge: GraphEdge): boolean {
    if (!this.concept(edge.from) || !this.concept(edge.to)) return false;
    return edge.entryIds === null || edge.entryIds.some((entryId) => this.entry(entryId));
  }

  /** Whether a source (of a merged concept or edge) is backed by a visible entry (no provenance: yes). */
  private backed(entryIds: readonly string[] | null): boolean {
    return entryIds === null || entryIds.some((entryId) => this.entry(entryId));
  }

  /**
   * The sources of a visible merged concept that a visible entry backs, in merge order (the kept
   * concept first when it is one of them); null for an unmerged concept.
   */
  visibleSources(conceptId: string): readonly GraphConceptSource[] | null {
    const concept = this.snapshot.concepts.get(conceptId);
    if (!concept?.merge) return null;
    let sources = this.sources.get(conceptId);
    if (!sources) {
      sources = concept.merge.sources.filter((source) => this.backed(source.entryIds));
      this.sources.set(conceptId, sources);
    }
    return sources;
  }

  /**
   * A visible concept as this scope sees it: a merged one says only what its visible sources say,
   * under the first one's id and name (the kept concept's while one of its own entries is visible,
   * else a visible folded concept's: a hidden concept is never named). Null when not visible.
   */
  present(conceptId: string): KnowledgeConcept | null {
    if (!this.concept(conceptId)) return null;
    let shown = this.presented.get(conceptId);
    if (!shown) {
      const concept = this.snapshot.concepts.get(conceptId)!;
      const sources = this.visibleSources(conceptId);
      if (sources && sources.length > 0) shown = combineSources(sources);
      else {
        const { entryIds: _entries, merge: _merge, ...wire } = concept;
        shown = wire;
      }
      this.presented.set(conceptId, shown);
    }
    return shown;
  }

  /** The id a visible concept goes by in this scope (see {@link present}). */
  shownId(conceptId: string): string {
    return this.present(conceptId)?.id ?? conceptId;
  }

  ref(conceptId: string): KnowledgeConceptRef {
    const shown = this.present(conceptId)!;
    return { id: shown.id, name: shown.name, type: shown.type };
  }

  /**
   * The concept a requested id names in this scope: a folded concept's id answers the concept it
   * was merged into, but only while it is one of that concept's visible sources (a hidden source's
   * id names nothing). Null when nothing visible goes by it.
   */
  resolve(requested: string): string | null {
    const id = this.snapshot.mergedInto.get(requested) ?? requested;
    if (!this.concept(id)) return null;
    const sources = this.visibleSources(id);
    if (sources && !sources.some((source) => source.id === requested)) return null;
    return id;
  }

  /**
   * An edge as this scope sees it: its ends by the ids they go by here; for a folded edge, the id,
   * confidence and `contradicts` context of its sources a visible entry backs. `from`/`to` stay the
   * graph's own ids when `internalEnds` (callers that walk the graph further).
   */
  presentEdge(edge: GraphEdge, internalEnds = false): GraphEdge {
    const sources = edge.sources?.filter((source) => this.backed(source.entryIds)) ?? [];
    const from = internalEnds ? edge.from : this.shownId(edge.from);
    const to = internalEnds ? edge.to : this.shownId(edge.to);
    if (sources.length === 0) {
      const { sources: _sources, ...plain } = edge;
      return { ...plain, from, to };
    }
    const context = sources.find((source) => source.context !== undefined)?.context;
    return {
      id: sources[0]!.id,
      type: edge.type,
      from,
      to,
      confidence: Math.max(...sources.map((source) => source.confidence)),
      entryIds: edge.entryIds,
      ...(context !== undefined ? { context } : {})
    };
  }

  visibleEdges(conceptId: string): GraphEdge[] {
    return (this.snapshot.adjacency.get(conceptId) ?? []).filter((edge) => this.edge(edge));
  }

  degree(conceptId: string): number {
    let degree = this.degrees.get(conceptId);
    if (degree === undefined) {
      degree = this.visibleEdges(conceptId).length;
      this.degrees.set(conceptId, degree);
    }
    return degree;
  }

  entriesOf(conceptId: string): string[] {
    let ids = this.conceptEntries.get(conceptId);
    if (!ids) {
      ids = (this.snapshot.concepts.get(conceptId)?.entryIds ?? []).filter((id) => this.entry(id));
      this.conceptEntries.set(conceptId, ids);
    }
    return ids;
  }

  /** Whether an entry surveys others rather than claiming (`isSurveyEntry`: a synthesis, a map or audit note). */
  survey(entryId: string): boolean {
    let survey = this.surveys.get(entryId);
    if (survey === undefined) this.surveys.set(entryId, (survey = isSurveyEntry(this.getMeta(entryId))));
    return survey;
  }

  /**
   * The visible collections of the visible entries behind a concept. A survey (a synthesis that
   * links every topic) counts only for a concept no other visible entry has: an all-collection
   * synthesis does not put "IPQualityScore" in "SEO & AI Search".
   */
  collectionsOf(conceptId: string): string[] {
    const out = new Set<string>();
    const entries = this.entriesOf(conceptId);
    const own = entries.filter((entryId) => !this.survey(entryId));
    for (const entryId of own.length > 0 ? own : entries) {
      const meta = this.getMeta(entryId);
      if (meta) for (const id of visibleCollections(meta, this.scope)) out.add(id);
    }
    return [...out];
  }

  node(conceptId: string): KnowledgeGraphNode {
    const concept = this.present(conceptId)!;
    return {
      id: concept.id,
      name: concept.name,
      type: concept.type,
      confidence: concept.confidence,
      collections: this.collectionsOf(conceptId),
      entryCount: this.entriesOf(conceptId).length,
      degree: this.degree(conceptId)
    };
  }

  /**
   * Whether a visible edge joins a Person to something only on the word of surveys: every visible
   * entry it comes from is a survey ({@link survey}), which attributes positions to the people it
   * cites rather than stating their own. No provenance: no.
   */
  surveyAttributed(edge: GraphEdge): boolean {
    if (edge.entryIds === null) return false;
    const isPerson = (id: string): boolean => this.snapshot.concepts.get(id)?.type.toLowerCase() === "person";
    const person = isPerson(edge.from) || isPerson(edge.to);
    if (!person) return false;
    const visible = edge.entryIds.filter((entryId) => this.entry(entryId));
    return visible.length > 0 && visible.every((entryId) => this.survey(entryId));
  }

  /** A visible edge on the wire: as this scope sees it ({@link presentEdge}). */
  wireEdge(edge: GraphEdge): KnowledgeEdge {
    const shown = this.presentEdge(edge);
    return { id: shown.id, type: shown.type, from: shown.from, to: shown.to, confidence: shown.confidence };
  }
}

/** Name and alias words of a concept ({@link tokenize}), numbers aside ("4.0 – Design" and "Guideline 4.3" share no word). */
function nameWords(concept: KnowledgeConcept): Set<string> {
  return new Set(tokenize([concept.name, ...concept.aliases].join(" ")).filter((token) => !/^\p{N}+$/u.test(token)));
}

/** A name compared without case, accents, spaces or punctuation. */
const squashed = (name: string): string => name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Whether two concepts' names are related: a shared content word (names and aliases), or one name containing the other. */
export function namesRelated(a: KnowledgeConcept, b: KnowledgeConcept): boolean {
  const x = squashed(a.name);
  const y = squashed(b.name);
  if (x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x))) return true;
  const words = nameWords(a);
  for (const word of nameWords(b)) if (words.has(word)) return true;
  return false;
}

const isShortName = (name: string): boolean => name.trim().split(/\s+/).length <= SHORT_NAME_WORDS;

function toRef(concept: GraphConcept): KnowledgeConceptRef {
  return { id: concept.id, name: concept.name, type: concept.type };
}

export interface KnowledgeGraphOptions {
  /** Entry metadata (collections) for visibility; the store. */
  entries: Pick<KnowledgeStorePort, "getMeta">;
  logger?: KnowledgeLogger;
}

export interface KnowledgeConceptView {
  concept: KnowledgeConcept;
  collections: string[];
  /** Visible entries behind it, in the graph's order. */
  entryIds: string[];
  neighbors: { edge: KnowledgeEdge; concept: KnowledgeConceptRef }[];
  /** Concepts merged into it that a visible entry backs. */
  mergedFrom: KnowledgeConceptRef[];
  /**
   * Visible concepts close in meaning (not merged with it), best first, up to 5; with a short name on
   * either side, only related names or a very high similarity (`SHORT_NAME_SIMILAR_MIN`).
   */
  similarConcepts: { concept: KnowledgeConceptRef; similarity: number }[];
}

/**
 * myKG's graph in memory (spec "Querying"), with every query scoped while it walks: hidden
 * entries never make a concept, an edge or a path visible. `load` swaps in a new snapshot
 * atomically; a query holds the snapshot it started with.
 *
 * The concept-merge overlay (phase 2 spec, "Concept merges") is applied to every load, and
 * {@link setConceptMerges} re-applies a changed one over the graph last loaded.
 */
export class KnowledgeGraph implements KnowledgeGraphPort {
  private snapshot: Snapshot = EMPTY;
  /** myKG's graph as last loaded, before the overlay. */
  private base: BaseGraph = EMPTY_BASE;
  private merges: readonly ConceptMergeOverlay[] = [];
  private similarProvider: SimilarConceptsProvider | null = null;
  private backingProvider: ((conceptId: string) => readonly string[]) | null = null;
  private vectorsReady: (() => boolean) | null = null;
  private families: Pick<KnowledgeConceptFamiliesPort, "familyOf" | "revision"> | null = null;
  private backingRev = 0;
  private readonly loadListeners = new Set<() => void>();
  /** Numbers loads in the order they start; `appliedLoad` is the current base graph's. */
  private loadSeq = 0;
  private appliedLoad = 0;
  /** Moves with every snapshot swapped in (a load, or the overlay re-applied). */
  private applied = 0;
  /** What myKG's files held at the last load applied (a digest), and a revision that moves only when they, or the merges in effect, change. */
  private baseDigest: string | null = null;
  private content = 0;
  private readonly getMeta: (id: string) => KnowledgeEntryMeta | null;
  private readonly logger: KnowledgeLogger;

  constructor(options: KnowledgeGraphOptions) {
    this.getMeta = (id) => options.entries.getMeta(id);
    this.logger = options.logger ?? console;
  }

  /** Reads `nodes.jsonl` / `edges.jsonl` from `outputDir` (or its `output/`). Throws when there is no nodes file. */
  async load(outputDir: string): Promise<{ nodes: number; edges: number }> {
    const seq = ++this.loadSeq;
    const dir = (await exists(join(outputDir, "nodes.jsonl"))) ? outputDir : join(outputDir, "output");
    const nodesPath = join(dir, "nodes.jsonl");
    const edgesPath = join(dir, "edges.jsonl");
    const digest = createHash("sha256");
    const nodes = await readJsonl(nodesPath, this.logger, "nodes.jsonl", digest);
    digest.update("\u0001");
    const edges = (await exists(edgesPath)) ? await readJsonl(edgesPath, this.logger, "edges.jsonl", digest) : [];
    const contentDigest = digest.digest("hex");
    const { base, skipped } = parseGraph(nodes, edges);
    if (skipped > 0) this.logger.warn(`knowledge: skipped ${skipped} graph record(s) (unreadable, repeated, or an edge to an unknown concept)`);
    if (seq < this.appliedLoad) {
      // A load that started later has already swapped in the newer graph.
      return { nodes: base.concepts.size, edges: base.edges.length };
    }
    this.base = base;
    this.appliedLoad = seq;
    if (contentDigest !== this.baseDigest) {
      this.baseDigest = contentDigest;
      this.content += 1;
    }
    this.swap(buildGraphSnapshot(base, this.merges));
    for (const listener of this.loadListeners) {
      try {
        listener();
      } catch (error) {
        this.logger.warn(`knowledge: a graph load listener failed (${(error as Error).message})`);
      }
    }
    return this.counts();
  }

  private swap(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.applied += 1;
  }

  /**
   * Replace the merge overlay and re-apply it over the graph last loaded now (the revision moves).
   * Applied in order: a concept already claimed by an earlier merge is left out of a later one.
   */
  setConceptMerges(merges: readonly ConceptMergeOverlay[]): void {
    this.merges = [...merges];
    const before = JSON.stringify(this.snapshot.merges);
    this.swap(buildGraphSnapshot(this.base, this.merges));
    if (JSON.stringify(this.snapshot.merges) !== before) this.content += 1;
  }

  /** The merges in effect on the current graph. */
  conceptMerges(): readonly EffectiveConceptMerge[] {
    return this.snapshot.merges;
  }

  /** myKG's concepts as last loaded, before the merge overlay (what concept vectors and merges are computed over). */
  baseConcepts(): readonly GraphConcept[] {
    return [...this.base.concepts.values()];
  }

  /**
   * The concepts of the current graph, after the merge overlay (a merged concept under its kept id,
   * with every source's entries and names); unscoped. What concept summaries are written for.
   */
  currentConcepts(): readonly GraphConcept[] {
    return [...this.snapshot.concepts.values()];
  }

  /** myKG's edges as last loaded, before the merge overlay (the concept checks' neighbour anchors). */
  baseEdges(): readonly GraphEdge[] {
    return this.base.edges;
  }

  /** Moves with every load swapped in (not with the overlay). */
  loadRevision(): number {
    return this.appliedLoad;
  }

  /**
   * Moves only when what the graph says may have changed: a load of files that differ from the
   * last ones loaded, or a change of the merges in effect (a reload of the same files does not).
   */
  contentRevision(): number {
    return this.content;
  }

  /** Called after every load swapped in a graph. */
  onLoad(listener: () => void): () => void {
    this.loadListeners.add(listener);
    return () => this.loadListeners.delete(listener);
  }

  /** Where concept details read similar concepts from (null: none). */
  setSimilarConcepts(provider: SimilarConceptsProvider | null): void {
    this.similarProvider = provider;
  }

  /**
   * Where {@link backingConcepts} reads from (null: none), and whether concept vectors are ready
   * (what {@link similarConceptIds} needs to answer; absent: never).
   */
  setBackingConcepts(provider: ((conceptId: string) => readonly string[]) | null, ready?: () => boolean): void {
    this.backingProvider = provider;
    this.vectorsReady = provider ? (ready ?? null) : null;
    this.backingMoved();
  }

  /** Where {@link conceptFamily} reads concept families from (`concept-families.ts`; null: none). */
  setConceptFamilies(families: Pick<KnowledgeConceptFamiliesPort, "familyOf" | "revision"> | null): void {
    this.families = families;
  }

  /**
   * The member concept ids (the graph's, itself included) of the family `conceptId` belongs to:
   * concepts of its type answering the same question (`concept-families.ts`); unscoped. Null when
   * it has none, or before families are computed.
   */
  conceptFamily(conceptId: string): readonly string[] | null {
    return this.families?.familyOf(this.canonicalConceptId(conceptId)) ?? null;
  }

  /** Moves whenever the families change (a cache key next to {@link revision}). */
  familiesRevision(): number {
    return this.families?.revision() ?? 0;
  }

  /** Whether concept vectors from a calibrated model are complete ({@link setBackingConcepts}'s `ready`). */
  conceptVectorsReady(): boolean {
    return this.vectorsReady?.() ?? false;
  }

  /**
   * Same-type concepts close in meaning to `conceptId` (the similar concepts of a concept detail,
   * without its name rules), as the graph's ids, never itself; unscoped. Null while concept vectors
   * are not ready (no calibrated model, or not computed yet): unknown, not "none".
   */
  similarConceptIds(conceptId: string): readonly string[] | null {
    if (!this.conceptVectorsReady() || !this.similarProvider) return null;
    const own = this.canonicalConceptId(conceptId);
    const out = new Set<string>();
    for (const hit of this.similarProvider(own)) {
      const id = this.canonicalConceptId(hit.id);
      if (id !== own && this.snapshot.concepts.has(id)) out.add(id);
    }
    return [...out];
  }

  /** What the backing provider answers may have changed (its vectors were computed). */
  backingMoved(): void {
    this.backingRev += 1;
  }

  /** Moves with every change {@link backingMoved} announces (a cache key next to {@link revision}). */
  backingRevision(): number {
    return this.backingRev;
  }

  /**
   * Concepts that say what `conceptId` says in other words (concept merges' `backing`: same type,
   * close in meaning and in wording), as the graph's ids, never itself; unscoped (callers ask which
   * entries they can see link one). None without a provider.
   */
  backingConcepts(conceptId: string): readonly string[] {
    const own = this.canonicalConceptId(conceptId);
    return (this.backingProvider?.(own) ?? []).filter((id) => id !== own && this.snapshot.concepts.has(id));
  }

  /** The concept a folded concept was merged into, or the id itself. */
  canonicalConceptId(id: string): string {
    return this.snapshot.mergedInto.get(id) ?? id;
  }

  counts(): { nodes: number; edges: number } {
    return { nodes: this.snapshot.concepts.size, edges: this.snapshot.edges.length };
  }

  conceptTypes(): Map<string, number> {
    const types = new Map<string, number>();
    for (const concept of this.snapshot.concepts.values()) types.set(concept.type, (types.get(concept.type) ?? 0) + 1);
    return types;
  }

  /** Moves whenever a load or {@link setConceptMerges} swaps in a snapshot (even one of the same size). */
  revision(): number {
    return this.applied;
  }

  private view(scope: KnowledgeScope): View {
    return new View(this.snapshot, this.getMeta, scope);
  }

  hasConcept(id: string): boolean {
    return this.snapshot.concepts.has(id);
  }

  /**
   * The visible graph, or the neighbourhood of `focus` (a concept or entry id; `null` when it is
   * not visible) out to `depth` hops; truncated to the `limit` most connected nodes.
   */
  graph(scope: KnowledgeScope, options: { focus?: string; depth?: number; limit?: number } = {}): KnowledgeGraphResponse | null {
    const view = this.view(scope);
    const limit = Math.max(1, Math.min(options.limit ?? KNOWLEDGE_GRAPH_MAX_NODES, KNOWLEDGE_GRAPH_MAX_NODES));
    let selected: string[];
    const pinned = new Set<string>();
    if (options.focus !== undefined) {
      const depth = Math.max(1, Math.min(options.depth ?? 2, 3));
      let frontier: string[];
      let hops: number;
      if (isKnowledgeEntryId(options.focus)) {
        if (!view.entry(options.focus)) return null;
        frontier = [...(view.snapshot.entryConcepts.get(options.focus) ?? [])].filter((id) => view.concept(id));
        hops = 1; // the entry's own concepts are the first hop
      } else {
        const focus = view.resolve(options.focus);
        if (focus === null) return null;
        frontier = [focus];
        hops = 0;
      }
      for (const id of frontier) pinned.add(id);
      const reached = new Set(frontier);
      while (hops < depth && frontier.length > 0) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const edge of view.visibleEdges(id)) {
            const other = edge.from === id ? edge.to : edge.from;
            if (!reached.has(other)) {
              reached.add(other);
              next.push(other);
            }
          }
        }
        frontier = next;
        hops += 1;
      }
      selected = [...reached];
    } else {
      selected = [...view.snapshot.concepts.keys()].filter((id) => view.concept(id));
    }
    const selectedSet = new Set(selected);
    const allEdges = view.snapshot.edges.filter((edge) => selectedSet.has(edge.from) && selectedSet.has(edge.to) && view.edge(edge));
    let kept = selected;
    const truncated = selected.length > limit;
    if (truncated) {
      kept = [...selected]
        .sort(
          (a, b) =>
            Number(pinned.has(b)) - Number(pinned.has(a)) ||
            view.degree(b) - view.degree(a) ||
            view.entriesOf(b).length - view.entriesOf(a).length ||
            (a < b ? -1 : 1)
        )
        .slice(0, limit);
    }
    const keptSet = new Set(kept);
    return {
      nodes: kept.map((id) => view.node(id)),
      edges: (truncated ? allEdges.filter((e) => keptSet.has(e.from) && keptSet.has(e.to)) : allEdges).map((edge) => view.wireEdge(edge)),
      truncated,
      totals: { nodes: selected.length, edges: allEdges.length }
    };
  }

  /**
   * A visible concept with its visible collections, entries and neighbours, the concepts merged
   * into it and similar ones; null when hidden or unknown. The id of a concept merged into another
   * answers that one (links to it keep working) while that folded concept is visible. A merged
   * concept says only what its visible sources say (`View.present`). A Person's links that only
   * surveys make (`View.surveyAttributed`) are not among the neighbours, on either end.
   */
  concept(requested: string, scope: KnowledgeScope): KnowledgeConceptView | null {
    const view = this.view(scope);
    const id = view.resolve(requested);
    if (id === null) return null;
    const shown = view.present(id)!;
    // A folded concept shows (as "merged from", and its names as aliases) only when a visible entry backs it.
    const mergedFrom = (view.visibleSources(id) ?? []).filter((source) => source.id !== shown.id).map((source) => ({ id: source.id, name: source.name, type: source.type }));
    const similarConcepts: KnowledgeConceptView["similarConcepts"] = [];
    for (const hit of this.similarProvider?.(id) ?? []) {
      if (similarConcepts.length >= SIMILAR_CONCEPTS_LIMIT) break;
      const other = view.snapshot.mergedInto.get(hit.id) ?? hit.id;
      if (other === id || !view.concept(other)) continue;
      const theirs = view.present(other)!;
      if ((isShortName(shown.name) || isShortName(theirs.name)) && hit.similarity < SHORT_NAME_SIMILAR_MIN && !namesRelated(shown, theirs)) continue;
      const ref = view.ref(other);
      if (similarConcepts.some((s) => s.concept.id === ref.id)) continue;
      similarConcepts.push({ concept: ref, similarity: hit.similarity });
    }
    return {
      concept: { ...shown, aliases: [...shown.aliases], attributes: { ...shown.attributes } },
      collections: view.collectionsOf(id),
      entryIds: view.entriesOf(id),
      // A person's links that only surveys make (a research note's "jason recommends …") are not
      // that person's own position: left out, both on the person and on what it would link.
      neighbors: view
        .visibleEdges(id)
        .filter((edge) => !view.surveyAttributed(edge))
        .map((edge) => ({
          edge: view.wireEdge(edge),
          concept: view.ref(edge.from === id ? edge.to : edge.from)
        })),
      mergedFrom,
      similarConcepts
    };
  }

  /**
   * The merges in effect whose concept the scope can see, as it sees them: `into` is the merged
   * concept under the name it goes by here (`View.present`), `merged` its other visible sources (a
   * merge with none of those is left out). Hidden concepts are never named.
   */
  visibleConceptMerges(scope: KnowledgeScope): EffectiveConceptMerge[] {
    const view = this.view(scope);
    const out: EffectiveConceptMerge[] = [];
    for (const merge of view.snapshot.merges) {
      const id = merge.into.id;
      if (!view.concept(id)) continue;
      const into = view.ref(id);
      const merged = (view.visibleSources(id) ?? []).filter((source) => source.id !== into.id).map((source) => ({ id: source.id, name: source.name, type: source.type }));
      if (merged.length > 0) out.push({ ...merge, into, merged });
    }
    return out;
  }

  /** A visible concept's ref (and description) as the scope sees it; a folded concept's id answers its merge. Null when not visible. */
  conceptRef(id: string, scope: KnowledgeScope): (KnowledgeConceptRef & { description: string | null }) | null {
    const view = this.view(scope);
    const canonical = view.snapshot.mergedInto.get(id) ?? id;
    const shown = view.present(canonical);
    return shown ? { id: shown.id, name: shown.name, type: shown.type, description: shown.description } : null;
  }

  /** A concept's type (unscoped: the same for every source of a merge); null when unknown. */
  conceptType(id: string): string | null {
    return this.snapshot.concepts.get(this.snapshot.mergedInto.get(id) ?? id)?.type ?? null;
  }

  /**
   * The concepts linked to an entry as the scope sees them (all visible whenever the entry is: each
   * has it as a source; a merged one under the name it goes by there).
   */
  conceptsOfEntry(entryId: string, scope: KnowledgeScope): KnowledgeConceptRef[] {
    const snapshot = this.snapshot;
    let view: View | null = null;
    const out: KnowledgeConceptRef[] = [];
    for (const id of snapshot.entryConcepts.get(entryId) ?? []) {
      const concept = snapshot.concepts.get(id)!;
      // Unmerged: what myKG wrote (read per entry in loops, so no scoped view unless a merge needs one).
      if (!concept.merge) out.push(toRef(concept));
      else if ((view ??= new View(snapshot, this.getMeta, scope)).concept(id)) out.push(view.ref(id));
    }
    return out;
  }

  /** The graph's own ids of the concepts linked to an entry (for walking the graph; never shown as such). */
  conceptIdsOfEntry(entryId: string): readonly string[] {
    return this.snapshot.entryConcepts.get(entryId) ?? [];
  }

  /** How many concepts the entry links to (what `linkCount` shows for a visible entry). */
  linkCount(entryId: string): number {
    return this.snapshot.entryConcepts.get(entryId)?.length ?? 0;
  }

  /** Other visible entries sharing concepts with `entryId`, most shared first. */
  relatedEntries(entryId: string, scope: KnowledgeScope, limit: number): { id: string; shared: number }[] {
    const view = this.view(scope);
    if (!view.entry(entryId)) return [];
    const counts = new Map<string, number>();
    for (const conceptId of view.snapshot.entryConcepts.get(entryId) ?? []) {
      for (const other of view.entriesOf(conceptId)) {
        if (other !== entryId) counts.set(other, (counts.get(other) ?? 0) + 1);
      }
    }
    return [...counts]
      .map(([id, shared]) => ({ id, shared, savedAt: this.getMeta(id)?.savedAt ?? "" }))
      .sort((a, b) => b.shared - a.shared || b.savedAt.localeCompare(a.savedAt) || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map(({ id, shared }) => ({ id, shared }));
  }

  /**
   * BM25 over visible concepts' names, aliases, attribute values and descriptions; a merged concept
   * matches on what its visible sources say only. Answers the graph's own ids, each with `named`:
   * the share of the query's distinct terms its name or aliases (as the scope sees them) hold.
   */
  searchConcepts(terms: readonly string[], scope: KnowledgeScope, limit: number): { id: string; score: number; named: number }[] {
    const view = this.view(scope);
    const accept = (key: string): boolean => {
      const at = key.indexOf("\u0000");
      if (at < 0) return view.concept(key);
      const id = key.slice(0, at);
      const source = view.snapshot.concepts.get(id)?.merge?.sources[Number(key.slice(at + 1))];
      return source !== undefined && view.concept(id) && (view.visibleSources(id) ?? []).includes(source);
    };
    const best = new Map<string, number>();
    for (const hit of view.snapshot.bm25.search(terms, accept, limit + view.snapshot.extraSearchKeys)) {
      const at = hit.key.indexOf("\u0000");
      const id = at < 0 ? hit.key : hit.key.slice(0, at);
      if (!best.has(id)) best.set(id, hit.score);
    }
    const distinct = new Set(terms);
    return [...best].slice(0, limit).map(([id, score]) => {
      const shown = view.present(id)!;
      const named = new Set(tokenize([shown.name, ...shown.aliases].join(" ")));
      let held = 0;
      for (const term of distinct) if (named.has(term)) held += 1;
      return { id, score, named: distinct.size > 0 ? held / distinct.size : 0 };
    });
  }

  /**
   * For one scope: a visible concept's visible neighbours by any relation (the graph's own ids),
   * none when it is not visible; a folded concept's id answers its merge. Memoized per lookup.
   */
  neighbourLookup(scope: KnowledgeScope): (conceptId: string) => readonly string[] {
    const view = this.view(scope);
    const memo = new Map<string, string[]>();
    return (requested) => {
      const id = view.snapshot.mergedInto.get(requested) ?? requested;
      let ids = memo.get(id);
      if (!ids) {
        ids = view.concept(id) ? view.visibleEdges(id).map((edge) => (edge.from === id ? edge.to : edge.from)) : [];
        memo.set(id, ids);
      }
      return ids;
    };
  }

  /** Visible entries behind a concept (the one-hop expansion); a folded concept's id answers its merge. */
  visibleEntriesOf(conceptId: string, scope: KnowledgeScope): string[] {
    const view = this.view(scope);
    return view.entriesOf(view.snapshot.mergedInto.get(conceptId) ?? conceptId);
  }

  /**
   * Visible edges of one relation type, compared without case (`contradicts` for the phase 2
   * spec's "Contradictions"), with whatever attributes the snapshot keeps; `around`: only those
   * touching one of these concepts. Each as the scope sees it (`View.presentEdge`: a folded edge's
   * id, confidence and context are its visible sources'), with the graph's own ids as `from`/`to`.
   */
  visibleEdgesOfType(type: string, scope: KnowledgeScope, around?: Iterable<string>): GraphEdge[] {
    const view = this.view(scope);
    const wanted = type.toLowerCase();
    const matches = (edge: GraphEdge): boolean => edge.type.toLowerCase() === wanted && view.edge(edge);
    let edges: GraphEdge[];
    if (!around) edges = view.snapshot.edges.filter(matches);
    else {
      const out = new Set<GraphEdge>();
      for (const conceptId of around) {
        for (const edge of view.snapshot.adjacency.get(view.snapshot.mergedInto.get(conceptId) ?? conceptId) ?? []) if (matches(edge)) out.add(edge);
      }
      edges = [...out];
    }
    return edges.map((edge) => view.presentEdge(edge, true));
  }
}
