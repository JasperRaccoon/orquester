/**
 * The knowledge tools (Knowledge Graph plugin spec, "Agent tools", "Citations"), through the
 * executor: inputs mirror the contract's limits, every request names the calling session, results
 * are compact text with collections by name and each entry's citation, and the daemon's refusals
 * (plugin off, not a worker, an invalid worker answer) come back as clean tool errors. The retrieval
 * spec's additions (filters, examples, paging, match explanations, body windows, similar entries and
 * duplicates) render when the daemon sends them and are left out when an older one does not.
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
  knowledgeCitation,
  knowledgeRoutes,
  type KnowledgeCollectionsResponse,
  type KnowledgeEntryDetail,
  type KnowledgeEntrySummary,
  type KnowledgeSaveResponse,
  type KnowledgeSearchResponse,
  type KnowledgeSimilarEntry
} from "@orquester/api";

import type { ThreadCaller } from "../catalog/contract.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";
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

  assert.ok(out.includes("Related:"), "an older daemon's related entries");
  assert.doesNotMatch(out, /Similar:|Possible duplicates|\[chars /, "an older daemon sends no similar entries; a whole body has no footer");
  assert.ok(out.endsWith(detail.entry.body));
});

test("knowledge_get: a long body is cut at 48 000 bytes on a character boundary, with the offset to read on from; from reads on", async () => {
  const entry = meta();
  const detail = (body: string): KnowledgeEntryDetail => ({ entry: { ...entry, body }, concepts: [{ id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic" }], related: [], similar: [], possibleDuplicates: [], citation: entry.citation });
  const api = withCollections(new FakeDaemonApi());
  const serve = (body: string) => api.on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: detail(body) } });

  // Two bytes a character: 24 000 characters fill the window.
  serve("é".repeat(48_000));
  const cut = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  assert.ok(cut.includes(`---\n${"é".repeat(24_000)}\n[chars 0–24000 of 48000 — continue with from=24000]`), cut.slice(-200));
  assert.ok(Buffer.byteLength(cut, "utf8") < 60_000);
  const rest = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa", from: 24_000 }));
  assert.ok(rest.endsWith(`---\n${"é".repeat(24_000)}\n[chars 24000–48000 of 48000, the end]`), rest.slice(-120));
  assert.ok(rest.startsWith(`cite: ${entry.citation}\nentry ke_aaaaaaaaaaaa`), "reading on keeps the head and citation");
  assert.ok(!rest.includes("Concepts:"), "reading on shows the body, not the neighbours again");
  assert.match(textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa", from: 100_000 })), /\[from=100000 is past the end: the body has 48000 chars\]$/);
  assert.equal(api.calls.filter((call) => call.path === knowledgeRoutes.item("ke_aaaaaaaaaaaa")).length, 3);

  // Four bytes and two UTF-16 units a character: a window never splits a surrogate pair, at either end.
  serve("😀".repeat(20_000));
  const emoji = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  assert.ok(emoji.endsWith(`${"😀".repeat(12_000)}\n[chars 0–24000 of 40000 — continue with from=24000]`), emoji.slice(-80));
  const odd = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa", from: 24_001 }));
  assert.ok(odd.endsWith(`---\n${"😀".repeat(8_000)}\n[chars 24000–40000 of 40000, the end]`), "a start inside a pair moves back to the pair");
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
    assert.ok(out.startsWith("Updated title, body, author, handle, url, collections."), out);
    for (const value of ["ke_aaaaaaaaaaaa", "SEO", "Ads", "linking pending", "Title: Playbook v2", `cite: ${entry.citation}`]) assert.ok(out.includes(value), value);
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
  assert.ok(out.startsWith("Deleted 1 entry; 1 not deleted."), out);
  assert.match(out, /- deleted ke_aaaaaaaaaaaa "Old playbook"/);
  assert.match(out, /- not deleted ke_hidden000000: No such entry\./);
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
  assert.match(textOf(r), /^No knowledge found \(over SEO, with these filters\)/);

  // Examples alone: no query; empty lists are not filters.
  await run(api, "knowledge_search", { similarTo: ["ke_aaaaaaaaaaaa"], kinds: [], collections: [] });
  assert.deepEqual(api.calls.filter((call) => call.path === knowledgeRoutes.search).at(-1)!.body, { sessionId: "chat-1", similarTo: ["ke_aaaaaaaaaaaa"] });
  assert.match(textOf(await run(api, "knowledge_search", { query: "x", sort: "newest" })), /^No knowledge found \(over SEO\)\./, "no filters, no filter advice");
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

test("knowledge_search: each entry hit shows its band and signals, title, snippet, passage and citation (never the matched terms); concept hits name their entries; the footer pages", async () => {
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
  assert.deepEqual(out.split("\n"), [
    "3 hits (over SEO, Ads). Read one whole with knowledge_get; cite each entry you use with its cite link, verbatim.",
    "Weak hits may be unrelated: never cite one as evidence.",
    "1. ke_aaaaaaaaaaaa · thread · Om Patel (@om_patel5) · 2026-10-11 · in SEO, Ads · strong · via keyword+meaning",
    '   "Alternatives pages"',
    '   Build a page per competitor: "[competitor] vs [you]" ranks fast.',
    "   passage: chars 120–480 (chunk 2/5)",
    `   cite: ${strong.citation}`,
    '2. concept tactic-alternatives "Alternatives pages" (Tactic) · entries ke_aaaaaaaaaaaa "Alternatives pages", ke_bbbbbbbbbbbb "Competitor pages"',
    "3. ke_wwwwwwwwwwww · note · Unfiled · linking pending · weak · via concept",
    '   "Paywall pricing"',
    "   Weekly plans convert.",
    `   cite: ${weak.citation}`,
    "Showing 1–2 of 31.",
    `Next page: cursor "${cursorAt(2)}".`,
    "Too many to read? Narrow it: a more specific query, collections, kinds, authors, years or dates."
  ]);

  // A later page counts from the cursor's offset; the last one has no next cursor.
  api.on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [response.hits[0]!], searched: ["kc_seo0000000"], total: 31, nextCursor: cursorAt(9) } });
  assert.match(textOf(await run(api, "knowledge_search", { query: "x", cursor: cursorAt(8) })), /\nShowing 9–9 of 31\.\nNext page: cursor "[^"]+"\.\nToo many/);
  api.on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [response.hits[0]!, response.hits[2]!], searched: ["kc_seo0000000"], total: 31, nextCursor: null } });
  const last = textOf(await run(api, "knowledge_search", { query: "x", cursor: "not-a-cursor" }));
  assert.match(last, /\nShowing 30–31 of 31\.\nToo many/, "the last page ends at the total even with an unreadable cursor");
  assert.doesNotMatch(last, /Next page/);
  api.on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [response.hits[0]!], searched: ["kc_seo0000000"], total: 31, nextCursor: "next" } });
  assert.match(textOf(await run(api, "knowledge_search", { query: "x", cursor: "not-a-cursor" })), /\nShowing 1 of 31\.\nNext page: cursor "next"\./);
  // Everything on one page: no hint, no cursor, no weak warning.
  api.on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [response.hits[0]!], searched: ["kc_seo0000000"], total: 1, nextCursor: null } });
  const one = textOf(await run(api, "knowledge_search", { query: "x" }));
  assert.ok(one.endsWith("\nShowing 1–1 of 1."), one);
  assert.doesNotMatch(one, /Weak hits|Next page|Too many/);
});

test("knowledge_search: an older daemon (no match, total, cursor or concept titles) renders without bands or a footer", async () => {
  const entry = meta();
  const response: KnowledgeSearchResponse = {
    hits: [
      { kind: "entry", score: 0.9, entry },
      { kind: "concept", score: 0.5, concept: { id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic", description: "Comparison pages." }, entryIds: ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"] }
    ],
    searched: ["kc_seo0000000"]
  };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.search, { status: 200, body: response });
  const out = textOf(await run(api, "knowledge_search", { query: "x" }));
  assert.ok(out.includes("\n1. ke_aaaaaaaaaaaa · thread · Om Patel (@om_patel5) · 2026-10-11 · in SEO, Ads\n"), out);
  assert.ok(out.endsWith('2. concept tactic-alternatives "Alternatives pages" (Tactic): Comparison pages. · entries ke_aaaaaaaaaaaa, ke_bbbbbbbbbbbb'), out);
  assert.doesNotMatch(out, /strong|good|weak|via |passage:|Showing|Next page/);
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
  const lines = out.split("\n");
  const from = lines.indexOf("Similar:");
  assert.ok(from > 0, out);
  assert.deepEqual(lines.slice(from + 1, from + 7), [
    '- ke_bbbbbbbbbbbb "Competitor pages" · meaning 0.91 · shares concepts Alternatives pages, SEO · same author',
    `  cite: ${similar[0]!.entry.citation}`,
    '- ke_cccccccccccc "Pricing pages" · shares concepts A, B, C +2 more',
    `  cite: ${similar[2]!.entry.citation}`,
    '- ke_eeeeeeeeeeee "Old notes" · same author',
    `  cite: ${similar[3]!.entry.citation}`
  ]);
  assert.equal(lines.filter((line) => line.startsWith("- ke_")).length, 8 + 1, "8 similar, then the duplicate");
  const dup = lines.findIndex((line) => line.startsWith("Possible duplicates"));
  assert.ok(dup > from, "duplicates after similar");
  assert.match(lines[dup]!, /knowledge_update/);
  assert.deepEqual(lines.slice(dup + 1, dup + 3), ['- ke_dddddddddddd "Same thread" (0.97)', `  cite: ${duplicate.entry.citation}`]);
  assert.equal(out.split("ke_dddddddddddd").length - 1, 2, "a duplicate is listed once (its id, and its citation)");
  assert.ok(!out.includes("Related") && !out.includes("ke_rrrrrrrrrrrr"), "similar replaces related");
  assert.ok(out.endsWith("---\nBody."));

  // A new daemon with nothing similar: no sections at all.
  api.on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: { ...detail, related: [], similar: [], possibleDuplicates: [] } } });
  assert.doesNotMatch(textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" })), /Similar|Related|Possible duplicates/);
});

test("knowledge_get: ids reads several at once — one request each, numbered, a refused one reported inline; all refused is the daemon's error", async () => {
  const entryDetail = (id: string, body: string): KnowledgeEntryDetail => {
    const entry = meta({ id, title: `Title ${id}` });
    return { entry: { ...entry, body }, concepts: [], related: [], citation: entry.citation };
  };
  const notFound = { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." } };
  const api = withCollections(new FakeDaemonApi())
    .on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: entryDetail("ke_aaaaaaaaaaaa", "short body") } })
    .on("GET", knowledgeRoutes.item("ke_bbbbbbbbbbbb"), { status: 200, body: { kind: "entry", entry: entryDetail("ke_bbbbbbbbbbbb", "b".repeat(100_000)) } })
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
  const sections = out.split(/\n\n(?==== )/);
  assert.equal(sections.length, 4, out.slice(0, 400));
  assert.ok(sections[0]!.startsWith("=== 1/4 ke_aaaaaaaaaaaa ===\ncite: ") && sections[0]!.endsWith("---\nshort body"), sections[0]);
  assert.equal(sections[1], "=== 2/4 ke_hidden000000 ===\nNot read: No such entry. (KNOWLEDGE_NOT_FOUND)");
  // The short body is whole; the long one gets the rest of the 48 000 bytes.
  assert.ok(sections[2]!.startsWith("=== 3/4 ke_bbbbbbbbbbbb ===") && sections[2]!.endsWith(`---\n${"b".repeat(47_990)}\n[chars 0–47990 of 100000 — continue with from=47990]`), sections[2]!.slice(-100));
  assert.ok(sections[3]!.startsWith('=== 4/4 tactic-x ===\nconcept tactic-x "X" (Tactic)'));

  const none = await run(api, "knowledge_get", { ids: ["ke_hidden000000", "ke_gone00000000"] });
  assert.equal(none.isError, true);
  assert.deepEqual(errorOf(none), { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." });
  // One id in ids reads like id; from reads on in it.
  const single = textOf(await run(api, "knowledge_get", { ids: ["ke_bbbbbbbbbbbb"], from: 99_990 }));
  assert.ok(single.startsWith("cite: ") && single.endsWith(`---\n${"b".repeat(10)}\n[chars 99990–100000 of 100000, the end]`), single.slice(-80));
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
  for (const id of ids) {
    const entry = meta({ id, title: "t".repeat(KNOWLEDGE_TITLE_MAX) });
    const similar = Array.from({ length: 8 }, (_, index): KnowledgeSimilarEntry => ({ entry: meta({ id: `ke_s${String(index).padStart(11, "0")}`, title: "s".repeat(KNOWLEDGE_TITLE_MAX) }), similarity: 0.9, reasons: [{ kind: "meaning", similarity: 0.9 }, { kind: "concepts", concepts: [{ id: "c", name: "n".repeat(500), type: "T" }], shared: 9 }, { kind: "author", value: "a" }] }));
    const detail: KnowledgeEntryDetail = {
      entry: { ...entry, body: "€".repeat(60_000) },
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
  assert.equal(entries.match(/continue with from=\d+\]/g)?.length, 5, "every body is cut, with its footer");
  assert.doesNotMatch(entries, /\ufffd/);
  assert.ok(!entries.includes("read fewer ids"), "the windows shrink instead: nothing else is cut");

  const huge = "word ".repeat(30_000);
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
  assert.ok(many.includes("=== 1/5 tactic-0 ==="));
  assert.ok(many.endsWith("\n[… the rest is cut at the result limit: read fewer ids at once]"), "the cut is said");
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
  const lines = out.split("\n");
  const at = lines.findIndex((line) => line.startsWith("- saved ke_aaaaaaaaaaaa"));
  assert.deepEqual(lines.slice(at + 1, at + 4), [
    '  possible duplicate of ke_cccccccccccc "Alternatives pages (copy)" (0.95) — if it is the same content, keep one (knowledge_update / knowledge_delete)',
    '  possible duplicate of ke_dddddddddddd "Comparison pages" (0.90) — if it is the same content, keep one (knowledge_update / knowledge_delete)',
    `- saved ke_eeeeeeeeeeee · in SEO · cite: ${saved.results[1]!.citation}`
  ]);
  assert.equal(out.match(/possible duplicate/g)?.length, 2, "only where the daemon named one");
});
