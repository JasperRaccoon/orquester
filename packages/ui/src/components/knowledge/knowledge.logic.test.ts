import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KNOWLEDGE_COLORS } from "@orquester/api";

import { entry, summary } from "../../lib/knowledge/fixtures.test-helpers.ts";
import {
  appendPage,
  cleanFilters,
  clearFilterField,
  collectionFormError,
  entriesQueryOf,
  entryFormOf,
  entryFormPatch,
  entryPostUrl,
  facetsRequestOf,
  filterChipLabel,
  filterHas,
  highlightParts,
  knowledgeErrorCode,
  knowledgeErrorText,
  linkingView,
  nextKnowledgeColor,
  passageText,
  patchNeedsLinking,
  queryIsEmpty,
  rediscoverEntries,
  rediscoverRequestOf,
  rediscoverSeeds,
  resultsCountText,
  searchHitKey,
  searchKeyOf,
  searchPageOf,
  searchRequestOf,
  shownSort,
  sortOptionsFor,
  toggleFilterValue,
  viaBadges,
  withoutExample
} from "./knowledge.logic.ts";
import { EMPTY_KNOWLEDGE_QUERY, findSimilarQuery, withUnlike, type KnowledgeQuery } from "./query-state.ts";

describe("knowledge colours", () => {

  it("give a new collection the first unused colour, then go round", () => {
    assert.equal(nextKnowledgeColor([{ color: "chart-1" }, { color: "chart-3" }], KNOWLEDGE_COLORS), "chart-2");
    const all = KNOWLEDGE_COLORS.map((color) => ({ color }));
    assert.equal(nextKnowledgeColor([...all, { color: "chart-1" }], KNOWLEDGE_COLORS), "chart-2");
  });
});

describe("knowledge errors", () => {
  const refused = (body: unknown) => Object.assign(new Error("Orquester API PATCH … failed with status 409"), { body });

  it("show the daemon's message, else a text for its code, else the error", () => {
    assert.equal(knowledgeErrorText(refused({ code: "KNOWLEDGE_COLLECTION_EXISTS", message: "“SEO” already exists." })), "“SEO” already exists.");
    assert.equal(knowledgeErrorText(refused({ code: "KNOWLEDGE_COLLECTION_EXISTS" })), "A collection with that name already exists.");
    assert.equal(knowledgeErrorText(refused({ error: { code: "KNOWLEDGE_BUSY" } })), "The knowledge base is busy; try again in a moment.");
    assert.match(knowledgeErrorText(refused(undefined)), /status 409/);
    assert.equal(knowledgeErrorCode(refused({ code: "KNOWLEDGE_NOT_FOUND" })), "KNOWLEDGE_NOT_FOUND");
    assert.equal(knowledgeErrorCode(refused({ code: "OTHER" })), null);
  });
});

describe("the status bar text", () => {

  it("describes each linking state", () => {
    assert.equal(linkingView({ state: "idle" }).label, "Linking idle");

    const now = Date.parse("2026-10-20T10:00:00Z");
    const queued = linkingView({ state: "queued", pendingEntries: 3, startsAt: "2026-10-20T10:00:15Z" }, [], now);
    assert.equal(queued.label, "Linking queued · 3 entries");
    assert.equal(queued.detail, "Linking starts in 15s.");

    const running = linkingView(
      { state: "running", runId: "r1", mode: "update", step: "pass2", progress: { done: 3, total: 12 }, pendingEntries: 1 },
      [{ id: "r1", mode: "update", startedAt: "", finishedAt: null, durationMs: null, entries: 4, tasks: 12, tokensIn: 0, tokensOut: 0, outcome: "running", error: null }]
    );
    assert.equal(running.label, "Linking 4 entries…");
    assert.equal(running.progress, 0.25);
    assert.match(running.detail ?? "", /3 of 12 steps · step pass2 · 1 entry waiting/);

    const unknownRun = linkingView({ state: "running", runId: "r9", mode: "update", step: "", progress: null, pendingEntries: 0 });
    assert.equal(unknownRun.label, "Linking…");
    assert.equal(unknownRun.progress, null);

    const paused = linkingView({ state: "paused", reason: "usage-limit", message: "Resets soon.", resumesAt: null, pendingEntries: 2 });
    assert.equal(paused.label, "Linking paused: every Claude account is at its usage limit");
    assert.equal(paused.detail, "Resets soon.");
  });

  it("does not call idle linking complete while some entries failed", () => {
    const now = Date.parse("2026-10-20T10:00:00Z");
    const allLinked = linkingView({ state: "idle" }, [], now, 0);
    assert.equal(allLinked.tone, "idle");
    assert.equal(allLinked.detail, "Every entry is linked.");

    const failed = linkingView({ state: "idle" }, [], now, 3);
    assert.equal(failed.tone, "failed");
    assert.equal(failed.label, "3 entries could not be linked");
    assert.equal(failed.detail, "See Settings → Plugins → Knowledge Graph for the last error.");
    assert.doesNotMatch(`${failed.label} ${failed.detail}`, /Every entry is linked/);
    assert.equal(linkingView({ state: "idle" }, [], now, 1).label, "1 entry could not be linked");
  });
});

