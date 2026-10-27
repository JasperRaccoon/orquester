import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KnowledgeSearchHit } from "@orquester/api";

import { summary } from "../../lib/knowledge/fixtures.test-helpers.ts";
import {
  bandLabel,
  graphSearchRequest,
  highlightParts,
  readEntryMatch,
  SEARCH_NAV_EMPTY,
  searchIsNarrowed,
  searchNavReducer,
  showAllLabel,
  viaBadges,
  type SearchNavAction,
  type SearchNavState
} from "./graph-search.logic.ts";
import { EMPTY_KNOWLEDGE_QUERY } from "./query-state.ts";

describe("the dropdown's keyboard highlight", () => {
  const run = (actions: SearchNavAction[], from: SearchNavState = SEARCH_NAV_EMPTY) => actions.reduce(searchNavReducer, from);

  it("highlights the first of new results (Enter opens it), and none without results", () => {
    assert.deepEqual(run([{ type: "results", count: 3 }]), { count: 3, index: 0 });
    assert.deepEqual(run([{ type: "results", count: 0 }]), { count: 0, index: -1 });
    assert.deepEqual(run([{ type: "results", count: 3 }, { type: "down" }, { type: "results", count: 2 }]), { count: 2, index: 0 }, "a new answer starts over");
  });

  it("moves down and up, wrapping round the ends", () => {
    const three = run([{ type: "results", count: 3 }]);
    assert.equal(run([{ type: "down" }], three).index, 1);
    assert.equal(run([{ type: "down" }, { type: "down" }], three).index, 2);
    assert.equal(run([{ type: "down" }, { type: "down" }, { type: "down" }], three).index, 0, "past the last: the first");
    assert.equal(run([{ type: "up" }], three).index, 2, "above the first: the last");
    assert.equal(run([{ type: "last" }, { type: "first" }], three).index, 0);
    assert.equal(run([{ type: "last" }], three).index, 2);
  });

  it("follows the pointer within the list, and ignores keys with nothing to move", () => {
    const three = run([{ type: "results", count: 3 }]);
    assert.equal(run([{ type: "point", index: 2 }], three).index, 2);
    assert.equal(run([{ type: "point", index: 7 }], three), three, "outside the list: unchanged");
    assert.equal(run([{ type: "point", index: 0 }], three), three, "the same option: the same state");
    assert.equal(run([{ type: "down" }]), SEARCH_NAV_EMPTY);
    assert.equal(run([{ type: "up" }]), SEARCH_NAV_EMPTY);
  });
});

describe("the dropdown's request", () => {
  it("searches the words within the collection chips; nothing without words", () => {
    assert.equal(graphSearchRequest({ ...EMPTY_KNOWLEDGE_QUERY, text: "  " }, [], 12), null);
    assert.equal(graphSearchRequest({ ...EMPTY_KNOWLEDGE_QUERY, similarTo: ["ke_1"] }, [], 12), null, "examples alone are the List view's");
    assert.deepEqual(graphSearchRequest({ ...EMPTY_KNOWLEDGE_QUERY, text: " paywalls " }, [], 12), { query: "paywalls", limit: 12 });
    assert.deepEqual(graphSearchRequest({ ...EMPTY_KNOWLEDGE_QUERY, text: "paywalls" }, ["kc_seo"], 12), { query: "paywalls", limit: 12, collections: ["kc_seo"] });
  });

  it("carries the shared query's filters, examples and sort, so Show all lists the same results", () => {
    const query = { text: "ads", similarTo: ["ke_1"], unlike: ["ke_2"], filters: { kinds: ["thread"], years: [] }, sort: "recent" as const };
    assert.deepEqual(graphSearchRequest(query, [], 12), {
      query: "ads",
      limit: 12,
      filters: { kinds: ["thread"], years: [] },
      similarTo: ["ke_1"],
      unlike: ["ke_2"],
      sort: "recent"
    });
    assert.equal(searchIsNarrowed(query), true);
    assert.equal(searchIsNarrowed({ ...EMPTY_KNOWLEDGE_QUERY, text: "ads", filters: { kinds: [] } }), false);
    assert.equal(graphSearchRequest({ ...EMPTY_KNOWLEDGE_QUERY, text: "ads", unlike: ["ke_2"] }, [], 12)!.unlike, undefined, "unlike only goes with examples");
  });
});

