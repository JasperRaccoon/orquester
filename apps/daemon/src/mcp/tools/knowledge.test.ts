/**
 * The knowledge tools (Knowledge Graph plugin spec, "Agent tools", "Citations"), through the
 * executor: inputs mirror the contract's limits, every request names the calling session, results
 * are compact text with collections by name and each entry's citation, and the daemon's refusals
 * (plugin off, not a worker, an invalid worker answer) come back as clean tool errors. The retrieval
 * spec's additions (filters, examples, paging, match explanations, body windows, similar entries and
 * duplicates) render when the daemon sends them and are left out when an older one does not; so do
 * the phase 2 ones (insights, disagreements, novelty, clusters, merged and similar concepts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  KNOWLEDGE_ENTRY_MAX_BYTES,
  KNOWLEDGE_FILTER_MAX_VALUES,
  KNOWLEDGE_SAVE_MAX_ENTRIES,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SIMILAR_MAX_EXAMPLES,
  KNOWLEDGE_TITLE_MAX,
  KNOWLEDGE_WORKER_PART_MAX,
  KNOWLEDGE_WORKER_RESULT_MAX,
  knowledgeCitation,
  knowledgeRoutes,
  knowledgeWorkerTextSize,
  type KnowledgeCollectionsResponse,
  type KnowledgeConceptRef,
  type KnowledgeEntryDetail,
  type KnowledgeEntrySummary,
  type KnowledgeInsightsResponse,
  type KnowledgeMergeResponse,
  type KnowledgeSaveResponse,
  type KnowledgeSearchResponse,
  type KnowledgeSimilarEntry,
  type KnowledgeWorkerTask
} from "@orquester/api";

import type { ThreadCaller } from "../catalog/contract.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";
import { splitWorkerText } from "./knowledge.ts";
import { KNOWLEDGE_QUERY_MAX } from "../../knowledge/search/search.ts";
import { KNOWLEDGE_AUTHOR_MAX, KNOWLEDGE_HANDLE_MAX, KNOWLEDGE_KIND_MAX, KNOWLEDGE_URL_MAX } from "../../knowledge/store/validate.ts";

const caller = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
  kind: "thread", threadId: "chat-1", title: "Landing page", projectPath: "/w/acme/web", workspace: "acme", cwd: "/w/acme/web", agentId: "claude", callId: "call-1",
  runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
});

const run = (api: FakeDaemonApi, name: string, args: Record<string, unknown>, who: ThreadCaller = caller()): Promise<CallToolResult> =>
  executeToolCall({ approvals: null }, { name, arguments: args }, { caller: who, api, signal: new AbortController().signal });

const textOf = (r: CallToolResult): string => r.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const errorOf = (r: CallToolResult) => r.structuredContent as { code: string; message: string };

const COLLECTIONS: KnowledgeCollectionsResponse = {
  collections: [
    { id: "kc_seo0000000", name: "SEO", description: "Ranking in search engines.", color: "chart-1", createdAt: "t", updatedAt: "t", entryCount: 40, profiles: [] },
    { id: "kc_ads0000000", name: "Ads", description: "Paid acquisition.", color: "chart-2", createdAt: "t", updatedAt: "t", entryCount: 9, profiles: [{ id: "p1", name: "Growth" }] }
  ],
  unfiledCount: 3,
  totalEntries: 52
};

const meta = (over: Partial<KnowledgeEntrySummary> = {}): KnowledgeEntrySummary => {
  const base = {
    id: "ke_aaaaaaaaaaaa",
    title: "Alternatives pages",
    kind: "thread",
    author: "Om Patel",
    handle: "om_patel5",
    url: null,
    postedAt: "2026-10-11T08:00:00.000Z",
    savedAt: "t",
    updatedAt: "t",
    savedFrom: { by: "agent" as const, sessionId: "chat-0" },
    collections: ["kc_seo0000000", "kc_ads0000000"],
    contentHash: "h",
    linkState: "linked" as const,
    snippet: "Build a page per competitor:\n\n  \"[competitor] vs [you]\" ranks fast.",
    linkCount: 3,
    ...over
  };
  return { ...base, citation: knowledgeCitation(base) };
};

const withCollections = (api: FakeDaemonApi) => api.on("GET", knowledgeRoutes.collections, { status: 200, body: COLLECTIONS });

test("knowledge_search: posts the query with the calling session; compact hits with collection names, one-line snippets and citations", async () => {
  const entry = meta();
  const response: KnowledgeSearchResponse = {
    hits: [
      { kind: "entry", score: 0.9, entry },
      { kind: "concept", score: 0.5, concept: { id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic", description: "Pages comparing a product with a competitor." }, entryIds: ["ke_aaaaaaaaaaaa"] }
    ],
    searched: ["kc_seo0000000", "kc_ads0000000"]
  };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.search, { status: 200, body: response });
  const r = await run(api, "knowledge_search", { query: "  ranking in ChatGPT ", collections: ["SEO", "SEO"], limit: 5 });
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(api.calls.find((call) => call.path === knowledgeRoutes.search)!.body, { query: "ranking in ChatGPT", sessionId: "chat-1", collections: ["SEO"], limit: 5 });
  const out = textOf(r);
  for (const value of ["SEO", "Ads", "ke_aaaaaaaaaaaa", "thread", "Om Patel", "@om_patel5", "2026-10-11", "tactic-alternatives", "Alternatives pages", "Tactic", "Pages comparing a product with a competitor.", entry.citation]) {
    assert.ok(out.includes(value), value);
  }
  assert.ok(out.includes('Build a page per competitor: "[competitor] vs [you]" ranks fast.'), "the supplied snippet remains on one line");
  assert.ok(out.indexOf("ke_aaaaaaaaaaaa") < out.indexOf("tactic-alternatives"), "search rank order is preserved");
  assert.doesNotMatch(out, /"score"|savedFrom|contentHash/, "never the full objects");
  assert.doesNotMatch(out, /\bstrong\b|\bgood\b|\bweak\b|via |passage:|Showing|Next page/, "an older daemon supplies none of this metadata");
});

test("knowledge_search: nothing found says so; the limits are the contract's", async () => {
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [], searched: ["kc_seo0000000"] } });
  const empty = await run(api, "knowledge_search", { query: "x" });
  assert.equal(empty.isError, undefined);
  assert.ok(textOf(empty).includes("SEO"));
  assert.doesNotMatch(textOf(empty), /orquester-knowledge:entry\//);
  for (const args of [{ query: "" }, { query: "   " }, { query: "x", limit: KNOWLEDGE_SEARCH_MAX_LIMIT + 1 }, { query: "x", limit: 0 }, { query: "x".repeat(KNOWLEDGE_QUERY_MAX + 1) }, { query: "x", collections: ["c".repeat(65)] }, { query: "x", sessionId: "other" }]) {
    assert.equal(errorOf(await run(api, "knowledge_search", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 60));
  }
});

test("knowledge_get: the entry whole with its citation, concepts and related entries (an older daemon); the session in the query", async () => {
  const entry = meta({ url: "https://x.com/om_patel5/status/1", linkState: "pending" });
  const detail: KnowledgeEntryDetail = {
    entry: { ...entry, body: "Line one.\nLine two." },
    concepts: [{ id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic" }],
    related: [meta({ id: "ke_bbbbbbbbbbbb", title: "Competitor pages", handle: "hridoyreh", author: null, collections: ["kc_gone000000"] })],
    citation: entry.citation
  };
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: detail } });
  const r = await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" });
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(api.calls.find((call) => call.path.startsWith("/api/knowledge/items/"))!.query, { sessionId: "chat-1" });
  const out = textOf(r);
  for (const value of [entry.citation, "ke_aaaaaaaaaaaa", "thread", "Om Patel", "@om_patel5", "2026-10-11", "SEO", "Ads", "pending", "https://x.com/om_patel5/status/1", "Alternatives pages", "Tactic", "tactic-alternatives", "ke_bbbbbbbbbbbb", "@hridoyreh", "kc_gone000000", detail.related[0]!.citation, detail.entry.body]) {
    assert.ok(out.includes(value), value);
  }

});

test("knowledge_get: a long body is cut at 48 000 bytes on a character boundary, with the offset to read on from; from reads on", async () => {
  const entry = meta();
  const detail = (body: string): KnowledgeEntryDetail => ({ entry: { ...entry, body }, concepts: [{ id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic" }], related: [], similar: [], possibleDuplicates: [], citation: entry.citation });
  const api = withCollections(new FakeDaemonApi());
  const serve = (body: string) => api.on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: detail(body) } });

  // Two bytes a character: 24 000 characters fill the window.
  serve("é".repeat(48_000));
  const cut = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  assert.equal(cut.match(/é+/u)?.[0], "é".repeat(24_000));
  assert.match(cut, /\bfrom=24000\b/);
  assert.ok(Buffer.byteLength(cut, "utf8") < 60_000);
  const rest = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa", from: 24_000 }));
  assert.equal(rest.match(/é+/u)?.[0], "é".repeat(24_000));
  assert.ok(rest.includes(entry.id) && rest.includes(entry.citation), "reading on keeps the entry identity and citation");
  assert.ok(!rest.includes("tactic-alternatives"), "reading on does not repeat the neighbouring concepts");
  const past = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa", from: 100_000 }));
  assert.match(past, /\bfrom=100000\b/);
  assert.match(past, /\b48000\b/);
  assert.doesNotMatch(past, /é/u);

  // Four bytes and two UTF-16 units a character: a window never splits a surrogate pair, at either end.
  serve("😀".repeat(20_000));
  const emoji = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  assert.equal(emoji.match(/😀+/u)?.[0], "😀".repeat(12_000));
  assert.match(emoji, /\bfrom=24000\b/);
  const odd = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa", from: 24_001 }));
  assert.equal(odd.match(/😀+/u)?.[0], "😀".repeat(8_000), "a start inside a pair moves back to the pair");
  assert.doesNotMatch(odd, /\bfrom=\d+/);
  for (const out of [emoji, odd]) assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, "no lone surrogate");
});

test("knowledge_get: a concept — description, entries, links; a hidden or unknown id is the daemon's refusal", async () => {
  const api = withCollections(new FakeDaemonApi())
    .on("GET", knowledgeRoutes.item("tactic-alternatives"), {
      status: 200,
      body: {
        kind: "concept",
        concept: {
          concept: { id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic", confidence: 0.912, description: "Comparison pages.", aliases: ["vs pages"], attributes: { channel: { value: "SEO", confidence: 0.8 } } },
          collections: ["kc_seo0000000"],
          entries: [meta()],
          neighbors: [{ edge: { id: "e1", type: "uses", from: "tactic-alternatives", to: "tool-ahrefs", confidence: 0.7 }, concept: { id: "tool-ahrefs", name: "Ahrefs", type: "Tool" } }]
        }
      }
    })
    .on("GET", knowledgeRoutes.item("ke_hidden00000"), { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." } });
  const out = textOf(await run(api, "knowledge_get", { id: "tactic-alternatives" }));
  for (const value of ["tactic-alternatives", "Alternatives pages", "Tactic", "0.91", "SEO", "vs pages", "Comparison pages.", "channel", "ke_aaaaaaaaaaaa", "uses", "Ahrefs", "Tool", "tool-ahrefs"]) {
    assert.ok(out.includes(value), value);
  }
  const hidden = await run(api, "knowledge_get", { id: "ke_hidden00000" });
  assert.equal(hidden.isError, true);
  assert.deepEqual(errorOf(hidden), { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." });
});

test("knowledge_save: one call, many items, the session named, handles without @; no card, even while planning", async () => {
  const saved: KnowledgeSaveResponse = {
    results: [
      { entryId: "ke_aaaaaaaaaaaa", status: "saved", title: "Alternatives pages", collections: ["kc_seo0000000", "kc_new0000000"], citation: meta().citation },
      { entryId: "ke_bbbbbbbbbbbb", status: "duplicate", title: "Old", collections: ["kc_ads0000000"], citation: "[Old](orquester-knowledge:entry/ke_bbbbbbbbbbbb)" }
    ],
    createdCollections: [{ id: "kc_new0000000", name: "AI search", description: "Getting cited by AI engines.", color: "chart-3", createdAt: "t", updatedAt: "t" }],
    linking: "queued"
  };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.save, { status: 200, body: saved });
  const args = {
    entries: [
      { body: "Build a page per competitor.", title: "Alternatives pages", kind: "thread", author: "Om Patel", handle: "@om_patel5", postedAt: "2026-10-11", collections: ["SEO", "AI search", "SEO"] },
      { body: "Old text", collections: ["Ads"] }
    ],
    newCollections: [{ name: "AI search", description: "Getting cited by AI engines." }]
  };
  for (const who of [caller(), caller({ planning: true }), caller({ workflowOwned: true, runtimeMode: "full-access" })]) {
    const r = await run(api, "knowledge_save", args, who);
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.structuredContent, undefined, "a text result: no toolApproval reference, no card");
    const out = textOf(r);
    for (const value of ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb", "SEO", "AI search", "Ads", "queued", saved.results[0]!.citation, saved.results[1]!.citation]) {
      assert.ok(out.includes(value), value);
    }
    assert.match(out, /already saved[^\n]*ke_bbbbbbbbbbbb/, "the duplicate is distinguished from a new save");
  }
  assert.deepEqual(api.calls.find((call) => call.path === knowledgeRoutes.save)!.body, {
    entries: [
      { body: "Build a page per competitor.", collections: ["SEO", "AI search"], title: "Alternatives pages", kind: "thread", author: "Om Patel", handle: "om_patel5", postedAt: "2026-10-11" },
      { body: "Old text", collections: ["Ads"] }
    ],
    sessionId: "chat-1",
    newCollections: [{ name: "AI search", description: "Getting cited by AI engines." }]
  });
});

test("knowledge_save: inputs mirror the contract — at least one collection, body and count caps, strict items; the daemon's refusals pass through", async () => {
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.save, { status: 403, body: { code: "KNOWLEDGE_DISABLED", message: "The Knowledge Graph plugin is off." } });
  const item = { body: "text", collections: ["SEO"] };
  for (const args of [
    { entries: [] },
    { entries: [{ body: "text", collections: [] }] },
    { entries: [{ body: "text" }] },
    { entries: [{ body: "", collections: ["SEO"] }] },
    { entries: [{ body: "   ", collections: ["SEO"] }] },
    { entries: [{ ...item, body: "x".repeat(KNOWLEDGE_ENTRY_MAX_BYTES + 1) }] },
    { entries: Array.from({ length: KNOWLEDGE_SAVE_MAX_ENTRIES + 1 }, () => item) },
    { entries: [{ ...item, title: "t".repeat(201) }] },
    // The store's own limits: one field over them would refuse the whole batch at the daemon.
    { entries: [{ ...item, kind: "k".repeat(KNOWLEDGE_KIND_MAX + 1) }] },
    { entries: [{ ...item, author: "a".repeat(KNOWLEDGE_AUTHOR_MAX + 1) }] },
    { entries: [{ ...item, handle: "h".repeat(KNOWLEDGE_HANDLE_MAX + 1) }] },
    { entries: [{ ...item, url: `https://x.com/${"u".repeat(KNOWLEDGE_URL_MAX)}` }] },
    { entries: [{ ...item, tags: ["x"] }] },
    { entries: [item], newCollections: [{ name: "New" }] },
    { entries: [item], newCollections: [{ name: "n".repeat(61), description: "d" }] }
  ]) {
    assert.equal(errorOf(await run(api, "knowledge_save", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 80));
  }
  const off = await run(api, "knowledge_save", { entries: [item] });
  assert.equal(off.isError, true);
  assert.deepEqual(errorOf(off), { code: "KNOWLEDGE_DISABLED", message: "The Knowledge Graph plugin is off." });
});

test("knowledge_update: PATCHes only the fields passed (null clears, no @, collections once), names the session, answers what changed and the citation; no card", async () => {
  const entry = meta({ title: "Playbook v2", author: null, handle: null, linkState: "pending" });
  const detail: KnowledgeEntryDetail = { entry: { ...entry, body: "Organic only." }, concepts: [], related: [], citation: entry.citation };
  const api = withCollections(new FakeDaemonApi()).on("PATCH", knowledgeRoutes.entry("ke_aaaaaaaaaaaa"), { status: 200, body: detail });
  for (const who of [caller(), caller({ workflowOwned: true, runtimeMode: "full-access" })]) {
    const r = await run(api, "knowledge_update", { id: "ke_aaaaaaaaaaaa", title: " Playbook v2 ", body: "Organic only.", author: null, handle: "@@claude", url: null, collections: ["SEO", "Ads", "SEO"] }, who);
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.structuredContent, undefined, "a text result: no card");
    const out = textOf(r);
    for (const field of ["title", "body", "author", "handle", "url", "collections"]) assert.match(out, new RegExp(`\\b${field}\\b`, "i"));
    for (const value of ["ke_aaaaaaaaaaaa", "SEO", "Ads", "pending", "Playbook v2", entry.citation]) assert.ok(out.includes(value), value);
    assert.ok(!out.includes("Organic only."), "the body is not echoed back");
  }
  const patch = api.calls.find((call) => call.method === "PATCH")!;
  assert.deepEqual(patch.query, { sessionId: "chat-1" });
  assert.deepEqual(patch.body, { title: "Playbook v2", body: "Organic only.", author: null, handle: "claude", url: null, collections: ["SEO", "Ads"] });
});

test("knowledge_update: an id, at least one change and the save limits; the daemon's refusals pass through", async () => {
  const api = withCollections(new FakeDaemonApi()).on("PATCH", knowledgeRoutes.entry("ke_hidden000000"), { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." } });
  for (const args of [
    { title: "t" },
    { id: "kc_seo0000000", title: "t" },
    { id: "ke_aaaaaaaaaaaa" },
    { id: "ke_aaaaaaaaaaaa", collections: [] },
    { id: "ke_aaaaaaaaaaaa", body: "   " },
    { id: "ke_aaaaaaaaaaaa", body: "x".repeat(KNOWLEDGE_ENTRY_MAX_BYTES + 1) },
    { id: "ke_aaaaaaaaaaaa", title: null },
    { id: "ke_aaaaaaaaaaaa", kind: "k".repeat(KNOWLEDGE_KIND_MAX + 1) },
    { id: "ke_aaaaaaaaaaaa", tags: ["x"] }
  ]) {
    assert.equal(errorOf(await run(api, "knowledge_update", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 80));
  }
  assert.ok(!api.calls.some((call) => call.method === "PATCH"), "nothing invalid reaches the daemon");
  const hidden = await run(api, "knowledge_update", { id: "ke_hidden000000", title: "t" });
  assert.deepEqual(errorOf(hidden), { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." });
});

test("knowledge_delete: reads then deletes each id once, with the session; reports each deleted or not; nothing deleted is the daemon's refusal", async () => {
  const found = (id: string, title: string): KnowledgeEntryDetail => {
    const entry = meta({ id, title });
    return { entry: { ...entry, body: "b" }, concepts: [], related: [], citation: entry.citation };
  };
  const notFound = { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." } };
  const api = new FakeDaemonApi()
    .on("GET", knowledgeRoutes.entry("ke_aaaaaaaaaaaa"), { status: 200, body: found("ke_aaaaaaaaaaaa", "Old playbook") })
    .on("GET", knowledgeRoutes.entry("ke_hidden000000"), notFound)
    .on("DELETE", knowledgeRoutes.entry("ke_aaaaaaaaaaaa"), { status: 204, body: null });
  const r = await run(api, "knowledge_delete", { ids: ["ke_aaaaaaaaaaaa", "ke_hidden000000", "ke_aaaaaaaaaaaa"] });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(r.structuredContent, undefined, "a text result: no card");
  const out = textOf(r);
  assert.match(out, /\bdeleted\b[^\n]*ke_aaaaaaaaaaaa[^\n]*Old playbook/);
  assert.match(out, /\bnot deleted\b[^\n]*ke_hidden000000[^\n]*No such entry/);
  assert.deepEqual(
    api.calls.map((call) => [call.method, call.path, call.query]),
    [
      ["GET", knowledgeRoutes.entry("ke_aaaaaaaaaaaa"), { sessionId: "chat-1" }],
      ["DELETE", knowledgeRoutes.entry("ke_aaaaaaaaaaaa"), { sessionId: "chat-1" }],
      ["GET", knowledgeRoutes.entry("ke_hidden000000"), { sessionId: "chat-1" }]
    ],
    "a hidden entry is never deleted, and a repeated id is deleted once"
  );

  const none = await run(api, "knowledge_delete", { ids: ["ke_hidden000000"] });
  assert.equal(none.isError, true);
  assert.deepEqual(errorOf(none), { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." });
  for (const args of [{ ids: [] }, { ids: ["nope"] }, { ids: Array.from({ length: 51 }, () => "ke_aaaaaaaaaaaa") }, { id: "ke_aaaaaaaaaaaa" }]) {
    assert.equal(errorOf(await run(api, "knowledge_delete", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 60));
  }
});

test("knowledge_merge: one POST with the session, ids once each; answers the kept entry, its citation and what was deleted; no card", async () => {
  const entry = meta({ id: "ke_aaaaaaaaaaaa", title: "Alternatives pages", linkState: "pending" });
  const merged: KnowledgeMergeResponse = {
    kept: { entry: { ...entry, body: "Combined." }, concepts: [], related: [], citation: entry.citation },
    deleted: ["ke_bbbbbbbbbbbb", "ke_cccccccccccc"]
  };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.entriesMerge, { status: 200, body: merged });
  const r = await run(api, "knowledge_merge", { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb", "ke_aaaaaaaaaaaa", "ke_cccccccccccc"], keep: "ke_aaaaaaaaaaaa", title: " Alternatives pages ", body: "Combined." });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(r.structuredContent, undefined, "a text result: no card");
  const out = textOf(r);
  for (const value of [entry.id, entry.title, entry.citation, "ke_bbbbbbbbbbbb", "ke_cccccccccccc", "SEO", "Ads", "pending"]) assert.ok(out.includes(value), value);
  assert.match(out, /\b(?:deleted|removed)\b/i);
  assert.doesNotMatch(out, /orquester-knowledge:entry\/ke_[bc]{12}/, "the deleted entries are not offered as citations");
  const posts = api.calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1, "merge is one atomic request");
  assert.deepEqual(posts[0]!.body, { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb", "ke_cccccccccccc"], sessionId: "chat-1", keep: "ke_aaaaaaaaaaaa", title: "Alternatives pages", body: "Combined." });
  await run(api, "knowledge_merge", { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"] });
  assert.deepEqual(api.calls.filter((call) => call.method === "POST").at(-1)!.body, { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"], sessionId: "chat-1" }, "no keep: the daemon's rule");
});

test("knowledge_merge: 2..10 distinct entry ids, keep among them, the save limits; the daemon's refusals pass through", async () => {
  const notFound = { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry: ke_hidden000000." } };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.entriesMerge, notFound);
  for (const args of [
    { ids: ["ke_aaaaaaaaaaaa"] },
    { ids: ["ke_aaaaaaaaaaaa", "ke_aaaaaaaaaaaa"] },
    { ids: Array.from({ length: 11 }, (_, i) => `ke_${String(i).padStart(12, "0")}`) },
    { ids: ["ke_aaaaaaaaaaaa", "nope"] },
    { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"], keep: "ke_cccccccccccc" },
    { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"], body: "   " },
    { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"], title: "t".repeat(KNOWLEDGE_TITLE_MAX + 1) },
    { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"], collections: ["SEO"] }
  ]) {
    assert.equal(errorOf(await run(api, "knowledge_merge", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 80));
  }
  assert.ok(!api.calls.some((call) => call.method === "POST"), "nothing invalid reaches the daemon");
  const hidden = await run(api, "knowledge_merge", { ids: ["ke_aaaaaaaaaaaa", "ke_hidden000000"] });
  assert.deepEqual(errorOf(hidden), { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry: ke_hidden000000." });
});

test("knowledge_collections: every collection by name, count and description", async () => {
  const api = withCollections(new FakeDaemonApi());
  const out = textOf(await run(api, "knowledge_collections", {}));
  assert.match(out, /SEO\D*40\b\D*Ranking in search engines\./);
  assert.match(out, /Ads\D*9\b\D*Paid acquisition\./);
  assert.match(out, /52\b\D*entries/i);
  assert.match(out, /3\b\D*unfiled/i);
  api.on("GET", knowledgeRoutes.collections, { status: 200, body: { collections: [], unfiledCount: 0, totalEntries: 0 } });
  const empty = await run(api, "knowledge_collections", {});
  assert.equal(empty.isError, undefined);
  assert.match(textOf(empty), /0\b\D*collections/i);
});

test("worker tools: next task (instructions once, then a pointer), submit returns the next one; an invalid answer is refused to be redone", async () => {
  const task = { taskId: "t2", step: "pass2", instructions: null, sameInstructionsAs: "t1", input: "Author: Om Patel\nAlternatives pages\n…", maxTokens: 4000, remaining: 5 };
  const api = new FakeDaemonApi()
    .on("POST", knowledgeRoutes.workerNext, { status: 200, body: { kind: "task", task: { ...task, taskId: "t1", instructions: "Extract concepts as JSON.", sameInstructionsAs: null } } })
    .on("POST", knowledgeRoutes.workerSubmit, ({ body }) =>
      (body as { answer: string }).answer.startsWith("{")
        ? { status: 200, body: { accepted: true, next: { kind: "task", task } } }
        : { status: 200, body: { accepted: false, error: "Unexpected token 'n' at position 0." } }
    );
  const first = textOf(await run(api, "knowledge_worker_next_task", {}));
  assert.equal(api.calls[0]!.path, knowledgeRoutes.workerNext);
  assert.deepEqual(api.calls[0]!.body, { sessionId: "chat-1" });
  for (const value of ["t1", "pass2", "4000", "5", "Extract concepts as JSON.", task.input, "knowledge_worker_submit"]) assert.ok(first.includes(value), value);

  const next = await run(api, "knowledge_worker_submit", { taskId: "t1", answer: '{"nodes": []}' });
  assert.equal(next.isError, undefined, textOf(next));
  assert.deepEqual(api.calls.at(-1)!.body, { sessionId: "chat-1", taskId: "t1", answer: '{"nodes": []}' });
  for (const value of ["t2", "pass2", "t1", task.input]) assert.ok(textOf(next).includes(value), value);
  assert.ok(!textOf(next).includes("Extract concepts as JSON."), "unchanged instructions are referenced rather than repeated");

  const refused = await run(api, "knowledge_worker_submit", { taskId: "t2", answer: "nodes: []" });
  assert.equal(refused.isError, true);
  assert.equal(errorOf(refused).code, "KNOWLEDGE_INVALID");
  assert.ok(errorOf(refused).message.includes("t2"));
  assert.ok(errorOf(refused).message.includes("Unexpected token 'n' at position 0."), "the broker reason is preserved");

  api.on("POST", knowledgeRoutes.workerNext, { status: 200, body: { kind: "done", reason: "session-budget" } });
  const done = await run(api, "knowledge_worker_next_task", {});
  assert.equal(done.isError, undefined);
  assert.ok(textOf(done).includes("session-budget"));
  assert.doesNotMatch(textOf(done), /\bt[12]\b/, "no active task is returned after the session budget ends");
});

test("worker tools: a chat that is no worker gets the daemon's KNOWLEDGE_NOT_A_WORKER as a clean error", async () => {
  const api = new FakeDaemonApi().on("POST", knowledgeRoutes.workerNext, { status: 403, body: { code: "KNOWLEDGE_NOT_A_WORKER", message: "Only the plugin's indexing sessions take tasks." } });
  const r = await run(api, "knowledge_worker_next_task", {});
  assert.equal(r.isError, true);
  assert.equal(errorOf(r).code, "KNOWLEDGE_NOT_A_WORKER");
  for (const args of [{ taskId: "", answer: "{}" }, { taskId: "t", answer: "" }, { taskId: "t" }]) {
    assert.equal(errorOf(await run(api, "knowledge_worker_submit", args)).code, "INVALID_ARGUMENT", JSON.stringify(args));
  }
});

// --- worker tasks in parts ----------------------------------------------------------------------

const TASK_ID = "f".repeat(64);
/** Name-normalization input as myKG writes it: one numbered name per line (about 75 bytes each). */
const nameList = (bytes: number): string => {
  const lines: string[] = [];
  for (let i = 0, size = 0; size < bytes; i += 1) {
    const line = `${i}. "Warm-up routine ${i} for a new TikTok account" — "café ≤ 48 h"`;
    lines.push(line);
    size += Buffer.byteLength(line, "utf8") + 1;
  }
  return lines.join("\n");
};
const workerTask = (over: Partial<KnowledgeWorkerTask> = {}): KnowledgeWorkerTask => ({
  taskId: TASK_ID, step: "normalize_names", instructions: "Merge names that mean the same thing. Answer {\"groups\": [...]}.", sameInstructionsAs: null, input: "x", maxTokens: 32000, remaining: 41, ...over
});
/** The size the CLI measures: the result's text, serialized. */
const resultSize = (r: CallToolResult): number => knowledgeWorkerTextSize(textOf(r));
const bodyOf = (task: KnowledgeWorkerTask): string =>
  `${task.instructions === null ? `Instructions: the same as task ${task.sameInstructionsAs}.` : `Instructions:\n${task.instructions}`}\n\nInput:\n${task.input}`;

