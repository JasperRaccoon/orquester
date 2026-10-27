import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FakeEmbedder, FakeEmbedderSource, silentLogger } from "./test-fakes.ts";
import { embeddingHeader, embeddingPassage } from "./text.ts";
import { InProcessVectorIndex, type VectorEntryText, vectorCacheKey } from "./vector-index.ts";

const ADS: VectorEntryText = { title: "Ads learning phase", author: "Ana", handle: "ana", kind: "thread", body: "Cap the daily budget while a campaign learns." };
const APP: VectorEntryText = { title: "Store listing", author: null, handle: null, kind: "note", body: "iOS app store screenshots sell the app." };
const AI: VectorEntryText = { title: "AI answers", author: null, handle: null, kind: "note", body: "ChatGPT and Perplexity cite original data." };

async function harness(t: TestContext, options: { indexDir?: string; embedder?: FakeEmbedder | null; minSimilarity?: number } = {}) {
  const indexDir = options.indexDir ?? (await mkdtemp(join(tmpdir(), "kg-vindex-")));
  const embedder = options.embedder === undefined ? new FakeEmbedder() : options.embedder;
  const embedders = new FakeEmbedderSource(embedder);
  const logger = silentLogger();
  const index = new InProcessVectorIndex({ embedders, indexDir, logger, minSimilarity: options.minSimilarity });
  index.start();
  t.after(async () => {
    await index.stop();
    if (!options.indexDir) await rm(indexDir, { recursive: true, force: true });
  });
  return { index, embedder, embedders, logger, indexDir };
}

async function embedAll(index: InProcessVectorIndex, entries: Record<string, VectorEntryText>): Promise<void> {
  for (const [id, entry] of Object.entries(entries)) index.setEntry(id, entry);
  index.backfill();
  await index.idle();
}

test("the cache key covers the embedding header and the body", () => {
  const key = vectorCacheKey(embeddingHeader(ADS), ADS.body);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(vectorCacheKey(embeddingHeader({ ...ADS, title: "Other" }), ADS.body), key);
  assert.notEqual(vectorCacheKey(embeddingHeader({ ...ADS, kind: "article" }), ADS.body), key);
  assert.notEqual(vectorCacheKey(embeddingHeader({ ...ADS, handle: "someone" }), ADS.body), key);
  assert.notEqual(vectorCacheKey(embeddingHeader(ADS), `${ADS.body}!`), key);
  // The separator keeps header and body apart.
  assert.notEqual(vectorCacheKey("a", "b c"), vectorCacheKey("a b", "c"));
});

test("passages are embedded with their header; queries as queries; mean vectors are normalized and cached", async (t) => {
  const { index, embedder } = await harness(t);
  const texts: { kind: string; text: string }[] = [];
  const embed = embedder!.embed.bind(embedder!);
  embedder!.embed = async (batch, kind = "passage") => {
    for (const text of batch) texts.push({ kind, text });
    return embed(batch, kind);
  };
  await embedAll(index, { ke_adsadsadsads: ADS, ke_appappappapp: APP });
  assert.deepEqual(
    texts.filter((t) => t.kind === "passage").map((t) => t.text).sort(),
    [embeddingPassage(embeddingHeader(ADS), ADS.body), embeddingPassage(embeddingHeader(APP), APP.body)].sort()
  );
  const query = await index.embedQuery("budget");
  assert.ok(query);
  assert.deepEqual(texts.at(-1), { kind: "query", text: "budget" });

  const vector = index.entryVector("ke_adsadsadsads")!;
  assert.deepEqual([...vector], [...embedder!.vector(embeddingPassage(embeddingHeader(ADS), ADS.body))], "one chunk: its own vector");
  assert.equal(index.entryVector("ke_adsadsadsads"), vector);
  assert.equal(index.entryVector("ke_nosuchentry1"), null);
});

test("long entries: one row per chunk; the mean of the chunks; hits name the best chunk's span", async (t) => {
  const { index } = await harness(t, { minSimilarity: 0.3 });
  const body = `${Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")} budget campaign spend cpc`;
  index.setEntry("ke_longlonglong", { ...ADS, body });
  assert.ok(index.chunkCount("ke_longlonglong") >= 2);
  await index.embedForSave(["ke_longlonglong"]);
  await index.idle();
  const mean = index.entryVector("ke_longlonglong")!;
  assert.ok(Math.abs(mean.reduce((n, x) => n + x * x, 0) - 1) < 1e-5);
  const [hit] = index.search((await index.embedQuery("cpc budget"))!, () => true, 5);
  assert.ok(hit);
  assert.equal(hit.chunks, index.chunkCount("ke_longlonglong"));
  assert.equal(hit.chunk, hit.chunks - 1);
  assert.match(body.slice(hit.span.start, hit.span.end), /cpc$/);
});

