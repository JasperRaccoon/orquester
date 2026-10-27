import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeVisibility } from "@orquester/api";
import type { KnowledgeEmbedder } from "./embedder.ts";
import { computeKnowledgeFacets } from "./facets.ts";
import { parseKnowledgeFilters, entryMatchesFilter } from "./filters.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
import { FakeEmbedderSource, FakeStore, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { entryInScope } from "./visibility.ts";

// Retrieval spec "Performance budgets": entry detail (similar + duplicates) and facets p95 under
// 100 ms at 5,000 entries; the similarity graph within 2 s cold at 1,000 entries. Vectors come from
// a controlled embedder at the real model's 384 dimensions (clustered, so neighbours and duplicates exist).

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
  `${prefix}${n.toString(32).padStart(width, "0")}`;

async function corpus(t: test.TestContext, count = ENTRIES) {
  const random = prng(7);
  const store = new FakeStore();
  const collections = Array.from({ length: 8 }, (_, i) => store.collection(id("kc_", i, 10), `Collection ${i}`).id);
  const vectors: Float32Array[] = [];
  const centres = Array.from({ length: 60 }, () => Array.from({ length: DIMS }, () => random() - 0.5));
  const entryIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
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
    const vector = Float32Array.from(centre, (x) => x + (random() - 0.5) * 0.3);
    const norm = Math.hypot(...vector);
    vectors.push(vector.map((x) => x / norm));
  }
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(
    graph,
    Array.from({ length: Math.floor(count * 0.4) }, (_, i) =>
      node(`concept-${i}`, `Concept ${i}`, Array.from({ length: 1 + Math.floor(random() * 5) }, () => `${entryIds[Math.floor(random() * count)]}.md`))
    )
  );
  const indexDir = await mkdtemp(join(tmpdir(), "kg-similarity-perf-"));
  const embedder: KnowledgeEmbedder = {
    modelId: "similarity-perf-fixture", dimensions: DIMS,
    thresholds: { minimum: 0.3, good: 0.5, strong: 0.7, duplicate: 0.9 },
    async embed(texts, kind) {
      return texts.map((text) => {
        if (kind === "query") return vectors[0]!;
        const match = /\bentry (\d+)\s*$/.exec(text);
        assert.ok(match, "fixture passage identifies its entry");
        return vectors[Number(match[1])]!;
      });
    }
  };
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(embedder), indexDir, logger: silentLogger() });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  await search.search({ query: "warm up" }, { kind: "all" });
  await search.idle();
  return { store, collections, search, entryIds, random };
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
    assert.ok(result?.similar?.length && result.possibleDuplicates?.length, target);
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

test("similarity graph over 1,000 entries: within 2 s cold and yielding to the event loop", { timeout: 120_000 }, async (t) => {
  const { search } = await corpus(t, 1_001);
  const scope = search.scope({ kind: "all" });
  let turns = 0;
  let drawing = true;
  const tick = () => {
    turns += 1;
    if (drawing) setImmediate(tick);
  };
  setImmediate(tick);
  const started = performance.now();
  const graph = await search.similarity.graph({ limit: 1_000, k: 3 }, scope).finally(() => { drawing = false; });
  const cold = performance.now() - started;
  t.diagnostic(`similarity graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.clusters.length} clusters; cold ${cold.toFixed(0)} ms, ${turns} event-loop turns`);
  assert.equal(graph.nodes.length, 1_000);
  assert.equal(graph.truncated, true);
  assert.ok(cold < 2_000, `cold ${cold.toFixed(0)} ms`);
  assert.ok(turns > 1 || cold < 40, "the event loop ran while the graph was computed");
});