/** Reads every part of the task in `first` through the tool, checking each result's budget; answers the body rebuilt. */
async function readParts(api: FakeDaemonApi, first: string, taskId: string): Promise<{ parts: number; body: string; texts: string[] }> {
  const head = /\nThis task is in (\d+) parts\. Part 1 of \1:\n\n/.exec(first);
  assert.ok(head, first.slice(0, 400));
  const parts = Number(head[1]);
  const texts = [first];
  for (let part = 2; part <= parts; part += 1) {
    const r = await run(api, "knowledge_worker_next_task", { taskId, part });
    assert.equal(r.isError, undefined, textOf(r).slice(0, 300));
    assert.ok(resultSize(r) <= KNOWLEDGE_WORKER_RESULT_MAX, `part ${part}: ${resultSize(r)}`);
    texts.push(textOf(r));
  }
  let body = "";
  texts.forEach((text, i) => {
    const start = text.indexOf(`Part ${i + 1} of ${parts}:\n\n`) + `Part ${i + 1} of ${parts}:\n\n`.length;
    const end = text.lastIndexOf(`\n\nEnd of part ${i + 1} of ${parts}`);
    assert.ok(start > 0 && end > start, `part ${i + 1} framed`);
    const midLine = i > 0 && texts[i - 1]!.includes(`(it stops mid-line: part ${i + 1} continues that line)`);
    body += (i === 0 ? "" : midLine ? "" : "\n") + text.slice(start, end);
  });
  return { parts, body, texts };
}

