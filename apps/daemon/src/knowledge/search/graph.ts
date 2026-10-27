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
import { tokenize } from "./text.ts";
import { type KnowledgeScope, entryInScope, visibleCollections } from "./visibility.ts";

/** A concept as held in memory: the contract's fields plus the entries it came from. */
export interface GraphConcept extends KnowledgeConcept {
  /** Entry ids from the node's `source_files` (only files named `<entryId>.md`). */
  entryIds: readonly string[];
  /**
   * Set on a concept other concepts were merged into (phase 2 spec, "Concept merges"): its own
   * aliases, and each folded concept with the entries it came from (so a caller only sees the ones
   * a visible entry backs). `aliases` and `entryIds` above are the unions.
   */
  merge?: { id: string; ownAliases: readonly string[]; members: readonly GraphMergedConcept[] };
}

/** A concept folded into another by a merge. */
export interface GraphMergedConcept {
  ref: KnowledgeConceptRef;
  aliases: readonly string[];
  entryIds: readonly string[];
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
  bm25: Bm25Index;
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
  mergedInto: new Map(),
  merges: []
};

/** Similar concepts of a concept (by meaning), best first; ids of concepts in the current graph. */
export type SimilarConceptsProvider = (conceptId: string) => readonly { id: string; similarity: number }[];

/** Similar concepts a concept detail lists. */
const SIMILAR_CONCEPTS_LIMIT = 5;

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

