import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { FakeEmbedderSource, FakeStore, cpu, cpuFloor, workClock, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { entryInScope, type KnowledgeScope } from "./visibility.ts";

// CPU budgets are relative to same-run independent scans, so host scheduling cannot fail them.
// Vectors come from
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
  const centreTexts = centres.map((_, c) => Array.from({ length: 60 }, (_, w) => `c${c}w${w}`).join(" "));
  const entryIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryId = id("ke_", i, 12);
    entryIds.push(entryId);
    // Entries of one centre are near-copies (possible duplicates need both meaning and text).
    store.put(
      entryId,
      `${centreTexts[i % centreTexts.length]} entry ${i}`,
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
  return { store, graph, collections, search, entryIds, random, vectors };
}

/** A plain, independent cosine scan: one query, or every pair, at the fixture's real dimensions. */
function vectorFloor(rows: readonly Float32Array[], pairs = false): number {
  return cpuFloor(() => {
    let sum = 0;
    for (let i = 0; i < (pairs ? rows.length : 1); i += 1)
      for (let j = pairs ? i + 1 : 0; j < rows.length; j += 1)
        for (let d = 0; d < DIMS; d += 1) sum += rows[i]![d]! * rows[j]![d]!;
    return sum;
  });
}

const p95 = (timings: number[]) => [...timings].sort((a, b) => a - b)[Math.floor(timings.length * 0.95)]!;

test("entry detail with similar entries and duplicates, and facets, over 5,000 entries: bounded CPU per vector scan", async (t) => {
  const { store, collections, search, entryIds, random, vectors } = await corpus(t);
  const floor = vectorFloor(vectors);
  const visibilities: KnowledgeVisibility[] = [{ kind: "all" }, { kind: "collections", ids: collections.slice(0, 3) }];

  const detail: number[] = [];
  for (let q = 0; q < 60; q += 1) {
    const visibility = visibilities[q % 2]!;
    const scope = search.scope(visibility);
    const visible = entryIds.filter((entryId) => entryInScope(store.getMeta(entryId)!, scope));
    const target = visible[Math.floor(random() * visible.length)]!;
    const started = cpu();
    const result = await search.entryDetail(target, visibility);
    detail.push(cpu() - started);
    assert.ok(result?.similar?.length && result.possibleDuplicates?.length, target);
  }

  const facets: number[] = [];
  for (let q = 0; q < 60; q += 1) {
    const visibility = visibilities[q % 2]!;
    const started = cpu();
    const filter = parseKnowledgeFilters(q % 3 === 0 ? { kinds: ["thread", "note"], years: ["2020", "2026"] } : undefined);
    const scope = search.scope(visibility, q % 4 === 0 ? [collections[0]!] : null);
    const kept = store.listMeta().filter((meta) => entryInScope(meta, scope) && entryMatchesFilter(meta, filter));
    const result = computeKnowledgeFacets(kept, scope, store.listCollections());
    facets.push(cpu() - started);
    assert.ok(result.kinds.length > 0);
  }

  assert.ok(p95(detail) < floor * 12, `entry detail p95 ${p95(detail).toFixed(1)} ms`);
  assert.ok(p95(facets) < floor * 12, `facets p95 ${p95(facets).toFixed(1)} ms`);
});

test("similarity graph over 1,000 entries: bounded CPU per pair scan and yielding to the event loop", async (t) => {
  const { search, vectors } = await corpus(t, 1_001);
  const floor = vectorFloor(vectors.slice(0, 1_000), true);
  workClock(t, 32);
  const scope = search.scope({ kind: "all" });
  let turns = 0;
  let drawing = true;
  const tick = () => {
    turns += 1;
    if (drawing) setImmediate(tick);
  };
  setImmediate(tick);
  const started = cpu();
  const graph = await search.similarity.graph({ limit: 1_000, k: 3 }, scope).finally(() => { drawing = false; });
  const cold = cpu() - started;
  assert.equal(graph.nodes.length, 1_000);
  assert.equal(graph.truncated, true);
  assert.ok(cold < floor * 8, `cold ${cold.toFixed(0)} ms`);
  assert.ok(turns > 1, "the event loop ran while the graph was computed");
});

/**
 * This process's CPU, right now, for one pass insights cannot avoid: every visible entry's
 * concepts read from the graph and its metadata hashed (median of 3).
 */
function insightsFloor(graph: KnowledgeGraph, store: FakeStore, ids: readonly string[], scope: KnowledgeScope): number {
  return cpuFloor(() => {
    const hash = createHash("sha256");
    let sink = 0;
    for (const id of ids) {
      sink += graph.conceptsOfEntry(id, scope).length;
      const meta = store.getMeta(id)!;
      hash.update(`${meta.id}\0${meta.updatedAt}\0${meta.collections.join(",")}\n`);
    }
    return sink + hash.digest().length;
  });
}

// Insights may use at most 64× the same-run visible-concept scan CPU, with similarity/gaps cached.
test("insights over 2,000 entries: bounded CPU per visible-entry scan (link gaps aside), yielding while gaps compute", async (t) => {
  const { store, graph, search, entryIds, random } = await corpus(t, 2_000);
  const pick = () => `${entryIds[Math.floor(random() * entryIds.length)]}.md`;
  const types = ["Tactic", "Rule", "Metric", "Topic", "Tool", "Person"];
  const concepts = Array.from({ length: 4_000 }, (_, i) =>
    node(`concept-${i}`, `Concept ${i}`, Array.from({ length: 1 + Math.floor(random() ** 2 * 6) }, pick), { type: types[i % types.length] })
  );
  const contradictions = Array.from({ length: 200 }, (_, i) => edge(`x-${i}`, `concept-${(i * 6) % 4_000}`, `concept-${(i * 6 + 3_006) % 4_000}`, null, "contradicts"));
  // A topic per vector centre on its entries, and a claim of one entry about it per 4 entries:
  // single-source claims whose topic their cluster discusses.
  const topics = Array.from({ length: 60 }, (_, c) => node(`topic-${c}`, `Topic ${c}`, entryIds.filter((_, i) => i % 60 === c).map((entryId) => `${entryId}.md`), { type: "Topic" }));
  const claims = entryIds.filter((_, i) => i % 4 === 0).map((entryId) => node(`claim-${entryId}`, `Claim of ${entryId}`, [`${entryId}.md`], { type: "Tactic" }));
  const about = entryIds.filter((_, i) => i % 4 === 0).map((entryId, n) => edge(`about-${n}`, `claim-${entryId}`, `topic-${(n * 4) % 60}`, null, "about"));
  await loadGraph(graph, [...concepts, ...topics, ...claims], [...contradictions, ...about]);
  const scope = search.scope({ kind: "all" });

  workClock(t, 32);
  let turns = 0;
  let computing = true;
  const tick = () => {
    turns += 1;
    if (computing) setImmediate(tick);
  };
  setImmediate(tick);
  const first = await search.insights.list({ limit: 20 }, scope).finally(() => {
    computing = false;
  });
  assert.ok(turns > 1, "the event loop ran while the graph and gaps were computed");

  const floor = insightsFloor(graph, store, entryIds, scope);
  const timings: number[] = [];
  for (let limit = 1; limit <= 50; limit += 1) {
    if (limit === 20) continue;
    const at = cpu();
    const result = await search.insights.list({ limit }, scope);
    timings.push(cpu() - at);
    assert.deepEqual(result.totals, first.totals);
  }
  const budget = floor * 64;
  assert.ok(first.totals.contradictions > 0 && first.totals.bridges > 0 && first.totals.singleSource > 0, JSON.stringify(first.totals));
  assert.ok(p95(timings) < budget, `insights p95 ${p95(timings).toFixed(1)} ms (budget ${budget.toFixed(0)} ms)`);
});