test("worker tools: a task under the result budget is one result, exactly as before (no part line)", async () => {
  const task = workerTask({ input: nameList(30_000), remaining: 3 });
  const api = new FakeDaemonApi().on("POST", knowledgeRoutes.workerNext, { status: 200, body: { kind: "task", task } });
  const out = textOf(await run(api, "knowledge_worker_next_task", {}));
  assert.equal(
    out,
    `Task ${TASK_ID} · step normalize_names · answer ≤ 32000 tokens · 3 more waiting\nInstructions:\n${task.instructions}\n\nInput:\n${task.input}\n\nReply with knowledge_worker_submit: taskId "${TASK_ID}" and the answer — only the JSON text the instructions ask for.`
  );
  assert.doesNotMatch(out, /\bparts?\b/i);
});

test("worker tools: a task over the result budget comes in parts under it; the parts are read through taskId and part, in order, from the task the chat holds, and rebuild it exactly", async () => {
  const task = workerTask({ input: nameList(75_000) });
  const api = new FakeDaemonApi().on("POST", knowledgeRoutes.workerNext, { status: 200, body: { kind: "task", task } });
  const first = await run(api, "knowledge_worker_next_task", {});
  assert.ok(resultSize(first) <= KNOWLEDGE_WORKER_RESULT_MAX, `part 1: ${resultSize(first)}`);
  const out = textOf(first);
  assert.ok(out.startsWith(`Task ${TASK_ID} · step normalize_names · answer ≤ 32000 tokens · 41 more waiting\nThis task is in `), out.slice(0, 200));
  const { parts, body, texts } = await readParts(api, out, TASK_ID);
  assert.ok(parts >= 2, `${parts} parts`);
  assert.match(out, new RegExp(`Call knowledge_worker_next_task with \\{"taskId": "${TASK_ID}", "part": 2\\}, and so on until you have all ${parts} parts; only then answer the whole task with knowledge_worker_submit`));
  assert.equal(body, bodyOf(task), "the parts are the task's instructions and input, cut at line breaks");
  assert.match(texts.at(-1)!, new RegExp(`End of part ${parts} of ${parts}: you now have the whole task\\. Answer it with knowledge_worker_submit: taskId "${TASK_ID}"`));
  assert.deepEqual(api.calls[0]!.body, { sessionId: "chat-1" }, "the first call asks for the next task");
  for (const call of api.calls.slice(1)) assert.deepEqual(call.body, { sessionId: "chat-1", taskId: TASK_ID }, "a part reads the held task again");
  // Asking for part 1 by id answers the same text as the first call.
  assert.equal(textOf(await run(api, "knowledge_worker_next_task", { taskId: TASK_ID, part: 1 })), out);
  assert.equal(textOf(await run(api, "knowledge_worker_next_task", { taskId: TASK_ID })), out, "no part: part 1");

  // The answer to a task in parts is submitted once, and a next task in parts comes as its first part.
  api.on("POST", knowledgeRoutes.workerSubmit, { status: 200, body: { accepted: true, next: { kind: "task", task: { ...task, instructions: null, sameInstructionsAs: "t0" } } } });
  const submitted = await run(api, "knowledge_worker_submit", { taskId: TASK_ID, answer: '{"groups": []}' });
  assert.ok(textOf(submitted).startsWith(`Accepted.\nTask ${TASK_ID}`) && textOf(submitted).includes("Part 1 of "));
  assert.ok(resultSize(submitted) <= KNOWLEDGE_WORKER_RESULT_MAX);
});

