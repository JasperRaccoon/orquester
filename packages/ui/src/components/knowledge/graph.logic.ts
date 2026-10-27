/**
 * The Knowledge view's graph rules: which request to make, how a concept is
 * coloured and sized, which ones carry a label. Pure — the canvas
 * (`KnowledgeGraphCanvas.tsx`) turns this into Cytoscape elements.
 */

import {
  KNOWLEDGE_COLORS,
  type KnowledgeCollectionView,
  type KnowledgeColor,
  type KnowledgeConceptRef,
  type KnowledgeGraphNode,
  type KnowledgeGraphQuery,
  type KnowledgeGraphResponse,
  type KnowledgeSearchHit,
  type KnowledgeSimilarityCluster,
  type KnowledgeSimilarityGraphQuery,
  type KnowledgeSimilarityGraphResponse
} from "@orquester/api";

/** The graph a view asks for: everything (within the filter), or the neighbourhood of `focus`. */
export interface GraphScope {
  /** Collection ids the user filtered to; empty = every collection. */
  collections: readonly string[];
  /** A concept or entry id whose neighbourhood to show, or null for the overview. */
  focus: string | null;
}

export const FOCUS_DEPTH = 2;

export function graphQueryOf(scope: GraphScope): KnowledgeGraphQuery {
  const query: KnowledgeGraphQuery = {};
  if (scope.collections.length > 0) query.collections = [...scope.collections].sort().join(",");
  if (scope.focus) {
    query.focus = scope.focus;
    query.depth = FOCUS_DEPTH;
  }
  return query;
}

/** A stable key for a scope (effect dependency). */
export function graphScopeKey(scope: GraphScope): string {
  return `${[...scope.collections].sort().join(",")}|${scope.focus ?? ""}`;
}

/**
 * Where the canvas goes when the user selects `target` (a node, a search hit,
 * a citation). A concept already on the canvas stays where it is; one that is
 * not gets its neighbourhood. An entry keeps the complete overview (its
 * concepts are all in it); otherwise it gets its own neighbourhood. Returns the
 * new focus (null = overview); `graph` null (not loaded yet) changes nothing.
 */
export function focusFor(
  target: { kind: "entry" | "concept"; id: string },
  graph: Pick<KnowledgeGraphResponse, "truncated" | "nodes"> | null,
  currentFocus: string | null
): string | null {
  if (!graph) return currentFocus;
  if (target.kind === "concept") return graph.nodes.some((n) => n.id === target.id) ? currentFocus : target.id;
  if (!graph.truncated && currentFocus === null) return null;
  return target.id;
}

/**
 * The colours of a concept: one per collection behind it, in its order,
 * limited to the filter (when there is one) and to collections this client
 * knows. Empty = Unfiled only (drawn neutral).
 */
export function nodeColors(
  node: Pick<KnowledgeGraphNode, "collections">,
  colorOf: ReadonlyMap<string, KnowledgeColor>,
  filter: readonly string[]
): KnowledgeColor[] {
  const only = filter.length > 0 ? new Set(filter) : null;
  const out: KnowledgeColor[] = [];
  for (const id of node.collections) {
    if (only && !only.has(id)) continue;
    const color = colorOf.get(id);
    if (color && !out.includes(color)) out.push(color);
  }
  return out;
}

const NODE_MIN_SIZE = 10;
const NODE_MAX_SIZE = 44;

/** Diameter by degree: square-root scaled so hubs stand out without swallowing the rest. */
function nodeSize(degree: number, maxDegree: number, min = NODE_MIN_SIZE, max = NODE_MAX_SIZE): number {
  if (maxDegree <= 0) return min;
  const t = Math.sqrt(Math.max(0, degree) / maxDegree);
  return Math.round(min + (max - min) * Math.min(1, t));
}

/** How many labels the canvas draws at most at rest (the rest show on hover and selection). */
const MAX_LABELS = 60;

/**
 * The concepts that carry a label: every one in a small graph, else the
 * `max` most connected (ties by entry count, then name), so labels stay legible.
 */
function labelledNodes(nodes: readonly KnowledgeGraphNode[], max = MAX_LABELS): Set<string> {
  if (nodes.length <= max) return new Set(nodes.map((n) => n.id));
  const ranked = [...nodes].sort((a, b) => b.degree - a.degree || b.entryCount - a.entryCount || a.name.localeCompare(b.name));
  return new Set(ranked.slice(0, max).map((n) => n.id));
}

