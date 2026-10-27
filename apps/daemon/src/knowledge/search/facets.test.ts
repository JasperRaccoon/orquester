import assert from "node:assert/strict";
import { test } from "node:test";

import { KNOWLEDGE_FACET_MAX_VALUES, type KnowledgeEntryMeta } from "@orquester/api";
import { computeKnowledgeFacets } from "./facets.ts";
import { FakeStore } from "./test-fakes.ts";
import { entryInScope, knowledgeScope } from "./visibility.ts";

function fixture() {
  const store = new FakeStore();
  store.collection("kc_seo", "SEO");
  store.collection("kc_ads", "Ads");
  store.collection("kc_secret", "Secret");
  const put = (id: string, collections: string[], extra: Partial<KnowledgeEntryMeta>) => store.put(id, `body of ${id}`, collections, extra, true);
  put("ke_000000000001", ["kc_seo"], { kind: "Thread", author: "Om Patel", handle: "om_patel5", postedAt: "2025-03-01" });
  put("ke_000000000002", ["kc_seo", "kc_ads"], { kind: "thread ", author: "Om  Patel", handle: "@Om_Patel5", savedAt: "2026-01-02T00:00:00.000Z" });
  put("ke_000000000003", ["kc_ads"], { kind: "article", author: "Jane Doe", savedAt: "2026-02-02T00:00:00.000Z" });
  put("ke_000000000004", [], { kind: "note", handle: "anon", savedAt: "2024-05-05T00:00:00.000Z" });
  put("ke_000000000005", ["kc_secret"], { kind: "secret-kind", author: "Hidden Author", savedAt: "2023-05-05T00:00:00.000Z" });
  put("ke_000000000006", ["kc_gone"], { kind: "thread", savedAt: "2026-03-03T00:00:00.000Z" });
  return store;
}

const facetsFor = (store: FakeStore, scope: ReturnType<typeof knowledgeScope>) =>
  computeKnowledgeFacets(
    store.listMeta().filter((m) => entryInScope(m, scope)),
    scope,
    store.listCollections()
  );

test("kinds group case-insensitively; authors by handle with the label rules; years newest first", () => {
  const store = fixture();
  const scope = knowledgeScope({ kind: "all" }, store.collections.map((c) => c.id));
  const facets = facetsFor(store, scope);
  assert.deepEqual(facets.kinds, [
    { value: "thread", label: "thread", count: 3 },
    { value: "article", label: "article", count: 1 },
    { value: "note", label: "note", count: 1 },
    { value: "secret-kind", label: "secret-kind", count: 1 }
  ]);
  assert.deepEqual(facets.authors, [
    { value: "om_patel5", label: "Om Patel (@om_patel5)", count: 2 },
    { value: "anon", label: "@anon", count: 1 },
    { value: "Hidden Author", label: "Hidden Author", count: 1 },
    { value: "Jane Doe", label: "Jane Doe", count: 1 }
  ]);
  assert.deepEqual(facets.years.map((y) => [y.value, y.count]), [
    ["2026", 3],
    ["2025", 1],
    ["2024", 1],
    ["2023", 1]
  ]);
  // Unfiled: no collection, or only collections that no longer exist.
  assert.deepEqual(facets.collections, [
    { value: "kc_ads", label: "Ads", count: 2 },
    { value: "kc_seo", label: "SEO", count: 2 },
    { value: "unfiled", label: "Unfiled", count: 2 },
    { value: "kc_secret", label: "Secret", count: 1 }
  ]);
});

test("a profile caller counts only what it sees, never Unfiled or hidden collections", () => {
  const store = fixture();
  const scope = knowledgeScope({ kind: "collections", ids: ["kc_seo"] }, store.collections.map((c) => c.id));
  const facets = facetsFor(store, scope);
  assert.deepEqual(facets.collections, [{ value: "kc_seo", label: "SEO", count: 2 }], "kc_ads is not named even on a shared entry");
  assert.deepEqual(facets.authors, [{ value: "om_patel5", label: "Om Patel (@om_patel5)", count: 2 }]);
  assert.deepEqual(facets.kinds, [{ value: "Thread", label: "Thread", count: 2 }], "a tie names the kind by its first spelling");
  assert.ok(!JSON.stringify(facets).includes("Hidden") && !JSON.stringify(facets).includes("secret"));
});

test("the request's narrowing keeps entries but not labels: an entry's other visible collections are counted", () => {
  const store = fixture();
  const scope = knowledgeScope({ kind: "all" }, store.collections.map((c) => c.id), ["kc_ads"]);
  const facets = facetsFor(store, scope);
  assert.deepEqual(facets.collections, [
    { value: "kc_ads", label: "Ads", count: 2 },
    { value: "kc_seo", label: "SEO", count: 1 }
  ]);
});

test("ties order by label; each facet keeps at most KNOWLEDGE_FACET_MAX_VALUES values (years: the newest)", () => {
  const store = new FakeStore();
  for (let i = 0; i < KNOWLEDGE_FACET_MAX_VALUES + 5; i += 1) {
    const n = String(i).padStart(2, "0");
    store.put(`ke_0000000000${n}`, "x", [], { kind: `kind ${n}`, author: `Author ${n}`, postedAt: `${1990 + i}-01-01` }, true);
  }
  store.put("ke_00000000zzzz", "x", [], { kind: "kind 34", author: "Author 34", postedAt: "1990-06-01" }, true);
  const scope = knowledgeScope({ kind: "all" }, []);
  const facets = facetsFor(store, scope);
  for (const list of [facets.kinds, facets.authors, facets.years]) assert.equal(list.length, KNOWLEDGE_FACET_MAX_VALUES);
  assert.deepEqual(facets.kinds.slice(0, 3).map((k) => [k.value, k.count]), [
    ["kind 34", 2],
    ["kind 00", 1],
    ["kind 01", 1]
  ]);
  assert.equal(facets.years[0]!.value, String(1990 + KNOWLEDGE_FACET_MAX_VALUES + 4));
  assert.equal(facets.years.at(-1)!.value, "1995");
  assert.deepEqual(facets.collections, [{ value: "unfiled", label: "Unfiled", count: KNOWLEDGE_FACET_MAX_VALUES + 6 }]);
});

test("no entries: every facet is empty", () => {
  const facets = computeKnowledgeFacets([], knowledgeScope({ kind: "all" }, []), []);
  assert.deepEqual(facets, { kinds: [], authors: [], collections: [], years: [] });
});