test("worker tools: a part of a task the chat does not hold, a part out of range, or a part without its task is refused, and only a held task is read", async () => {
  const task = workerTask({ input: nameList(75_000) });
  const api = new FakeDaemonApi().on("POST", knowledgeRoutes.workerNext, ({ body }) =>
    (body as { taskId?: string }).taskId === TASK_ID
      ? { status: 200, body: { kind: "task", task } }
      : { status: 400, body: { code: "KNOWLEDGE_INVALID", message: `You do not hold task "${(body as { taskId?: string }).taskId}", so it has no parts to read.` } }
  );
  const parts = Number(/This task is in (\d+) parts/.exec(textOf(await run(api, "knowledge_worker_next_task", { taskId: TASK_ID })))![1]);
  const calls = api.calls.length;
  const noTask = await run(api, "knowledge_worker_next_task", { part: 2 });
  assert.deepEqual(errorOf(noTask), { code: "INVALID_ARGUMENT", message: "A part needs the taskId of the task it belongs to." });
  for (const part of [0, -1, 1.5]) assert.equal(errorOf(await run(api, "knowledge_worker_next_task", { taskId: TASK_ID, part })).code, "INVALID_ARGUMENT", String(part));
  assert.equal(api.calls.length, calls, "nothing invalid reaches the daemon");
  const beyond = await run(api, "knowledge_worker_next_task", { taskId: TASK_ID, part: parts + 1 });
  assert.deepEqual(errorOf(beyond), { code: "INVALID_ARGUMENT", message: `Task ${TASK_ID} has ${parts} parts: ask for a part from 1 to ${parts}.` });
  const notHeld = await run(api, "knowledge_worker_next_task", { taskId: "other", part: 2 });
  assert.deepEqual(errorOf(notHeld), { code: "KNOWLEDGE_INVALID", message: 'You do not hold task "other", so it has no parts to read.' });
  // A task in one part has only part 1.
  api.on("POST", knowledgeRoutes.workerNext, { status: 200, body: { kind: "task", task: workerTask() } });
  assert.match(errorOf(await run(api, "knowledge_worker_next_task", { taskId: TASK_ID, part: 2 })).message, /has 1 part: it is not in parts, ask for part 1\./);
  // The run ended while the chat read its parts: it is told to stop.
  api.on("POST", knowledgeRoutes.workerNext, { status: 200, body: { kind: "done", reason: "run-finished" } });
  assert.equal(textOf(await run(api, "knowledge_worker_next_task", { taskId: TASK_ID, part: 2 })), "No task (run-finished). End your turn now.");
});

test("worker tools: no result of any step exceeds the budget, whatever the task's size, characters or lines", async () => {
  const long = (bytes: number) => "Pass 2 document with no line break at all, 中文 and 😀 emoji, \"quoted\" \\ back\tslash. ".repeat(Math.ceil(bytes / 90));
  const inputs = [nameList(10_000), nameList(49_500), nameList(52_000), nameList(75_000), long(50_000), long(130_000), `${"\u0001".repeat(9_000)}\n${"😀".repeat(12_000)}`];
  for (const step of ["pass1", "pass2", "normalize_names", "pair-check", "concept-check", "cluster-name"]) {
    for (const [i, input] of inputs.entries()) {
      for (const instructions of ["I".repeat(6_000), null]) {
        const task = workerTask({ step, input, instructions, sameInstructionsAs: instructions === null ? "t0" : null, taskId: `${step}-${i}`.padEnd(200, "0") });
        const api = new FakeDaemonApi()
          .on("POST", knowledgeRoutes.workerNext, { status: 200, body: { kind: "task", task } })
          .on("POST", knowledgeRoutes.workerSubmit, { status: 200, body: { accepted: true, next: { kind: "task", task } } });
        const first = await run(api, "knowledge_worker_next_task", {});
        assert.ok(resultSize(first) <= KNOWLEDGE_WORKER_RESULT_MAX, `${step} ${i}: ${resultSize(first)}`);
        const submitted = await run(api, "knowledge_worker_submit", { taskId: task.taskId, answer: "{}" });
        assert.ok(resultSize(submitted) <= KNOWLEDGE_WORKER_RESULT_MAX, `${step} ${i} after submit: ${resultSize(submitted)}`);
        if (knowledgeWorkerTextSize(bodyOf(task)) <= KNOWLEDGE_WORKER_PART_MAX) {
          assert.doesNotMatch(textOf(first), /This task is in/, `${step} ${i}: one result`);
          continue;
        }
        const { body } = await readParts(api, textOf(first), task.taskId);
        assert.equal(body, bodyOf(task), `${step} ${i}: rebuilt`);
      }
    }
  }
});

test("splitWorkerText: parts within the size, cut at line breaks, a longer line at a character boundary (never inside a surrogate pair)", () => {
  assert.deepEqual(splitWorkerText("", 10), [{ text: "", midLine: false }]);
  assert.deepEqual(splitWorkerText("aaa\nbbb\nccc", 8), [{ text: "aaa\nbbb", midLine: false }, { text: "ccc", midLine: false }]);
  assert.deepEqual(splitWorkerText("aa\nbbbbbbbbbbbbb\nc", 6), [
    { text: "aa", midLine: false },
    { text: "bbbbbb", midLine: true },
    { text: "bbbbbb", midLine: true },
    { text: "b\nc", midLine: false }
  ]);
  const emoji = splitWorkerText("😀😀😀", 6);
  assert.deepEqual(emoji.map((part) => part.text), ["😀", "😀", "😀"]);
  assert.deepEqual(splitWorkerText('""""', 4).map((part) => part.text), ['""', '""'], "escapes count serialized");
});

test("the family is chat-only: an external caller is never served it", async () => {
  const api = new FakeDaemonApi();
  const r = await executeToolCall({ approvals: null }, { name: "knowledge_search", arguments: { query: "x" } }, { caller: { kind: "external" }, api, signal: new AbortController().signal });
  assert.equal(r.isError, true);
  assert.equal(errorOf(r).code, "TOOL_NOT_FOUND");
  assert.equal(api.calls.length, 0);
});

test("knowledge inputs accept exactly the daemon's limits (query, kind, author, handle)", async () => {
  const api = withCollections(new FakeDaemonApi())
    .on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [], searched: [] } })
    .on("POST", knowledgeRoutes.save, { status: 200, body: { results: [], createdCollections: [], linking: "not-needed" } });
  assert.equal((await run(api, "knowledge_search", { query: "q".repeat(KNOWLEDGE_QUERY_MAX) })).isError, undefined);
  const r = await run(api, "knowledge_save", {
    entries: [{ body: "text", kind: "k".repeat(KNOWLEDGE_KIND_MAX), author: "a".repeat(KNOWLEDGE_AUTHOR_MAX), handle: `@${"h".repeat(KNOWLEDGE_HANDLE_MAX)}`, collections: ["SEO"] }]
  });
  assert.equal(r.isError, undefined, textOf(r));
});

test("knowledge_get: a concept's text fields are bounded — a text result is not capped by the executor", async () => {
  const huge = "word ".repeat(30_000);
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.item("tactic-x"), {
    status: 200,
    body: {
      kind: "concept",
      concept: {
        concept: {
          id: "tactic-x",
          name: huge,
          type: "Tactic",
          confidence: 0.5,
          description: huge,
          aliases: Array.from({ length: 2_000 }, (_, index) => `alias ${index} ${"a".repeat(200)}`),
          attributes: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`${"k".repeat(5_000)}${index}`, { value: huge, confidence: 1 }]))
        },
        collections: ["kc_seo0000000"],
        entries: Array.from({ length: 30 }, () => meta()),
        neighbors: Array.from({ length: 100 }, (_, index) => ({ edge: { id: `e${index}`, type: huge, from: "tactic-x", to: `tool-${index}`, confidence: 1 }, concept: { id: `tool-${index}`, name: huge, type: huge } }))
      }
    }
  });
  const out = textOf(await run(api, "knowledge_get", { id: "tactic-x" }));
  assert.ok(Buffer.byteLength(out, "utf8") < 60_000, `${Buffer.byteLength(out, "utf8")} bytes`);
  assert.ok(out.includes("tactic-x"));
  assert.ok(out.includes("word word"));
  assert.ok(out.includes("alias 0"));
  assert.ok(out.includes("…"), "omitted text is marked");
});

// ---------------------------------------------------------------------------
// Retrieval (spec 2026-10-27-knowledge-retrieval-phase0-1-design.md, "Agent tools (A1)")
// ---------------------------------------------------------------------------

const emptySearch: KnowledgeSearchResponse = { hits: [], searched: ["kc_seo0000000"], total: 0, nextCursor: null };
const cursorAt = (offset: number): string => Buffer.from(JSON.stringify({ v: 1, o: offset, h: "f" })).toString("base64url");