/** The note shown when the canvas holds part of the graph. */
export function truncationNote(graph: Pick<KnowledgeGraphResponse, "truncated" | "nodes" | "totals">, focused: boolean): string | null {
  if (focused) return `Showing the neighbourhood: ${graph.nodes.length.toLocaleString("en-US")} of ${graph.totals.nodes.toLocaleString("en-US")} concepts.`;
  if (!graph.truncated) return null;
  return `Showing the ${graph.nodes.length.toLocaleString("en-US")} most connected of ${graph.totals.nodes.toLocaleString("en-US")} concepts. Search or select one to see its neighbourhood.`;
}

export interface CanvasNode {
  id: string;
  label: string;
  /** Shown at rest (else only on hover / selection). */
  labelled: boolean;
  size: number;
  /** Empty: drawn neutral. Several: drawn as a pie. */
  colors: KnowledgeColor[];
}

/** A line between two canvas nodes (a concept graph's `KnowledgeEdge` is one). */
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  /** Similarity layer: a spanning-forest edge (drawn solid) or a nearest-neighbour one (thinner, dashed). */
  variant?: "tree" | "knn";
  /** Similarity layer: the two entries disagree (drawn in the destructive colour). */
  contradicts?: boolean;
}

/** The canvas' nodes for a graph. */
export function canvasNodes(
  graph: Pick<KnowledgeGraphResponse, "nodes">,
  colorOf: ReadonlyMap<string, KnowledgeColor>,
  filter: readonly string[]
): CanvasNode[] {
  const maxDegree = graph.nodes.reduce((max, n) => Math.max(max, n.degree), 0);
  const labelled = labelledNodes(graph.nodes);
  return graph.nodes.map((node) => ({
    id: node.id,
    label: node.name,
    labelled: labelled.has(node.id),
    size: nodeSize(node.degree, maxDegree),
    colors: nodeColors(node, colorOf, filter)
  }));
}

/**
 * What the canvas says about a search while its results list is closed, so no
 * hit is invisible: entry hits have no node, and a concept hit may be outside
 * the graph shown. Null without hits.
 */
