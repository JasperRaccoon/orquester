// Search, facets and the entries list on the wire (retrieval spec): the new optional fields, an
// older daemon's answers without them, malformed values, and what the client sends.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseKnowledgeFacetsResponse, parseKnowledgeSearchResponse } from "./validate.ts";
import { ApiClient } from "../api-client.ts";
import type { TransportRequest, Transporter } from "../transporter.ts";

const entry = (id = "ke_aaaaaaaaaaaa") => ({
  id,
  title: "Alternatives pages",
  kind: "post",
  author: "Hridoy",
  handle: "hridoyreh",
  url: null,
  postedAt: "2026-10-11",
  savedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  savedFrom: { by: "agent" },
  collections: ["kc_seo"],
  contentHash: "abc",
  linkState: "linked",
  snippet: "Make a page for every competitor",
  linkCount: 2,
  citation: "[c](orquester-knowledge:entry/ke_aaaaaaaaaaaa)"
});

const MATCH = {
  band: "strong",
  via: ["concept", "meaning", "similar", "keyword"],
  terms: ["competitor", "pages", ""],
  passage: { start: 120, end: 480, chunk: 2, chunks: 12 },
  concepts: [{ id: "tactic-alt", name: "Alternatives pages", type: "Tactic" }, { bad: true }]
};

describe("search answers", () => {
  it("read every new field: match, totals, cursor, facets, concept hits' entries", () => {
    const parsed = parseKnowledgeSearchResponse({
      hits: [
        { kind: "entry", score: 0.92, entry: entry(), match: MATCH },
        {
          kind: "concept",
          score: 0.5,
          concept: { id: "tactic-alt", name: "Alternatives pages", type: "Tactic", description: null },
          entryIds: ["ke_aaaaaaaaaaaa"],
          entries: [{ id: "ke_aaaaaaaaaaaa", title: "Alternatives pages" }, { title: "no id" }]
        }
      ],
      searched: ["kc_seo"],
      total: 31,
      nextCursor: "eyJ2IjoxfQ",
      facets: { kinds: [{ value: "post", label: "post", count: 3 }], authors: [], collections: [], years: [{ value: "2026", label: "2026", count: 3 }] }
    });
    assert.ok(parsed);
    assert.equal(parsed.total, 31);
    assert.equal(parsed.nextCursor, "eyJ2IjoxfQ");
    assert.deepEqual(parsed.facets?.years, [{ value: "2026", label: "2026", count: 3 }]);
    const [hit, concept] = parsed.hits;
    assert.ok(hit?.kind === "entry");
    assert.deepEqual(hit.match, {
      band: "strong",
      via: ["keyword", "meaning", "similar", "concept"],
      terms: ["competitor", "pages"],
      passage: { start: 120, end: 480, chunk: 2, chunks: 12 },
      concepts: [{ id: "tactic-alt", name: "Alternatives pages", type: "Tactic" }]
    });
    assert.ok(concept?.kind === "concept");
    assert.deepEqual(concept.entries, [{ id: "ke_aaaaaaaaaaaa", title: "Alternatives pages" }]);
  });

  it("leave the new fields absent from an older daemon's answer", () => {
    const parsed = parseKnowledgeSearchResponse({
      hits: [
        { kind: "entry", score: 0.9, entry: entry() },
        { kind: "concept", score: 0.4, concept: { id: "c", name: "C", type: "Tool" }, entryIds: [] }
      ],
      searched: []
    });
    assert.ok(parsed);
    assert.equal(parsed.total, undefined);
    assert.equal(parsed.nextCursor, undefined);
    assert.equal(parsed.facets, undefined);
    const [hit, concept] = parsed.hits;
    assert.ok(hit?.kind === "entry");
    assert.equal(hit.match, undefined);
    assert.ok(concept?.kind === "concept");
    assert.equal(concept.entries, undefined);
  });

  it("read the last page's null cursor, and drop malformed totals, cursors and facets", () => {
    assert.equal(parseKnowledgeSearchResponse({ hits: [], searched: [], total: 0, nextCursor: null })?.nextCursor, null);
    const parsed = parseKnowledgeSearchResponse({ hits: [], searched: [], total: "31", nextCursor: 7, facets: "all" });
    assert.ok(parsed);
    assert.equal(parsed.total, undefined);
    assert.equal(parsed.nextCursor, undefined);
    assert.equal(parsed.facets, undefined);
    assert.equal(parseKnowledgeSearchResponse({ hits: [], searched: [], total: -4.5 })?.total, 0);
    assert.equal(parseKnowledgeSearchResponse({ hits: {}, searched: [] }), null);
  });

  it("drop a match it cannot read, keeping the hit", () => {
    for (const match of [
      { ...MATCH, band: "excellent" },
      { ...MATCH, via: [] },
      { ...MATCH, via: ["telepathy"] },
      "strong",
      null
    ]) {
      const parsed = parseKnowledgeSearchResponse({ hits: [{ kind: "entry", score: 1, entry: entry(), match }], searched: [] });
      assert.ok(parsed?.hits[0]?.kind === "entry");
      assert.equal(parsed.hits[0].match, undefined, JSON.stringify(match));
    }
  });

  it("read a bad passage as none and keep only readable terms and known signals", () => {
    for (const passage of [
      { start: 10, end: 5, chunk: 0, chunks: 2 },
      { start: 0, end: 5, chunk: 2, chunks: 2 },
      { start: 0, end: 5, chunk: 0, chunks: 0 },
      { start: -1, end: 5, chunk: 0, chunks: 2 },
      { start: 0.5, end: 5, chunk: 0, chunks: 2 },
      { start: 0, end: 5 },
      "chunk 1"
    ]) {
      const parsed = parseKnowledgeSearchResponse({ hits: [{ kind: "entry", score: 1, entry: entry(), match: { ...MATCH, passage } }], searched: [] });
      const hit = parsed?.hits[0];
      assert.ok(hit?.kind === "entry");
      assert.equal(hit.match?.passage, null, JSON.stringify(passage));
    }
    const parsed = parseKnowledgeSearchResponse({ hits: [{ kind: "entry", score: 1, entry: entry(), match: { band: "weak", via: ["concept", "future-signal", "keyword", "keyword"], terms: [3, "seo", "seo"], passage: null } }], searched: [] });
    const hit = parsed?.hits[0];
    assert.ok(hit?.kind === "entry");
    assert.deepEqual(hit.match, { band: "weak", via: ["keyword", "concept"], terms: ["seo"], passage: null, concepts: [] });
  });
});

