import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { KnowledgeEntryMeta, KnowledgeVisibility } from "@orquester/api";
import type { KnowledgePairCheck, KnowledgeVectorThresholds } from "../ports.ts";
import { KnowledgeError } from "../store/errors.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
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

async function setup(t: TestContext, options: { embedder?: FakeEmbedder | null; more?: (store: FakeStore) => void } = {}) {
  const indexDir = await mkdtemp(join(tmpdir(), "kg-search-"));
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
  options.more?.(store);
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
  const embedder = options.embedder === undefined ? new FakeEmbedder({ thresholds: { minimum: 0.3, good: 0.4, strong: 0.6, duplicate: 0.92 } }) : options.embedder;
  const embedders = new FakeEmbedderSource(embedder);
  const logger = silentLogger();
  const search = new KnowledgeSearch({ store, graph, embedders, indexDir, logger });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  return { store, graph, search, embedder, embedders, logger, indexDir };
}

function entryIds(hits: { kind: string; entry?: { id: string } }[]): string[] {
  return hits.filter((h) => h.kind === "entry").map((h) => h.entry!.id);
}

test("search by meaning finds an entry that shares no words with the query", async (t) => {
  const { search } = await setup(t);
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
  assert.deepEqual(concept.entries, [{ id: BILLING, title: "Annual billing" }]);
  const billing = entryHits(result.hits)[0]!;
  assert.equal(billing.match!.band, "strong");
  assert.deepEqual(billing.match!.terms, ["stripe", "proration"]);
  const snippet = result.hits[0]!.kind === "entry" ? result.hits[0]!.entry.snippet : "";
  assert.match(snippet, /Stripe makes proration easy/);
});

test("a concept named like the query is listed among the best entries, even when more entries match than the page holds", async (t) => {
  // Every matching entry is found by two or three signals (keyword, meaning, the concept's one-hop
  // expansion); the concept by one. Their fused scores are on different scales: the concept must
  // still make the first page, scored by how much of the query its name holds.
  const { search } = await setup(t);
  await search.idle();
  for (const limit of [3, 6]) {
    const result = await search.search({ query: "comparison tables", limit }, ALL);
    const concept = result.hits.find((hit) => hit.kind === "concept");
    assert.ok(concept && concept.kind === "concept", `limit ${limit}: no concept hit in ${JSON.stringify(result.hits.map((hit) => hit.kind))}`);
    assert.equal(concept.concept.id, "tactic-comparison-tables");
    assert.equal(concept.score, 1);
    assert.ok(result.hits.indexOf(concept) <= 1, "listed with the best entries");
  }
  // A concept matched in its description or attributes only is listed after the entries.
  const described = await search.search({ query: "stripe proration", limit: 2 }, ALL);
  assert.ok(described.hits.every((hit) => hit.kind === "entry" || hit.score < 1));
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
    for (const name of ["SEO", "SaaS", "Ads"]) assert.ok(error.message.includes(name));
    return true;
  });
  await assert.rejects(search.search({ query: "x", collections: ["SaaS"] }, SEO_ONLY), (error: unknown) => {
    assert.ok(error instanceof KnowledgeError && error.code === "KNOWLEDGE_UNKNOWN_COLLECTION");
    assert.ok(error.message.includes("SEO"));
    assert.ok(!error.message.includes("Ads"));
    return true;
  });
  await assert.rejects(search.search({ query: "  " }, ALL), (error: unknown) => error instanceof KnowledgeError && error.code === "KNOWLEDGE_INVALID");
  // The Unfiled pseudo-collection, as in the entries and graph routes: only for callers who see everything.
  const unfiled = await search.search({ query: "tables", collections: ["unfiled"], limit: 25 }, ALL);
  assert.deepEqual(entryIds(unfiled.hits), [UNFILED]);
  assert.deepEqual(entryIds((await search.search({ query: "tables", collections: ["Unfiled", "SEO"], limit: 25 }, ALL)).hits).sort(), [ALT, CLOUDFLARE, UNFILED].sort());
  await assert.rejects(search.search({ query: "tables", collections: ["unfiled"] }, SEO_ONLY), (error: unknown) => error instanceof KnowledgeError && error.code === "KNOWLEDGE_UNKNOWN_COLLECTION");
  const limited = await search.search({ query: "tables", limit: 1 }, ALL);
  assert.equal(limited.hits.length, 1);
});