describe("the collection form", () => {
  const existing = [
    { id: "kc_seo", name: "SEO" },
    { id: "kc_ads", name: "Ads" }
  ];

  it("needs a unique name within the limits and a one-line description", () => {
    assert.equal(collectionFormError({ name: "  ", description: "" }, existing, null), "Give the collection a name.");
    assert.match(collectionFormError({ name: "x".repeat(61), description: "" }, existing, null) ?? "", /at most 60/);
    assert.match(collectionFormError({ name: "New", description: "y".repeat(201) }, existing, null) ?? "", /at most 200/);
    assert.equal(collectionFormError({ name: "New", description: "two\nlines" }, existing, null), "The description is one line.");
    assert.match(collectionFormError({ name: " seo ", description: "" }, existing, null) ?? "", /already a collection named/);
    assert.equal(collectionFormError({ name: "SEO", description: "renamed nothing" }, existing, "kc_seo"), null, "its own name is fine");
    assert.equal(collectionFormError({ name: "Mobile apps", description: "" }, existing, null), null);
  });
});

describe("entry display", () => {

  it("offers only http(s) links as the original post", () => {
    assert.equal(entryPostUrl({ url: "https://x.com/a/status/1" }), "https://x.com/a/status/1");
    assert.equal(entryPostUrl({ url: "javascript:alert(1)" }), null);
    assert.equal(entryPostUrl({ url: null }), null);
  });
});

describe("the entry form", () => {
  it("patches only what changed", () => {
    const original = entry();
    const form = { ...entryFormOf(original), title: "Alternatives pages (v2)", handle: "@hridoyreh", collections: ["kc_seo"] };
    assert.deepEqual(entryFormPatch(original, form), { patch: { title: "Alternatives pages (v2)" } });
    assert.deepEqual(entryFormPatch(original, entryFormOf(original)), { patch: {} });
  });

  it("clears an emptied optional field and sorts the collections", () => {
    const original = entry();
    const result = entryFormPatch(original, { ...entryFormOf(original), url: " ", author: "", collections: ["kc_seo", "kc_ads", "kc_ads"] });
    assert.deepEqual(result, { patch: { author: null, url: null, collections: ["kc_ads", "kc_seo"] } });
  });

  it("refuses an empty text, a bad URL and a bad date", () => {
    const original = entry();
    assert.deepEqual(entryFormPatch(original, { ...entryFormOf(original), body: "  " }), { error: "The text cannot be empty." });
    assert.deepEqual(entryFormPatch(original, { ...entryFormOf(original), url: "x.com/a" }), {
      error: "The URL must start with http:// or https://."
    });
    const badDate = entryFormPatch(original, { ...entryFormOf(original), postedAt: "someday" });
    assert.ok("error" in badDate);
  });

  it("refuses before sending what the daemon refuses: an empty title, a date that is not ISO", () => {
    const original = entry();
    assert.deepEqual(entryFormPatch(original, { ...entryFormOf(original), title: "  " }), { error: "Give the entry a title." });
    for (const postedAt of ["Oct 11 2026", "2026/10/11", "11-10-2026"]) {
      assert.ok("error" in entryFormPatch(original, { ...entryFormOf(original), postedAt }), postedAt);
    }
    for (const postedAt of ["2026-10-12", "2026-10-12T09:30", "2026-10-12T09:30:00.000Z", "2026-10-12T09:30:00+02:00"]) {
      assert.deepEqual(entryFormPatch(original, { ...entryFormOf(original), postedAt }), { patch: { postedAt } }, postedAt);
    }
  });

  it("knows a relabel alone does not re-link", () => {
    assert.equal(patchNeedsLinking({ collections: ["kc_ads"] }), false);
    assert.equal(patchNeedsLinking({ collections: ["kc_ads"], body: "x" }), true);
    // The URL is metadata myKG never reads (the daemon files it as a relabel): no re-link.
    assert.equal(patchNeedsLinking({ url: "https://x.com/a/status/1" }), false);
    assert.equal(patchNeedsLinking({ url: null, collections: [] }), false);
    assert.equal(patchNeedsLinking({ url: null, title: "New title" }), true);
  });
});