describe("facets", () => {
  it("read counts, defaulting a missing list, a label and a bad count, and dropping unreadable or repeated values", () => {
    const facets = parseKnowledgeFacetsResponse({ facets: {
      kinds: [{ value: "thread", count: 4 }, { value: "post", label: "post", count: -1 }, { value: "", count: 2 }, { label: "x" }, { value: "thread", count: 9 }],
      authors: "many",
      years: [{ value: "2026", label: "2026", count: 2.7 }]
    } })?.facets;
    assert.deepEqual(facets, {
      kinds: [
        { value: "thread", label: "thread", count: 4 },
        { value: "post", label: "post", count: 0 }
      ],
      authors: [],
      collections: [],
      years: [{ value: "2026", label: "2026", count: 2 }]
    });
    assert.equal(parseKnowledgeFacetsResponse({ facets: null }), null);
  });

  it("need the facets in POST /facets' answer; a missing total is the kinds' sum", () => {
    assert.equal(parseKnowledgeFacetsResponse({ total: 3 }), null);
    assert.equal(parseKnowledgeFacetsResponse([]), null);
    assert.equal(parseKnowledgeFacetsResponse({ facets: { kinds: [{ value: "post", count: 2 }, { value: "note", count: 1 }] } })?.total, 3);
    assert.equal(parseKnowledgeFacetsResponse({ facets: {}, total: 12 })?.total, 12);
  });
});

describe("the client", () => {
  const client = (answer: () => unknown) => {
    const sent: TransportRequest[] = [];
    const transporter = {
      kind: "fake",
      request: async (req: TransportRequest) => (sent.push(req), { status: 200, ok: true, data: answer() }),
      openStream: () => ({ close: () => undefined })
    } as unknown as Transporter;
    return { api: new ApiClient({ id: "c1" } as never, transporter), sent };
  };

  it("sends every search field and validates the answer", async () => {
    const { api, sent } = client(() => ({ hits: [], searched: [], total: 0, nextCursor: null }));
    const req = {
      query: "seo",
      similarTo: ["ke_aaaaaaaaaaaa"],
      unlike: ["ke_bbbbbbbbbbbb"],
      filters: { kinds: ["thread"], years: ["2026"], savedBefore: "2026-09-26" },
      sort: "recent" as const,
      diverse: false,
      cursor: "abc",
      facets: true,
      limit: 25
    };
    assert.deepEqual(await api.searchKnowledge(req), { hits: [], searched: [], total: 0, nextCursor: null });
    assert.equal(sent[0]?.method, "POST");
    assert.equal(sent[0]?.path, "/api/knowledge/search");
    assert.deepEqual(sent[0]?.body, req);
  });

  it("posts facets and refuses an answer it cannot read", async () => {
    let answer: unknown = { facets: { kinds: [{ value: "post", label: "post", count: 2 }] }, total: 2 };
    const { api, sent } = client(() => answer);
    const facets = await api.getKnowledgeFacets({ collections: ["kc_seo"], filters: { authors: ["@om"] } });
    assert.deepEqual(facets.facets.kinds, [{ value: "post", label: "post", count: 2 }]);
    assert.equal(sent[0]?.method, "POST");
    assert.equal(sent[0]?.path, "/api/knowledge/facets");
    assert.deepEqual(sent[0]?.body, { collections: ["kc_seo"], filters: { authors: ["@om"] } });
    answer = "<html>";
    await assert.rejects(api.getKnowledgeFacets({}));
  });

  it("lists entries with the filter params on the query string", async () => {
    const { api, sent } = client(() => ({ entries: [entry()], nextCursor: null }));
    await api.listKnowledgeEntries({ collection: "kc_seo", limit: 50, kinds: "thread,post", authors: "om_patel5", years: "2026", savedBefore: "2026-09-01" });
    assert.equal(sent[0]?.method, "GET");
    assert.equal(sent[0]?.path, "/api/knowledge/entries");
    const query = Object.fromEntries(Object.entries(sent[0]?.query ?? {}).filter(([, value]) => value !== undefined));
    assert.deepEqual(query, {
      collection: "kc_seo",
      limit: 50,
      kinds: "thread,post",
      authors: "om_patel5",
      years: "2026",
      savedBefore: "2026-09-01"
    });
  });
});