test("semantic candidates are selected within the live collection scope, including multi-chunk entries", async (t) => {
  const indexDir = await mkdtemp(join(tmpdir(), "kg-search-scoped-"));
  const store = new FakeStore();
  store.collection(SEO, "SEO");
  store.collection(SAAS, "SaaS");
  // More than CANDIDATES hidden entries beat the visible entry by vector similarity. The
  // visible multi-chunk match must still be returned.
  const hidden = Array.from({ length: 128 }, (_, i) => `ke_${i.toString(32).padStart(12, "0")}`);
  for (const id of hidden) store.put(id, "ranking chatgpt", [SAAS], {}, true);
  const visible = "ke_visibleentry";
  // The final chunks contain only semantic matches; earlier chunks include filler. Keep
  // enough prose for the token-budget chunker to emit several pure-semantic chunks.
  const body = `${"filler ".repeat(280)}${"LLM visibility: answer engines surface sites with fresh FAQs. ".repeat(60)}`;
  store.put(visible, body, [SEO], { title: "Fresh FAQs" }, true);
  const search = new KnowledgeSearch({
    store,
    graph: new KnowledgeGraph({ entries: store, logger: silentLogger() }),
    embedders: new FakeEmbedderSource(new FakeEmbedder()),
    indexDir,
    logger: silentLogger()
  });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  await search.idle();
  assert.ok(!entryIds((await search.search({ query: "ranking chatgpt", limit: 25 }, ALL)).hits).includes(visible));
  const scoped = await search.search({ query: "ranking chatgpt" }, SEO_ONLY);
  assert.deepEqual(entryIds(scoped.hits), [visible]);
  assert.deepEqual(entryIds((await search.search({ query: "ranking chatgpt", collections: [SEO] }, ALL)).hits), [visible]);
  assert.deepEqual((await search.search({ query: "ranking chatgpt" }, { kind: "collections", ids: [] })).hits, []);

  // Relabelling changes metadata without re-embedding: every query must read the current scope.
  store.entries.get(visible)!.collections = [SAAS];
  store.entries.get(hidden[0]!)!.collections = [SEO];
  store.emit({ kind: "relabelled", entryIds: [visible, hidden[0]!] });
  assert.deepEqual(entryIds((await search.search({ query: "ranking chatgpt" }, SEO_ONLY)).hits), [hidden[0]!]);
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

  // The runtime arrives: meaning search starts working.
  broken.embedders.set(new FakeEmbedder());
  await broken.search.idle();
  assert.equal(entryIds((await broken.search.search({ query: "Ranking in ChatGPT" }, ALL)).hits)[0], CLOUDFLARE);
});

test("startup and model arrival fill similar-entry details without a search", async (t) => {
  const LLM = "ke_llmllmllmllm";
  const { search } = await setup(t, {
    more: (store) => store.put(LLM, "ChatGPT and LLM answer engines cite the sources they trust.", [SEO], { title: "LLM citations" }, true)
  });
  await search.idle();
  const detail = (await search.entryDetail(CLOUDFLARE, ALL))!;
  assert.ok(detail.similar?.find((similar) => similar.entry.id === LLM)?.reasons.some((reason) => reason.kind === "meaning"));
  const none = await setup(t, {
    embedder: null,
    more: (store) => store.put(LLM, "ChatGPT and LLM answer engines cite the sources they trust.", [SEO], { title: "LLM citations" }, true)
  });
  assert.ok(!(await none.search.entryDetail(CLOUDFLARE, ALL))!.similar?.some((similar) => similar.reasons.some((reason) => reason.kind === "meaning")));
  none.embedders.set(new FakeEmbedder());
  await none.search.idle();
  const arrived = (await none.search.entryDetail(CLOUDFLARE, ALL))!;
  assert.ok(arrived.similar?.find((similar) => similar.entry.id === LLM)?.reasons.some((reason) => reason.kind === "meaning"), "model installation fills read views without a query");
});

test("read views: lists, details, items and graphs respect visibility", async (t) => {
  const { search } = await setup(t, { embedder: null });
  assert.deepEqual((await search.listEntries({ collection: "unfiled" }, ALL)).entries.map((e) => e.id), [UNFILED]);
  assert.deepEqual((await search.listEntries({}, SEO_ONLY)).entries.map((e) => e.id), [ALT, CLOUDFLARE]);
  await assert.rejects(search.listEntries({ collection: "unfiled" }, SEO_ONLY), (error: unknown) => error instanceof KnowledgeError && error.code === "KNOWLEDGE_UNKNOWN_COLLECTION");
  await assert.rejects(search.listEntries({ cursor: "garbage" }, ALL), (error: unknown) => error instanceof KnowledgeError && error.code === "KNOWLEDGE_INVALID");

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
  await search.idle();
  // The ads entry must keep its own meaning (a query sharing no word with it), not the edited entry's.
  assert.equal(entryIds((await search.search({ query: "cpc", limit: 25 }, ALL)).hits)[0], ADSPOST);
});

