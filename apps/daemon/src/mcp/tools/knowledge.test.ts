/**
 * The knowledge tools (Knowledge Graph plugin spec, "Agent tools", "Citations"), through the
 * executor: inputs mirror the contract's limits, every request names the calling session, results
 * are compact text with collections by name and each entry's citation, and the daemon's refusals
 * (plugin off, not a worker, an invalid worker answer) come back as clean tool errors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  KNOWLEDGE_ENTRY_MAX_BYTES,
  KNOWLEDGE_SAVE_MAX_ENTRIES,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  knowledgeCitation,
  knowledgeRoutes,
  type KnowledgeCollectionsResponse,
  type KnowledgeEntryDetail,
  type KnowledgeEntrySummary,
  type KnowledgeSaveResponse,
  type KnowledgeSearchResponse
} from "@orquester/api";

import type { ThreadCaller } from "../catalog/contract.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";
import { KNOWLEDGE_GET_BODY_MAX_BYTES } from "./knowledge.ts";

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
  const response: KnowledgeSearchResponse = {
    hits: [
      { kind: "entry", score: 0.9, entry: meta() },
      { kind: "concept", score: 0.5, concept: { id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic", description: "Pages comparing a product with a competitor." }, entryIds: ["ke_aaaaaaaaaaaa"] }
    ],
    searched: ["kc_seo0000000", "kc_ads0000000"]
  };
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.search, { status: 200, body: response });
  const r = await run(api, "knowledge_search", { query: "  ranking in ChatGPT ", collections: ["SEO", "SEO"], limit: 5 });
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(api.calls.find((call) => call.path === knowledgeRoutes.search)!.body, { query: "ranking in ChatGPT", sessionId: "chat-1", collections: ["SEO"], limit: 5 });
  const out = textOf(r);
  assert.match(out, /^2 hits \(over SEO, Ads\)/);
  assert.match(out, /1\. ke_aaaaaaaaaaaa · thread · Om Patel \(@om_patel5\) · 2026-10-11 · in SEO, Ads\n/);
  assert.match(out, /   Build a page per competitor: "\[competitor\] vs \[you\]" ranks fast\.\n/, "the snippet is one line");
  assert.ok(out.includes(`   cite: ${knowledgeCitation(meta())}`));
  assert.match(out, /2\. concept tactic-alternatives "Alternatives pages" \(Tactic\): Pages comparing a product with a competitor\. · entries ke_aaaaaaaaaaaa/);
  assert.doesNotMatch(out, /"score"|savedFrom|contentHash/, "never the full objects");
});

test("knowledge_search: nothing found says so; the limits are the contract's", async () => {
  const api = withCollections(new FakeDaemonApi()).on("POST", knowledgeRoutes.search, { status: 200, body: { hits: [], searched: ["kc_seo0000000"] } });
  assert.match(textOf(await run(api, "knowledge_search", { query: "x" })), /^No knowledge found \(over SEO\)/);
  for (const args of [{ query: "" }, { query: "   " }, { query: "x", limit: KNOWLEDGE_SEARCH_MAX_LIMIT + 1 }, { query: "x", limit: 0 }, { query: "x".repeat(2_001) }, { query: "x", collections: ["c".repeat(65)] }, { query: "x", sessionId: "other" }]) {
    assert.equal(errorOf(await run(api, "knowledge_search", args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 60));
  }
});

test("knowledge_get: the entry whole with its citation, concepts and related entries; the session in the query; a long body is cut", async () => {
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
  assert.ok(out.startsWith(`cite: ${entry.citation}\nentry ke_aaaaaaaaaaaa · thread · Om Patel (@om_patel5) · 2026-10-11 · in SEO, Ads · linking pending\n`), out);
  assert.match(out, /URL: https:\/\/x\.com\/om_patel5\/status\/1/);
  assert.match(out, /Concepts: Alternatives pages \(Tactic\) \[tactic-alternatives\]/);
  assert.match(out, /- ke_bbbbbbbbbbbb · thread · @hridoyreh · 2026-10-11 · in kc_gone000000\n  cite: \[Competitor pages · @hridoyreh\]/, "an unknown collection shows its id");
  assert.ok(out.endsWith("---\nLine one.\nLine two."));

  const long = { ...detail, entry: { ...detail.entry, body: "é".repeat(KNOWLEDGE_GET_BODY_MAX_BYTES) } };
  api.on("GET", knowledgeRoutes.item("ke_aaaaaaaaaaaa"), { status: 200, body: { kind: "entry", entry: long } });
  const cut = textOf(await run(api, "knowledge_get", { id: "ke_aaaaaaaaaaaa" }));
  assert.match(cut, new RegExp(`\\[… ${KNOWLEDGE_GET_BODY_MAX_BYTES} more bytes not shown\\]$`));
  assert.ok(Buffer.byteLength(cut, "utf8") < 60_000);
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
  assert.match(out, /^concept tactic-alternatives "Alternatives pages" \(Tactic\) · confidence 0\.91 · in SEO\nAliases: vs pages\nComparison pages\.\nAttributes: channel: SEO\nEntries:\n- ke_aaaaaaaaaaaa/);
  assert.match(out, /Links:\n- uses → Ahrefs \(Tool\) \[tool-ahrefs\]$/);
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
    assert.match(out, /^Saved 1 entry, 1 already saved; linking queued\.\nCreated collection "AI search": tell the user\.\n/);
    assert.ok(out.includes(`- saved ke_aaaaaaaaaaaa · in SEO, AI search · cite: ${meta().citation}`));
    assert.match(out, /- already saved as ke_bbbbbbbbbbbb \(new collections added\) · in Ads · cite: \[Old\]/);
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

test("knowledge_collections: every collection by name, count and description", async () => {
  const api = withCollections(new FakeDaemonApi());
  const out = textOf(await run(api, "knowledge_collections", {}));
  assert.equal(out, "2 collections, 52 entries (3 unfiled).\n- SEO (40): Ranking in search engines.\n- Ads (9): Paid acquisition.");
  api.on("GET", knowledgeRoutes.collections, { status: 200, body: { collections: [], unfiledCount: 0, totalEntries: 0 } });
  assert.match(textOf(await run(api, "knowledge_collections", {})), /None yet: knowledge_save can create one/);
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
  assert.match(first, /^Task t1 · step pass2 · answer ≤ 4000 tokens · 5 more waiting\nInstructions:\nExtract concepts as JSON\.\n\nInput:\nAuthor: Om Patel/);
  assert.match(first, /knowledge_worker_submit: taskId "t1"/);

  const next = await run(api, "knowledge_worker_submit", { taskId: "t1", answer: '{"nodes": []}' });
  assert.equal(next.isError, undefined, textOf(next));
  assert.deepEqual(api.calls.at(-1)!.body, { sessionId: "chat-1", taskId: "t1", answer: '{"nodes": []}' });
  assert.match(textOf(next), /^Accepted\.\nTask t2 · step pass2 .*\nInstructions: the same as task t1\.\n/);

  const refused = await run(api, "knowledge_worker_submit", { taskId: "t2", answer: "nodes: []" });
  assert.equal(refused.isError, true);
  assert.equal(errorOf(refused).code, "KNOWLEDGE_INVALID");
  assert.match(errorOf(refused).message, /task t2 was refused: Unexpected token 'n' at position 0\. Fix it and submit that task again\./);

  api.on("POST", knowledgeRoutes.workerNext, { status: 200, body: { kind: "done", reason: "session-budget" } });
  assert.equal(textOf(await run(api, "knowledge_worker_next_task", {})), "No task (session-budget). End your turn now.");
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
