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
}

/** An edge as held in memory. */
export interface GraphEdge extends KnowledgeEdge {
  /**
   * Entry ids from the edge's `source_files`, or `null` when the edge carries no provenance at all
   * (then it is visible iff both ends are). An edge whose files map to no entry has `[]` and is
   * never visible.
   */
  entryIds: readonly string[] | null;
}

interface Snapshot {
  concepts: ReadonlyMap<string, GraphConcept>;
  edges: readonly GraphEdge[];
  adjacency: ReadonlyMap<string, readonly GraphEdge[]>;
  entryConcepts: ReadonlyMap<string, readonly string[]>;
  bm25: Bm25Index;
}

const EMPTY: Snapshot = { concepts: new Map(), edges: [], adjacency: new Map(), entryConcepts: new Map(), bm25: new Bm25Index() };

/** `ke_xxx.md`, `input/ke_xxx.md`, `session_a/ke_xxx.md`, `ke_xxx.md::3` → `ke_xxx`. */
export function entryIdOfSourceFile(sourceFile: string): string | null {
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
  return { id: edge.id, type: edge.type, from: edge.from, to: edge.to, confidence: confidenceOf(edge.confidence), entryIds: entryIdsOf(edge.source_files) };
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

/** Build a snapshot from parsed records (exported for tests and synthetic graphs). */
export function buildGraphSnapshot(nodes: readonly unknown[], edges: readonly unknown[]): { snapshot: Snapshot; skipped: number } {
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
  const adjacency = new Map<string, GraphEdge[]>();
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
  return { snapshot: { concepts, edges: edgeList, adjacency, entryConcepts, bm25 }, skipped };
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
}

/**
 * myKG's graph in memory (spec "Querying"), with every query scoped while it walks: hidden
 * entries never make a concept, an edge or a path visible. `load` swaps in a new snapshot
 * atomically; a query holds the snapshot it started with.
 */
export class KnowledgeGraph implements KnowledgeGraphPort {
  private snapshot: Snapshot = EMPTY;
  /** Numbers loads and replaces in the order they start; `applied` is the current snapshot's. */
  private generation = 0;
  private applied = 0;
  private readonly getMeta: (id: string) => KnowledgeEntryMeta | null;
  private readonly logger: KnowledgeLogger;

  constructor(options: KnowledgeGraphOptions) {
    this.getMeta = (id) => options.entries.getMeta(id);
    this.logger = options.logger ?? console;
  }

  /** Reads `nodes.jsonl` / `edges.jsonl` from `outputDir` (or its `output/`). Throws when there is no nodes file. */
  async load(outputDir: string): Promise<{ nodes: number; edges: number }> {
    const generation = ++this.generation;
    const dir = (await exists(join(outputDir, "nodes.jsonl"))) ? outputDir : join(outputDir, "output");
    const nodesPath = join(dir, "nodes.jsonl");
    const edgesPath = join(dir, "edges.jsonl");
    const nodes = await readJsonl(nodesPath, this.logger, "nodes.jsonl");
    const edges = (await exists(edgesPath)) ? await readJsonl(edgesPath, this.logger, "edges.jsonl") : [];
    const { snapshot, skipped } = buildGraphSnapshot(nodes, edges);
    if (skipped > 0) this.logger.warn(`knowledge: skipped ${skipped} graph record(s) (unreadable, repeated, or an edge to an unknown concept)`);
    if (generation < this.applied) {
      // A load (or replace) that started later has already swapped in the newer graph.
      return { nodes: snapshot.concepts.size, edges: snapshot.edges.length };
    }
    this.snapshot = snapshot;
    this.applied = generation;
    return this.counts();
  }

  /** Swap in records directly (tests, synthetic graphs). */
  replace(nodes: readonly unknown[], edges: readonly unknown[]): { nodes: number; edges: number } {
    this.applied = ++this.generation;
    this.snapshot = buildGraphSnapshot(nodes, edges).snapshot;
    return this.counts();
  }

  counts(): { nodes: number; edges: number } {
    return { nodes: this.snapshot.concepts.size, edges: this.snapshot.edges.length };
  }

  conceptTypes(): Map<string, number> {
    const types = new Map<string, number>();
    for (const concept of this.snapshot.concepts.values()) types.set(concept.type, (types.get(concept.type) ?? 0) + 1);
    return types;
  }

  /** Moves whenever a load or replace swaps in a snapshot (even one of the same size). */
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
        if (!view.concept(options.focus)) return null;
        frontier = [options.focus];
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

  /** A visible concept with its visible collections, entries and neighbours; null when hidden or unknown. */
  concept(id: string, scope: KnowledgeScope): KnowledgeConceptView | null {
    const view = this.view(scope);
    const concept = view.snapshot.concepts.get(id);
    if (!concept || !view.concept(id)) return null;
    const { entryIds: _entries, ...wire } = concept;
    return {
      concept: { ...wire, aliases: [...wire.aliases], attributes: { ...wire.attributes } },
      collections: view.collectionsOf(id),
      entryIds: view.entriesOf(id),
      neighbors: view.visibleEdges(id).map((edge) => ({
        edge: toEdge(edge),
        concept: toRef(view.snapshot.concepts.get(edge.from === id ? edge.to : edge.from)!)
      }))
    };
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
}