test("a save returns within its bounded embedding wait while a stalled model finishes later", async (t) => {
  const { store, search, embedder } = await setup(t);
  await search.idle();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  let started!: () => void;
  const embedding = new Promise<void>((resolve) => (started = resolve));
  const embed = embedder!.embed.bind(embedder!);
  embedder!.embed = async (texts, kind) => {
    if (texts.some((text) => text.includes("onboarding"))) {
      started();
      await gate;
    }
    return embed(texts, kind);
  };
  const id = "ke_slowslowslow";
  store.put(id, "Welcome emails: onboarding sequences that convert.", [SEO], { title: "Onboarding emails" }, true);
  let done = false;
  const indexing = search.indexEntries([id]).then(() => (done = true));
  await embedding;
  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  if (!done) release();
  assert.ok(done, "the save must not wait beyond the documented two-second bound");
  await indexing;
  assert.ok(entryIds((await search.search({ query: "welcome emails" }, ALL)).hits).includes(id), "searchable by text while its model call is pending");
  release();
  await search.idle();
  assert.ok(search.vectorIndex().entryVector(id), "the background embedding completes after the caller returns");
});

// Retrieval spec: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md

type Hit = Awaited<ReturnType<KnowledgeSearch["search"]>>["hits"][number];
type EntryHit = Extract<Hit, { kind: "entry" }>;
const entryHits = (hits: readonly Hit[]): EntryHit[] => hits.filter((hit): hit is EntryHit => hit.kind === "entry");

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

/** External model answers are fixed geometric fixtures; the real index and ranking remain in use. */
async function geometricSearch(
  t: TestContext,
  entries: { id: string; title: string; body: string; vector: number[] }[],
  thresholds: KnowledgeVectorThresholds = { minimum: 0.1, good: 0.5, strong: 0.7, duplicate: 0.95 }
) {
  const store = new FakeStore();
  for (const entry of entries) store.put(entry.id, entry.body, [], { title: entry.title }, true);
  const dimensions = entries[0]!.vector.length;
  const embedder = new FakeEmbedder({ dimensions, groups: [], thresholds });
  embedder.embed = async (texts, kind = "passage") => texts.map((text) => {
    if (kind === "query") return Float32Array.from({ length: dimensions }, (_, dimension) => dimension === 0 ? 1 : 0);
    const entry = entries.find((candidate) => text.includes(candidate.title));
    assert.ok(entry, `unexpected passage: ${text}`);
    return Float32Array.from(entry.vector);
  });
  const embedders = new FakeEmbedderSource(embedder);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const indexDir = await mkdtemp(join(tmpdir(), "kg-search-geometry-"));
  const search = new KnowledgeSearch({ store, graph, embedders, indexDir, logger: silentLogger() });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  await search.idle();
  return { search, embedders };
}

test("filters constrain keyword, meaning, expansion and concept candidates before ranking", async (t) => {
  const { store, search } = await setup(t);
  labelFixture(store);
  await search.idle();
  const threads = await search.search({ query: "comparison tables competitor pricing", filters: { kinds: ["thread"] }, limit: 25 }, ALL);
  assert.deepEqual(entryIds(threads.hits).sort(), [ALT, BILLING].sort());
  assert.ok(entryHits(threads.hits).find((hit) => hit.entry.id === BILLING)!.match!.via.includes("concept"));
  for (const hit of threads.hits) if (hit.kind === "concept") for (const id of hit.entryIds) assert.ok([ALT, BILLING].includes(id));
  assert.deepEqual(entryIds((await search.search({ query: "ranking in chatgpt", filters: { authors: ["Kevin"] } }, ALL)).hits), [CLOUDFLARE], "the semantic signal uses the same filter");
  const none = await search.search({ query: "comparison tables", filters: { kinds: ["podcast"] } }, ALL);
  assert.deepEqual(none.hits, []);
  assert.equal(none.total, 0);
  assert.equal(none.nextCursor, null);
  await assert.rejects(search.search({ query: "tables", filters: { postedAfter: "yesterday" } }, ALL), invalid);
});