test("search asks `accept` before scoring, honours the minimum and the limit, best first", async (t) => {
  const { index } = await harness(t);
  await embedAll(index, { ke_adsadsadsads: ADS, ke_appappappapp: APP, ke_aiaiaiaiaiai: AI });
  const query = (await index.embedQuery("ads budget campaign"))!;
  const asked: string[] = [];
  const all = index.search(query, (id) => (asked.push(id), true), 10, -1);
  assert.deepEqual(asked.sort(), ["ke_adsadsadsads", "ke_aiaiaiaiaiai", "ke_appappappapp"]);
  assert.equal(all[0]!.entryId, "ke_adsadsadsads");
  assert.ok(all.every((hit, i) => i === 0 || all[i - 1]!.score >= hit.score));
  assert.equal(index.search(query, () => true, 1, -1).length, 1);
  assert.deepEqual(index.search(query, (id) => id !== "ke_adsadsadsads", 10, 0.5), []);
  assert.deepEqual(index.search(new Float32Array(3), () => true, 10), [], "a vector of the wrong size matches nothing");
});

test("thresholds come from the model; minSimilarity overrides only the minimum", async (t) => {
  const plain = await harness(t);
  assert.deepEqual(plain.index.thresholds(), plain.embedder!.thresholds);
  const custom = await harness(t, { minSimilarity: 0.1, embedder: new FakeEmbedder({ thresholds: { minimum: 0.7, good: 0.8, strong: 0.85, duplicate: 0.95 } }) });
  assert.deepEqual(custom.index.thresholds(), { minimum: 0.1, good: 0.8, strong: 0.85, duplicate: 0.95 });
});

test("generation moves on every vector change and only then", async (t) => {
  const { index, embedders } = await harness(t);
  const g0 = index.generation();
  index.setEntry("ke_adsadsadsads", ADS);
  assert.equal(index.generation(), g0, "text alone is no vector change");
  await index.embedForSave(["ke_adsadsadsads"]);
  await index.idle();
  const g1 = index.generation();
  assert.ok(g1 > g0);
  index.setEntry("ke_adsadsadsads", { ...ADS });
  assert.equal(index.generation(), g1, "same header and body: kept");
  index.setEntry("ke_adsadsadsads", { ...ADS, title: "Renamed" });
  const g2 = index.generation();
  assert.ok(g2 > g1);
  assert.equal(index.entryVector("ke_adsadsadsads"), null, "stale vectors are dropped at once");
  await index.embedForSave(["ke_adsadsadsads"]);
  await index.idle();
  const g3 = index.generation();
  assert.ok(g3 > g2);
  index.removeEntry("ke_adsadsadsads");
  assert.ok(index.generation() > g3);
  assert.deepEqual(index.embeddedIds(), []);
  const g4 = index.generation();
  embedders.set(new FakeEmbedder({ modelId: "fake/other" }));
  assert.ok(index.generation() > g4, "another model");
});

test("cached vectors are reused across restarts by key; an edited header is embedded again", async (t) => {
  const indexDir = await mkdtemp(join(tmpdir(), "kg-vindex-cache-"));
  t.after(() => rm(indexDir, { recursive: true, force: true }));
  const first = await harness(t, { indexDir });
  await embedAll(first.index, { ke_adsadsadsads: ADS, ke_appappappapp: APP });
  await first.index.stop();
  assert.equal(first.embedder!.texts, 2);

  const second = await harness(t, { indexDir });
  second.index.setEntry("ke_adsadsadsads", ADS);
  second.index.setEntry("ke_appappappapp", { ...APP, title: "Renamed listing" });
  await second.index.loadCached();
  assert.equal(second.embedder!.texts, 0);
  assert.ok(second.index.entryVector("ke_adsadsadsads"));
  assert.equal(second.index.entryVector("ke_appappappapp"), null);
  second.index.backfill();
  await second.index.idle();
  assert.equal(second.embedder!.texts, 1, "only the renamed entry");
  assert.ok(second.index.entryVector("ke_appappappapp"));
});

test("a failing model: no query vector, one warning, nothing answered until the runtime changes", async (t) => {
  const failing = new FakeEmbedder();
  const { index, embedders, logger } = await harness(t, { embedder: failing });
  await embedAll(index, { ke_adsadsadsads: ADS });
  assert.ok(index.entryVector("ke_adsadsadsads"));
  const generation = index.generation();
  failing.failWith = new Error("model file missing");
  assert.equal(await index.embedQuery("budget"), null);
  assert.equal(await index.embedQuery("budget"), null);
  assert.equal(logger.lines.filter((l) => l.includes("embeddings are unavailable")).length, 1);
  assert.equal(index.modelId(), null);
  assert.equal(index.entryVector("ke_adsadsadsads"), null);
  assert.ok(index.generation() > generation);
  embedders.set(new FakeEmbedder());
  assert.equal(index.modelId(), "fake/semantic");
  assert.ok(index.entryVector("ke_adsadsadsads"), "the same model's vectors are usable again");
});

test("without an embedder everything is empty and nothing is queued", async (t) => {
  const { index } = await harness(t, { embedder: null });
  index.setEntry("ke_adsadsadsads", ADS);
  await index.embedForSave(["ke_adsadsadsads"]);
  index.backfill();
  await index.idle();
  assert.equal(index.modelId(), null);
  assert.equal(index.thresholds(), null);
  assert.equal(await index.embedQuery("x"), null);
  assert.deepEqual(index.embeddedIds(), []);
  assert.equal(index.entryVector("ke_adsadsadsads"), null);
});
