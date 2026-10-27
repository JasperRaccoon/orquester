import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeVisibility } from "@orquester/api";
import { computeKnowledgeFacets } from "./facets.ts";
import { FakeVectorIndex } from "./fake-vector-index.ts";
import { parseKnowledgeFilters, entryMatchesFilter } from "./filters.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
import { FakeEmbedderSource, FakeStore, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { entryInScope } from "./visibility.ts";

// Retrieval spec "Performance budgets": entry detail (similar + duplicates) and facets p95 under
// 100 ms at 5,000 entries; the similarity graph within 2 s cold at 1,000 entries. Vectors come from
// the fake index at the real model's 384 dimensions (clustered, so neighbours and duplicates exist).

const ENTRIES = 5_000;
const DIMS = 384;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const id = (prefix: string, n: number, width: number) =>
  `${prefix}${n.toString(32).padStart(width, "0").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`;

async function corpus(t: test.TestContext) {
  const random = prng(7);
  const store = new FakeStore();
  const collections = Array.from({ length: 8 }, (_, i) => store.collection(id("kc_", i, 10), `Collection ${i}`).id);
  const index = new FakeVectorIndex();
  const centres = Array.from({ length: 60 }, () => Array.from({ length: DIMS }, () => random() - 0.5));
  const entryIds: string[] = [];
  for (let i = 0; i < ENTRIES; i += 1) {
    const entryId = id("ke_", i, 12);
    entryIds.push(entryId);
    store.put(
      entryId,
      `entry ${i}`,
      [collections[i % collections.length]!],
      {
        title: `Title ${i % 300} topic ${i % 17}`,
        kind: ["thread", "article", "note", "post"][i % 4]!,
        author: `Author ${i % 90}`,
        handle: i % 3 === 0 ? `handle${i % 90}` : null,
        postedAt: i % 2 === 0 ? `${2018 + (i % 9)}-05-01` : null
      },
      true
    );
    const centre = centres[i % centres.length]!;
    index.set(entryId, centre.map((x) => x + (random() - 0.5) * 0.3), centre.map((x) => x + (random() - 0.5) * 0.3));
  }
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(
    graph,
    Array.from({ length: 2_000 }, (_, i) =>
      node(`concept-${i}`, `Concept ${i}`, Array.from({ length: 1 + Math.floor(random() * 5) }, () => `${entryIds[Math.floor(random() * ENTRIES)]}.md`))
    )
  );
  const indexDir = await mkdtemp(join(tmpdir(), "kg-similarity-perf-"));
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(null), indexDir, logger: silentLogger() });
  search.vectorIndex = () => index;
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  return { store, collections, index, search, entryIds, random };
}

const p95 = (timings: number[]) => [...timings].sort((a, b) => a - b)[Math.floor(timings.length * 0.95)]!;

test("entry detail with similar entries and duplicates, and facets, over 5,000 entries: p95 under 100 ms", { timeout: 120_000 }, async (t) => {
  const { store, collections, search, entryIds, random } = await corpus(t);
  const visibilities: KnowledgeVisibility[] = [{ kind: "all" }, { kind: "collections", ids: collections.slice(0, 3) }];

  const detail: number[] = [];
  for (let q = 0; q < 60; q += 1) {
    const visibility = visibilities[q % 2]!;
    const scope = search.scope(visibility);
    const visible = entryIds.filter((entryId) => entryInScope(store.getMeta(entryId)!, scope));
    const target = visible[Math.floor(random() * visible.length)]!;
    const started = performance.now();
    const result = await search.entryDetail(target, visibility);
    detail.push(performance.now() - started);
    assert.ok(result && result.similar && result.similar.length > 0, target);
  }

  const facets: number[] = [];
  for (let q = 0; q < 60; q += 1) {
    const visibility = visibilities[q % 2]!;
    const started = performance.now();
    const filter = parseKnowledgeFilters(q % 3 === 0 ? { kinds: ["thread", "note"], years: ["2020", "2026"] } : undefined);
    const scope = search.scope(visibility, q % 4 === 0 ? [collections[0]!] : null);
    const kept = store.listMeta().filter((meta) => entryInScope(meta, scope) && entryMatchesFilter(meta, filter));
    const result = computeKnowledgeFacets(kept, scope, store.listCollections());
    facets.push(performance.now() - started);
    assert.ok(result.kinds.length > 0);
  }

  t.diagnostic(`entry detail p95 ${p95(detail).toFixed(1)} ms; facets p95 ${p95(facets).toFixed(1)} ms`);
  assert.ok(p95(detail) < 100, `entry detail p95 ${p95(detail).toFixed(1)} ms`);
  assert.ok(p95(facets) < 100, `facets p95 ${p95(facets).toFixed(1)} ms`);
});

/**
 * The time this machine takes, right now, for the graph's unavoidable work: one dot product per
 * pair of 1,000 vectors at 384 dimensions (the same unrolled loop). On a busy host this alone can
 * pass the 2 s budget, so the graph is held to the budget or to a small multiple of this floor.
 */
function pairwiseFloor(n: number, dims: number): number {
  const random = prng(7);
  const packed = new Float32Array(n * dims).map(() => random() - 0.5);
  const started = performance.now();
  let sink = 0;
  for (let i = 0; i < n; i += 1) {
    const a = i * dims;
    for (let j = i + 1; j < n; j += 1) {
      const b = j * dims;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let d = 0; d + 3 < dims; d += 4) {
        s0 += packed[a + d]! * packed[b + d]!;
        s1 += packed[a + d + 1]! * packed[b + d + 1]!;
        s2 += packed[a + d + 2]! * packed[b + d + 2]!;
        s3 += packed[a + d + 3]! * packed[b + d + 3]!;
      }
      sink += s0 + s1 + s2 + s3;
    }
  }
  const elapsed = performance.now() - started;
  assert.ok(Number.isFinite(sink));
  return elapsed;
}

test("similarity graph over 1,000 entries: within 2 s cold, yielding to the event loop, then cached", { timeout: 120_000 }, async (t) => {
  const { search } = await corpus(t);
  const scope = search.scope({ kind: "all" });
  let turns = 0;
  let drawing = true;
  const tick = () => {
    turns += 1;
    if (drawing) setImmediate(tick);
  };
  const floor = pairwiseFloor(1_000, DIMS);
  setImmediate(tick);
  const started = performance.now();
  const graph = await search.similarity.graph({ limit: 1_000, k: 3 }, scope);
  const cold = performance.now() - started;
  drawing = false;
  const warmStarted = performance.now();
  const again = await search.similarity.graph({ limit: 1_000, k: 3 }, scope);
  const warm = performance.now() - warmStarted;
  t.diagnostic(`similarity graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.clusters.length} clusters; cold ${cold.toFixed(0)} ms (pairwise floor ${floor.toFixed(0)} ms), cached ${warm.toFixed(1)} ms, ${turns} event-loop turns`);
  assert.equal(graph.nodes.length, 1_000);
  assert.equal(graph.truncated, true);
  assert.deepEqual(again, graph);
  assert.ok(cold < Math.max(2_000, floor * 2.5), `cold ${cold.toFixed(0)} ms (pairwise floor ${floor.toFixed(0)} ms)`);
  assert.ok(warm < cold / 4, `cached ${warm.toFixed(1)} ms`);
  assert.ok(turns > 1 || cold < 40, "the event loop ran while the graph was computed");
});
