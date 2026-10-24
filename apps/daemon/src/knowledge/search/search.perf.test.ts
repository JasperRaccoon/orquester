import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeVisibility } from "@orquester/api";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
import { FakeEmbedder, FakeEmbedderSource, FakeStore, edge, node, silentLogger } from "./test-fakes.ts";

// Spec "Fast": search returns within about 300 ms p95 at 5,000 entries. A fake embedder with the
// real model's 384 dimensions stands in for the model (its own latency is measured by the
// model-gated test in embedder.model.test.ts).

const ENTRIES = 5_000;
const CONCEPTS = 3_000;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const id = (prefix: string, n: number, width: number) =>
  `${prefix}${n.toString(32).padStart(width, "0").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`;

test("hybrid search over 5,000 entries: p95 under 300 ms", { timeout: 120_000 }, async (t) => {
  const random = prng(42);
  const vocabulary = Array.from({ length: 3_000 }, (_, i) => `w${i.toString(36)}`);
  const store = new FakeStore();
  const collections = Array.from({ length: 8 }, (_, i) => store.collection(id("kc_", i, 10), `Collection ${i}`).id);
  const entryIds: string[] = [];
  for (let i = 0; i < ENTRIES; i += 1) {
    const words = Array.from({ length: 40 + Math.floor(random() * 200) }, () => vocabulary[Math.floor(random() ** 2 * vocabulary.length)]!);
    const entryId = id("ke_", i, 12);
    entryIds.push(entryId);
    store.put(entryId, words.join(" "), [collections[i % collections.length]!], { title: words.slice(0, 6).join(" ") }, true);
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
  graph.replace(nodes, edges);

  const indexDir = await mkdtemp(join(tmpdir(), "kg-perf-"));
  const embedder = new FakeEmbedder({ dimensions: 384 });
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(embedder), indexDir, logger: silentLogger() });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  await search.search({ query: "warm up" }, { kind: "all" });
  await search.idle();

  const visibilities: KnowledgeVisibility[] = [{ kind: "all" }, { kind: "collections", ids: collections.slice(0, 3) }];
  const timings: number[] = [];
  for (let q = 0; q < 60; q += 1) {
    const query = Array.from({ length: 2 + (q % 4) }, () => vocabulary[Math.floor(random() * 400)]!).join(" ");
    const started = performance.now();
    const result = await search.search({ query, limit: 8 }, visibilities[q % 2]!);
    timings.push(performance.now() - started);
    assert.ok(result.hits.length > 0, query);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length * 0.5)]!;
  const p95 = timings[Math.floor(timings.length * 0.95)]!;
  t.diagnostic(`search over ${ENTRIES} entries: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);

  const graphStarted = performance.now();
  const whole = search.graphView({}, { kind: "all" });
  t.diagnostic(`whole graph (${whole.totals.nodes} nodes, truncated ${whole.truncated}): ${(performance.now() - graphStarted).toFixed(1)} ms`);
  assert.ok(p95 < 300, `p95 ${p95.toFixed(1)} ms`);
});