test("knowledge_search: typed filters, examples, sort and cursor map onto the request — lists once each, empty ones left out", async () => {
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.search, { status: 200, body: emptySearch });
  const r = await run(api, "knowledge_search", {
    query: " paywall tests ",
    similarTo: ["ke_aaaaaaaaaaaa", "ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"],
    unlike: ["ke_cccccccccccc"],
    collections: ["SEO", "SEO"],
    kinds: ["thread", "thread", "article"],
    authors: ["@om_patel5", "Om Patel"],
    years: ["2025", " 2026 "],
    postedAfter: "2025-01-01",
    postedBefore: "2026-10-27T12:00:00Z",
    savedAfter: "2026-01-01",
    savedBefore: "2026-10-27",
    sort: "recent",
    limit: 10,
    cursor: cursorAt(10)
  });
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(api.calls.find((call) => call.path === knowledgeRoutes.search)!.body, {
    query: "paywall tests",
    sessionId: "chat-1",
    collections: ["SEO"],
    limit: 10,
    filters: {
      kinds: ["thread", "article"],
      authors: ["@om_patel5", "Om Patel"],
      years: ["2025", "2026"],
      postedAfter: "2025-01-01",
      postedBefore: "2026-10-27T12:00:00Z",
      savedAfter: "2026-01-01",
      savedBefore: "2026-10-27"
    },
    similarTo: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"],
    unlike: ["ke_cccccccccccc"],
    sort: "recent",
    cursor: cursorAt(10)
  });

  // Examples alone: no query; empty lists are not filters.
  await run(api, "knowledge_search", { similarTo: ["ke_aaaaaaaaaaaa"], kinds: [], collections: [] });
  assert.deepEqual(api.calls.filter((call) => call.path === knowledgeRoutes.search).at(-1)!.body, { sessionId: "chat-1", similarTo: ["ke_aaaaaaaaaaaa"] });
});

test("knowledge_search: refuses what the daemon would — no query and no examples, unlike alone, bad ids, years, dates, sort or cursor — before any request", async () => {
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.search, { status: 200, body: emptySearch });
  const nothing = errorOf(await run(api, "knowledge_search", {}));
  assert.equal(nothing.code, "INVALID_ARGUMENT");
  assert.match(nothing.message, /query.*similarTo/, "the refusal says what to pass");
  assert.equal(errorOf(await run(api, "knowledge_search", { similarTo: [], kinds: ["thread"] })).code, "INVALID_ARGUMENT", "filters alone are no search");
  const unlikeAlone = errorOf(await run(api, "knowledge_search", { query: "x", unlike: ["ke_aaaaaaaaaaaa"] }));
  assert.equal(unlikeAlone.code, "INVALID_ARGUMENT");
  assert.match(unlikeAlone.message, /with similarTo/);
  const ids = (n: number) => Array.from({ length: n }, (_, index) => `ke_${String(index).padStart(12, "0")}`);
  for (const args of [
    { similarTo: ["kc_seo0000000"] },
    { similarTo: ["ke_AAAAAAAAAAAA"] },
    { similarTo: ids(KNOWLEDGE_SIMILAR_MAX_EXAMPLES + 1) },
    { similarTo: ["ke_aaaaaaaaaaaa"], unlike: ids(KNOWLEDGE_SIMILAR_MAX_EXAMPLES + 1) },
    { query: "x", kinds: Array.from({ length: KNOWLEDGE_FILTER_MAX_VALUES + 1 }, (_, index) => `k${index}`) },
    { query: "x", kinds: [" "] },
    { query: "x", kinds: ["k".repeat(KNOWLEDGE_KIND_MAX + 1)] },
    { query: "x", authors: ["a".repeat(KNOWLEDGE_AUTHOR_MAX + 1)] },
    { query: "x", years: ["25"] },
    { query: "x", years: ["2025-01"] },
    { query: "x", postedAfter: "last week" },
    { query: "x", postedBefore: "2026-13-45" },
    { query: "x", savedAfter: "" },
    { query: "x", savedBefore: "27/10/2026" },
    { query: "x", sort: "oldest" },
    { query: "x", cursor: "" },
    { query: "x", cursor: "c".repeat(1_001) },
    { query: "x", diverse: false },
    { query: "x", filters: { kinds: ["thread"] } }
  ]) {
    assert.equal(errorOf(await run(api, "knowledge_search", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 80));
  }
  assert.ok(!api.calls.some((call) => call.path === knowledgeRoutes.search), "nothing invalid reaches the daemon");
  // The limits themselves pass.
  const full = await run(api, "knowledge_search", { similarTo: ids(KNOWLEDGE_SIMILAR_MAX_EXAMPLES), unlike: ["ke_aaaaaaaaaaaa"], years: ["2026"], postedAfter: "2026-10-27T08:30:00.000+01:00", kinds: ["k".repeat(KNOWLEDGE_KIND_MAX)] });
  assert.equal(full.isError, undefined, textOf(full));
});

test("knowledge_search: entry match data, concept titles and citations survive; the footer pages", async () => {
  const strong = meta();
  const weak = meta({ id: "ke_wwwwwwwwwwww", title: "Paywall\n  pricing ", kind: "note", author: null, handle: null, postedAt: null, collections: [], linkState: "pending", snippet: "Weekly plans convert." });
  const response: KnowledgeSearchResponse = {
    hits: [
      { kind: "entry", score: 1, entry: strong, match: { band: "strong", via: ["keyword", "meaning"], terms: ["alternatives", "competitor"], passage: { start: 120, end: 480, chunk: 1, chunks: 5 }, concepts: [] } },
      { kind: "concept", score: 0.6, concept: { id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic", description: null }, entryIds: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"], entries: [{ id: "ke_aaaaaaaaaaaa", title: "Alternatives pages" }, { id: "ke_bbbbbbbbbbbb", title: "Competitor\npages" }] },
      { kind: "entry", score: 0.2, entry: weak, match: { band: "weak", via: ["concept"], terms: [], passage: null, concepts: [{ id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic" }] } }
    ],
    searched: ["kc_seo0000000", "kc_ads0000000"],
    total: 31,
    nextCursor: cursorAt(2)
  };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.search, { status: 200, body: response });
  const out = textOf(await run(api, "knowledge_search", { query: "alternatives competitor" }));
  for (const value of [strong.id, strong.title, strong.citation, weak.id, "Paywall pricing", weak.snippet!, weak.citation, "tactic-alternatives", "ke_bbbbbbbbbbbb", "Competitor pages", cursorAt(2)]) assert.ok(out.includes(value), value);
  assert.match(out, /ke_aaaaaaaaaaaa[^\n]*strong[^\n]*keyword[^\n]*meaning/);
  assert.match(out, /ke_wwwwwwwwwwww[^\n]*weak[^\n]*concept/);
  assert.match(out, /120[^\d]+480[^\n]*2\/5/, "the passage retains its offsets and one-based chunk number");
  assert.match(out, /Weak[^\n]*never cite[^\n]*evidence/i);
  assert.match(out, /Showing 1–2 of 31/);

  // A later page counts from the cursor's offset; the last one has no next cursor.
  api.on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [response.hits[0]!], searched: ["kc_seo0000000"], total: 31, nextCursor: cursorAt(9) } });
  const later = textOf(await run(api, "knowledge_search", { query: "x", cursor: cursorAt(8) }));
  assert.match(later, /Showing 9–9 of 31/);
  assert.ok(later.includes(cursorAt(9)));
  api.on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [response.hits[0]!, response.hits[2]!], searched: ["kc_seo0000000"], total: 31, nextCursor: null } });
  const last = textOf(await run(api, "knowledge_search", { query: "x", cursor: cursorAt(29) }));
  assert.match(last, /Showing 30–31 of 31/);
  assert.doesNotMatch(last, /Next page/);
});

test("knowledge_get: similar entries with every reason, possible duplicates once, at most 8 similar; related only from an older daemon", async () => {
  const entry = meta();
  const other = (id: string, title: string) => meta({ id, title });
  const duplicate: KnowledgeSimilarEntry = { entry: other("ke_dddddddddddd", "Same thread"), similarity: 0.973, reasons: [{ kind: "meaning", similarity: 0.973 }] };
  const similar: KnowledgeSimilarEntry[] = [
    {
      entry: other("ke_bbbbbbbbbbbb", "Competitor pages"),
      similarity: 0.912,
      reasons: [
        { kind: "meaning", similarity: 0.912 },
        { kind: "concepts", concepts: [{ id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic" }, { id: "channel-seo", name: "SEO", type: "Channel" }], shared: 2 },
        { kind: "author", value: "om_patel5" }
      ]
    },
    duplicate,
    { entry: other("ke_cccccccccccc", "Pricing pages"), similarity: null, reasons: [{ kind: "concepts", concepts: [{ id: "a", name: "A", type: "T" }, { id: "b", name: "B", type: "T" }, { id: "c", name: "C", type: "T" }], shared: 5 }] },
    { entry: other("ke_eeeeeeeeeeee", "Old notes"), similarity: null, reasons: [{ kind: "author", value: "om_patel5" }] },
    ...Array.from({ length: 8 }, (_, index): KnowledgeSimilarEntry => ({ entry: other(`ke_x${String(index).padStart(11, "0")}`, `More ${index}`), similarity: 0.8, reasons: [{ kind: "meaning", similarity: 0.8 }] }))
  ];
  const detail: KnowledgeEntryDetail = {
    entry: { ...entry, body: "Body." },
    concepts: [],
    related: [other("ke_rrrrrrrrrrrr", "Related only")],
    similar,
    possibleDuplicates: [duplicate],
    citation: entry.citation
  };
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: detail } });
  const out = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  for (const item of [similar[0]!, similar[2]!, similar[3]!, duplicate]) {
    assert.ok(out.includes(item.entry.id) && out.includes(item.entry.title) && out.includes(item.entry.citation), item.entry.id);
  }
  for (const reason of ["meaning 0.91", "Alternatives pages, SEO", "A, B, C +2 more", "same author", "0.97", "knowledge_merge"]) assert.ok(out.includes(reason), reason);
  const listed = new Set(similar.filter((item) => item.entry.id !== duplicate.entry.id && out.includes(item.entry.citation)).map((item) => item.entry.id));
  assert.equal(listed.size, 8, "the documented similar-entry limit excludes the separately offered duplicate");
  assert.equal(out.split(duplicate.entry.citation).length - 1, 1, "the duplicate is offered once");
  assert.ok(!out.includes("ke_rrrrrrrrrrrr"), "similar replaces related");
  assert.ok(out.includes(detail.entry.body));
});