const q = (overrides: Partial<KnowledgeQuery> = {}): KnowledgeQuery => ({ ...EMPTY_KNOWLEDGE_QUERY, ...overrides });

describe("the List view's requests", () => {
  it("map a query to a search: trimmed words, examples, narrowing, clean filters, sort and cursor", () => {
    assert.deepEqual(searchRequestOf(q({ text: "  seo pages " }), "all"), { limit: 25, query: "seo pages", sort: "relevance" });
    assert.deepEqual(
      searchRequestOf(
        q({
          text: "",
          similarTo: ["ke_a", "ke_a", "ke_b"],
          unlike: ["ke_b", "ke_c"],
          filters: { kinds: [" thread ", "Thread", ""], authors: [], savedBefore: " 2026-09-01 ", postedAfter: "" },
          sort: "recent"
        }),
        "kc_seo",
        { cursor: "next", limit: 10 }
      ),
      {
        limit: 10,
        similarTo: ["ke_a", "ke_b"],
        unlike: ["ke_c"],
        collections: ["kc_seo"],
        filters: { kinds: ["thread"], savedBefore: "2026-09-01" },
        sort: "recent",
        cursor: "next"
      }
    );
    // "Less like" alone means nothing: it is not sent.
    assert.equal(searchRequestOf(q({ text: "x", unlike: ["ke_c"] }), "all").unlike, undefined);
    assert.deepEqual(searchRequestOf(findSimilarQuery("ke_a"), "unfiled"), { limit: 25, similarTo: ["ke_a"], collections: ["unfiled"], sort: "relevance" });
  });

  it("key a search by everything but its page, so whitespace alone does not search again", () => {
    assert.equal(searchKeyOf(q({ text: "seo" }), "all"), searchKeyOf(q({ text: " seo  " }), "all"));
    assert.notEqual(searchKeyOf(q({ text: "seo" }), "all"), searchKeyOf(q({ text: "seo" }), "kc_seo"));
    assert.notEqual(searchKeyOf(q({ text: "seo" }), "all"), searchKeyOf(q({ text: "seo", sort: "newest" }), "all"));
  });

  it("map filters to the entries list's query string", () => {
    assert.deepEqual(entriesQueryOf("all", {}), { limit: 50 });
    assert.deepEqual(entriesQueryOf("unfiled", { kinds: ["thread", "post"], authors: ["@om", "Om Patel"], years: ["2026"], postedAfter: "2026-01-01" }, { cursor: "c2" }), {
      limit: 50,
      collection: "unfiled",
      cursor: "c2",
      kinds: "thread,post",
      authors: "@om,Om Patel",
      years: "2026",
      postedAfter: "2026-01-01"
    });
  });

  it("scope a filter's counts to the collection and the other filters, never its own", () => {
    const filters = { kinds: ["thread"], authors: ["om"], years: ["2026"] };
    assert.deepEqual(facetsRequestOf("kc_seo", filters, "kinds"), { collections: ["kc_seo"], filters: { authors: ["om"], years: ["2026"] } });
    assert.deepEqual(facetsRequestOf("all", { kinds: ["thread"] }, "kinds"), {});
  });
});

