import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FakeEmbedder, FakeEmbedderSource, silentLogger } from "./test-fakes.ts";
import { embeddingHeader, embeddingPassage } from "./text.ts";
import { InProcessVectorIndex, type VectorEntryText } from "./vector-index.ts";

const ADS: VectorEntryText = { title: "Ads learning phase", author: "Ana", handle: "ana", kind: "thread", body: "Cap the daily budget while a campaign learns." };
const APP: VectorEntryText = { title: "Store listing", author: null, handle: null, kind: "note", body: "iOS app store screenshots sell the app." };
const AI: VectorEntryText = { title: "AI answers", author: null, handle: null, kind: "note", body: "ChatGPT and Perplexity cite original data." };

async function harness(t: TestContext, options: { indexDir?: string; embedder?: FakeEmbedder | null } = {}) {
  const indexDir = options.indexDir ?? (await mkdtemp(join(tmpdir(), "kg-vindex-")));
  const embedder = options.embedder === undefined ? new FakeEmbedder() : options.embedder;
  const embedders = new FakeEmbedderSource(embedder);
  const logger = silentLogger();
  const index = new InProcessVectorIndex({ embedders, indexDir, logger });
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

test("passages carry context and queries use the query embedding kind", async (t) => {
  const embedder = new FakeEmbedder({ dimensions: 2, groups: [] });
  embedder.vector = (text) => Float32Array.from(text.includes("Ads learning phase") ? [1, 0] : [0, 1]);
  const { index } = await harness(t, { embedder });
  const texts: { kind: string; text: string }[] = [];
  const embed = embedder.embed.bind(embedder);
  embedder.embed = async (batch, kind = "passage") => {
    for (const text of batch) texts.push({ kind, text });
    return embed(batch, kind);
  };
  await embedAll(index, { ke_adsadsadsads: ADS, ke_appappappapp: APP });
  const passages = texts.filter((entry) => entry.kind === "passage");
  assert.equal(passages.length, 2);
  const ads = passages.find((entry) => entry.text.endsWith(ADS.body))!;
  const [header, body] = ads.text.split("\n\n");
  assert.equal(body, ADS.body);
  for (const context of ["Ads learning phase", "Ana", "@ana", "thread"]) assert.ok(header!.includes(context), context);
  await index.embedQuery("budget");
  assert.deepEqual(texts.at(-1), { kind: "query", text: "budget" });
  const vector = index.entryVector("ke_adsadsadsads")!;
  assert.deepEqual([...vector], [1, 0]);
  assert.equal(index.entryVector("ke_adsadsadsads"), vector, "mean cached until its vectors change");
  assert.equal(index.entryVector("ke_nosuchentry1"), null);
});

test("long entries expose the normalized chunk mean and the best chunk's body span", async (t) => {
  const embedder = new FakeEmbedder({ dimensions: 2, groups: [] });
  const emitted: number[][] = [];
  embedder.vector = (text) => {
    const vector = text.includes("cpc") ? [0, 1] : [1, 0];
    emitted.push(vector);
    return Float32Array.from(vector);
  };
  const { index } = await harness(t, { embedder });
  const body = `${"alpha ".repeat(200)}budget campaign spend cpc`;
  index.setEntry("ke_longlonglong", { ...ADS, body });
  await index.embedForSave(["ke_longlonglong"]);
  await index.idle();
  assert.deepEqual(emitted, [[1, 0], [0, 1]], "two independently supplied chunk vectors");
  const mean = index.entryVector("ke_longlonglong")!;
  assert.ok(Math.abs(mean[0]! - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(mean[1]! - Math.SQRT1_2) < 1e-6);
  const [hit] = index.search(Float32Array.from([0, 1]), () => true, 5);
  assert.ok(hit);
  assert.equal(hit.chunks, 2);
  assert.equal(hit.chunk, 1);
  assert.ok(hit.span.start > 0 && hit.span.end <= body.length);
  assert.match(body.slice(hit.span.start, hit.span.end), /cpc$/);
});

test("search excludes rejected entries before its limit and applies the score floor", async (t) => {
  const embedder = new FakeEmbedder({ dimensions: 2, groups: [] });
  embedder.vector = (text) => Float32Array.from(text.includes(ADS.title) ? [1, 0] : text.includes(APP.title) ? [0.6, 0.8] : [0, 1]);
  const { index } = await harness(t, { embedder });
  await embedAll(index, { ke_adsadsadsads: ADS, ke_appappappapp: APP, ke_aiaiaiaiaiai: AI });
  const query = Float32Array.from([1, 0]);
  assert.deepEqual(index.search(query, () => true, 3, -1).map((hit) => hit.entryId), ["ke_adsadsadsads", "ke_appappappapp", "ke_aiaiaiaiaiai"]);
  assert.deepEqual(index.search(query, () => true, 1).map((hit) => hit.entryId), ["ke_adsadsadsads"]);
  assert.deepEqual(index.search(query, (id) => id !== "ke_adsadsadsads", 1, 0.5).map((hit) => hit.entryId), ["ke_appappappapp"]);
  assert.deepEqual(index.search(query, (id) => id !== "ke_adsadsadsads", 10, 0.7), []);
  assert.deepEqual(index.search(new Float32Array(3), () => true, 10), [], "a vector of the wrong size matches nothing");
});

test("thresholds follow the current embedding model", async (t) => {
  const { index, embedders } = await harness(t);
  assert.deepEqual(index.thresholds(), { minimum: 0.25, good: 0.4, strong: 0.6, duplicate: 0.92 });
  embedders.set(new FakeEmbedder({ thresholds: { minimum: 0.7, good: 0.8, strong: 0.85, duplicate: 0.95 } }));
  assert.deepEqual(index.thresholds(), { minimum: 0.7, good: 0.8, strong: 0.85, duplicate: 0.95 });
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

test("a model switch while a cache opens never attaches the old model's cached vectors to the new one", async (t) => {
  const indexDir = await mkdtemp(join(tmpdir(), "kg-vindex-switch-"));
  t.after(() => rm(indexDir, { recursive: true, force: true }));
  const a = new FakeEmbedder({ modelId: "fake/a" });
  const first = await harness(t, { indexDir, embedder: a });
  await embedAll(first.index, { ke_adsadsadsads: ADS });
  await first.index.stop();

  // Model a's cache is on disk; the runtime switches to model b (same size) while a's cache opens.
  const b = new FakeEmbedder({ modelId: "fake/b", groups: [["learning", "phase"]] });
  const second = await harness(t, { indexDir, embedder: a });
  second.index.setEntry("ke_adsadsadsads", ADS);
  const loading = second.index.loadCached();
  second.embedders.set(b);
  second.index.backfill();
  await loading;
  await second.index.idle();
  assert.equal(b.texts, 1, "model b embeds the entry itself");
  const passage = embeddingPassage(embeddingHeader(ADS), ADS.body);
  assert.notDeepEqual([...a.vector(passage)], [...b.vector(passage)]);
  assert.deepEqual([...second.index.entryVector("ke_adsadsadsads")!], [...b.vector(passage)]);
  await second.index.stop();

  // The cache on disk is model b's now, holding b's vectors.
  const b2 = new FakeEmbedder({ modelId: "fake/b", groups: [["learning", "phase"]] });
  const third = await harness(t, { indexDir, embedder: b2 });
  third.index.setEntry("ke_adsadsadsads", ADS);
  await third.index.loadCached();
  assert.equal(b2.texts, 0);
  assert.deepEqual([...third.index.entryVector("ke_adsadsadsads")!], [...b.vector(passage)]);
});

test("a batch the old model was embedding when the model changed is dropped, never filed or attached", async (t) => {
  const indexDir = await mkdtemp(join(tmpdir(), "kg-vindex-switch-"));
  t.after(() => rm(indexDir, { recursive: true, force: true }));
  const a = new FakeEmbedder({ modelId: "fake/a" });
  const { index, embedders } = await harness(t, { indexDir, embedder: a });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const embedding = new Promise<void>((resolve) => (started = resolve));
  const embed = a.embed.bind(a);
  a.embed = async (texts, kind) => {
    started();
    await gate;
    return embed(texts, kind);
  };
  index.setEntry("ke_adsadsadsads", ADS);
  index.backfill();
  await embedding;

  // Model b arrives and its cache opens while a's batch is in flight.
  const b = new FakeEmbedder({ modelId: "fake/b", groups: [["learning", "phase"]] });
  embedders.set(b);
  await index.loadCached();
  const generation = index.generation();
  release();
  await index.idle();
  assert.equal(index.generation(), generation, "a's vectors were not attached");
  assert.equal(index.entryVector("ke_adsadsadsads"), null);

  index.backfill();
  await index.idle();
  const passage = embeddingPassage(embeddingHeader(ADS), ADS.body);
  assert.deepEqual([...index.entryVector("ke_adsadsadsads")!], [...b.vector(passage)]);
  await index.stop();
  // Only b's rows were filed: a restart on b reads them without embedding.
  const b2 = new FakeEmbedder({ modelId: "fake/b", groups: [["learning", "phase"]] });
  const again = await harness(t, { indexDir, embedder: b2 });
  again.index.setEntry("ke_adsadsadsads", ADS);
  await again.index.loadCached();
  assert.equal(b2.texts, 0);
  assert.deepEqual([...again.index.entryVector("ke_adsadsadsads")!], [...b.vector(passage)]);
});

test("backfillAll embeds every tracked entry at once, and again for each new embedder", async (t) => {
  const { index, embedders } = await harness(t, { embedder: null });
  index.setEntry("ke_adsadsadsads", ADS);
  index.setEntry("ke_appappappapp", APP);
  await index.backfillAll();
  await index.idle();
  assert.deepEqual(index.embeddedIds(), []);
  const arriving = new FakeEmbedder();
  embedders.set(arriving);
  await index.idle();
  assert.deepEqual(index.embeddedIds().sort(), ["ke_adsadsadsads", "ke_appappappapp"]);
  assert.equal(arriving.texts, 2);
  // Another change event for the same embedder (a settings toggle): nothing is embedded twice.
  embedders.set(arriving);
  await index.idle();
  index.backfill();
  await index.idle();
  assert.equal(arriving.texts, 2);
});