export function searchSummary(hits: readonly KnowledgeSearchHit[], onCanvas: ReadonlySet<string>): string | null {
  if (hits.length === 0) return null;
  const entries = hits.filter((h) => h.kind === "entry").length;
  const concepts = hits.length - entries;
  const hidden = hits.filter((h) => h.kind === "concept" && !onCanvas.has(h.concept.id)).length;
  const parts: string[] = [];
  if (entries > 0) parts.push(`${entries} ${entries === 1 ? "entry" : "entries"}`);
  if (concepts > 0) {
    const marked = concepts - hidden;
    const where = hidden === 0 ? "marked" : marked === 0 ? "not on the canvas" : `${marked} marked`;
    parts.push(`${concepts} ${concepts === 1 ? "concept" : "concepts"} (${where})`);
  }
  return `Matches: ${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// The similarity layer (retrieval spec R7, "Graph view (U3)")
// ---------------------------------------------------------------------------

/** What the canvas draws: concepts and their relations, or entries joined by meaning. */
export type GraphLayer = "concepts" | "similarity";
/** How the similarity layer colours its entries. */
export type SimilarityColorBy = "cluster" | "collection";

/** The similarity graph a view asks for: the collections filtered to (empty = every one), the daemon's default size. */
export function similarityQueryOf(collections: readonly string[]): KnowledgeSimilarityGraphQuery {
  return collections.length > 0 ? { collections: [...collections].sort().join(",") } : {};
}

/**
 * Whether a refused request means the daemon has no such route (one that
 * predates it): a 404 without a knowledge error code. A refusal the knowledge
 * routes made themselves (`KNOWLEDGE_NOT_FOUND`, …) carries one.
 */
export function isMissingRoute(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status !== 404) return false;
  const body = (error as { body?: unknown }).body;
  const inner = body && typeof body === "object" ? ((body as { error?: unknown }).error ?? body) : null;
  const code = inner && typeof inner === "object" ? (inner as { code?: unknown }).code : undefined;
  return !(typeof code === "string" && code.startsWith("KNOWLEDGE_"));
}

/** A cluster with one entry (or an index the answer has no cluster for): drawn neutral, left out of the legend. */
const isSingleton = (cluster: Pick<KnowledgeSimilarityCluster, "size"> | undefined) => !cluster || cluster.size < 2;

/**
 * Each cluster's colour, by its index: the palette in turn for clusters of two
 * or more entries (largest first, as the daemon orders them), null (neutral)
 * for singletons.
 */
function clusterColors(clusters: readonly Pick<KnowledgeSimilarityCluster, "size">[]): (KnowledgeColor | null)[] {
  let next = 0;
  return clusters.map((cluster) => (isSingleton(cluster) ? null : KNOWLEDGE_COLORS[next++ % KNOWLEDGE_COLORS.length]!));
}

const ENTRY_MIN_SIZE = 9;
const ENTRY_MAX_SIZE = 26;
/** Up to this many entries every title is shown at rest; above it titles show on hover and selection. */
const ENTRY_LABELS_AT_REST = 40;

/** The canvas' nodes for a similarity graph, coloured by cluster or by collection (as concepts are). */
export function similarityCanvasNodes(
  graph: Pick<KnowledgeSimilarityGraphResponse, "nodes" | "clusters">,
  colorBy: SimilarityColorBy,
  colorOf: ReadonlyMap<string, KnowledgeColor>,
  filter: readonly string[]
): CanvasNode[] {
  const maxDegree = graph.nodes.reduce((max, n) => Math.max(max, n.degree), 0);
  const palette = clusterColors(graph.clusters);
  const labelled = graph.nodes.length <= ENTRY_LABELS_AT_REST;
  return graph.nodes.map((node) => {
    const clusterColor = palette[node.cluster] ?? null;
    return {
      id: node.id,
      label: node.title.trim() || "Untitled",
      labelled,
      size: nodeSize(node.degree, maxDegree, ENTRY_MIN_SIZE, ENTRY_MAX_SIZE),
      colors: colorBy === "cluster" ? (clusterColor ? [clusterColor] : []) : nodeColors(node, colorOf, filter)
    };
  });
}

/**
 * The canvas' edges for a similarity graph: spanning-forest edges solid, nearest-neighbour ones
 * dashed, and those between entries that disagree marked to be drawn in the destructive colour.
 */
export function similarityCanvasEdges(graph: Pick<KnowledgeSimilarityGraphResponse, "edges">): CanvasEdge[] {
  return graph.edges.map((edge) => {
    const out: CanvasEdge = { id: `s:${edge.from}|${edge.to}`, from: edge.from, to: edge.to, variant: edge.tree ? "tree" : "knn" };
    if (edge.contradicts) out.contradicts = true;
    return out;
  });
}

/** The Cytoscape classes of a canvas edge: its variant, and `contradicts` when the entries disagree. */
export function canvasEdgeClasses(edge: Pick<CanvasEdge, "variant" | "contradicts">): string {
  return [edge.variant ?? "", edge.contradicts ? "contradicts" : ""].filter(Boolean).join(" ");
}

/** Pairs of drawn entries that disagree (the legend's "Disagree" line). */
export function contradictingEdgeCount(graph: Pick<KnowledgeSimilarityGraphResponse, "edges">): number {
  return graph.edges.reduce((n, edge) => n + (edge.contradicts ? 1 : 0), 0);
}

/**
 * The entries of a concept that the similarity layer draws ("Show its entries in Similarity"):
 * the concept's entries that are nodes of `graph`, in the concept's order.
 */
export function drawnEntryIds(entryIds: readonly string[], graph: Pick<KnowledgeSimilarityGraphResponse, "nodes"> | null): string[] {
  if (!graph) return [];
  const drawn = new Set(graph.nodes.map((n) => n.id));
  return [...new Set(entryIds)].filter((id) => drawn.has(id));
}

/** A concept's entries to mark on the Similarity layer ("Show its entries in Similarity"). */
export interface ConceptMarks {
  id: string;
  name: string;
  /** Each once, newest first. */
  entryIds: readonly string[];
  /** When `entryIds` are only the newest this many of a concept's entries (a capped list), else null (all of them). */
  newest: number | null;
}

/** Entries a concept detail lists in full (the newest), and ids it lists at most (`entryIds`). */
const CONCEPT_ENTRIES_MAX = 50;
const CONCEPT_ENTRY_IDS_MAX = 2_000;

/**
 * The entries of a concept the panel has read: every visible one from `entryIds`, or from an older
 * daemon without it the entries it details (the newest 50 at most). A list at its cap says so.
 */
export function conceptMarksOf(detail: {
  concept: Pick<KnowledgeConceptRef, "id" | "name">;
  entries: readonly { id: string }[];
  entryIds?: readonly string[];
}): ConceptMarks {
  const ids = [...new Set(detail.entryIds ?? detail.entries.map((e) => e.id))];
  const cap = detail.entryIds ? CONCEPT_ENTRY_IDS_MAX : CONCEPT_ENTRIES_MAX;
  return { id: detail.concept.id, name: detail.concept.name, entryIds: ids, newest: ids.length >= cap ? ids.length : null };
}

/** What the Similarity layer says while a concept's entries are marked: how many of them it draws. */
export function conceptMarksText(concept: { name: string; entryIds: readonly string[]; newest?: number | null }, drawn: number): string {
  const total = new Set(concept.entryIds).size;
  const of = `behind “${concept.name}”`;
  // A capped list ("the 50 newest") never claims to be every entry.
  const entries = concept.newest != null ? "newest entries" : "entries";
  const count = total.toLocaleString("en-US");
  if (drawn === 0) return total === 1 ? `The entry ${of} is not drawn here.` : `None of the ${count} ${entries} ${of} is drawn here.`;
  if (drawn >= total) return total === 1 ? `Marked the entry ${of}.` : `Marked the ${count} ${entries} ${of}.`;
  return `Marked ${drawn.toLocaleString("en-US")} of the ${count} ${entries} ${of} (the rest are not drawn).`;
}

/** Which entries a legend line stands for. */
export type LegendMembers = { kind: "cluster"; index: number } | { kind: "singletons" } | { kind: "collection"; id: string } | { kind: "unfiled" };

export interface LegendItem {
  key: string;
  label: string;
  /** Entries in it. */
  size: number;
  /** Null: neutral. */
  color: KnowledgeColor | null;
  members: LegendMembers;
  /** A cluster's most distinctive concepts (phase 2; absent from an older daemon): each opens it in the Concepts layer. */
  concepts?: KnowledgeConceptRef[];
}

export interface Legend {
  items: LegendItem[];
  /** Clusters past the listed ones. */
  more: number;
}

const LEGEND_MAX = 12;

/**
 * The cluster legend: each cluster of two or more entries with its label
 * ("Untitled" without one) and size, largest first, then one line for the
 * entries in no cluster.
 *
 * A cluster line's key names the cluster by its first member entry id (the
 * smallest), not by its index or `id`: the daemon numbers clusters by rank in
 * each answer, so a refetch that reorders them would move a picked line to
 * another cluster. Its key outlives a refetch while that entry stays in a
 * cluster, and is gone (the pick lets go) when it does not.
 */
export function similarityLegend(graph: Pick<KnowledgeSimilarityGraphResponse, "nodes" | "clusters">, max = LEGEND_MAX): Legend {
  const palette = clusterColors(graph.clusters);
  const anchors = new Map<number, string>();
  for (const node of graph.nodes) {
    const anchor = anchors.get(node.cluster);
    if (anchor === undefined || node.id < anchor) anchors.set(node.cluster, node.id);
  }
  const items: LegendItem[] = [];
  let more = 0;
  graph.clusters.forEach((cluster, index) => {
    if (isSingleton(cluster)) return;
    if (items.length >= max) {
      more += 1;
      return;
    }
    const anchor = anchors.get(index);
    const key = anchor === undefined ? `cluster#${index}` : `cluster:${anchor}`;
    const item: LegendItem = { key, label: cluster.label ?? "Untitled", size: cluster.size, color: palette[index] ?? null, members: { kind: "cluster", index } };
    if (cluster.concepts && cluster.concepts.length > 0) item.concepts = cluster.concepts;
    items.push(item);
  });
  const alone = graph.nodes.filter((node) => palette[node.cluster] == null).length;
  if (alone > 0) items.push({ key: "singletons", label: "In no cluster", size: alone, color: null, members: { kind: "singletons" } });
  return { items, more };
}