test("knowledge_get: ids reads each distinct item in order, preserves partial success and fails when all fail", async () => {
  const entryDetail = (id: string, body: string): KnowledgeEntryDetail => {
    const entry = meta({ id, title: `Title ${id}` });
    return { entry: { ...entry, body }, concepts: [], related: [], citation: entry.citation };
  };
  const notFound = { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." } };
  const api = withCollections(new FakeDaemonApi())
    .on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: entryDetail("ke_aaaaaaaaaaaa", "short body") } })
    .on("GET", knowledgeRoutes.item("ke_bbbbbbbbbbbb"), { status: 200, body: { kind: "entry", entry: entryDetail("ke_bbbbbbbbbbbb", "B".repeat(100_000)) } })
    .on("GET", knowledgeRoutes.item("ke_hidden000000"), notFound)
    .on("GET", knowledgeRoutes.item("ke_gone00000000"), notFound)
    .on("GET", knowledgeRoutes.item("tactic-x"), { status: 200, body: { kind: "concept", concept: { concept: { id: "tactic-x", name: "X", type: "Tactic", confidence: 0.5, description: null, aliases: [], attributes: {} }, collections: [], entries: [], neighbors: [] } } });
  const r = await run(api, "knowledge_get", { ids: ["ke_aaaaaaaaaaaa", "ke_hidden000000", "ke_bbbbbbbbbbbb", "ke_aaaaaaaaaaaa", "tactic-x"] });
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(
    api.calls.filter((call) => call.path.startsWith("/api/knowledge/items/")).map((call) => [call.path, call.query]),
    ["ke_aaaaaaaaaaaa", "ke_hidden000000", "ke_bbbbbbbbbbbb", "tactic-x"].map((id) => [knowledgeRoutes.item(id), { sessionId: "chat-1" }]),
    "one request per distinct id, with the session"
  );
  const out = textOf(r);
  const positions = ["ke_aaaaaaaaaaaa", "ke_hidden000000", "ke_bbbbbbbbbbbb", "tactic-x"].map((id) => out.indexOf(id));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)), "results retain the distinct ids' order");
  assert.ok(out.includes("KNOWLEDGE_NOT_FOUND") && out.includes("short body"));
  const shown = out.match(/B{2,}/)?.[0] ?? "";
  assert.ok(shown.length > 0 && shown.length < 100_000);
  assert.ok(Buffer.byteLength(`short body${shown}`) <= 48_000, "the bodies share one byte budget");
  assert.ok(out.includes(`from=${shown.length}`), "continuation starts after the body characters shown");

  const none = await run(api, "knowledge_get", { ids: ["ke_hidden000000", "ke_gone00000000"] });
  assert.equal(none.isError, true);
  assert.deepEqual(errorOf(none), { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." });
  // One id in ids reads like id; from reads on in it.
  const single = textOf(await run(api, "knowledge_get", { ids: ["ke_bbbbbbbbbbbb"], from: 99_990 }));
  assert.equal(single.match(/B{2,}/)?.[0], "B".repeat(10));
  assert.match(single, /99990[^\d]+100000/);
});

test("knowledge_get: exactly one of id and ids, at most 5 ids, from a whole offset and only for one entry", async () => {
  const api = withCollections(new FakeDaemonApi());
  for (const args of [
    {},
    { id: "ke_aaaaaaaaaaaa", ids: ["ke_bbbbbbbbbbbb"] },
    { ids: [] },
    { ids: Array.from({ length: 6 }, (_, index) => `ke_${String(index).padStart(12, "0")}`) },
    { ids: [""] },
    { id: "ke_aaaaaaaaaaaa", from: -1 },
    { id: "ke_aaaaaaaaaaaa", from: 1.5 },
    { id: "ke_aaaaaaaaaaaa", from: "10" },
    { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"], from: 10 }
  ]) {
    assert.equal(errorOf(await run(api, "knowledge_get", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 80));
  }
  assert.match(errorOf(await run(api, "knowledge_get", {})).message, /id, or ids/);
  assert.match(errorOf(await run(api, "knowledge_get", { ids: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"], from: 10 })).message, /with id/);
  assert.equal(api.calls.filter((call) => call.path.startsWith("/api/knowledge/items/")).length, 0, "nothing invalid reaches the daemon");
});

test("knowledge_get: five full entries or five huge concepts stay under the result cap", async () => {
  const api = withCollections(new FakeDaemonApi());
  const ids = Array.from({ length: 5 }, (_, index) => `ke_${String(index).padStart(12, "0")}`);
  const citations: string[] = [];
  for (const id of ids) {
    const entry = meta({ id, title: "t".repeat(KNOWLEDGE_TITLE_MAX) });
    citations.push(entry.citation);
    const similar = Array.from({ length: 8 }, (_, index): KnowledgeSimilarEntry => ({ entry: meta({ id: `ke_s${String(index).padStart(11, "0")}`, title: "s".repeat(KNOWLEDGE_TITLE_MAX) }), similarity: 0.9, reasons: [{ kind: "meaning", similarity: 0.9 }, { kind: "concepts", concepts: [{ id: "c", name: "n".repeat(500), type: "T" }], shared: 9 }, { kind: "author", value: "a" }] }));
    const detail: KnowledgeEntryDetail = {
      entry: { ...entry, body: "€".repeat(6_000) },
      concepts: Array.from({ length: 30 }, (_, index) => ({ id: `c-${index}`, name: "n".repeat(200), type: "T" })),
      related: [],
      similar,
      possibleDuplicates: similar.slice(0, 3),
      citation: entry.citation
    };
    api.on("GET", knowledgeRoutes.item(id), { status: 200, body: { kind: "entry", entry: detail } });
  }
  const entries = textOf(await run(api, "knowledge_get", { ids }));
  assert.ok(Buffer.byteLength(entries, "utf8") < 60_000, `${Buffer.byteLength(entries, "utf8")} bytes`);
  assert.equal(entries.match(/\bfrom=\d+\b/g)?.length, 5, "every body has a continuation offset");
  assert.doesNotMatch(entries, /\ufffd/);
  for (const citation of citations) assert.ok(entries.includes(citation), "each citation survives beside the body window");

  const huge = "word ".repeat(12_001);
  const concepts = ids.map((_, index) => `tactic-${index}`);
  for (const id of concepts) {
    api.on("GET", knowledgeRoutes.item(id), {
      status: 200,
      body: {
        kind: "concept",
        concept: {
          concept: { id, name: huge, type: huge, confidence: 1, description: "€".repeat(30_000), aliases: Array.from({ length: 50 }, () => "€".repeat(500)), attributes: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, { value: "€".repeat(500), confidence: 1 }])) },
          collections: [],
          entries: Array.from({ length: 30 }, () => meta({ snippet: "€".repeat(1_000) })),
          neighbors: Array.from({ length: 100 }, (_, index) => ({ edge: { id: `e${index}`, type: huge, from: id, to: `t${index}`, confidence: 1 }, concept: { id: `t${index}`, name: huge, type: huge } }))
        }
      }
    });
  }
  const many = textOf(await run(api, "knowledge_get", { ids: concepts }));
  assert.ok(Buffer.byteLength(many, "utf8") < 60_000, `${Buffer.byteLength(many, "utf8")} bytes`);
  assert.ok(many.includes("tactic-0"));
  assert.match(many, /(?:cut|truncat)[^\n]*ids/, "the cut and a smaller follow-up read are disclosed");
});

test("knowledge_save: a saved entry close in meaning to one already there gets a possible-duplicate line; an older daemon's answer has none", async () => {
  const saved: KnowledgeSaveResponse = {
    results: [
      {
        entryId: "ke_aaaaaaaaaaaa",
        status: "saved",
        title: "Alternatives pages",
        collections: ["kc_seo0000000"],
        citation: meta().citation,
        similar: [
          { entryId: "ke_cccccccccccc", title: "Alternatives\npages (copy)", similarity: 0.953, citation: "[c](orquester-knowledge:entry/ke_cccccccccccc)" },
          { entryId: "ke_dddddddddddd", title: "Comparison pages", similarity: 0.9, citation: "[d](orquester-knowledge:entry/ke_dddddddddddd)" }
        ]
      },
      { entryId: "ke_eeeeeeeeeeee", status: "saved", title: "New", collections: ["kc_seo0000000"], citation: "[New](orquester-knowledge:entry/ke_eeeeeeeeeeee)", similar: [] },
      { entryId: "ke_ffffffffffff", status: "saved", title: "Older daemon", collections: ["kc_seo0000000"], citation: "[Older daemon](orquester-knowledge:entry/ke_ffffffffffff)" }
    ],
    createdCollections: [],
    linking: "queued"
  };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.save, { status: 200, body: saved });
  const out = textOf(await run(api, "knowledge_save", { entries: [{ body: "text", collections: ["SEO"] }] }));
  for (const value of ["ke_cccccccccccc", "Alternatives pages (copy)", "0.95", "ke_dddddddddddd", "Comparison pages", "0.90", "knowledge_merge", saved.results[1]!.citation, saved.results[2]!.citation]) assert.ok(out.includes(value), value);
  assert.equal(out.match(/possible duplicate/g)?.length, 2, "only where the daemon named one");
});

// ---------------------------------------------------------------------------
// Phase 2 (docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md, "Agent tools")
// ---------------------------------------------------------------------------

const concept = (id: string, name: string, type = "Tactic"): KnowledgeConceptRef => ({ id, name, type });

const INSIGHTS: KnowledgeInsightsResponse = {
  contradictions: [
    {
      a: meta({ id: "ke_aaaaaaaaaaaa", title: "Cap the budget" }),
      b: meta({ id: "ke_bbbbbbbbbbbb", title: "Never cap\nthe budget" }),
      similarity: 0.842,
      source: "graph",
      pairs: [
        { from: concept("tactic-cap", "Daily cap"), to: concept("tactic-uncapped", "Uncapped spend") },
        { from: concept("rule-a", "A", "Rule"), to: concept("rule-b", "B", "Rule") },
        { from: concept("rule-c", "C", "Rule"), to: concept("rule-d", "D", "Rule") },
        { from: concept("rule-e", "E", "Rule"), to: concept("rule-f", "F", "Rule") }
      ],
      note: "Capping\nslows learning"
    },
    { a: meta({ id: "ke_cccccccccccc", title: "Long pages" }), b: meta({ id: "ke_dddddddddddd", title: "Short pages" }), similarity: null, source: "checked", pairs: [], note: null }
  ],
  bridges: [
    {
      entry: meta({ id: "ke_eeeeeeeeeeee", title: "Ads feed SEO" }),
      clusters: [{ label: "Paid ads", size: 12 }, { label: "SEO", size: 8 }, { label: null, size: 3 }],
      concepts: [concept("tactic-alternatives", "Alternatives pages"), concept("metric-cpc", "CPC", "Metric")]
    }
  ],
  singleSource: [{ concept: concept("rule-48h", "Wait 48 hours", "Rule"), entry: meta({ id: "ke_ffffffffffff", title: "Learning phase" }), cluster: { label: "Paid ads", size: 12 } }],
  gaps: [
    { a: meta({ id: "ke_aaaaaaaaaaaa", title: "Cap the budget" }), b: meta({ id: "ke_gggggggggggg", title: "Budget pacing" }), similarity: 0.931, queued: true },
    { a: meta({ id: "ke_cccccccccccc", title: "Long pages" }), b: meta({ id: "ke_hhhhhhhhhhhh", title: "Pillar pages" }), similarity: 0.9, queued: false }
  ],
  totals: { contradictions: 5, bridges: 1, singleSource: 1, gaps: 2 }
};

test("knowledge_insights: one GET with the session, the limit (default 10) and the collections once, comma-joined; four sections, contradictions first, with totals", async () => {
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.insights, { status: 200, body: INSIGHTS });
  const r = await run(api, "knowledge_insights", { collections: ["SEO", "Ads", "SEO"], limit: 5 });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(r.structuredContent, undefined, "a text result");
  assert.deepEqual(api.calls, [{ method: "GET", path: knowledgeRoutes.insights, query: { sessionId: "chat-1", limit: "5", collections: "SEO,Ads" } }], "no collections read: no name holds a comma");
  const c = (id: string, title: string) => meta({ id, title }).citation;
  assert.equal(
    textOf(r),
    [
      "Knowledge insights (in SEO, Ads). Read an entry with knowledge_get; cite each entry you use with its cite link, verbatim.",
      "Contradictions, entries that disagree (2 of 5):",
      '1. ke_aaaaaaaaaaaa "Cap the budget" ↔ ke_bbbbbbbbbbbb "Never cap the budget" · concept graph · meaning 0.84',
      "   note: Capping slows learning",
      "   concepts: Daily cap (Tactic) vs Uncapped spend (Tactic); A (Rule) vs B (Rule); C (Rule) vs D (Rule) +1 more",
      `   cite: ${c("ke_aaaaaaaaaaaa", "Cap the budget")}`,
      `   cite: ${c("ke_bbbbbbbbbbbb", "Never cap\nthe budget")}`,
      '2. ke_cccccccccccc "Long pages" ↔ ke_dddddddddddd "Short pages" · LLM-checked',
      `   cite: ${c("ke_cccccccccccc", "Long pages")}`,
      `   cite: ${c("ke_dddddddddddd", "Short pages")}`,
      "Bridges, entries tying clusters together (1):",
      '1. ke_eeeeeeeeeeee "Ads feed SEO" · links "Paid ads" (12), "SEO" (8), unlabelled (3)',
      "   via: Alternatives pages (Tactic), CPC (Metric)",
      `   cite: ${c("ke_eeeeeeeeeeee", "Ads feed SEO")}`,
      "Single source, claims its cluster discusses that only one entry backs (1):",
      '1. Wait 48 hours (Rule) [rule-48h] → only ke_ffffffffffff "Learning phase" · in cluster "Paid ads" (12 entries)',
      `   cite: ${c("ke_ffffffffffff", "Learning phase")}`,
      "Link gaps, close in meaning, no shared concept (2):",
      '1. ke_aaaaaaaaaaaa "Cap the budget" ↔ ke_gggggggggggg "Budget pacing" · meaning 0.93 · queued for re-linking',
      '2. ke_cccccccccccc "Long pages" ↔ ke_hhhhhhhhhhhh "Pillar pages" · meaning 0.90 · not queued'
    ].join("\n")
  );
  await run(api, "knowledge_insights", {});
  assert.deepEqual(api.calls.at(-1)!.query, { sessionId: "chat-1", limit: "10" }, "no collections: every visible one; the tool's default limit");
});

test("knowledge_insights: an empty list says none; nothing anywhere is one line; a collection name holding a comma goes by its id", async () => {
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.insights, { status: 200, body: { ...INSIGHTS, contradictions: [], singleSource: [], totals: { contradictions: 0, bridges: 1, singleSource: 0, gaps: 2 } } });
  const some = textOf(await run(api, "knowledge_insights", {})).split("\n");
  assert.equal(some[0], "Knowledge insights. Read an entry with knowledge_get; cite each entry you use with its cite link, verbatim.");
  assert.equal(some[1], "Contradictions: none.");
  assert.ok(some.includes("Single source: none."));
  assert.ok(some.indexOf("Contradictions: none.") < some.indexOf("Bridges, entries tying clusters together (1):"));

  api.on("GET", knowledgeRoutes.insights, { status: 200, body: { contradictions: [], bridges: [], singleSource: [], gaps: [], totals: { contradictions: 0, bridges: 0, singleSource: 0, gaps: 0 } } });
  assert.equal(textOf(await run(api, "knowledge_insights", { collections: ["SEO"] })), "No knowledge insights (in SEO): no contradictions, bridges, single-source concepts or link gaps found.");

  api.on("GET", knowledgeRoutes.collections, { status: 200, body: { ...COLLECTIONS, collections: [...COLLECTIONS.collections, { ...COLLECTIONS.collections[0]!, id: "kc_comma00000", name: "Growth, paid" }] } });
  await run(api, "knowledge_insights", { collections: ["growth, PAID", "Ads"] });
  assert.equal(api.calls.at(-1)!.query!.collections, "kc_comma00000,Ads");
  const unknown = await run(api, "knowledge_insights", { collections: ["Nope, none"] });
  assert.equal(errorOf(unknown).code, "INVALID_ARGUMENT");
  assert.match(errorOf(unknown).message, /No collection named "Nope, none"/);
});