describe("a hit's match explanation", () => {
  const hit = (match: unknown): KnowledgeSearchHit => ({ kind: "entry", score: 1, entry: summary(), ...(match === undefined ? {} : { match }) }) as KnowledgeSearchHit;

  it("reads a match, its signals in the fixed order", () => {
    const match = readEntryMatch(
      hit({
        band: "strong",
        via: ["concept", "keyword", "meaning", "telepathy"],
        terms: ["paywall", 3, ""],
        passage: { start: 10, end: 90, chunk: 1, chunks: 4 },
        concepts: [{ id: "c1", name: "Paywalls", type: "Topic" }, { name: "no id" }]
      })
    );
    assert.deepEqual(match, {
      band: "strong",
      via: ["keyword", "meaning", "concept"],
      terms: ["paywall"],
      passage: { start: 10, end: 90, chunk: 1, chunks: 4 },
      concepts: [{ id: "c1", name: "Paywalls", type: "Topic" }]
    });
  });

  it("has none from an older daemon, a malformed one, or a concept hit", () => {
    assert.equal(readEntryMatch(hit(undefined)), null);
    assert.equal(readEntryMatch(hit({ band: "excellent", via: ["keyword"] })), null);
    assert.equal(readEntryMatch(hit("strong")), null);
    assert.equal(readEntryMatch({ kind: "concept", score: 1, concept: { id: "c", name: "C", type: "T", description: null }, entryIds: [] }), null);
    assert.deepEqual(readEntryMatch(hit({ band: "weak", via: "keyword", passage: { start: "0" } })), { band: "weak", via: [], terms: [], passage: null, concepts: [] });
  });

  it("names the band and the signals, one badge per concept that led to it", () => {
    assert.equal(bandLabel("good"), "Good");
    assert.deepEqual(viaBadges({ via: ["keyword", "meaning", "similar"], concepts: [] }), ["Keyword", "Meaning", "Similar"]);
    assert.deepEqual(
      viaBadges({
        via: ["concept"],
        concepts: [
          { id: "a", name: "Paywalls", type: "T" },
          { id: "b", name: "Pricing", type: "T" }
        ]
      }),
      ["Concept Paywalls", "Concept Pricing"]
    );
    assert.deepEqual(viaBadges({ via: ["concept"], concepts: [] }), ["Concept"]);
  });
});

describe("highlighted terms", () => {
  it("cuts the text at every case-insensitive occurrence, as plain text parts", () => {
    assert.deepEqual(highlightParts("Paywall tests: the PAYWALL wins", ["paywall"]), [
      { text: "Paywall", hit: true },
      { text: " tests: the ", hit: false },
      { text: "PAYWALL", hit: true },
      { text: " wins", hit: false }
    ]);
  });

  it("prefers the longest term where terms overlap, and treats terms as text, not patterns", () => {
    assert.deepEqual(highlightParts("paywalls", ["pay", "paywalls"]), [{ text: "paywalls", hit: true }]);
    assert.deepEqual(highlightParts("a (b) c.*", ["(b)", ".*"]), [
      { text: "a ", hit: false },
      { text: "(b)", hit: true },
      { text: " c", hit: false },
      { text: ".*", hit: true }
    ]);
  });

  it("leaves text without terms whole, and markup as text", () => {
    assert.deepEqual(highlightParts("<b>bold</b>", []), [{ text: "<b>bold</b>", hit: false }]);
    assert.deepEqual(highlightParts("<img src=x onerror=alert(1)>", ["img"]), [
      { text: "<", hit: false },
      { text: "img", hit: true },
      { text: " src=x onerror=alert(1)>", hit: false }
    ]);
    assert.deepEqual(highlightParts("", ["a"]), []);
    assert.deepEqual(highlightParts("Ünïcode ÜNÏ", ["ünï"]), [
      { text: "Ünï", hit: true },
      { text: "code ", hit: false },
      { text: "ÜNÏ", hit: true }
    ]);
  });
});

describe("the Show all line", () => {
  it("counts the response's total when the daemon sends one", () => {
    assert.equal(showAllLabel({ hits: [], total: 31 }), "Show all 31 results");
    assert.equal(showAllLabel({ hits: [], total: 1 }), "Show all 1 result");
    assert.equal(showAllLabel({ hits: [], total: 1200 }), "Show all 1,200 results");
    assert.equal(showAllLabel({ hits: [] }), "Show all results");
  });
});
