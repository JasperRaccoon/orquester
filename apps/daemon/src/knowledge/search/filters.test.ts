import assert from "node:assert/strict";
import { test } from "node:test";

import { KNOWLEDGE_FILTER_MAX_VALUES, encodeKnowledgeFilterList } from "@orquester/api";
import { KnowledgeError } from "../store/errors.ts";
import { NO_FILTER, entryMatchesFilter, entryYear, filterKey, isEmptyFilter, parseKnowledgeFilters, splitFilterList } from "./filters.ts";

const meta = (over: Partial<{ kind: string; author: string | null; handle: string | null; postedAt: string | null; savedAt: string }> = {}) => ({
  kind: "thread",
  author: "Om Patel",
  handle: "om_patel5",
  postedAt: "2026-10-11",
  savedAt: "2026-10-26T08:00:00.000Z",
  ...over
});

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError);
    assert.equal(error.code, "KNOWLEDGE_INVALID");
    return error.message;
  }
  assert.fail("expected a refusal");
};

test("no filters, empty lists and blank bounds are NO_FILTER", () => {
  assert.equal(parseKnowledgeFilters(undefined), NO_FILTER);
  assert.equal(parseKnowledgeFilters({}), NO_FILTER);
  assert.equal(parseKnowledgeFilters({ kinds: [], authors: ["  "], postedAfter: " " }), NO_FILTER);
  assert.ok(isEmptyFilter(NO_FILTER));
  assert.ok(entryMatchesFilter(meta(), NO_FILTER));
});

test("kinds compare case-insensitively and trimmed", () => {
  const filter = parseKnowledgeFilters({ kinds: [" Thread ", "ARTICLE"] });
  assert.ok(entryMatchesFilter(meta(), filter));
  assert.ok(entryMatchesFilter(meta({ kind: "article" }), filter));
  assert.ok(!entryMatchesFilter(meta({ kind: "post" }), filter));
  assert.ok(entryMatchesFilter(meta({ kind: "case  study" }), parseKnowledgeFilters({ kinds: ["Case Study"] })));
});

test("authors match the display name or the handle, with or without @", () => {
  for (const value of ["om patel", "OM  PATEL", "@om_patel5", "Om_Patel5"]) {
    assert.ok(entryMatchesFilter(meta(), parseKnowledgeFilters({ authors: [value] })), value);
  }
  assert.ok(!entryMatchesFilter(meta(), parseKnowledgeFilters({ authors: ["hridoyreh"] })));
  assert.ok(!entryMatchesFilter(meta({ author: null, handle: null }), parseKnowledgeFilters({ authors: ["om patel"] })));
});

test("years use postedAt, else savedAt", () => {
  assert.equal(entryYear(meta()), "2026");
  assert.equal(entryYear(meta({ postedAt: null, savedAt: "2025-01-02T00:00:00.000Z" })), "2025");
  const filter = parseKnowledgeFilters({ years: ["2025"] });
  assert.ok(!entryMatchesFilter(meta(), filter));
  assert.ok(entryMatchesFilter(meta({ postedAt: "2025-04-22" }), filter));
  assert.ok(entryMatchesFilter(meta({ postedAt: null, savedAt: "2025-12-31T23:00:00.000Z" }), filter));
  assert.match(refusal(() => parseKnowledgeFilters({ years: ["26"] })), /not a valid year/);
});

test("date bounds are inclusive, compare dates on the day, and posted bounds drop undated entries", () => {
  const sameDay = parseKnowledgeFilters({ postedAfter: "2026-10-11", postedBefore: "2026-10-11" });
  assert.ok(entryMatchesFilter(meta(), sameDay));
  assert.ok(entryMatchesFilter(meta({ postedAt: "2026-10-11T23:59:00Z" }), sameDay), "a date-time on the bound's day passes a bare-date bound");
  assert.ok(!entryMatchesFilter(meta({ postedAt: "2026-10-12" }), sameDay));
  assert.ok(!entryMatchesFilter(meta({ postedAt: null }), parseKnowledgeFilters({ postedAfter: "2000-01-01" })));
  const saved = parseKnowledgeFilters({ savedAfter: "2026-10-26T09:00:00Z" });
  assert.ok(!entryMatchesFilter(meta(), saved), "full date-times compare exactly");
  assert.ok(entryMatchesFilter(meta({ savedAt: "2026-10-26T09:00:00.000Z" }), saved));
  assert.ok(entryMatchesFilter(meta({ postedAt: null }), parseKnowledgeFilters({ savedBefore: "2026-12-31" })), "saved bounds ignore postedAt");
});

test("invalid input is refused with a readable message", () => {
  assert.match(refusal(() => parseKnowledgeFilters({ postedAfter: "yesterday" })), /postedAfter is not an ISO date/);
  assert.match(refusal(() => parseKnowledgeFilters({ savedBefore: "2026-13-45" })), /savedBefore is not an ISO date/);
  assert.match(refusal(() => parseKnowledgeFilters({ kinds: Array.from({ length: KNOWLEDGE_FILTER_MAX_VALUES + 1 }, (_, i) => `k${i}`) })), /At most/);
  assert.match(refusal(() => parseKnowledgeFilters({ kinds: [3 as unknown as string] })), /must be strings/);
  assert.match(refusal(() => parseKnowledgeFilters({ authors: "om" as unknown as string[] })), /must be a list/);
});

test("comma lists and keys", () => {
  assert.deepEqual(splitFilterList(" thread, ,article "), ["thread", "article"]);
  assert.equal(splitFilterList(""), undefined);
  assert.equal(splitFilterList(undefined), undefined);
  // The JSON form, for values holding a comma; it round-trips the client's encoding.
  assert.deepEqual(splitFilterList(' ["Smith, John", " Om ", ""] '), ["Smith, John", "Om"]);
  for (const values of [["Smith, John", "om"], ["[weird"], ["thread", "article"], ['a "quote", and \\ a backslash']]) {
    assert.deepEqual(splitFilterList(encodeKnowledgeFilterList(values)), values);
  }
  assert.equal(splitFilterList("[]"), undefined);
  assert.match(refusal(() => splitFilterList("[Smith, John", "authors")), /^authors starting with "\[" must be a JSON array of strings/);
  assert.match(refusal(() => splitFilterList('["a", 3]', "kinds")), /^kinds starting with "\[" must be a JSON array of strings/);
  assert.match(refusal(() => splitFilterList(" [{}]")), /JSON array of strings/);
  const a = parseKnowledgeFilters({ kinds: ["thread", "article"], years: ["2026"] });
  const b = parseKnowledgeFilters({ kinds: ["Article", "thread"], years: ["2026"] });
  assert.equal(filterKey(a), filterKey(b), "order and case do not change the key");
  assert.notEqual(filterKey(a), filterKey(NO_FILTER));
});