test("knowledge_insights: inputs (limit 1..20, collection refs) are checked before any request; an older daemon's 404 says it has no insights; knowledge refusals pass through", async () => {
  const api = withCollections(new FakeDaemonApi());
  for (const args of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: "5" }, { collections: [""] }, { collections: ["c".repeat(65)] }, { collections: "SEO" }, { sessionId: "other" }]) {
    assert.equal(errorOf(await run(api, "knowledge_insights", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 60));
  }
  assert.equal(api.calls.length, 0, "nothing invalid reaches the daemon");

  // An older daemon: no such route (the daemon's own 404 shape, Fastify's, or none; the fake's own when unrouted).
  const old = await run(api, "knowledge_insights", { limit: 20 });
  assert.deepEqual(errorOf(old), { code: "NOT_FOUND", message: "This Orquester server has no insights yet (it predates them): use knowledge_search and knowledge_get." });
  for (const body of [{ code: "NOT_FOUND", message: "Route not found." }, { statusCode: 404, error: "Not Found", message: "Route GET:/api/knowledge/insights not found" }, null]) {
    api.on("GET", knowledgeRoutes.insights, { status: 404, body });
    const r = await run(api, "knowledge_insights", {});
    assert.equal(r.isError, true);
    assert.deepEqual(errorOf(r), errorOf(old));
  }
  for (const [status, code] of [[400, "KNOWLEDGE_UNKNOWN_COLLECTION"], [403, "KNOWLEDGE_DISABLED"], [404, "KNOWLEDGE_NOT_FOUND"]] as const) {
    api.on("GET", knowledgeRoutes.insights, { status, body: { code, message: `refused: ${code}` } });
    assert.deepEqual(errorOf(await run(api, "knowledge_insights", { collections: ["Marketing"] })), { code, message: `refused: ${code}` });
  }
});

test("knowledge_get: entries it disagrees with come first (source, note, concept pairs, cite) and leave Similar; New here; distinctive shared concepts", async () => {
  const entry = meta();
  const other = (id: string, title: string) => meta({ id, title });
  const similar: KnowledgeSimilarEntry[] = [
    {
      entry: other("ke_bbbbbbbbbbbb", "Competitor pages"),
      similarity: 0.912,
      reasons: [
        { kind: "meaning", similarity: 0.912 },
        { kind: "concepts", concepts: [concept("tactic-alternatives", "Alternatives pages"), concept("channel-seo", "SEO", "Channel")], shared: 2, distinctive: [concept("tactic-alternatives", "Alternatives pages")] }
      ]
    },
    {
      entry: other("ke_cccccccccccc", "Never build comparison pages"),
      similarity: 0.71,
      reasons: [
        { kind: "meaning", similarity: 0.71 },
        { kind: "contradicts", source: "graph", pairs: [{ from: concept("tactic-alternatives", "Alternatives pages"), to: concept("tactic-no-comparisons", "No comparison pages") }], note: "Comparison pages\ncannibalise" }
      ]
    },
    { entry: other("ke_dddddddddddd", "Thin pages"), similarity: null, reasons: [{ kind: "contradicts", source: "checked", pairs: [], note: null }] }
  ];
  const detail: KnowledgeEntryDetail = {
    entry: { ...entry, body: "Body." },
    concepts: [concept("tactic-alternatives", "Alternatives pages"), concept("metric-x", "Rank in 6 weeks", "Metric")],
    related: [],
    similar,
    possibleDuplicates: [],
    novelty: { newConcepts: [concept("metric-x", "Rank in 6 weeks", "Metric")], cluster: { label: "Comparison pages", size: 7 } },
    citation: entry.citation
  };
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: detail } });
  const out = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  const lines = out.split("\n");
  const at = lines.findIndex((line) => line.startsWith("Concepts:"));
  assert.deepEqual(lines.slice(at + 1), [
    'New here: Rank in 6 weeks (Metric) · in cluster "Comparison pages" (7 entries)',
    "Disagrees with:",
    '- ke_cccccccccccc "Never build comparison pages" · concept graph · meaning 0.71',
    "  note: Comparison pages cannibalise",
    "  concepts: Alternatives pages (Tactic) vs No comparison pages (Tactic)",
    `  cite: ${similar[1]!.entry.citation}`,
    '- ke_dddddddddddd "Thin pages" · LLM-checked',
    `  cite: ${similar[2]!.entry.citation}`,
    "Similar:",
    '- ke_bbbbbbbbbbbb "Competitor pages" · meaning 0.91 · shares concepts Alternatives pages (distinctive), SEO',
    `  cite: ${similar[0]!.entry.citation}`,
    "---",
    "Body."
  ]);
  assert.equal(out.split("ke_cccccccccccc").length - 1, 2, "a disagreeing entry is listed once (its id, and its citation)");

  // Nothing new, no cluster yet; only disagreements: no Similar head.
  api.on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: { ...detail, similar: similar.slice(2), novelty: { newConcepts: [], cluster: null } } } });
  const bare = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  assert.ok(bare.includes("\nNew here: no concept of its own\nDisagrees with:\n"), bare);
  assert.ok(!bare.includes("Similar:"));
});

test("knowledge_get: `disagreements` lists every entry it disagrees with (+N more past them), none repeated under Similar", async () => {
  const entry = meta();
  const other = (id: string, title: string) => meta({ id, title });
  const detail: KnowledgeEntryDetail = {
    entry: { ...entry, body: "Body." },
    concepts: [],
    related: [],
    similar: [
      { entry: other("ke_bbbbbbbbbbbb", "Use Outlook"), similarity: 0.95, reasons: [{ kind: "contradicts", source: "checked", pairs: [], note: "Gmail vs Outlook" }, { kind: "meaning", similarity: 0.95 }] },
      // Not carrying the reason (the daemon keeps 3 in `similar`), yet on the disagreements list.
      { entry: other("ke_dddddddddddd", "Three accounts a phone"), similarity: 0.92, reasons: [{ kind: "meaning", similarity: 0.92 }] },
      { entry: other("ke_eeeeeeeeeeee", "Warm-up guide"), similarity: 0.9, reasons: [{ kind: "meaning", similarity: 0.9 }] }
    ],
    possibleDuplicates: [],
    disagreements: [
      { entry: other("ke_bbbbbbbbbbbb", "Use Outlook"), similarity: 0.95, source: "checked", pairs: [], note: "Gmail vs Outlook" },
      { entry: other("ke_cccccccccccc", "No SIM"), similarity: null, source: "graph", pairs: [{ from: concept("t-sim", "Keep the SIM"), to: concept("t-nosim", "No SIM") }], note: null },
      { entry: other("ke_dddddddddddd", "Three accounts a phone"), similarity: 0.92, source: "checked", pairs: [], note: "2-3 vs 5 accounts" }
    ],
    disagreementsTotal: 25,
    citation: entry.citation
  };
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: detail } });
  const lines = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" })).split("\n");
  const at = lines.indexOf("Disagrees with:");
  assert.deepEqual(lines.slice(at, lines.indexOf("---")), [
    "Disagrees with:",
    '- ke_bbbbbbbbbbbb "Use Outlook" · LLM-checked · meaning 0.95',
    "  note: Gmail vs Outlook",
    `  cite: ${detail.disagreements![0]!.entry.citation}`,
    '- ke_cccccccccccc "No SIM" · concept graph',
    "  concepts: Keep the SIM (Tactic) vs No SIM (Tactic)",
    `  cite: ${detail.disagreements![1]!.entry.citation}`,
    '- ke_dddddddddddd "Three accounts a phone" · LLM-checked · meaning 0.92',
    "  note: 2-3 vs 5 accounts",
    `  cite: ${detail.disagreements![2]!.entry.citation}`,
    "+22 more",
    "Similar:",
    '- ke_eeeeeeeeeeee "Warm-up guide" · meaning 0.90',
    `  cite: ${detail.similar![2]!.entry.citation}`
  ]);
});

