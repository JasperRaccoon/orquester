import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeSearchRequest, KnowledgeVisibility } from "@orquester/api";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
import { FakeEmbedder, FakeEmbedderSource, FakeStore, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";

// Spec "Fast": search returns within about 300 ms p95 at 5,000 entries. A fake embedder with the
// real model's 384 dimensions stands in for the model (its own latency is measured by the
// model-gated test in embedder.model.test.ts).

const ENTRIES = 5_000;
const CONCEPTS = 3_000;
const KINDS = ["post", "thread", "article", "note"];

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const id = (prefix: string, n: number, width: number) =>
  `${prefix}${n.toString(32).padStart(width, "0")}`;

test("hybrid search over 5,000 entries with filters, MMR, facets and paging: p95 under 300 ms", { timeout: 120_000 }, async (t) => {
  const random = prng(42);
  const vocabulary = Array.from({ length: 3_000 }, (_, i) => `w${i.toString(36)}`);
  const store = new FakeStore();
  const collections = Array.from({ length: 8 }, (_, i) => store.collection(id("kc_", i, 10), `Collection ${i}`).id);
  const entryIds: string[] = [];
  for (let i = 0; i < ENTRIES; i += 1) {
    const words = Array.from({ length: 40 + Math.floor(random() * 200) }, () => vocabulary[Math.floor(random() ** 2 * vocabulary.length)]!);
    const entryId = id("ke_", i, 12);
    entryIds.push(entryId);
    const posted = random() < 0.5 ? null : new Date(Date.parse("2024-01-01") + Math.floor(random() * 1_000) * 86_400_000).toISOString();
    store.put(
      entryId,
      words.join(" "),
      [collections[i % collections.length]!],
      { title: words.slice(0, 6).join(" "), kind: KINDS[i % KINDS.length]!, author: `Author ${i % 40}`, handle: i % 3 === 0 ? `handle${i % 40}` : null, postedAt: posted },
      true
    );
  }
  const nodes = Array.from({ length: CONCEPTS }, (_, i) =>
    node(
      `concept-${i}`,
      `${vocabulary[i]} ${vocabulary[(i * 7) % vocabulary.length]}`,
      Array.from({ length: 1 + Math.floor(random() * 4) }, () => `${entryIds[Math.floor(random() * ENTRIES)]}.md`)
    )
  );
  const edges = Array.from({ length: CONCEPTS * 3 }, (_, i) => {
    const a = Math.floor(random() * CONCEPTS);
    const b = (a + 1 + Math.floor(random() * (CONCEPTS - 1))) % CONCEPTS;
    return edge(`edge-${i}`, `concept-${a}`, `concept-${b}`, [`${entryIds[Math.floor(random() * ENTRIES)]}.md`]);
  });
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(graph, nodes, edges);

  const indexDir = await mkdtemp(join(tmpdir(), "kg-perf-"));
  const embedder = new FakeEmbedder({ dimensions: 384 });
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(embedder), indexDir, logger: silentLogger() });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  await search.idle();
  assert.equal(search.vectorIndex().embeddedIds().length, ENTRIES, "the benchmark must index all 5,000 distinct entries");

  const visibilities: KnowledgeVisibility[] = [{ kind: "all" }, { kind: "collections", ids: collections.slice(0, 3) }];
  const timings: number[] = [];
  // Every request diversifies (MMR is the default); most also filter, count facets, sort by
  // recency, page, or search by example (retrieval spec, "Performance budgets").
  for (let q = 0; q < 80; q += 1) {
    const query = Array.from({ length: 2 + (q % 4) }, () => vocabulary[Math.floor(random() * 400)]!).join(" ");
    const visibility = visibilities[q % 2]!;
    const variant = q % 5;
    const request: KnowledgeSearchRequest =
      variant === 0
        ? { query, limit: 8 }
        : variant === 1
          ? { query, limit: 8, filters: { kinds: ["thread", "post"], years: ["2024", "2025", "2026"] }, facets: true }
          : variant === 2
            ? { query, limit: 8, sort: "recent", facets: true, filters: { savedAfter: "2026-01-01" } }
            : variant === 3
              ? // Entry q·8 is in the first collection, visible to both callers.
                { query, limit: 8, similarTo: [entryIds[q * 8]!], filters: { authors: Array.from({ length: 20 }, (_, i) => `Author ${i}`) } }
              : { query, limit: 25, facets: true };
    let started = performance.now();
    const result = await search.search(request, visibility);
    timings.push(performance.now() - started);
    assert.ok(result.total !== undefined && (variant === 0 ? result.hits.length > 0 : true), query);
    if (request.facets) assert.ok(result.facets);
    if (result.nextCursor) {
      started = performance.now();
      await search.search({ ...request, cursor: result.nextCursor }, visibility);
      timings.push(performance.now() - started);
    }
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length * 0.5)]!;
  const p95 = timings[Math.floor(timings.length * 0.95)]!;
  t.diagnostic(`search over ${ENTRIES} entries: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);

  assert.ok(p95 < 300, `p95 ${p95.toFixed(1)} ms`);
});
