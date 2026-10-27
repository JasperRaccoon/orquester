import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { KnowledgeEntryMeta, KnowledgeVisibility } from "@orquester/api";
import { KnowledgeError } from "../store/errors.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch, matchBand, mmr, recencyFactor } from "./search.ts";
import { FakeEmbedder, FakeEmbedderSource, FakeStore, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";

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
  await loadGraph(
    graph,
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

test("vectors are cached under the hash of the text that was embedded, not the hash the store claims", async (t) => {
  const { store, search } = await setup(t);
  // A hand-edited entry file whose frontmatter still carries the old body's hash.
  const stale = "ke_stalestalest";
  const oldBody = "Cap the daily budget while a campaign learns; raise spend after 50 conversions.";
  store.put(stale, "Notes about iOS app store screenshots and android listings.", [SEO], { title: "Edited by hand", contentHash: store.entries.get(ADSPOST)!.contentHash }, true);
  assert.equal(store.entries.get(ADSPOST)!.body, oldBody);
  await search.indexEntries([stale]);
  await search.search({ query: "warm up" }, ALL);
  await search.idle();
  // The ads entry must keep its own meaning (a query sharing no word with it), not the edited entry's.
  assert.equal(entryIds((await search.search({ query: "cpc", limit: 25 }, ALL)).hits)[0], ADSPOST);
});

test("a save waits a bounded time for its embeddings (a slow first model load never holds the chat)", async (t) => {
  const { store, search, embedder } = await setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const embed = embedder!.embed.bind(embedder!);
  embedder!.embed = async (texts) => {
    if (texts.some((text) => text.includes("onboarding"))) await gate;
    return embed(texts);
  };
  const id = "ke_slowslowslow";
  store.put(id, "Welcome emails: onboarding sequences that convert.", [SEO], { title: "Onboarding emails" }, true);
  let done = false;
  const indexing = search.indexEntries([id]).then(() => (done = true));
  for (let waited = 0; !done && waited < 10_000; waited += 500) {
    t.mock.timers.tick(500);
    for (let i = 0; i < 20 && !done; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  if (!done) release();
  assert.ok(done, "the save is still waiting for the model after 10 s");
  await indexing;
  assert.equal(entryIds((await search.search({ query: "welcome emails" }, ALL)).hits)[0], id, "searchable by text already");
  release();
  await search.idle();
  assert.ok(entryIds((await search.search({ query: "onboarding" }, ALL)).hits).includes(id));
});

// ---------------------------------------------------------------------------
// Retrieval spec (docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md)
// ---------------------------------------------------------------------------

type Hit = Awaited<ReturnType<KnowledgeSearch["search"]>>["hits"][number];
type EntryHit = Extract<Hit, { kind: "entry" }>;
const entryHits = (hits: readonly Hit[]): EntryHit[] => hits.filter((h): h is EntryHit => h.kind === "entry");

/** Labels a fixture entry for filter tests (the store's metadata is read live). */
function label(store: FakeStore, id: string, meta: Partial<KnowledgeEntryMeta>): void {
  Object.assign(store.entries.get(id)!, meta);
}

function labelFixture(store: FakeStore): void {
  label(store, CLOUDFLARE, { kind: "Case Study", postedAt: "2025-03-01" });
  label(store, ALT, { kind: "thread", author: "Hridoy  Rehman", handle: "hridoy", postedAt: "2026-09-15T10:00:00.000Z" });
  label(store, BILLING, { kind: "thread" });
  label(store, ADSPOST, { kind: "article" });
}

const invalid = (error: unknown) => error instanceof KnowledgeError && error.code === "KNOWLEDGE_INVALID";
const notFound = (error: unknown) => error instanceof KnowledgeError && error.code === "KNOWLEDGE_NOT_FOUND";

async function warm(search: KnowledgeSearch): Promise<void> {
  await search.search({ query: "warm up" }, ALL);
  await search.idle();
}

test("filters narrow every signal — keywords, meaning, expansion and concept hits", async (t) => {
  const { store, search } = await setup(t);
  labelFixture(store);
  await warm(search);

  const threads = await search.search({ query: "comparison tables competitor pricing", filters: { kinds: [" THREAD "] }, limit: 25 }, ALL);
  assert.ok(entryHits(threads.hits).length > 0);
  for (const hit of entryHits(threads.hits)) assert.ok([ALT, BILLING].includes(hit.entry.id), hit.entry.id);
  for (const hit of threads.hits) if (hit.kind === "concept") for (const id of hit.entryIds) assert.ok([ALT, BILLING].includes(id), `concept entry ${id}`);
  // BILLING shares no word with the query: it is reached through the concept, and still filtered.
  assert.ok(entryIds(threads.hits).includes(BILLING));

  assert.deepEqual(entryIds((await search.search({ query: "tables pages", filters: { authors: ["@HRIDOY"] } }, ALL)).hits), [ALT]);
  assert.deepEqual(entryIds((await search.search({ query: "tables pages", filters: { authors: ["hridoy rehman"] } }, ALL)).hits), [ALT]);
  assert.deepEqual(entryIds((await search.search({ query: "ranking in chatgpt", filters: { authors: ["Kevin"] } }, ALL)).hits), [CLOUDFLARE]);
  assert.deepEqual(entryIds((await search.search({ query: "tables", filters: { years: ["2025"] } }, ALL)).hits), [CLOUDFLARE]);
  assert.ok(!entryIds((await search.search({ query: "tables", filters: { years: ["2026"] }, limit: 25 }, ALL)).hits).includes(CLOUDFLARE));
  // Entries with no postedAt never pass a posted… bound; a bare-date bound includes that whole day.
  assert.deepEqual(entryIds((await search.search({ query: "tables", filters: { postedAfter: "2026-01-01" }, limit: 25 }, ALL)).hits), [ALT]);
  assert.deepEqual(entryIds((await search.search({ query: "tables", filters: { postedBefore: "2026-09-15" }, limit: 25 }, ALL)).hits).sort(), [ALT, CLOUDFLARE].sort());
  const savedBefore = store.entries.get(ALT)!.savedAt;
  assert.deepEqual(entryIds((await search.search({ query: "tables", filters: { savedBefore }, limit: 25 }, ALL)).hits).sort(), [ALT, CLOUDFLARE].sort());

  // Nothing passes: no entries and no concept hits.
  const none = await search.search({ query: "comparison tables", filters: { kinds: ["podcast"] } }, ALL);
  assert.deepEqual(none.hits, []);
  assert.equal(none.total, 0);
  assert.equal(none.nextCursor, null);

  for (const filters of [{ postedAfter: "yesterday" }, { savedBefore: "2026-13-45" }, { years: ["26"] }, { kinds: Array.from({ length: 21 }, (_, i) => `k${i}`) }]) {
    await assert.rejects(search.search({ query: "tables", filters }, ALL), invalid, JSON.stringify(filters));
  }
});

test("hidden entries never leak through examples, expansion, concept hits or facets", async (t) => {
  const { store, search } = await setup(t);
  labelFixture(store);
  await warm(search);
  // A hidden example is refused like an unknown one, naming the id.
  for (const request of [{ similarTo: [BILLING] }, { query: "x", similarTo: [ALT], unlike: [BILLING] }, { similarTo: ["ke_nosuchentry1"] }]) {
    await assert.rejects(search.search(request, SEO_ONLY), (error: unknown) => {
      assert.ok(notFound(error));
      assert.match((error as Error).message, /ke_/);
      return true;
    });
  }
  // A near-copy of CLOUDFLARE in a collection the profile cannot see.
  const twin = "ke_hiddentwin12";
  store.put(twin, "How Cloudflare got cited by AI answer engines like Perplexity and Gemini.", [SAAS], { title: "Cloudflare case study" }, true);
  await search.indexEntries([twin]);
  assert.equal(entryIds((await search.search({ similarTo: [CLOUDFLARE] }, ALL)).hits)[0], twin, "the user sees it");
  const like = await search.search({ similarTo: [CLOUDFLARE], facets: true, limit: 25 }, SEO_ONLY);
  for (const id of entryIds(like.hits)) assert.equal(id, ALT);
  assert.deepEqual(like.searched, [SEO]);
  assert.ok(like.facets!.collections.every((f) => f.value === SEO && f.label === "SEO"), "no Unfiled, no hidden collection");
  assert.equal(like.facets!.kinds.reduce((n, f) => n + f.count, 0), like.total);

  // Expansion and concepts under a filter, for a profile.
  for (const query of ["perplexity", "stripe", "comparison tables", "pricing tables"]) {
    const result = await search.search({ query, filters: { kinds: ["thread"] }, facets: true, limit: 25 }, SEO_ONLY);
    for (const hit of result.hits) {
      if (hit.kind === "entry") assert.equal(hit.entry.id, ALT, query);
      else {
        assert.notEqual(hit.concept.id, "tool-stripe", query);
        assert.deepEqual(hit.entryIds, [ALT], query);
        assert.deepEqual(hit.entries, [{ id: ALT, title: "Alternatives pages" }], query);
      }
    }
    for (const facet of [...result.facets!.collections, ...result.facets!.kinds]) assert.ok(facet.count <= 1, query);
    assert.ok(result.facets!.collections.every((f) => f.value === SEO), query);
  }
});

test("query by example: nearest entries by meaning, never the examples; unlike pushes away and is excluded", async (t) => {
  const { store, search } = await setup(t);
  const twin = "ke_twintwintwin";
  store.put(twin, "Getting cited in ChatGPT and Perplexity answers: LLM answer engines cite original data.", [SEO], { title: "AI citations" }, true);
  await search.indexEntries([twin]);
  await warm(search);

  const like = await search.search({ similarTo: [CLOUDFLARE], limit: 25 }, ALL);
  const hits = entryHits(like.hits);
  assert.equal(hits[0]!.entry.id, twin);
  assert.ok(!entryIds(like.hits).includes(CLOUDFLARE), "the example is never returned");
  assert.ok(like.hits.every((h) => h.kind === "entry"), "no concept hits without a query");
  for (const hit of hits) assert.deepEqual(hit.match!.via, ["similar"]);
  assert.equal(hits[0]!.score, 1);
  assert.equal(like.total, hits.length);

  const unlike = await search.search({ similarTo: [CLOUDFLARE], unlike: [twin], limit: 25 }, ALL);
  assert.ok(!entryIds(unlike.hits).includes(twin) && !entryIds(unlike.hits).includes(CLOUDFLARE));

  // With a query, the example list is fused with the others.
  const both = await search.search({ query: "cloudflare cited by answer engines", similarTo: [twin], limit: 25 }, ALL);
  const top = entryHits(both.hits)[0]!;
  assert.equal(top.entry.id, CLOUDFLARE);
  assert.deepEqual(top.match!.via.slice(0, 3), ["keyword", "meaning", "similar"]);

  // `unlike` alone (no similarTo) only excludes.
  const excluded = await search.search({ query: "tables", unlike: [ALT], limit: 25 }, ALL);
  assert.ok(!entryIds(excluded.hits).includes(ALT));

  await assert.rejects(search.search({ similarTo: Array.from({ length: 11 }, () => CLOUDFLARE) }, ALL), invalid);
  await assert.rejects(search.search({ query: "   ", similarTo: [] }, ALL), invalid);
});

test("query by example without vectors falls back to BM25 over the examples' titles and openings", async (t) => {
  const { store, search } = await setup(t, { embedder: null });
  const pricing = "ke_pricingpage1";
  store.put(pricing, "Offer annual plans on the pricing page: two months free beats a discount code.", [SAAS], { title: "Pricing page" }, true);
  await search.indexEntries([pricing]);
  const result = await search.search({ similarTo: [BILLING], limit: 25 }, ALL);
  assert.equal(entryIds(result.hits)[0], pricing);
  assert.ok(!entryIds(result.hits).includes(BILLING));
  for (const hit of entryHits(result.hits)) {
    assert.deepEqual(hit.match!.via, ["similar"]);
    assert.equal(hit.match!.passage, null);
  }
});

test("search pages with a cursor: stable pages, a total, concept hits on the first page only", async (t) => {
  const { search } = await setup(t);
  await warm(search);
  const full = await search.search({ query: "tables competitor pricing perplexity", limit: 25 }, ALL);
  assert.equal(full.nextCursor, null);
  const total = full.total!;
  assert.ok(total >= 3);
  assert.equal(entryHits(full.hits).length, total);

  const seen: string[] = [];
  let concepts = 0;
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await search.search({ query: "tables  competitor pricing perplexity ", limit: 2, ...(cursor ? { cursor } : {}) }, ALL);
    assert.equal(page.total, total);
    assert.ok(page.hits.length <= 2);
    if (pages > 0) assert.ok(page.hits.every((h) => h.kind === "entry"), "concepts only on the first page");
    concepts += page.hits.length - entryHits(page.hits).length;
    seen.push(...entryIds(page.hits));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 20);
  assert.deepEqual(seen, entryIds(full.hits), "pages concatenate to the full ranking");
  assert.ok(concepts <= 1, "floor(2/3) → at most one concept hit");

  const first = await search.search({ query: "tables competitor pricing perplexity", limit: 1 }, ALL);
  assert.ok(first.nextCursor);
  await assert.rejects(search.search({ query: "tables", limit: 1, cursor: first.nextCursor! }, ALL), invalid, "another query");
  await assert.rejects(search.search({ query: "tables competitor pricing perplexity", sort: "newest", cursor: first.nextCursor! }, ALL), invalid, "another sort");
  await assert.rejects(search.search({ query: "tables competitor pricing perplexity", filters: { kinds: ["note"] }, cursor: first.nextCursor! }, ALL), invalid);
  await assert.rejects(search.search({ query: "tables competitor pricing perplexity", cursor: first.nextCursor! }, SEO_ONLY), invalid, "another visibility");
  for (const bad of ["garbage", Buffer.from(JSON.stringify({ v: 2, o: 1, h: "x" })).toString("base64url"), Buffer.from(JSON.stringify({ v: 1, o: -1, h: "x" })).toString("base64url")]) {
    await assert.rejects(search.search({ query: "tables", cursor: bad }, ALL), invalid, bad);
  }
  // The same request with another limit keeps going.
  const rest = await search.search({ query: "tables competitor pricing perplexity", limit: 25, cursor: first.nextCursor! }, ALL);
  const firstIds = entryIds(first.hits);
  assert.deepEqual([...firstIds, ...entryIds(rest.hits)], entryIds(full.hits).slice(0, firstIds.length + entryIds(rest.hits).length));
});

test("match explanations: via in order, terms as typed, passage offsets into the body, expansion concepts", async (t) => {
  const { store, search } = await setup(t);
  const long = "ke_longlonglong";
  const filler = Array.from({ length: 200 }, (_, i) => `filler${i}`).join(" ");
  const body = `${filler}\nRaise the cpc budget only after the campaign learns.`;
  store.put(long, body, [ADS], { title: "Long notes" }, true);
  await search.indexEntries([long]);
  await warm(search);

  const result = await search.search({ query: "CPC Budget", limit: 25 }, ALL);
  const hit = entryHits(result.hits).find((h) => h.entry.id === long)!;
  assert.deepEqual(hit.match!.via.slice(0, 2), ["keyword", "meaning"]);
  assert.deepEqual(hit.match!.terms, ["cpc", "budget"]);
  const passage = hit.match!.passage!;
  assert.ok(passage.chunks >= 2 && passage.chunk >= 1 && passage.chunk < passage.chunks);
  assert.ok(passage.start >= 0 && passage.end <= body.length && passage.start < passage.end);
  assert.match(body.slice(passage.start, passage.end), /cpc budget/, "offsets are into the body, never the embedding header");
  assert.equal(hit.match!.band, "strong");
  assert.match(hit.entry.snippet, /cpc budget/);

  // A concept-only hit names the seed concepts.
  const expanded = await search.search({ query: "perplexity", limit: 25 }, ALL);
  const viaConcept = entryHits(expanded.hits).find((h) => h.entry.id === ALT)!;
  assert.ok(viaConcept.match!.via.includes("concept"));
  assert.ok(viaConcept.match!.concepts.some((c) => c.id === "tactic-comparison-tables"));
  assert.deepEqual(viaConcept.match!.terms, []);
  assert.equal(viaConcept.match!.passage, null);
  assert.equal(viaConcept.match!.band, "good", "concept expansion is at least good");
});

test("match bands follow the spec's rules", () => {
  const th = { good: 0.4, strong: 0.6 };
  assert.equal(matchBand(0.61, 0, ["meaning"], th), "strong");
  assert.equal(matchBand(0.45, 0, ["meaning"], th), "good");
  assert.equal(matchBand(0.3, 0, ["meaning"], th), "weak");
  assert.equal(matchBand(null, 1, ["keyword", "concept"], th), "strong", "every token and two signals");
  assert.equal(matchBand(null, 1, ["keyword"], th), "good", "every token, one signal");
  assert.equal(matchBand(null, 0.5, ["keyword"], th), "good");
  assert.equal(matchBand(null, 0.4, ["keyword"], th), "weak");
  assert.equal(matchBand(null, 0, ["concept"], th), "good");
  assert.equal(matchBand(0.99, 0, ["meaning"], null), "weak", "without embeddings only c and via decide");
});

test("concept hits carry their entries' titles", async (t) => {
  const { search } = await setup(t, { embedder: null });
  const result = await search.search({ query: "stripe proration" }, ALL);
  const concept = result.hits.find((h) => h.kind === "concept");
  assert.ok(concept && concept.kind === "concept");
  assert.deepEqual(concept.entries, [{ id: BILLING, title: "Annual billing" }]);
  const billing = entryHits(result.hits)[0]!;
  assert.equal(billing.match!.band, "strong", "every query token and two signals");
  assert.deepEqual(billing.match!.terms, ["stripe", "proration"]);
});

test("sort: newest orders matches by save time; recent boosts newer posts; the recency math", async (t) => {
  const { store, search } = await setup(t, { embedder: null });
  const newest = await search.search({ query: "tables competitor", sort: "newest", limit: 25 }, ALL);
  const saved = entryHits(newest.hits).map((h) => h.entry.savedAt);
  assert.deepEqual(saved, [...saved].sort().reverse());
  assert.ok(saved.length >= 3);

  const day = 86_400_000;
  // Identical text: relevance keeps id order (the old post first); recent prefers the new post.
  const body = "Churn interviews: call every cancelled customer within a week.";
  store.put("ke_churnaaaaaaa", body, [SAAS], { title: "Churn interviews", postedAt: new Date(Date.now() - 720 * day).toISOString() }, true);
  store.put("ke_churnbbbbbbb", body, [SAAS], { title: "Churn interviews", postedAt: new Date(Date.now() - day).toISOString() }, true);
  await search.indexEntries(["ke_churnaaaaaaa", "ke_churnbbbbbbb"]);
  assert.deepEqual(entryIds((await search.search({ query: "churn interviews", diverse: false }, ALL)).hits), ["ke_churnaaaaaaa", "ke_churnbbbbbbb"]);
  const recent = await search.search({ query: "churn interviews", sort: "recent", diverse: false }, ALL);
  assert.deepEqual(entryIds(recent.hits), ["ke_churnbbbbbbb", "ke_churnaaaaaaa"]);

  const now = Date.parse("2026-10-27T00:00:00.000Z");
  assert.equal(recencyFactor({ postedAt: "2026-10-27", savedAt: "2026-10-27T00:00:00.000Z" }, now), 1);
  assert.equal(recencyFactor({ postedAt: null, savedAt: new Date(now - 90 * day).toISOString() }, now), 0.75);
  assert.equal(recencyFactor({ postedAt: new Date(now - 180 * day).toISOString(), savedAt: "2026-10-26T00:00:00.000Z" }, now), 0.625);
  assert.equal(recencyFactor({ postedAt: "2027-01-01", savedAt: "2026-10-26T00:00:00.000Z" }, now), 1, "future dates are not boosted past 1");
  assert.equal(recencyFactor({ postedAt: "garbage", savedAt: new Date(now).toISOString() }, now), 1, "an unreadable postedAt falls back to savedAt");

  await assert.rejects(search.search({ query: "x", sort: "oldest" as never }, ALL), invalid);
});

test("diversity (MMR) spreads near-identical results apart, deterministically", async (t) => {
  const store = new FakeStore();
  store.collection(ADS, "Ads");
  store.put("ke_dupaaaaaaaaa", "Ads budget campaign spend tips.", [ADS], { title: "Ads tips" }, true);
  store.put("ke_dupbbbbbbbbb", "Ads budget campaign spend tips.", [ADS], { title: "Ads tips" }, true);
  store.put("ke_otherccccccc", "Ads budget for an iOS app store launch, screenshots first.", [ADS], { title: "Launch ads" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const indexDir = await mkdtemp(join(tmpdir(), "kg-mmr-"));
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(new FakeEmbedder()), indexDir, logger: silentLogger(), minSimilarity: 0.3 });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  await warm(search);
  const plain = entryIds((await search.search({ query: "ads budget", diverse: false }, ALL)).hits);
  assert.deepEqual(plain, ["ke_dupaaaaaaaaa", "ke_dupbbbbbbbbb", "ke_otherccccccc"]);
  const diverse = entryIds((await search.search({ query: "ads budget" }, ALL)).hits);
  assert.deepEqual(diverse, ["ke_dupaaaaaaaaa", "ke_otherccccccc", "ke_dupbbbbbbbbb"]);
  assert.deepEqual(entryIds((await search.search({ query: "ads budget" }, ALL)).hits), diverse, "the same request, the same order");
  assert.deepEqual(entryIds((await search.search({ query: "ads budget", sort: "newest" }, ALL)).hits), ["ke_otherccccccc", "ke_dupbbbbbbbbb", "ke_dupaaaaaaaaa"], "newest is never diversified");
});

test("mmr: λ 0.7 trade-off, entries without vectors count as dissimilar", () => {
  const v = (...xs: number[]) => Float32Array.from(xs);
  const vectors = new Map<string, Float32Array | null>([
    ["a", v(1, 0)],
    ["a2", v(1, 0)],
    ["b", v(0, 1)],
    ["none", null]
  ]);
  const ranked = [
    { id: "a", rank: 1 },
    { id: "a2", rank: 0.99 },
    { id: "b", rank: 0.6 },
    { id: "none", rank: 0.5 }
  ];
  const order = mmr(ranked, (id) => vectors.get(id) ?? null).map((r) => r.id);
  // After a: a2 = 0.7·0.99 − 0.3·1 = 0.393; b = 0.42; none = 0.35 → b. Then a2 0.393 vs none 0.35 → a2.
  assert.deepEqual(order, ["a", "b", "a2", "none"]);
  assert.deepEqual(mmr(ranked, () => null).map((r) => r.id), ["a", "a2", "b", "none"], "no vectors: relevance order");
});

test("facets count every match (all pages), with labels; Unfiled only for callers who see it", async (t) => {
  const { store, search } = await setup(t, { embedder: null });
  labelFixture(store);
  const result = await search.search({ query: "tables competitor pricing", limit: 1, facets: true }, ALL);
  const facets = result.facets!;
  assert.equal(facets.kinds.reduce((n, f) => n + f.count, 0), result.total);
  assert.equal(facets.years.reduce((n, f) => n + f.count, 0), result.total);
  assert.ok(facets.collections.some((f) => f.value === "unfiled" && f.label === "Unfiled" && f.count === 1));
  assert.ok(facets.collections.some((f) => f.value === SEO && f.label === "SEO"));
  assert.deepEqual(
    facets.years.map((f) => f.value),
    [...facets.years.map((f) => f.value)].sort().reverse()
  );
  assert.ok(facets.authors.some((f) => f.value === "hridoy" && f.label === "Hridoy Rehman (@hridoy)"));
  assert.ok(facets.authors.some((f) => f.value === "kev" && f.label === "Kevin (@kev)"));
  assert.equal((await search.search({ query: "tables" }, ALL)).facets, undefined, "only when asked");
});

test("entry lists take the search filters", async (t) => {
  const { store, search } = await setup(t, { embedder: null });
  labelFixture(store);
  const ids = async (query: Parameters<KnowledgeSearch["listEntries"]>[0], visibility: KnowledgeVisibility = ALL) =>
    (await search.listEntries(query, visibility)).entries.map((e) => e.id);
  assert.deepEqual(await ids({ kinds: "thread" }), [BILLING, ALT]);
  assert.deepEqual(await ids({ kinds: "thread,case study" }), [BILLING, ALT, CLOUDFLARE]);
  assert.deepEqual(await ids({ authors: "@kev, Hridoy Rehman" }), [ALT, CLOUDFLARE]);
  assert.deepEqual(await ids({ years: "2025" }), [CLOUDFLARE]);
  assert.deepEqual(await ids({ postedAfter: "2026-01-01" }), [ALT]);
  assert.deepEqual(await ids({ savedAfter: store.entries.get(ADSPOST)!.savedAt }), [UNFILED, ADSPOST]);
  assert.deepEqual(await ids({ kinds: "thread" }, SEO_ONLY), [ALT]);
  assert.deepEqual(await ids({ kinds: "thread", collection: SAAS }), [BILLING]);
  const page = await search.listEntries({ kinds: "thread", limit: 1 }, ALL);
  assert.deepEqual(page.entries.map((e) => e.id), [BILLING]);
  assert.deepEqual((await search.listEntries({ kinds: "thread", limit: 1, cursor: page.nextCursor! }, ALL)).entries.map((e) => e.id), [ALT]);
  await assert.rejects(search.listEntries({ postedBefore: "soon" }, ALL), invalid);
  await assert.rejects(search.listEntries({ years: "1,2" }, ALL), invalid);
});

test("embedding: passages carry the entry's context header, queries are embedded as queries", async (t) => {
  const { search, embedder } = await setup(t);
  const seen: { kind: string; texts: readonly string[] }[] = [];
  const embed = embedder!.embed.bind(embedder!);
  embedder!.embed = async (texts, kind = "passage") => {
    seen.push({ kind, texts });
    return embed(texts, kind);
  };
  await warm(search);
  assert.ok(seen.some((call) => call.kind === "query" && call.texts.join() === "warm up"));
  const passages = seen.filter((call) => call.kind === "passage").flatMap((call) => call.texts);
  assert.equal(passages.length, 5);
  assert.ok(passages.includes(`Cloudflare case study · by Kevin @kev · note\n\n${(await search.entryDetail(CLOUDFLARE, ALL))!.entry.body}`));
  assert.ok(embedder!.kinds.includes("query") && embedder!.kinds.includes("passage"));
});

test("a title edit re-embeds an entry; a relabel or a postedAt edit does not", async (t) => {
  const { store, search, embedder } = await setup(t);
  await warm(search);
  const index = search.vectorIndex();
  const texts = embedder!.texts;
  const generation = index.generation();
  const before = index.entryVector(ALT)!;

  // Relabel: collections change, nothing is embedded.
  label(store, ALT, { collections: [SEO, SAAS] });
  store.emit({ kind: "relabelled", entryIds: [ALT] });
  await search.idle();
  assert.equal(embedder!.texts, texts);

  // postedAt is not in the embedding header.
  const alt = store.entries.get(ALT)!;
  store.put(ALT, alt.body, alt.collections, { title: alt.title, postedAt: "2026-01-01" });
  await search.idle();
  assert.equal(embedder!.texts, texts);
  assert.equal(index.generation(), generation);

  // A title edit changes the cache key: embedded again, vectors changed.
  store.put(ALT, alt.body, alt.collections, { title: "Competitor comparison pages" });
  await search.idle();
  assert.equal(embedder!.texts, texts + 1);
  assert.ok(index.generation() > generation);
  assert.notDeepEqual([...index.entryVector(ALT)!], [...before]);
  // The new title is searchable at once.
  assert.equal(entryIds((await search.search({ query: "competitor comparison pages" }, ALL)).hits)[0], ALT);
});

test("the vector index port through KnowledgeSearch: model, thresholds, entry vectors and scoped search", async (t) => {
  const { search, embedders } = await setup(t);
  await warm(search);
  const index = search.vectorIndex();
  assert.equal(index.modelId(), "fake/semantic");
  assert.deepEqual(index.thresholds(), { minimum: 0.3, good: 0.4, strong: 0.6, duplicate: 0.92 }, "minSimilarity overrides the minimum");
  assert.deepEqual(index.embeddedIds().sort(), [ADSPOST, ALT, BILLING, CLOUDFLARE, UNFILED].sort());
  const vector = index.entryVector(CLOUDFLARE)!;
  assert.ok(Math.abs(vector.reduce((n, x) => n + x * x, 0) - 1) < 1e-5);
  assert.equal(index.entryVector(CLOUDFLARE), vector, "cached until its vectors change");
  const query = (await index.embedQuery("ranking in chatgpt"))!;
  const asked: string[] = [];
  const hits = index.search(query, (id) => (asked.push(id), id !== CLOUDFLARE), 10);
  assert.equal(asked.length, 5, "each embedded entry is asked once");
  assert.ok(!hits.some((h) => h.entryId === CLOUDFLARE));
  assert.ok(hits.every((h) => h.score >= 0.3 && h.chunks === 1 && h.chunk === 0));
  assert.deepEqual(index.search(query, () => true, 10, 0.999), []);

  embedders.set(null);
  assert.equal(index.modelId(), null);
  assert.equal(index.thresholds(), null);
  assert.equal(index.entryVector(CLOUDFLARE), null);
  assert.deepEqual(index.embeddedIds(), []);
  assert.equal(await index.embedQuery("x"), null);
});
