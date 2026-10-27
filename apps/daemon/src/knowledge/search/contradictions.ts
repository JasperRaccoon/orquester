/**
 * Entries that disagree (phase 2 spec docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md,
 * "Contradictions"), read by similar entries, the similarity graph and insights:
 *
 * - `graph`: a concept of A `contradicts` a concept of B in the concept graph (either direction,
 *   after merges), A ≠ B, both visible, the edge itself visible; note = the edge's `context`;
 * - `checked`: an LLM pair check said `contradicts` (its note first, the graph's pairs kept).
 *
 * A pair check that found the two `consistent` or `unrelated` overrides the graph's guess: the
 * checker read both entries, the graph only their extracted concepts.
 */

import type { KnowledgeConceptRef } from "@orquester/api";
import type { KnowledgePairChecksPort } from "../ports.ts";
import type { GraphEdge, KnowledgeGraph } from "./graph.ts";
import type { KnowledgeScope } from "./visibility.ts";

/** The concept-graph relation that says one concept contradicts another. */
export const CONTRADICTS_RELATION = "contradicts";
/** Concept pairs kept per contradiction (the first ones found, in graph order). */
export const CONTRADICTION_PAIRS_MAX = 3;

export interface KnowledgeContradictionFound {
  /** Sorted: `a` < `b`. */
  a: string;
  b: string;
  source: "graph" | "checked";
  pairs: { from: KnowledgeConceptRef; to: KnowledgeConceptRef }[];
  note: string | null;
}

export type ContradictionGraph = Pick<KnowledgeGraph, "visibleEdgesOfType" | "visibleEntriesOf" | "conceptRef" | "conceptsOfEntry">;

export interface FindContradictionsOptions {
  graph: ContradictionGraph;
  scope: KnowledgeScope;
  pairChecks: KnowledgePairChecksPort | null;
  /** Entries that may take part (already visible in `scope`; e.g. the drawn nodes). */
  accept: (entryId: string) => boolean;
  /** Only pairs with this entry (similar entries); absent: every pair. */
  entryId?: string;
}

export const pairKeyOf = (x: string, y: string): string => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);

/** The edge's `context` (graph.ts reads myKG's attribute as text) as one line, or null. */
function contextOf(edge: GraphEdge): string | null {
  if (typeof edge.context !== "string") return null;
  const text = edge.context.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

function refOf(graph: ContradictionGraph, id: string): KnowledgeConceptRef | null {
  const ref = graph.conceptRef(id);
  return ref ? { id: ref.id, name: ref.name, type: ref.type } : null;
}

/** Contradicting entry pairs by {@link pairKeyOf}; every entry and concept named is visible in `scope`. */
export function findContradictions(options: FindContradictionsOptions): Map<string, KnowledgeContradictionFound> {
  const { graph, scope, accept, entryId } = options;
  const found = new Map<string, KnowledgeContradictionFound & { edges: Set<string> }>();
  const entriesOf = new Map<string, string[]>();
  const visibleEntries = (conceptId: string): string[] => {
    let ids = entriesOf.get(conceptId);
    if (!ids) entriesOf.set(conceptId, (ids = graph.visibleEntriesOf(conceptId, scope).filter(accept)));
    return ids;
  };
  const add = (x: string, y: string, edge: GraphEdge): void => {
    if (x === y) return;
    const key = pairKeyOf(x, y);
    let item = found.get(key);
    if (!item) {
      const [a, b] = x < y ? [x, y] : [y, x];
      found.set(key, (item = { a, b, source: "graph", pairs: [], note: null, edges: new Set() }));
    }
    if (item.edges.has(edge.id)) return;
    item.edges.add(edge.id);
    if (item.pairs.length >= CONTRADICTION_PAIRS_MAX) return;
    const from = refOf(graph, edge.from);
    const to = refOf(graph, edge.to);
    if (!from || !to) return;
    item.pairs.push({ from, to });
    item.note ??= contextOf(edge);
  };

  if (entryId !== undefined) {
    if (accept(entryId)) {
      const own = new Set(graph.conceptsOfEntry(entryId).map((concept) => concept.id));
      for (const edge of graph.visibleEdgesOfType(CONTRADICTS_RELATION, scope, own)) {
        if (own.has(edge.from)) for (const other of visibleEntries(edge.to)) add(entryId, other, edge);
        if (own.has(edge.to)) for (const other of visibleEntries(edge.from)) add(entryId, other, edge);
      }
    }
  } else {
    for (const edge of graph.visibleEdgesOfType(CONTRADICTS_RELATION, scope)) {
      const froms = visibleEntries(edge.from);
      if (froms.length === 0) continue;
      for (const to of visibleEntries(edge.to)) for (const from of froms) add(from, to, edge);
    }
  }

  for (const check of options.pairChecks?.all() ?? []) {
    if (entryId !== undefined && check.a !== entryId && check.b !== entryId) continue;
    if (check.a === check.b || !accept(check.a) || !accept(check.b)) continue;
    const key = pairKeyOf(check.a, check.b);
    if (check.verdict !== "contradicts") {
      found.delete(key);
      continue;
    }
    const item = found.get(key);
    const note = check.note?.replace(/\s+/g, " ").trim() || null;
    if (item) {
      item.source = "checked";
      item.note = note ?? item.note;
    } else {
      const [a, b] = check.a < check.b ? [check.a, check.b] : [check.b, check.a];
      found.set(key, { a, b, source: "checked", pairs: [], note, edges: new Set() });
    }
  }

  const out = new Map<string, KnowledgeContradictionFound>();
  for (const [key, { edges: _edges, ...item }] of found) out.set(key, item);
  return out;
}