test("hidden entries never leak through examples, expansion, concept hits or facets", async (t) => {
  const { store, search } = await setup(t);
  labelFixture(store);
  await search.idle();
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

  const expanded = await search.search({ query: "perplexity", limit: 25 }, SEO_ONLY);
  assert.ok(entryIds(expanded.hits).includes(ALT), "visible expansion remains available without a filter");
  assert.ok(!entryIds((await search.search({ query: "stripe annual billing", limit: 25 }, SEO_ONLY)).hits).includes(BILLING));
  // Expansion and concepts under a filter, for a profile.
  for (const query of ["perplexity", "comparison tables"]) {
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

test("a concept merged into a hidden one is shown as itself: search, entry and concept details and the graph never name the hidden one", async (t) => {
  const { search, graph } = await setup(t);
  await loadGraph(graph, [
    node("tool-stripe", "Stripe", [`${BILLING}.md`], { aliases: ["stripe.com"], attributes: { description: { value: "Payments for SaaS billing", confidence: 1 } } }),
    node("tool-tables", "Comparison tables tool", [`${ALT}.md`])
  ]);
  graph.setConceptMerges([{ id: "cm_tools", type: "tool", into: "tool-stripe", merged: ["tool-tables"], similarity: 0.93, createdAt: "2026-10-27T10:00:00.000Z" }]);
  await search.idle();
  const leaks = /stripe|payments/i;
  const shown = { id: "tool-tables", name: "Comparison tables tool", type: "tool" };
  const found = await search.search({ query: "comparison tables tool" }, SEO_ONLY);
  assert.deepEqual(
    found.hits.filter((hit) => hit.kind === "concept").map((hit) => hit.kind === "concept" && hit.concept),
    [{ ...shown, description: null }]
  );
  assert.doesNotMatch(JSON.stringify(found), leaks);
  for (const query of ["stripe", "payments"]) {
    assert.deepEqual(
      (await search.search({ query }, SEO_ONLY)).hits.filter((hit) => hit.kind === "concept"),
      [],
      query
    );
  }
  const entry = await search.entryDetail(ALT, SEO_ONLY);
  assert.deepEqual(entry?.concepts, [shown]);
  assert.doesNotMatch(JSON.stringify(entry), leaks);
  const concept = await search.conceptDetail("tool-tables", SEO_ONLY);
  assert.equal(concept?.concept.id, "tool-tables");
  assert.doesNotMatch(JSON.stringify(concept), leaks);
  assert.equal(await search.conceptDetail("tool-stripe", SEO_ONLY), null);
  assert.doesNotMatch(JSON.stringify(search.graphView({}, SEO_ONLY)), leaks);
  // The user sees the merge as it is.
  assert.equal((await search.conceptDetail("tool-tables", ALL))?.concept.id, "tool-stripe");
});

test("a concept detail lists every visible entry id behind it, merged sources included, newest first, up to 2,000", async (t) => {
  const many = Array.from({ length: 2_005 }, (_, i) => `ke_many${String(i).padStart(8, "0")}`);
  const { search, graph } = await setup(t, {
    embedder: null,
    more: (store) => {
      for (const id of many) store.put(id, `Note ${id} about pricing pages.`, [SEO], {}, true);
    }
  });
  await loadGraph(graph, [
    node("tactic-pricing", "Pricing pages", [...many.slice(0, 1_000), BILLING].map((id) => `${id}.md`)),
    node("tactic-pricing-page", "Pricing page", [...many.slice(1_000), ALT].map((id) => `${id}.md`)),
    node("tactic-small", "Small", [`${CLOUDFLARE}.md`, `${BILLING}.md`])
  ]);
  graph.setConceptMerges([{ id: "cm_pricing", type: "tactic", into: "tactic-pricing", merged: ["tactic-pricing-page"], similarity: 0.95, createdAt: "2026-10-27T10:00:00.000Z" }]);
  await search.idle();
  const detail = (await search.conceptDetail("tactic-pricing-page", SEO_ONLY))!;
  const newestFirst = [...many].reverse();
  assert.equal(detail.entryIds?.length, 2_000);
  assert.deepEqual(detail.entryIds, newestFirst.slice(0, 2_000), "newest first; the hidden BILLING and the oldest past 2,000 left out");
  assert.deepEqual(
    detail.entries.map((e) => e.id),
    newestFirst.slice(0, 50)
  );
  assert.deepEqual((await search.conceptDetail("tactic-small", SEO_ONLY))!.entryIds, [CLOUDFLARE], "a hidden entry is never listed");
  assert.deepEqual((await search.conceptDetail("tactic-small", ALL))!.entryIds, [BILLING, CLOUDFLARE]);
});

test("query by example ranks toward positive and away from negative examples, excluding both", async (t) => {
  const like = "ke_likeseedaaaa";
  const unlike = "ke_zunlikeseed1";
  const a = "ke_candidateaa1";
  const b = "ke_candidatebb1";
  const { search } = await geometricSearch(t, [
    { id: like, title: "Positive fixture", body: "source", vector: [1, 0] },
    { id: unlike, title: "Negative fixture", body: "avoid", vector: [0.8, 0.6] },
    { id: a, title: "Candidate Alpha", body: "needle", vector: [0.8, 0.6] },
    { id: b, title: "Candidate Beta", body: "other", vector: [0.8, -0.6] }
  ]);
  const positive = await search.search({ similarTo: [like], limit: 25 }, ALL);
  assert.equal(entryIds(positive.hits)[0], a, "equal positive cosine starts with the smaller candidate id");
  assert.ok(!entryIds(positive.hits).includes(like));
  assert.ok(positive.hits.every((hit) => hit.kind === "entry"));
  for (const hit of entryHits(positive.hits)) assert.deepEqual(hit.match!.via, ["similar"]);
  const negative = await search.search({ similarTo: [like], unlike: [unlike], limit: 25 }, ALL);
  assert.deepEqual(entryIds(negative.hits), [b, a], "the negative vector changes the ranking, beyond excluding the example");
  const both = await search.search({ query: "needle", similarTo: [like], unlike: [unlike], limit: 25 }, ALL);
  assert.equal(entryIds(both.hits)[0], a);
  assert.deepEqual(entryHits(both.hits)[0]!.match!.via, ["keyword", "meaning", "similar"]);
  assert.ok(!entryIds((await search.search({ query: "needle", unlike: [a] }, ALL)).hits).includes(a));
  await assert.rejects(search.search({ similarTo: Array.from({ length: 11 }, () => like) }, ALL), invalid);
  await assert.rejects(search.search({ query: "   ", similarTo: [] }, ALL), invalid);
});

test("query by example with unlike, on a model whose vectors sit in a narrow cone: unlike never empties it or changes what matches", async (t) => {
  const like = "ke_likeseedaaaa";
  const unlike = "ke_zunlikeseed1";
  const a = "ke_candidateaa1";
  const b = "ke_candidatebb1";
  // Both candidates have cosine 0.91 to the positive example, above the supplied 0.9 floor.
  const { search } = await geometricSearch(t, [
    { id: like, title: "Positive fixture", body: "source", vector: [0.3, 0, 0.9539392014] },
    { id: unlike, title: "Negative fixture", body: "avoid", vector: [-0.3, 0, 0.9539392014] },
    { id: a, title: "Candidate Alpha", body: "first", vector: [0, 0.3, 0.9539392014] },
    { id: b, title: "Candidate Beta", body: "second", vector: [0, -0.3, 0.9539392014] }
  ], { minimum: 0.9, good: 0.93, strong: 0.96, duplicate: 0.995 });
  const steered = await search.search({ similarTo: [like], unlike: [unlike], limit: 25 }, ALL);
  assert.deepEqual(entryIds(steered.hits).sort(), [a, b]);
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
  await search.idle();
  const full = await search.search({ query: "tables competitor pricing perplexity", limit: 25 }, ALL);
  assert.equal(full.nextCursor, null);
  const total = full.total!;
  assert.equal(total, 4);
  assert.deepEqual(entryIds(full.hits).sort(), [ALT, BILLING, CLOUDFLARE, UNFILED].sort());
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
    assert.ok(pages <= total + 1, "the cursor must advance through the known result set");
  } while (cursor);
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
  const filtered = await search.search({ query: "tables competitor pricing perplexity", filters: { kinds: ["thread", "note"] }, limit: 1 }, ALL);
  assert.ok(filtered.nextCursor);
  await search.search({ query: "tables competitor pricing perplexity", filters: { kinds: ["NOTE", "Thread"] }, cursor: filtered.nextCursor! }, ALL);
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
  await search.idle();

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

test("a long entry's passage is the chunk that holds the query's words when it is about as close in meaning as the closest", async (t) => {
  const { store, search } = await setup(t);
  const long = "ke_longsurveyaa";
  // The first window is all ads words (closest to "cpc budget" by meaning, none of its words); the
  // last one names them among other words.
  const ads = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? "campaign" : "ads")).join(" ");
  const other = Array.from({ length: 60 }, (_, i) => `note${i}`).join(" ");
  const body = `${ads} ${other} raise the cpc budget after learning`;
  store.put(long, body, [ADS], { title: "Ads notes" }, true);
  await search.indexEntries([long]);
  await search.idle();
  const hit = entryHits((await search.search({ query: "cpc budget", limit: 25 }, ALL)).hits).find((h) => h.entry.id === long)!;
  const passage = hit.match!.passage!;
  assert.ok(passage.chunks >= 2);
  assert.equal(passage.chunk, passage.chunks - 1);
  assert.match(body.slice(passage.start, passage.end), /cpc budget/);
  assert.match(hit.entry.snippet, /cpc budget/);
});

test("a survey ranks below an entry that matches as well, unless the query asks for a survey", async (t) => {
  const text = "Raise the ads budget only after the campaign learns.";
  const { search } = await setup(t, {
    more: (store) => {
      // Ids in the order a tie is broken: the survey first.
      store.put("ke_aaaasurveyaa", text, [ADS], { title: "Ads", kind: "synthesis" }, true);
      store.put("ke_bbbbpostbbbb", text, [ADS], { title: "Ads", kind: "post" }, true);
    }
  });
  await search.idle();
  const order = async (query: string) => entryIds((await search.search({ query, diverse: false }, ALL)).hits).filter((id) => id.includes("survey") || id.includes("post"));
  assert.deepEqual(await order("ads budget campaign"), ["ke_bbbbpostbbbb", "ke_aaaasurveyaa"]);
  assert.deepEqual(await order("ads budget campaign overview"), ["ke_aaaasurveyaa", "ke_bbbbpostbbbb"]);
});

test("the other side of a checked disagreement the query finds comes up next to it; a consistent check moves nothing", async (t) => {
  const { search } = await setup(t, {
    embedder: null,
    more: (store) => {
      store.put("ke_gmailgmailgm", "Use Gmail: the email provider matters. Gmail is the email provider TikTok trusts.", [ADS], { title: "Email provider for TikTok" }, true);
      store.put("ke_fillerfiller", "Which email provider? Any email provider works for newsletters.", [ADS], { title: "Newsletters" }, true);
      store.put("ke_fillertwotwo", "An email provider with good deliverability helps cold outreach.", [ADS], { title: "Cold outreach" }, true);
      store.put("ke_outlookoutlo", "Make an Outlook or Proton email and sign up with it.", [ADS], { title: "13 steps" }, true);
    }
  });
  await search.idle();
  const order = async () => entryIds((await search.search({ query: "email provider" }, ALL)).hits);
  const before = await order();
  assert.deepEqual(before.slice(0, 1), ["ke_gmailgmailgm"]);
  assert.ok(before.indexOf("ke_outlookoutlo") > 2, before.join(" "));
  const checks: KnowledgePairCheck[] = [];
  search.connectLinking({ pairChecks: { all: () => checks, get: () => null, onChange: () => () => undefined } });
  checks.push({ a: "ke_gmailgmailgm", b: "ke_outlookoutlo", verdict: "consistent", note: "Both need an email", checkedAt: "t" });
  assert.deepEqual(await order(), before);
  checks[0] = { ...checks[0]!, verdict: "contradicts", note: "A says only a Gmail email provider is safe, B an Outlook one" };
  const after = await order();
  assert.deepEqual(after.slice(0, 2), ["ke_gmailgmailgm", "ke_outlookoutlo"]);
  assert.deepEqual([...after].sort(), [...before].sort(), "the same hits");
});

test("a hit another hit brought up still brings up its own other side; a disagreement whose note is not about the query moves nothing", async (t) => {
  const { search } = await setup(t, {
    embedder: null,
    more: (store) => {
      store.put("ke_jasonjasonja", "VPN or proxy for the account: buy an ISP proxy. Proxy, VPN, account.", [ADS], { title: "VPN proxy account" }, true);
      store.put("ke_danieldaniel", "Self-host a VPN for the account instead of a shared proxy.", [ADS], { title: "VPN proxy" }, true);
      for (let i = 0; i < 6; i += 1) store.put(`ke_fillerfill0${i}`, `A VPN or proxy note ${i}.`, [ADS], { title: `VPN proxy filler ${i}` }, true);
      store.put("ke_emaemaemaema", "Install a VPN (NordVPN) before you open the app, then keep it on for days and days.", [ADS], { title: "Seven steps" }, true);
      store.put("ke_offtopicoffo", "The warm-up matters more than the proxy.", [ADS], { title: "Warm-up" }, true);
    }
  });
  await search.idle();
  const order = async () => entryIds((await search.search({ query: "vpn proxy account", limit: 20 }, ALL)).hits);
  const before = await order();
  assert.ok(before.indexOf("ke_emaemaemaema") > 3 && before.indexOf("ke_offtopicoffo") > 3, before.join(" "));
  const at = "2026-10-28T00:00:00.000Z";
  const checks: KnowledgePairCheck[] = [
    { a: "ke_danieldaniel", b: "ke_jasonjasonja", verdict: "contradicts", note: "jason buys an ISP proxy for the account; daniel says a shared proxy gets flagged.", checkedAt: at },
    { a: "ke_danieldaniel", b: "ke_emaemaemaema", verdict: "contradicts", note: "Ema uses NordVPN for the account; daniel says a shared VPN gets the account banned.", checkedAt: at },
    { a: "ke_jasonjasonja", b: "ke_offtopicoffo", verdict: "contradicts", note: "jason says set up a proxy first; the other says warm-up comes first.", checkedAt: at }
  ];
  search.connectLinking({ pairChecks: { all: () => checks, get: () => null, onChange: () => () => undefined } });
  const after = await order();
  // jason brings up daniel (proxy, account); daniel, though brought up, brings up Ema (vpn, account).
  assert.equal(after.indexOf("ke_danieldaniel"), after.indexOf("ke_jasonjasonja") + 1, after.join(" "));
  assert.equal(after.indexOf("ke_emaemaemaema"), after.indexOf("ke_danieldaniel") + 1, after.join(" "));
  // jason and the warm-up post disagree about something the note holds one query word of: it stays put.
  assert.equal(after.indexOf("ke_offtopicoffo"), before.indexOf("ke_offtopicoffo") + (before.indexOf("ke_emaemaemaema") > before.indexOf("ke_offtopicoffo") ? 1 : 0), after.join(" "));
});

test("a query that asks how long: \"long\" is the question, a stated duration matches and is the passage shown", async (t) => {
  const { search } = await setup(t, {
    embedder: null,
    more: (store) => {
      store.put("ke_aslongasyoul", "Keep posting as long as you like; the account will grow. Warm vibes, long captions.", [ADS], { title: "Posting for a long time" }, true);
      store.put("ke_fortyeighthh", "Make an account with a fresh email and warm up the account.\nThen warm it up for 48 hours before you post.", [ADS], { title: "Account steps" }, true);
    }
  });
  await search.idle();
  const hits = entryHits((await search.search({ query: "how long to warm up an account", limit: 10 }, ALL)).hits);
  const ids = hits.map((hit) => hit.entry.id);
  assert.ok(ids.indexOf("ke_fortyeighthh") < ids.indexOf("ke_aslongasyoul") || !ids.includes("ke_aslongasyoul"), ids.join(" "));
  const hit = hits.find((h) => h.entry.id === "ke_fortyeighthh")!;
  assert.match(hit.entry.snippet, /48 hours/);
  assert.ok(!hit.match!.terms.includes("long"));
});

test("match bands reflect semantic thresholds and lexical coverage through search results", async (t) => {
  const { search, embedders } = await geometricSearch(t, [
    { id: "ke_bandstrong01", title: "Semantic high", body: "unrelated", vector: [0.8, 0.6] },
    { id: "ke_bandgood0001", title: "Semantic medium", body: "unrelated", vector: [0.6, 0.8] },
    { id: "ke_bandweak0001", title: "Semantic low", body: "unrelated", vector: [0.2, Math.sqrt(0.96)] },
    { id: "ke_bandfull0001", title: "Lexical full", body: "needle haystack pin", vector: [0, 1] },
    { id: "ke_bandhalf0001", title: "Lexical majority", body: "needle haystack", vector: [0, 1] },
    { id: "ke_bandpart0001", title: "Lexical partial", body: "needle", vector: [0, 1] },
    { id: "ke_bandboth0001", title: "Multiple signals", body: "needle haystack pin", vector: [0.2, Math.sqrt(0.96)] }
  ]);
  const bands = async () => Object.fromEntries(entryHits((await search.search({ query: "needle haystack pin", limit: 25 }, ALL)).hits).map((hit) => [hit.entry.id, hit.match!.band]));
  assert.deepEqual(await bands(), {
    ke_bandstrong01: "strong", ke_bandgood0001: "good", ke_bandweak0001: "weak",
    ke_bandfull0001: "good", ke_bandhalf0001: "good", ke_bandpart0001: "weak", ke_bandboth0001: "strong"
  });
  embedders.set(null);
  assert.deepEqual(await bands(), { ke_bandfull0001: "good", ke_bandhalf0001: "good", ke_bandpart0001: "weak", ke_bandboth0001: "good" });
});

test("newest orders matches by save time and recent boosts newer posts", async (t) => {
  const { store, search } = await setup(t, { embedder: null });
  const newest = await search.search({ query: "tables competitor", sort: "newest", limit: 25 }, ALL);
  const saved = entryHits(newest.hits).map((h) => h.entry.savedAt);
  assert.deepEqual(saved, [...saved].sort().reverse());
  assert.ok(saved.length >= 3);

  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-27T00:00:00.000Z") });
  const day = 86_400_000;
  // Identical text: relevance keeps id order (the old post first); recent prefers the new post.
  const body = "Churn interviews: call every cancelled customer within a week.";
  store.put("ke_churnaaaaaaa", body, [SAAS], { title: "Churn interviews", postedAt: new Date(Date.now() - 720 * day).toISOString() }, true);
  store.put("ke_churnbbbbbbb", body, [SAAS], { title: "Churn interviews", postedAt: new Date(Date.now() - day).toISOString() }, true);
  await search.indexEntries(["ke_churnaaaaaaa", "ke_churnbbbbbbb"]);
  assert.deepEqual(entryIds((await search.search({ query: "churn interviews", diverse: false }, ALL)).hits), ["ke_churnaaaaaaa", "ke_churnbbbbbbb"]);
  const recent = await search.search({ query: "churn interviews", sort: "recent", diverse: false }, ALL);
  assert.deepEqual(entryIds(recent.hits), ["ke_churnbbbbbbb", "ke_churnaaaaaaa"]);

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
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(new FakeEmbedder({ thresholds: { minimum: 0.3, good: 0.4, strong: 0.6, duplicate: 0.92 } })), indexDir, logger: silentLogger() });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  await search.idle();
  const plain = entryIds((await search.search({ query: "ads budget", diverse: false }, ALL)).hits);
  assert.deepEqual(plain, ["ke_dupaaaaaaaaa", "ke_dupbbbbbbbbb", "ke_otherccccccc"]);
  const diverse = entryIds((await search.search({ query: "ads budget" }, ALL)).hits);
  assert.deepEqual(diverse, ["ke_dupaaaaaaaaa", "ke_otherccccccc", "ke_dupbbbbbbbbb"]);
  assert.deepEqual(entryIds((await search.search({ query: "ads budget" }, ALL)).hits), diverse, "the same request, the same order");
  assert.deepEqual(entryIds((await search.search({ query: "ads budget", sort: "newest" }, ALL)).hits), ["ke_otherccccccc", "ke_dupbbbbbbbbb", "ke_dupaaaaaaaaa"], "newest is never diversified");
});

