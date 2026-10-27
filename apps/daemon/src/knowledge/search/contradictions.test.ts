import assert from "node:assert/strict";
import { test } from "node:test";

import type { KnowledgePairCheck, KnowledgePairChecksPort } from "../ports.ts";
import { type ContradictionGraph, findContradictions } from "./contradictions.ts";
import type { GraphEdge } from "./graph.ts";
import { knowledgeScope } from "./visibility.ts";

// The phase 2 spec's contradiction rules over a hand-built concept graph (edges carry the
// `context` attribute concept merges keep): either direction, both entries visible, the edge's
// context as the note, pair checks confirming or overriding.

const scope = knowledgeScope({ kind: "all" }, []);

/** Concept → its entries; `contradicts` edges with an optional context. */
function graphOf(concepts: Record<string, string[]>, edges: (Partial<GraphEdge> & { from: string; to: string; context?: unknown })[]): ContradictionGraph {
  const full: GraphEdge[] = edges.map((edge, i) => ({ id: `e${i}`, type: "contradicts", confidence: 0.9, entryIds: null, ...edge }));
  return {
    visibleEdgesOfType: (type, _scope, around) => {
      const near = around ? new Set(around) : null;
      return full.filter((edge) => edge.type.toLowerCase() === type && (!near || near.has(edge.from) || near.has(edge.to)));
    },
    visibleEntriesOf: (conceptId) => [...(concepts[conceptId] ?? [])],
    conceptRef: (id) => (concepts[id] ? { id, name: id.toUpperCase(), type: "Tactic", description: null } : null),
    conceptIdsOfEntry: (entryId) =>
      Object.entries(concepts)
        .filter(([, entries]) => entries.includes(entryId))
        .map(([id]) => id)
  };
}

function checks(list: KnowledgePairCheck[]): KnowledgePairChecksPort {
  return { all: () => list, get: (a, b) => list.find((c) => c.a === a && c.b === b) ?? null, onChange: () => () => undefined };
}

const check = (a: string, b: string, verdict: KnowledgePairCheck["verdict"], note: string | null = null): KnowledgePairCheck => ({
  a,
  b,
  verdict,
  note,
  checkedAt: "2026-10-27T00:00:00.000Z"
});

test("graph: a concept of one entry contradicting a concept of another, in either direction, with the edge's context as the note", () => {
  const graph = graphOf({ short: ["ke_a"], long: ["ke_b", "ke_c"], other: ["ke_c"] }, [
    { from: "short", to: "long", context: "  Trials:  3 days vs 14 days " },
    { from: "other", to: "short", context: "one says daily, one says weekly" },
    { from: "long", to: "other", type: "supports" }
  ]);
  const all = findContradictions({ graph, scope, pairChecks: null, accept: () => true });
  assert.deepEqual([...all.values()], [
    { a: "ke_a", b: "ke_b", source: "graph", pairs: [{ from: { id: "short", name: "SHORT", type: "Tactic" }, to: { id: "long", name: "LONG", type: "Tactic" } }], note: "Trials: 3 days vs 14 days" },
    {
      a: "ke_a",
      b: "ke_c",
      source: "graph",
      pairs: [
        { from: { id: "short", name: "SHORT", type: "Tactic" }, to: { id: "long", name: "LONG", type: "Tactic" } },
        { from: { id: "other", name: "OTHER", type: "Tactic" }, to: { id: "short", name: "SHORT", type: "Tactic" } }
      ],
      note: "Trials: 3 days vs 14 days"
    }
  ]);
  // The same pairs, seen from one entry (B: only through `long`; an entry is never its own contradiction).
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: () => true, entryId: "ke_b" }).keys()].length, 1);
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: () => true, entryId: "ke_c" }).values()].map((c) => [c.a, c.b]), [["ke_a", "ke_c"]]);
});

test("an edge without context has no note; an entry that is not accepted is never on either side", () => {
  const graph = graphOf({ x: ["ke_a", "ke_hidden"], y: ["ke_b", "ke_hidden"] }, [{ from: "x", to: "y" }]);
  const visible = (id: string) => id !== "ke_hidden";
  const all = [...findContradictions({ graph, scope, pairChecks: null, accept: visible }).values()];
  assert.deepEqual(all.map((c) => [c.a, c.b, c.note]), [["ke_a", "ke_b", null]]);
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: visible, entryId: "ke_hidden" }).values()], []);
  const checked = checks([check("ke_a", "ke_hidden", "contradicts", "secret")]);
  assert.ok(![...findContradictions({ graph, scope, pairChecks: checked, accept: visible }).values()].some((c) => c.note === "secret"));
});

test("checked: a `contradicts` pair check adds the pair (or confirms the graph's, keeping its pairs); `consistent` and `unrelated` override the graph", () => {
  const graph = graphOf({ x: ["ke_a"], y: ["ke_b"], z: ["ke_c"] }, [
    { from: "x", to: "y", context: "graph says" },
    { from: "x", to: "z", context: "refuted" }
  ]);
  const port = checks([check("ke_a", "ke_b", "contradicts", "the checker says"), check("ke_a", "ke_c", "consistent"), check("ke_b", "ke_d", "contradicts", "d")]);
  const found = findContradictions({ graph, scope, pairChecks: port, accept: (id) => id !== "ke_d" });
  assert.deepEqual([...found.values()], [
    { a: "ke_a", b: "ke_b", source: "checked", pairs: [{ from: { id: "x", name: "X", type: "Tactic" }, to: { id: "y", name: "Y", type: "Tactic" } }], note: "the checker says" }
  ]);
  const only = findContradictions({ graph, scope, pairChecks: checks([check("ke_b", "ke_c", "contradicts", null)]), accept: () => true, entryId: "ke_c" });
  assert.deepEqual([...only.values()], [
    { a: "ke_a", b: "ke_c", source: "graph", pairs: [{ from: { id: "x", name: "X", type: "Tactic" }, to: { id: "z", name: "Z", type: "Tactic" } }], note: "refuted" },
    { a: "ke_b", b: "ke_c", source: "checked", pairs: [], note: null }
  ]);
});