async function readJsonl(path: string, logger: KnowledgeLogger, what: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
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
    const attributes: GraphConcept["attributes"] = {};
    for (const source of [...members].reverse()) Object.assign(attributes, source.attributes);
    Object.assign(attributes, keep.attributes);
    replaced.set(keep.id, {
      ...keep,
      confidence: Math.max(keep.confidence, ...members.map((m) => m.confidence)),
      description: keep.description ?? members.find((m) => m.description !== null)?.description ?? null,
      aliases: unionAliases(keep.name, [keep.aliases, ...members.flatMap((m) => [[m.name], m.aliases])]),
      attributes,
      entryIds: unionIds([keep.entryIds, ...members.map((m) => m.entryIds)]),
      merge: {
        id: merge.id,
        ownAliases: keep.aliases,
        members: members.map((m) => ({ ref: toRef(m), aliases: m.aliases, entryIds: m.entryIds }))
      }
    });
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
      // One edge for the pair: the first's id, every source (none at all wins: visible iff both ends are).
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
  for (const concept of concepts.values()) {
    for (const entryId of concept.entryIds) {
      let list = entryConcepts.get(entryId);
      if (!list) entryConcepts.set(entryId, (list = []));
      list.push(concept.id);
    }
    bm25.add(concept.id, [
      { tokens: tokenize(concept.name), weight: 3 },
      { tokens: tokenize(concept.aliases.join(" ")), weight: 2 },
      { tokens: tokenize(Object.values(concept.attributes).map((a) => a.value).join(" ")), weight: 1 },
      { tokens: tokenize(concept.description ?? ""), weight: 1 }
    ]);
  }
  return { concepts, edges: edgeList, adjacency, entryConcepts, bm25, mergedInto, merges: effective };
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

  collectionsOf(conceptId: string): string[] {
    const out = new Set<string>();
    for (const entryId of this.entriesOf(conceptId)) {
      const meta = this.getMeta(entryId);
      if (meta) for (const id of visibleCollections(meta, this.scope)) out.add(id);
    }
    return [...out];
  }

  node(conceptId: string): KnowledgeGraphNode {
    const concept = this.snapshot.concepts.get(conceptId)!;
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
}

function toEdge(edge: GraphEdge): KnowledgeEdge {
  return { id: edge.id, type: edge.type, from: edge.from, to: edge.to, confidence: edge.confidence };
}

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
  /** Visible concepts close in meaning (not merged with it), best first, up to 5. */
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
  private readonly loadListeners = new Set<() => void>();
  /** Numbers loads in the order they start; `appliedLoad` is the current base graph's. */
  private loadSeq = 0;
  private appliedLoad = 0;
  /** Moves with every snapshot swapped in (a load, or the overlay re-applied). */
  private applied = 0;
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
    const nodes = await readJsonl(nodesPath, this.logger, "nodes.jsonl");
    const edges = (await exists(edgesPath)) ? await readJsonl(edgesPath, this.logger, "edges.jsonl") : [];
    const { base, skipped } = parseGraph(nodes, edges);
    if (skipped > 0) this.logger.warn(`knowledge: skipped ${skipped} graph record(s) (unreadable, repeated, or an edge to an unknown concept)`);
    if (seq < this.appliedLoad) {
      // A load that started later has already swapped in the newer graph.
      return { nodes: base.concepts.size, edges: base.edges.length };
    }
    this.base = base;
    this.appliedLoad = seq;
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
    this.swap(buildGraphSnapshot(this.base, this.merges));
  }

  /** The merges in effect on the current graph. */
  conceptMerges(): readonly EffectiveConceptMerge[] {
    return this.snapshot.merges;
  }

  /** myKG's concepts as last loaded, before the merge overlay (what concept vectors and merges are computed over). */
  baseConcepts(): readonly GraphConcept[] {
    return [...this.base.concepts.values()];
  }

  /** Moves with every load swapped in (not with the overlay). */
  loadRevision(): number {
    return this.appliedLoad;
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
        const focus = view.snapshot.mergedInto.get(options.focus) ?? options.focus;
        if (!view.concept(focus)) return null;
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
      edges: (truncated ? allEdges.filter((e) => keptSet.has(e.from) && keptSet.has(e.to)) : allEdges).map(toEdge),
      truncated,
      totals: { nodes: selected.length, edges: allEdges.length }
    };
  }

  /**
   * A visible concept with its visible collections, entries and neighbours, the concepts merged
   * into it and similar ones; null when hidden or unknown. The id of a concept merged into another
   * answers that one (links to it keep working).
   */
  concept(requested: string, scope: KnowledgeScope): KnowledgeConceptView | null {
    const view = this.view(scope);
    const id = view.snapshot.mergedInto.get(requested) ?? requested;
    const concept = view.snapshot.concepts.get(id);
    if (!concept || !view.concept(id)) return null;
    const { entryIds: _entries, merge, ...wire } = concept;
    // A folded concept shows (as "merged from" and as aliases) only when a visible entry backs it.
    const members = (merge?.members ?? []).filter((member) => member.entryIds.some((entryId) => view.entry(entryId)));
    const aliases = merge ? unionAliases(concept.name, [merge.ownAliases, ...members.flatMap((m) => [[m.ref.name], m.aliases])]) : [...wire.aliases];
    const similarConcepts: KnowledgeConceptView["similarConcepts"] = [];
    for (const hit of this.similarProvider?.(id) ?? []) {
      if (similarConcepts.length >= SIMILAR_CONCEPTS_LIMIT) break;
      const other = view.snapshot.concepts.get(hit.id);
      if (!other || other.id === id || !view.concept(other.id) || similarConcepts.some((s) => s.concept.id === other.id)) continue;
      similarConcepts.push({ concept: toRef(other), similarity: hit.similarity });
    }
    return {
      concept: { ...wire, aliases, attributes: { ...wire.attributes } },
      collections: view.collectionsOf(id),
      entryIds: view.entriesOf(id),
      neighbors: view.visibleEdges(id).map((edge) => ({
        edge: toEdge(edge),
        concept: toRef(view.snapshot.concepts.get(edge.from === id ? edge.to : edge.from)!)
      })),
      mergedFrom: members.map((member) => ({ ...member.ref })),
      similarConcepts
    };
  }

  /**
   * The merges in effect whose kept concept the scope can see, each with only its folded concepts
   * a visible entry backs (a merge with none of those is left out).
   */
  visibleConceptMerges(scope: KnowledgeScope): EffectiveConceptMerge[] {
    const view = this.view(scope);
    const out: EffectiveConceptMerge[] = [];
    for (const merge of view.snapshot.merges) {
      const concept = view.snapshot.concepts.get(merge.into.id);
      if (!concept?.merge || !view.concept(concept.id)) continue;
      const visible = new Set(concept.merge.members.filter((m) => m.entryIds.some((entryId) => view.entry(entryId))).map((m) => m.ref.id));
      const merged = merge.merged.filter((ref) => visible.has(ref.id));
      if (merged.length > 0) out.push({ ...merge, into: { ...merge.into }, merged: merged.map((ref) => ({ ...ref })) });
    }
    return out;
  }

  conceptRef(id: string): (KnowledgeConceptRef & { description: string | null }) | null {
    const concept = this.snapshot.concepts.get(id);
    return concept ? { ...toRef(concept), description: concept.description } : null;
  }

  /** The concepts linked to an entry (all visible whenever the entry is: each has it as a source). */
  conceptsOfEntry(entryId: string): KnowledgeConceptRef[] {
    const snapshot = this.snapshot;
    return (snapshot.entryConcepts.get(entryId) ?? []).map((id) => toRef(snapshot.concepts.get(id)!));
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

  /** BM25 over visible concepts' names, aliases, attribute values and descriptions. */
  searchConcepts(terms: readonly string[], scope: KnowledgeScope, limit: number): { id: string; score: number }[] {
    const view = this.view(scope);
    return view.snapshot.bm25.search(terms, (id) => view.concept(id), limit).map((hit) => ({ id: hit.key, score: hit.score }));
  }

  /** Visible entries behind a concept (the one-hop expansion). */
  visibleEntriesOf(conceptId: string, scope: KnowledgeScope): string[] {
    return this.view(scope).entriesOf(conceptId);
  }

  /**
   * Visible edges of one relation type, compared without case (`contradicts` for the phase 2
   * spec's "Contradictions"), as held in memory with whatever attributes the snapshot keeps;
   * `around`: only those touching one of these concepts.
   */
  visibleEdgesOfType(type: string, scope: KnowledgeScope, around?: Iterable<string>): GraphEdge[] {
    const view = this.view(scope);
    const wanted = type.toLowerCase();
    const matches = (edge: GraphEdge): boolean => edge.type.toLowerCase() === wanted && view.edge(edge);
    if (!around) return view.snapshot.edges.filter(matches);
    const out = new Set<GraphEdge>();
    for (const conceptId of around) for (const edge of view.snapshot.adjacency.get(conceptId) ?? []) if (matches(edge)) out.add(edge);
    return [...out];
  }
}
