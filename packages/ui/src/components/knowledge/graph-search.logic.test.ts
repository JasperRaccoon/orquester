import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { graphSearchRequest, highlightParts } from "./graph-search.logic.ts";
import { EMPTY_KNOWLEDGE_QUERY } from "./query-state.ts";

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
    assert.equal(graphSearchRequest({ ...EMPTY_KNOWLEDGE_QUERY, text: "ads", unlike: ["ke_2"] }, [], 12)!.unlike, undefined, "unlike only goes with examples");
  });
});

describe("highlighted terms", () => {
  it("prefers the longest term where terms overlap, and treats terms as text, not patterns", () => {
    assert.deepEqual(highlightParts("Paywalls PAYWALLS", ["pay", "paywalls"]).filter((part) => part.hit).map((part) => part.text), ["Paywalls", "PAYWALLS"]);
    const literal = highlightParts("a (b) c.*", ["(b)", ".*"]);
    assert.deepEqual(literal.filter((part) => part.hit).map((part) => part.text), ["(b)", ".*"]);
    assert.equal(literal.map((part) => part.text).join(""), "a (b) c.*");
  });
});