/**
 * The collection legend: each collection (within the filter) with how many of
 * the graph's entries it holds, then Unfiled. An entry in several collections
 * counts in each.
 */
export function collectionLegend(
  graph: Pick<KnowledgeSimilarityGraphResponse, "nodes">,
  collections: readonly Pick<KnowledgeCollectionView, "id" | "name" | "color">[],
  filter: readonly string[]
): Legend {
  const only = filter.length > 0 ? new Set(filter) : null;
  const known = new Set(collections.map((c) => c.id));
  const counts = new Map<string, number>();
  let unfiled = 0;
  for (const node of graph.nodes) {
    const mine = node.collections.filter((id) => known.has(id));
    if (mine.length === 0) unfiled += 1;
    for (const id of mine) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const items: LegendItem[] = [];
  for (const c of collections) {
    const size = counts.get(c.id) ?? 0;
    if (size === 0 || (only && !only.has(c.id))) continue;
    items.push({ key: `collection:${c.id}`, label: c.name, size, color: c.color, members: { kind: "collection", id: c.id } });
  }
  if (unfiled > 0) items.push({ key: "unfiled", label: "Unfiled", size: unfiled, color: null, members: { kind: "unfiled" } });
  return { items, more: 0 };
}

/** The entry ids a legend line stands for (marked on the canvas while it is picked). */
export function legendMemberIds(
  graph: Pick<KnowledgeSimilarityGraphResponse, "nodes" | "clusters">,
  members: LegendMembers,
  knownCollections: ReadonlySet<string>
): Set<string> {
  const palette = clusterColors(graph.clusters);
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    const isMember =
      members.kind === "cluster"
        ? node.cluster === members.index
        : members.kind === "singletons"
          ? palette[node.cluster] == null
          : members.kind === "collection"
            ? node.collections.includes(members.id)
            : !node.collections.some((id) => knownCollections.has(id));
    if (isMember) ids.add(node.id);
  }
  return ids;
}

