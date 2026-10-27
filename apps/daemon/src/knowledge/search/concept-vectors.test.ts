import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { knowledgeIndexDir } from "@orquester/config";
import { KnowledgeConceptMerges } from "./concept-merges.ts";
import { CONCEPT_EMBED_BATCH, type ConceptText, ConceptVectors, conceptEmbeddingText } from "./concept-vectors.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
import { FakeEmbedder, FakeEmbedderSource, FakeStore, loadGraph, node, silentLogger } from "./test-fakes.ts";

const concepts = (n: number, prefix = "Tactic"): ConceptText[] =>
  Array.from({ length: n }, (_, i) => ({ id: `tactic-${i}`, type: prefix, name: `Concept number ${i}`, aliases: i % 2 ? [`alias ${i}`] : [], description: i % 3 ? null : `About ${i}` }));

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kg-concept-vectors-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the text of a concept: type, name, aliases, description", () => {
  assert.equal(conceptEmbeddingText({ id: "x", type: "Tactic", name: " Warm up ", aliases: ["warm-up", " "], description: "Use it first." }), "Tactic: Warm up. warm-up. Use it first.");
  assert.equal(conceptEmbeddingText({ id: "x", type: "Tool", name: "Ahrefs", aliases: [], description: null }), "Tool: Ahrefs");
});

test("concepts are embedded as passages in batches of at most 16 with a pause between them, and cached on disk", async (t) => {
  const dir = await tempDir(t);
  const embedder = new FakeEmbedder({ dimensions: 16, groups: [] });
  const sizes: number[] = [];
  const embed = embedder.embed.bind(embedder);
  embedder.embed = async (texts, kind) => {
    sizes.push(texts.length);
    return embed(texts, kind);
  };
  let pauses = 0;
  const vectors = new ConceptVectors({ embedders: new FakeEmbedderSource(embedder), dir, logger: silentLogger(), pause: async () => void (pauses += 1) });
  let computed = 0;
  vectors.onComputed(() => (computed += 1));
  vectors.update(concepts(40));
  await vectors.idle();
  assert.deepEqual(sizes, [16, 16, 8]);
  assert.ok(sizes.every((size) => size <= CONCEPT_EMBED_BATCH));
  assert.equal(pauses, 2);
  assert.ok(embedder.kinds.every((kind) => kind === "passage"));
  assert.equal(computed, 1);
  const set = vectors.current()!;
  assert.equal(set.modelId, embedder.modelId);
  assert.equal(set.vectors.size, 40);
  await vectors.stop();

  // Another instance over the same directory reads them back: nothing is embedded again.
  const again = new ConceptVectors({ embedders: new FakeEmbedderSource(embedder), dir, logger: silentLogger() });
  again.update(concepts(40));
  await again.idle();
  assert.equal(sizes.length, 3);
  assert.equal(again.current()!.vectors.size, 40);
  // One new concept: one call.
  again.update([...concepts(40), { id: "tactic-new", type: "Tactic", name: "Brand new", aliases: [], description: null }]);
  await again.idle();
  assert.deepEqual(sizes.slice(3), [1]);
  await again.stop();
});

test("another model recomputes every vector; vectors of a model no longer current are not answered", async (t) => {
  const dir = await tempDir(t);
  const first = new FakeEmbedder({ dimensions: 16, modelId: "fake/one", groups: [] });
  const source = new FakeEmbedderSource(first);
  const vectors = new ConceptVectors({ embedders: source, dir, logger: silentLogger(), pause: async () => undefined });
  vectors.start();
  t.after(() => vectors.stop());
  vectors.update(concepts(5));
  await vectors.idle();
  assert.equal(vectors.current()?.modelId, "fake/one");
  const second = new FakeEmbedder({ dimensions: 24, modelId: "fake/two", groups: [] });
  source.embedder = second; // not announced yet
  assert.equal(vectors.current(), null);
  source.set(second);
  await vectors.idle();
  assert.equal(vectors.current()?.modelId, "fake/two");
  assert.equal(second.texts, 5);
  assert.equal(vectors.current()!.vectors.get("tactic-0")!.length, 24);
  source.set(null);
  assert.equal(vectors.current(), null);
});

test("a newer graph during a computation restarts it; only complete sets are published", async (t) => {
  const dir = await tempDir(t);
  const embedder = new FakeEmbedder({ dimensions: 16, groups: [] });
  let release!: () => void;
  let held = false;
  const vectors = new ConceptVectors({
    embedders: new FakeEmbedderSource(embedder),
    dir,
    logger: silentLogger(),
    pause: () => {
      if (held) return Promise.resolve();
      held = true;
      return new Promise<void>((resolve) => (release = resolve));
    }
  });
  t.after(() => vectors.stop());
  const published: number[] = [];
  vectors.onComputed(() => published.push(vectors.current()!.vectors.size));
  vectors.update(concepts(40));
  while (!held) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vectors.current(), null, "nothing until complete");
  vectors.update(concepts(20));
  release();
  await vectors.idle();
  assert.deepEqual(published, [20]);
});

test("concept embedding runs in the background: the graph loads and search answers while it is held", async (t) => {
  const appdir = await mkdtemp(join(tmpdir(), "kg-concept-bg-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
  const logger = silentLogger();
  const store = new FakeStore();
  store.collection("kc_aaaaaaaaaa", "A");
  const entry = "ke_aaaaaaaaaaaa";
  store.put(entry, "Alternatives pages convert well: one per competitor.", ["kc_aaaaaaaaaa"], { title: "Alternatives pages" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger });
  const embedder = new FakeEmbedder();
  const source = new FakeEmbedderSource(embedder);
  const search = new KnowledgeSearch({ store, graph, embedders: source, indexDir: knowledgeIndexDir(appdir), logger });
  await search.start();
  let release!: () => void;
  let held = 0;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const merges = new KnowledgeConceptMerges({
    graph,
    embedders: source,
    path: join(appdir, "concept-merges.json"),
    vectorsDir: join(knowledgeIndexDir(appdir), "concepts"),
    logger,
    thresholds: () => ({ merge: 0.9, similar: 0.5 }),
    pause: () => {
      held += 1;
      return gate;
    }
  });
  t.after(async () => {
    release();
    await merges.stop();
    await search.stop();
  });
  await merges.start();
  const nodes = Array.from({ length: 40 }, (_, i) => node(`tactic-${i}`, `Alternatives pages variant ${i}`, [`${entry}.md`]));
  await loadGraph(graph, nodes);
  while (held === 0) await new Promise((resolve) => setImmediate(resolve));
  // Concept embedding is parked between two batches: search and concept details still answer.
  const result = await search.search({ query: "alternatives pages" }, { kind: "all" });
  assert.ok(result.hits.length > 0);
  const detail = await search.conceptDetail("tactic-1", { kind: "all" });
  assert.deepEqual(detail?.similarConcepts, [], "no similar concepts until the vectors are complete");
  release();
  await merges.idle();
  assert.ok(merges.vectors.current());
});