test("search facets count the complete match set before paging and only when requested", async (t) => {
  const { store, search } = await setup(t, { embedder: null });
  labelFixture(store);
  const result = await search.search({ query: "tables competitor pricing", limit: 1, facets: true }, ALL);
  assert.equal(result.hits.length, 1);
  assert.equal(result.total, 4);
  assert.deepEqual(result.facets!.kinds, [
    { value: "thread", label: "thread", count: 2 },
    { value: "Case Study", label: "Case Study", count: 1 },
    { value: "note", label: "note", count: 1 }
  ]);
  assert.deepEqual(result.facets!.years, [{ value: "2026", label: "2026", count: 3 }, { value: "2025", label: "2025", count: 1 }]);
  assert.ok(result.facets!.collections.some((facet) => facet.value === "unfiled" && facet.count === 1));
  assert.equal((await search.search({ query: "tables" }, ALL)).facets, undefined);
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
  await assert.rejects(search.listEntries({ postedBefore: "soon" }, ALL), invalid);
});

test("entry cursors retain timestamp ties and collection filters across every page", async (t) => {
  const A = "ke_pageaaaaaaaa";
  const C = "ke_pageaaaaaaac";
  const E = "ke_pageaaaaaaae";
  const { search } = await setup(t, {
    embedder: null,
    more: (store) => {
      // Import order differs from save order, and C/A share a timestamp. Hidden entries
      // and a different kind fall between them in the unfiltered ordering.
      store.put(C, "Third", [SEO], { savedAt: "2026-10-02T00:00:00.000Z" }, true);
      store.put("ke_pageaaaaaaab", "Hidden", [SAAS], { savedAt: "2026-10-03T00:00:00.000Z" }, true);
      store.put(A, "First", [SEO], { savedAt: "2026-10-02T00:00:00.000Z" }, true);
      store.put("ke_pageaaaaaaad", "Other kind", [SEO], { kind: "post", savedAt: "2026-10-02T00:00:00.000Z" }, true);
      store.put(E, "Fifth", [SEO], { savedAt: "2026-10-04T00:00:00.000Z" }, true);
    }
  });
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await search.listEntries({ collection: SEO, kinds: "note", limit: 1, cursor }, ALL);
    assert.equal(result.entries.length, 1);
    ids.push(result.entries[0]!.id);
    if (page < 4) assert.ok(result.nextCursor);
    else assert.equal(result.nextCursor, null);
    cursor = result.nextCursor ?? undefined;
  }
  assert.deepEqual(ids, [E, C, A, ALT, CLOUDFLARE]);
});

test("a title edit re-embeds an entry; a relabel or a postedAt edit does not", async (t) => {
  const { store, search, embedder } = await setup(t);
  await search.idle();
  const texts = embedder!.texts;

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

  // A title edit changes the cache key: embedded again, vectors changed.
  store.put(ALT, alt.body, alt.collections, { title: "Competitor comparison pages" });
  await search.idle();
  assert.equal(embedder!.texts, texts + 1);
  // The new title is searchable at once.
  assert.equal(entryIds((await search.search({ query: "competitor comparison pages" }, ALL)).hits)[0], ALT);
});
