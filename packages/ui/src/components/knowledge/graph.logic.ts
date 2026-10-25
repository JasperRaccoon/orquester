/**
 * The Knowledge tab's graph rules: which request to make, how a concept is
 * coloured and sized, which ones carry a label. Pure — the canvas
 * (`KnowledgeGraphCanvas.tsx`) turns this into Cytoscape elements.
 */

import type { KnowledgeColor, KnowledgeGraphNode, KnowledgeGraphQuery, KnowledgeGraphResponse, KnowledgeSearchHit } from "@orquester/api";

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
function nodeSize(degree: number, maxDegree: number): number {
  if (maxDegree <= 0) return NODE_MIN_SIZE;
  const t = Math.sqrt(Math.max(0, degree) / maxDegree);
  return Math.round(NODE_MIN_SIZE + (NODE_MAX_SIZE - NODE_MIN_SIZE) * Math.min(1, t));
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
  colors: KnowledgeColor[];
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