describe("the List view's filters", () => {
  it("toggle values as the daemon compares them, and cap a list", () => {
    let query = toggleFilterValue(q(), "authors", "@Om_Patel5");
    assert.deepEqual(query.filters, { authors: ["@Om_Patel5"] });
    assert.ok(filterHas(query.filters, "authors", "om_patel5"));
    query = toggleFilterValue(query, "authors", "om_patel5");
    assert.deepEqual(query.filters, {}, "the same author, written differently, is let go of");
    assert.equal(toggleFilterValue(query, "kinds", "  "), query);
    const full = q({ filters: { kinds: Array.from({ length: 20 }, (_, i) => `k${i}`) } });
    assert.equal(toggleFilterValue(full, "kinds", "another"), full);
    assert.deepEqual(clearFilterField(q({ filters: { kinds: ["a"], years: ["2026"] } }), "kinds").filters, { years: ["2026"] });
  });

  it("label the chips, clean the filters, and know when there is nothing to clear", () => {
    assert.equal(filterChipLabel("kinds", {}), "Kind");
    assert.equal(filterChipLabel("kinds", { kinds: ["thread"] }), "Kind: thread");
    assert.equal(filterChipLabel("years", { years: ["2025", "2026"] }), "Year: 2");
    assert.equal(cleanFilters({ kinds: [" "], postedBefore: " " }), undefined);
    assert.equal(queryIsEmpty(q({ filters: { kinds: [] } })), true);
    assert.equal(queryIsEmpty(q({ sort: "newest" })), false);
    assert.equal(queryIsEmpty(q({ text: "  " })), true);
  });

  it("offer every sort while searching, and only Newest otherwise", () => {
    assert.deepEqual(sortOptionsFor(q()), ["newest"]);
    assert.equal(shownSort(q({ sort: "recent" })), "newest");
    assert.deepEqual(sortOptionsFor(q({ text: "seo" })), ["relevance", "recent", "newest"]);
    assert.equal(shownSort(q({ text: "seo" })), "relevance");
    assert.equal(shownSort(q({ similarTo: ["ke_a"], sort: "newest" })), "newest");
  });

  it("remove examples; the last \"like\" takes the \"not like\" ones with it", () => {
    const query = withUnlike(q({ similarTo: ["ke_a", "ke_b"] }), "ke_c");
    assert.deepEqual(withoutExample(query, "ke_c"), { ...query, unlike: [] });
    assert.deepEqual(withoutExample(query, "ke_a"), { ...query, similarTo: ["ke_b"] });
    assert.deepEqual(withoutExample(withoutExample(query, "ke_a"), "ke_b"), { ...query, similarTo: [], unlike: [] });
    assert.equal(withoutExample(query, "ke_z"), query);
  });
});