test("knowledge_insights: a long note is cut at a sentence end, else a word end, with …", async () => {
  const first = "Entry A says to sign up with an Outlook or Proton email because Gmail accounts get linked across devices by Google's own signals.";
  const second = "Entry B says to sign up with the email and not the phone number, and that only Gmail is safe because other providers carry a much higher ban risk on TikTok.";
  const long = `${first} ${second} ${second}`;
  const words = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.insights, {
    status: 200,
    body: { ...INSIGHTS, contradictions: [{ ...INSIGHTS.contradictions[1]!, note: long }, { ...INSIGHTS.contradictions[1]!, note: words }] }
  });
  const notes = textOf(await run(api, "knowledge_insights", {}))
    .split("\n")
    .filter((line) => line.startsWith("   note: "))
    .map((line) => line.slice("   note: ".length));
  assert.equal(notes[0], `${first} ${second} …`, "whole sentences, past 200 characters");
  assert.ok(notes[1]!.length <= 400 && notes[1]!.endsWith("…"), notes[1]);
  assert.match(notes[1]!, / word\d+…$/, "a whole word before the …");
  assert.ok(words.startsWith(notes[1]!.slice(0, -1)));
});

test("knowledge_get: a name that repeats in one list of shared concepts carries its type", async () => {
  const entry = meta();
  const detail: KnowledgeEntryDetail = {
    entry: { ...entry, body: "Body." },
    concepts: [],
    related: [],
    similar: [
      {
        entry: meta({ id: "ke_bbbbbbbbbbbb", title: "US TikTok via eSIM" }),
        similarity: 0.9,
        reasons: [
          {
            kind: "concepts",
            concepts: [concept("channel-tiktok", "TikTok", "Channel"), concept("permission-location", "Location", "Permission"), concept("app-tiktok", "tiktok", "App")],
            shared: 5,
            distinctive: [concept("app-tiktok", "tiktok", "App")]
          }
        ]
      }
    ],
    possibleDuplicates: [],
    citation: entry.citation
  };
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: detail } });
  const out = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  assert.ok(out.includes('· shares concepts TikTok (Channel), Location, tiktok (App) (distinctive) +2 more'), out);
});

test("knowledge_get: a concept with more entries than it shows lists every other visible entry by id", async () => {
  const entries = Array.from({ length: 6 }, (_, i) => meta({ id: `ke_${String(i).repeat(12)}`, title: `Entry ${i}` }));
  const body = {
    kind: "concept",
    concept: {
      concept: { id: "channel-tiktok", name: "TikTok", type: "Channel", confidence: 0.9, description: null, aliases: [], attributes: {} },
      collections: [],
      entries,
      neighbors: [],
      entryIds: [...entries.map((entry) => entry.id), "ke_bk4lk3nknmiw"]
    }
  };
  const api = withCollections(new FakeDaemonApi())
    .on("GET", knowledgeRoutes.item("channel-tiktok"), { status: 200, body })
    .on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: { entry: { ...meta(), body: "Body." }, concepts: [], related: [], citation: meta().citation } } });
  // Read with another id, the concept shows 4 entries in full: the 3 others by id, none missing.
  const out = textOf(await run(api, "knowledge_get", { ids: ["channel-tiktok", "ke_aaaaaaaaaaaa"] }));
  assert.ok(out.includes("Entries (7; the newest 4 in full):"), out);
  assert.ok(out.includes("- also: ke_444444444444, ke_555555555555, ke_bk4lk3nknmiw"), out);
  const alone = textOf(await run(api, "knowledge_get", { id: "channel-tiktok" }));
  assert.ok(alone.includes("Entries (7; the newest 6 in full):") && alone.includes("- also: ke_bk4lk3nknmiw"), alone);
});

test("knowledge_get: a concept shows what was merged into it and its similar concepts; an older daemon's concept renders as before", async () => {
  const base = {
    concept: { id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic", confidence: 0.9, description: null, aliases: ["vs pages"], attributes: {} },
    collections: ["kc_seo0000000"],
    entries: [],
    neighbors: []
  };
  const api = withCollections(new FakeDaemonApi());
  api.on("GET", knowledgeRoutes.item("tactic-alternatives"), { status: 200, body: { kind: "concept", concept: base } });
  const old = textOf(await run(api, "knowledge_get", { id: "tactic-alternatives" }));
  assert.equal(old, 'concept tactic-alternatives "Alternatives pages" (Tactic) · confidence 0.90 · in SEO\nAliases: vs pages');

  api.on("GET", knowledgeRoutes.item("tactic-alternatives"), {
    status: 200,
    body: {
      kind: "concept",
      concept: {
        ...base,
        mergedFrom: [concept("tactic-alternative-pages", "Alternative pages"), concept("tactic-vs-pages", "VS pages")],
        similarConcepts: [{ concept: concept("tactic-comparison", "Comparison pages"), similarity: 0.812 }, ...Array.from({ length: 6 }, (_, i) => ({ concept: concept(`t-${i}`, `T${i}`), similarity: 0.7 }))]
      }
    }
  });
  const lines = textOf(await run(api, "knowledge_get", { id: "tactic-alternatives" })).split("\n");
  assert.deepEqual(lines.slice(1), [
    "Aliases: vs pages",
    "Merged from: Alternative pages (Tactic) [tactic-alternative-pages], VS pages (Tactic) [tactic-vs-pages]",
    "Similar concepts: Comparison pages (Tactic) [tactic-comparison] 0.81, T0 (Tactic) [t-0] 0.70, T1 (Tactic) [t-1] 0.70, T2 (Tactic) [t-2] 0.70, T3 (Tactic) [t-3] 0.70"
  ]);
  api.on("GET", knowledgeRoutes.item("tactic-alternatives"), { status: 200, body: { kind: "concept", concept: { ...base, mergedFrom: [], similarConcepts: [] } } });
  assert.equal(textOf(await run(api, "knowledge_get", { id: "tactic-alternatives" })), old, "empty lists: no lines");
});

test("knowledge_get: an older daemon's entry (no novelty, no contradicts or distinctive) renders exactly as before", async () => {
  const entry = meta();
  const detail: KnowledgeEntryDetail = {
    entry: { ...entry, body: "Body." },
    concepts: [concept("tactic-alternatives", "Alternatives pages")],
    related: [],
    similar: [{ entry: meta({ id: "ke_bbbbbbbbbbbb", title: "Competitor pages" }), similarity: 0.9, reasons: [{ kind: "meaning", similarity: 0.9 }, { kind: "concepts", concepts: [concept("tactic-alternatives", "Alternatives pages")], shared: 1 }] }],
    possibleDuplicates: [],
    citation: entry.citation
  };
  const api = withCollections(new FakeDaemonApi()).on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: detail } });
  assert.equal(
    textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" })),
    [
      `cite: ${entry.citation}`,
      "entry ke_aaaaaaaaaaaa · thread · Om Patel (@om_patel5) · 2026-10-11 · in SEO, Ads",
      "Title: Alternatives pages",
      "Concepts: Alternatives pages (Tactic) [tactic-alternatives]",
      "Similar:",
      '- ke_bbbbbbbbbbbb "Competitor pages" · meaning 0.90 · shares concept Alternatives pages',
      `  cite: ${detail.similar![0]!.entry.citation}`,
      "---",
      "Body."
    ].join("\n")
  );
});

test("knowledge_save: a saved entry names the cluster it joins; none when the daemon sends null or nothing, or for a duplicate", async () => {
  const saved: KnowledgeSaveResponse = {
    results: [
      {
        entryId: "ke_aaaaaaaaaaaa",
        status: "saved",
        title: "Alternatives pages",
        collections: ["kc_seo0000000"],
        citation: meta().citation,
        cluster: { label: "Comparison pages", size: 7 },
        similar: [{ entryId: "ke_cccccccccccc", title: "Alternatives pages (copy)", similarity: 0.953, citation: "[c](orquester-knowledge:entry/ke_cccccccccccc)" }]
      },
      { entryId: "ke_eeeeeeeeeeee", status: "saved", title: "New", collections: ["kc_seo0000000"], citation: "[New](orquester-knowledge:entry/ke_eeeeeeeeeeee)", cluster: { label: null, size: 3 } },
      { entryId: "ke_ffffffffffff", status: "saved", title: "Alone", collections: ["kc_seo0000000"], citation: "[Alone](orquester-knowledge:entry/ke_ffffffffffff)", cluster: null },
      { entryId: "ke_gggggggggggg", status: "saved", title: "Older daemon", collections: ["kc_seo0000000"], citation: "[Older daemon](orquester-knowledge:entry/ke_gggggggggggg)" },
      { entryId: "ke_bbbbbbbbbbbb", status: "duplicate", title: "Old", collections: ["kc_ads0000000"], citation: "[Old](orquester-knowledge:entry/ke_bbbbbbbbbbbb)", cluster: { label: "Paid ads", size: 9 } }
    ],
    createdCollections: [],
    linking: "queued"
  };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.save, { status: 200, body: saved });
  assert.equal(
    textOf(await run(api, "knowledge_save", { entries: [{ body: "text", collections: ["SEO"] }] })),
    [
      "Saved 4 entries, 1 already saved; linking queued.",
      `- saved ke_aaaaaaaaaaaa · in SEO · cite: ${meta().citation}`,
      '  joins cluster "Comparison pages" (7 entries)',
      '  possible duplicate of ke_cccccccccccc "Alternatives pages (copy)" (0.95) — if it is the same content, knowledge_merge the two',
      "- saved ke_eeeeeeeeeeee · in SEO · cite: [New](orquester-knowledge:entry/ke_eeeeeeeeeeee)",
      "  joins an unlabelled cluster (3 entries)",
      "- saved ke_ffffffffffff · in SEO · cite: [Alone](orquester-knowledge:entry/ke_ffffffffffff)",
      "- saved ke_gggggggggggg · in SEO · cite: [Older daemon](orquester-knowledge:entry/ke_gggggggggggg)",
      "- already saved as ke_bbbbbbbbbbbb (not saved again; the collections it is in now) · in Ads · cite: [Old](orquester-knowledge:entry/ke_bbbbbbbbbbbb)"
    ].join("\n")
  );
});