/**
 * `searchSummary` for the similarity layer, where entry hits are nodes: how
 * many entry hits are marked on it, and the concept hits (which are not).
 */
export function similaritySearchSummary(hits: readonly KnowledgeSearchHit[], onCanvas: ReadonlySet<string>): string | null {
  if (hits.length === 0) return null;
  const entryIds = hits.flatMap((h) => (h.kind === "entry" ? [h.entry.id] : []));
  const concepts = hits.length - entryIds.length;
  const parts: string[] = [];
  if (entryIds.length > 0) {
    const marked = entryIds.filter((id) => onCanvas.has(id)).length;
    const where = marked === entryIds.length ? "marked" : marked === 0 ? "not on the canvas" : `${marked} marked`;
    parts.push(`${entryIds.length} ${entryIds.length === 1 ? "entry" : "entries"} (${where})`);
  }
  if (concepts > 0) parts.push(`${concepts} ${concepts === 1 ? "concept" : "concepts"}`);
  return `Matches: ${parts.join(", ")}.`;
}

/** Why the similarity layer has nothing to draw. */
export type SimilarityEmpty = "no-entries" | "computing" | "model-missing";

/**
 * The similarity layer's empty state, or null when it has entries to draw: no
 * entries in the collections shown; or entries but none embedded yet — the
 * embedding model still has to be fetched (`status.embeddingModelReady` false),
 * else "Embeddings are being computed…" (also when an older daemon does not say).
 */
export function similarityEmptyState(
  graph: Pick<KnowledgeSimilarityGraphResponse, "nodes" | "totals">,
  embeddingModelReady: boolean | undefined
): SimilarityEmpty | null {
  if (graph.nodes.length > 0) return null;
  if (graph.totals.entries === 0) return "no-entries";
  return embeddingModelReady === false ? "model-missing" : "computing";
}

/** The note shown when the similarity layer holds part of the entries (truncated, or some not embedded yet). */
export function similarityNote(graph: Pick<KnowledgeSimilarityGraphResponse, "nodes" | "truncated" | "totals">): string | null {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const parts: string[] = [];
  if (graph.truncated) parts.push(`Showing the ${fmt(graph.nodes.length)} most recent of ${fmt(graph.totals.embedded)} entries.`);
  const waiting = graph.totals.entries - graph.totals.embedded;
  if (waiting > 0 && graph.nodes.length > 0) parts.push(`${fmt(waiting)} ${waiting === 1 ? "entry is" : "entries are"} still being embedded.`);
  return parts.length > 0 ? parts.join(" ") : null;
}
