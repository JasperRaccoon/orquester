import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { KnowledgeVisibility } from "@orquester/api";
import { KnowledgeError } from "../store/errors.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
import { FakeEmbedder, FakeEmbedderSource, FakeStore, edge, node, silentLogger } from "./test-fakes.ts";

const SEO = "kc_seoseoseos";
const SAAS = "kc_saassaassa";
const ADS = "kc_adsadsadsa";
const ALL: KnowledgeVisibility = { kind: "all" };
const SEO_ONLY: KnowledgeVisibility = { kind: "collections", ids: [SEO] };

const CLOUDFLARE = "ke_cloudflare2a";
const ALT = "ke_alternative2";
const BILLING = "ke_billingbill2";
const ADSPOST = "ke_adsadsadsads";
const UNFILED = "ke_unfiledunfil";

async function setup(t: TestContext, options: { embedder?: FakeEmbedder | null; indexDir?: string } = {}) {
  const indexDir = options.indexDir ?? (await mkdtemp(join(tmpdir(), "kg-search-")));
  const store = new FakeStore();
  store.collection(SEO, "SEO");
  store.collection(SAAS, "SaaS");
  store.collection(ADS, "Ads");
  store.put(
    CLOUDFLARE,
    "Case study: how Cloudflare got cited by AI answer engines.\nThey published original data and structured comparison tables. Perplexity and Gemini now cite them.",
    [SEO],
    { title: "Cloudflare case study", author: "Kevin", handle: "kev" },
    true
  );
  store.put(ALT, "Alternatives pages: write one page per competitor, [competitor] vs [you], with honest tables.", [SEO], { title: "Alternatives pages" }, true);
  store.put(BILLING, "Annual billing with a discount lifts cash flow. Stripe makes proration easy.", [SAAS], { title: "Annual billing" }, true);
  store.put(ADSPOST, "Cap the daily budget while a campaign learns; raise spend after 50 conversions.", [ADS], { title: "Ads learning phase" }, true);
  store.put(UNFILED, "Remember to compare pricing tables of competitor tools.", [], { title: "Note to self" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  graph.replace(
    [
      node("tactic-comparison-tables", "Comparison tables", [`${CLOUDFLARE}.md`, `${ALT}.md`, `${BILLING}.md`]),
      node("tool-stripe", "Stripe", [`${BILLING}.md`]),
      node("platform-perplexity", "Perplexity", [`${CLOUDFLARE}.md`], { aliases: ["pplx"] })
    ],
    [
      edge("e1", "tactic-comparison-tables", "platform-perplexity", [`${CLOUDFLARE}.md`]),
      edge("e2", "tactic-comparison-tables", "tool-stripe", [`${BILLING}.md`])
    ]
  );
  const embedder = options.embedder === undefined ? new FakeEmbedder() : options.embedder;
  const embedders = new FakeEmbedderSource(embedder);
  const logger = silentLogger();
  const search = new KnowledgeSearch({ store, graph, embedders, indexDir, logger, minSimilarity: 0.3 });
  t.after(async () => {
    await search.stop();
    if (!options.indexDir) await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  return { store, graph, search, embedder, embedders, logger, indexDir };
}

function entryIds(hits: { kind: string; entry?: { id: string } }[]): string[] {
  return hits.filter((h) => h.kind === "entry").map((h) => h.entry!.id);
}

test("search by meaning finds an entry that shares no words with the query", async (t) => {
  const { search } = await setup(t);
  // The first query starts the backfill of entries saved before the model was there.
  await search.search({ query: "warm up" }, ALL);
  await search.idle();
  const result = await search.search({ query: "Ranking in ChatGPT" }, ALL);
  const first = result.hits[0]!;
  assert.equal(first.kind, "entry");
  assert.equal(first.kind === "entry" && first.entry.id, CLOUDFLARE);
  assert.ok(first.score > 0 && first.score <= 1);
  if (first.kind === "entry") {
    assert.equal(first.entry.citation, `[Cloudflare case study · @kev](orquester-knowledge:entry/${CLOUDFLARE})`);
    assert.ok(first.entry.snippet.length > 0 && first.entry.snippet.length <= 240);
    assert.equal(first.entry.linkCount, 2);
  }
  assert.deepEqual(result.searched, [SEO, SAAS, ADS]);
});

test("BM25 finds words in titles, bodies and concepts; concept hits carry visible entry ids", async (t) => {
  const { search } = await setup(t, { embedder: null });
  const result = await search.search({ query: "stripe proration" }, ALL);
  assert.equal(entryIds(result.hits)[0], BILLING);
  const concept = result.hits.find((h) => h.kind === "concept");
  assert.ok(concept && concept.kind === "concept");
  assert.equal(concept.concept.id, "tool-stripe");
  assert.deepEqual(concept.entryIds, [BILLING]);
  const snippet = result.hits[0]!.kind === "entry" ? result.hits[0]!.entry.snippet : "";
  assert.match(snippet, /Stripe makes proration easy/);
});

test("a profile never gets hidden entries or concepts, even through the one-hop expansion", async (t) => {
  const { search } = await setup(t);
  for (const query of ["stripe", "annual billing", "comparison tables", "pricing tables", "budget campaign", "Ranking in ChatGPT"]) {
    const result = await search.search({ query, limit: 25 }, SEO_ONLY);
    for (const hit of result.hits) {
      if (hit.kind === "entry") {
        assert.ok([CLOUDFLARE, ALT].includes(hit.entry.id), `${query}: ${hit.entry.id}`);
        assert.deepEqual(hit.entry.collections, [SEO]);
      } else {
        assert.notEqual(hit.concept.id, "tool-stripe", query);
        for (const id of hit.entryIds) assert.ok([CLOUDFLARE, ALT].includes(id), `${query}: concept entry ${id}`);
      }
    }
    assert.deepEqual(result.searched, [SEO]);
  }
  // Expansion reaches ALT through the shared concept even though its text does not match.
  const expanded = await search.search({ query: "perplexity", limit: 25 }, SEO_ONLY);
  assert.ok(entryIds(expanded.hits).includes(ALT));
});

test("the collections filter narrows within visibility; unknown or hidden names are refused with what is visible", async (t) => {
  const { search } = await setup(t, { embedder: null });
  const narrowed = await search.search({ query: "tables", collections: ["seo"], limit: 25 }, ALL);
  assert.deepEqual(entryIds(narrowed.hits).sort(), [ALT, CLOUDFLARE].sort());
  assert.deepEqual(narrowed.searched, [SEO]);
  const all = await search.search({ query: "tables", limit: 25 }, ALL);
  assert.ok(entryIds(all.hits).includes(UNFILED), "Unfiled entries are found by `all` callers");

  await assert.rejects(search.search({ query: "x", collections: ["Marketing"] }, ALL), (error: unknown) => {
    assert.ok(error instanceof KnowledgeError && error.code === "KNOWLEDGE_UNKNOWN_COLLECTION");
    assert.match(error.message, /"SEO", "SaaS", "Ads"/);
    return true;
  });
  await assert.rejects(search.search({ query: "x", collections: ["SaaS"] }, SEO_ONLY), (error: unknown) => {
    assert.ok(error instanceof KnowledgeError && error.code === "KNOWLEDGE_UNKNOWN_COLLECTION");
    assert.match(error.message, /Collections: "SEO"\.$/);
    return true;
  });
  await assert.rejects(search.search({ query: "  " }, ALL), (error: unknown) => error instanceof KnowledgeError && error.code === "KNOWLEDGE_INVALID");
  const limited = await search.search({ query: "tables", limit: 1 }, ALL);
  assert.equal(limited.hits.length, 1);
});

test("a new, unlinked entry is searchable by text and meaning as soon as it is indexed", async (t) => {
  const { store, search, embedder } = await setup(t);
  const id = "ke_newnewnewnew";
  store.put(id, "LLM visibility: answer engines surface sites with fresh FAQs.", [SEO], { title: "FAQ freshness" }, true);
  await search.indexEntries([id]);
  assert.ok(embedder!.texts > 0);
  assert.equal(entryIds((await search.search({ query: "FAQs" }, ALL)).hits)[0], id);
  assert.ok(entryIds((await search.search({ query: "appear in chatgpt" }, ALL)).hits).includes(id));
  // Store events index too (edits re-index; deletes drop the doc).
  store.put(id, "Completely different words about onboarding emails.", [SEO], { title: "Onboarding" });
  await search.idle();
  assert.equal(entryIds((await search.search({ query: "onboarding" }, ALL)).hits)[0], id);
  store.remove(id);
  await search.idle();
  assert.ok(!entryIds((await search.search({ query: "onboarding" }, ALL)).hits).includes(id));
});

test("without a runtime, or when the model fails, search degrades to text and never fails", async (t) => {
  const none = await setup(t, { embedder: null });
  assert.equal(entryIds((await none.search.search({ query: "Ranking in ChatGPT" }, ALL)).hits).length, 0);
  assert.equal(entryIds((await none.search.search({ query: "cloudflare" }, ALL)).hits)[0], CLOUDFLARE);

  const failing = new FakeEmbedder();
  failing.failWith = new Error("model file missing");
  const broken = await setup(t, { embedder: failing });
  const result = await broken.search.search({ query: "cloudflare" }, ALL);
  assert.equal(entryIds(result.hits)[0], CLOUDFLARE);
  await broken.search.search({ query: "cloudflare again" }, ALL);
  assert.equal(broken.logger.lines.filter((l) => l.includes("embeddings are unavailable")).length, 1);
  const calls = failing.calls;
  await broken.search.search({ query: "third" }, ALL);
  assert.equal(failing.calls, calls, "a failed embedder is not retried until the runtime changes");

  // The runtime arrives: meaning search starts working.
  broken.embedders.set(new FakeEmbedder());
  await broken.search.search({ query: "warm up" }, ALL);
  await broken.search.idle();
  assert.equal(entryIds((await broken.search.search({ query: "Ranking in ChatGPT" }, ALL)).hits)[0], CLOUDFLARE);
});

test("vectors are cached by content hash and reused across restarts; another model rebuilds", async (t) => {
  const indexDir = await mkdtemp(join(tmpdir(), "kg-search-cache-"));
  t.after(() => rm(indexDir, { recursive: true, force: true }));
  const first = await setup(t, { indexDir });
  await first.search.search({ query: "warm" }, ALL);
  await first.search.idle();
  assert.equal(first.embedder!.texts, 1 + 5, "the query and the five entries");
  await first.search.stop();
  assert.ok((await readdir(indexDir)).some((n) => n.endsWith(".bin")));

  const second = await setup(t, { indexDir });
  await second.search.search({ query: "warm" }, ALL);
  await second.search.idle();
  assert.equal(second.embedder!.texts, 1, "only the query is embedded");
  assert.equal(entryIds((await second.search.search({ query: "Ranking in ChatGPT" }, ALL)).hits)[0], CLOUDFLARE);
  await second.search.stop();

  const other = await setup(t, { indexDir, embedder: new FakeEmbedder({ modelId: "fake/other" }) });
  await other.search.search({ query: "warm" }, ALL);
  await other.search.idle();
  assert.equal(other.embedder!.texts, 6);
  await other.search.stop();

  // A corrupt manifest is discarded and rebuilt.
  await writeFile(join(indexDir, "vectors.json"), "{oops");
  const rebuilt = await setup(t, { indexDir, embedder: new FakeEmbedder({ modelId: "fake/other" }) });
  await rebuilt.search.search({ query: "warm" }, ALL);
  await rebuilt.search.idle();
  assert.equal(rebuilt.embedder!.texts, 6);
  assert.ok(rebuilt.logger.lines.some((l) => l.includes("rebuilding the embedding cache")));
  await rebuilt.search.stop();
});

test("read views: entry lists page newest first; details and items respect visibility", async (t) => {
  const { search } = await setup(t, { embedder: null });
  const page1 = await search.listEntries({ limit: 2 }, ALL);
  assert.deepEqual(page1.entries.map((e) => e.id), [UNFILED, ADSPOST]);
  assert.ok(page1.nextCursor);
  const page2 = await search.listEntries({ limit: 2, cursor: page1.nextCursor! }, ALL);
  assert.deepEqual(page2.entries.map((e) => e.id), [BILLING, ALT]);
  const page3 = await search.listEntries({ limit: 2, cursor: page2.nextCursor! }, ALL);
  assert.deepEqual(page3.entries.map((e) => e.id), [CLOUDFLARE]);
  assert.equal(page3.nextCursor, null);
  assert.deepEqual((await search.listEntries({ collection: "unfiled" }, ALL)).entries.map((e) => e.id), [UNFILED]);
  assert.deepEqual((await search.listEntries({}, SEO_ONLY)).entries.map((e) => e.id), [ALT, CLOUDFLARE]);
  await assert.rejects(search.listEntries({ collection: "unfiled" }, SEO_ONLY));
  await assert.rejects(search.listEntries({ cursor: "garbage" }, ALL));

  const detail = (await search.entryDetail(CLOUDFLARE, SEO_ONLY))!;
  assert.equal(detail.entry.body.startsWith("Case study"), true);
  assert.deepEqual(detail.concepts.map((c) => c.id).sort(), ["platform-perplexity", "tactic-comparison-tables"]);
  assert.deepEqual(detail.related.map((r) => r.id), [ALT], "BILLING shares the concept but is hidden");
  assert.equal(await search.entryDetail(BILLING, SEO_ONLY), null);

  const item = (await search.item("tactic-comparison-tables", SEO_ONLY))!;
  assert.equal(item.kind, "concept");
  if (item.kind === "concept") {
    assert.deepEqual(item.concept.entries.map((e) => e.id).sort(), [ALT, CLOUDFLARE].sort());
    assert.deepEqual(item.concept.neighbors.map((n) => n.concept.id), ["platform-perplexity"]);
    assert.deepEqual(item.concept.collections, [SEO]);
  }
  assert.equal(await search.item("tool-stripe", SEO_ONLY), null);
  assert.equal((await search.item(ALT, ALL))!.kind, "entry");

  const graph = search.graphView({ collections: SAAS }, ALL);
  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ["tactic-comparison-tables", "tool-stripe"]);
  assert.throws(() => search.graphView({ collections: SAAS }, SEO_ONLY), (e: unknown) => e instanceof KnowledgeError && e.code === "KNOWLEDGE_UNKNOWN_COLLECTION");
  assert.throws(() => search.graphView({ focus: "tool-stripe" }, SEO_ONLY), (e: unknown) => e instanceof KnowledgeError && e.code === "KNOWLEDGE_NOT_FOUND");
});