describe("the List view's results", () => {
  it("split text around the matched terms, longest first, case-insensitively", () => {
    assert.deepEqual(highlightParts("Competitor pages: one page per Competitor", ["page", "pages", "competitor"]), [
      { text: "Competitor", match: true },
      { text: " ", match: false },
      { text: "pages", match: true },
      { text: ": one ", match: false },
      { text: "page", match: true },
      { text: " per ", match: false },
      { text: "Competitor", match: true }
    ]);
    assert.deepEqual(highlightParts("Precios (SaaS) — más", ["(saas)", "más"]), [
      { text: "Precios ", match: false },
      { text: "(SaaS)", match: true },
      { text: " — ", match: false },
      { text: "más", match: true }
    ]);
    assert.deepEqual(highlightParts("a b c", ["a", "b"]), [{ text: "a b c", match: false }], "single letters are not highlighted");
    assert.deepEqual(highlightParts("seoseo", ["seo"]), [{ text: "seoseo", match: true }], "adjacent matches join");
    assert.deepEqual(highlightParts("", ["seo"]), []);
    assert.deepEqual(highlightParts("plain", []), [{ text: "plain", match: false }]);
  });

  it("name the signals, the passage and the count", () => {
    assert.deepEqual(
      viaBadges({ via: ["keyword", "meaning", "similar", "concept"], concepts: [{ id: "c1", name: "Pricing", type: "Topic" }] }).map((b) => b.label),
      ["Keyword", "Meaning", "Similar", "Concept Pricing"]
    );
    assert.deepEqual(viaBadges({ via: ["concept"], concepts: [] }).map((b) => b.label), ["Concept"]);
    assert.equal(passageText({ passage: { start: 0, end: 10, chunk: 2, chunks: 12 } }), "passage 3 of 12");
    assert.equal(passageText({ passage: { start: 0, end: 10, chunk: 0, chunks: 1 } }), null, "a short entry has one passage");
    assert.equal(passageText({ passage: null }), null);
    assert.equal(resultsCountText(31, 25), "31 results");
    assert.equal(resultsCountText(1, 1), "1 result");
    assert.equal(resultsCountText(200, 25), "Top 200 results");
    assert.equal(resultsCountText(null, 8), "8 results", "an older daemon: the hits shown");
  });

  it("page: append without repeats; total and cursor from the newest page", () => {
    const a = { kind: "entry" as const, score: 1, entry: summary({ id: "ke_a" }) };
    const b = { kind: "entry" as const, score: 0.9, entry: summary({ id: "ke_b" }) };
    const c = { kind: "concept" as const, score: 0.8, concept: { id: "ke_a", name: "A", type: "T", description: null }, entryIds: [] };
    const first = appendPage(null, searchPageOf({ hits: [a, c], searched: [], total: 3, nextCursor: "p2" }), searchHitKey);
    assert.deepEqual(first, { items: [a, c], total: 3, nextCursor: "p2" });
    const second = appendPage(first, searchPageOf({ hits: [a, b], searched: [], total: 3, nextCursor: null }), searchHitKey);
    assert.deepEqual(second.items.map(searchHitKey), ["entry:ke_a", "concept:ke_a", "entry:ke_b"]);
    assert.equal(second.nextCursor, null);
    // An older daemon: no total, no cursor — one page.
    assert.deepEqual(appendPage(null, searchPageOf({ hits: [b], searched: [] }), searchHitKey), { items: [b], total: null, nextCursor: null });
  });
});

describe("Rediscover", () => {
  const now = Date.parse("2026-10-27T15:00:00Z");

  it("seeds with up to five entries saved this week, most recent first", () => {
    const entries = [
      { id: "old", savedAt: "2026-10-01T10:00:00Z" },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `ke_${i}`, savedAt: `2026-10-2${i}T10:00:00Z` })),
      { id: "bad", savedAt: "yesterday" }
    ];
    assert.deepEqual(rediscoverSeeds(entries, now), ["ke_5", "ke_4", "ke_3", "ke_2", "ke_1"]);
    assert.deepEqual(rediscoverSeeds([{ id: "old", savedAt: "2026-10-01T10:00:00Z" }], now), []);
  });

  it("asks for entries like the seeds saved over 30 days ago, in the collection", () => {
    assert.equal(rediscoverRequestOf([], "all", now), null);
    assert.deepEqual(rediscoverRequestOf(["ke_5", "ke_4"], "kc_seo", now), {
      similarTo: ["ke_5", "ke_4"],
      filters: { savedBefore: "2026-09-26" },
      sort: "relevance",
      limit: 5,
      collections: ["kc_seo"]
    });
  });

  it("shows entry hits only, never a seed; hides when empty or from an older daemon", () => {
    const hit = (id: string) => ({ kind: "entry" as const, score: 1, entry: summary({ id }) });
    const concept = { kind: "concept" as const, score: 1, concept: { id: "c", name: "C", type: "T", description: null }, entryIds: [] };
    assert.deepEqual(rediscoverEntries({ hits: [hit("ke_5"), concept, hit("ke_x")], searched: [], total: 2 }, ["ke_5"])?.map((e) => e.id), ["ke_x"]);
    assert.equal(rediscoverEntries({ hits: [], searched: [], total: 0 }, ["ke_5"]), null);
    assert.equal(rediscoverEntries({ hits: [hit("ke_x")], searched: [] }, ["ke_5"]), null, "no total: an older daemon");
  });
});
