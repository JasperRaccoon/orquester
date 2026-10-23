import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseKnowledgeChangedEvent,
  parseKnowledgeCollectionsResponse,
  parseKnowledgeEntriesResponse,
  parseKnowledgeGraphResponse,
  parseKnowledgeItemResponse,
  parseKnowledgeLinkingState,
  parseKnowledgeSearchResponse,
  parseKnowledgeStatus
} from "./validate.ts";

const entryMeta = (overrides: Record<string, unknown> = {}) => ({
  id: "ke_aaaaaaaaaaaa",
  title: "Alternatives pages",
  kind: "post",
  author: "Hridoy",
  handle: "hridoyreh",
  url: null,
  postedAt: "2026-10-11",
  savedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  savedFrom: { by: "agent", sessionId: "s1" },
  collections: ["kc_seo"],
  contentHash: "abc",
  linkState: "linked",
  ...overrides
});

describe("knowledge wire validation", () => {
  it("keeps readable collections, repairs fields, and drops unreadable ones", () => {
    const parsed = parseKnowledgeCollectionsResponse({
      collections: [
        { id: "kc_seo", name: "SEO", description: "Search", color: "chart-2", entryCount: 3, profiles: [{ id: "p1", name: "SaaS expert" }, { bad: true }] },
        { id: "kc_new", name: "Ads", color: "chart-9", entryCount: -2 },
        { name: "no id" },
        "junk"
      ],
      unfiledCount: 1,
      totalEntries: 4
    });
    assert.ok(parsed);
    assert.deepEqual(
      parsed.collections.map((c) => [c.id, c.color, c.entryCount, c.description, c.profiles.length]),
      [
        ["kc_seo", "chart-2", 3, "Search", 1],
        ["kc_new", "chart-1", 0, "", 0]
      ]
    );
    assert.equal(parsed.totalEntries, 4);
    assert.equal(parseKnowledgeCollectionsResponse({ collections: "nope" }), null);
    assert.equal(parseKnowledgeCollectionsResponse(null), null);
  });

  it("totals the entries itself when the daemon left the total out", () => {
    const parsed = parseKnowledgeCollectionsResponse({ collections: [{ id: "a", name: "A", entryCount: 2 }], unfiledCount: 1 });
    assert.equal(parsed?.totalEntries, 3);
  });

  it("reads entry pages, defaulting what an entry may lack and keeping a citation", () => {
    const parsed = parseKnowledgeEntriesResponse({
      entries: [entryMeta({ kind: "", linkState: "weird", author: "", snippet: "Make one page per competitor", linkCount: 4 }), { title: "no id" }],
      nextCursor: "c2"
    });
    assert.ok(parsed);
    assert.equal(parsed.entries.length, 1);
    const [entry] = parsed.entries;
    assert.equal(entry!.kind, "note");
    assert.equal(entry!.linkState, "pending");
    assert.equal(entry!.author, null);
    assert.equal(entry!.linkCount, 4);
    assert.equal(entry!.citation, "[Alternatives pages · @hridoyreh](orquester-knowledge:entry/ke_aaaaaaaaaaaa)");
    assert.equal(parsed.nextCursor, "c2");
    assert.equal(parseKnowledgeEntriesResponse({ entries: [], nextCursor: "" })?.nextCursor, null);
  });

  it("drops duplicate nodes and edges whose ends are not in the graph", () => {
    const parsed = parseKnowledgeGraphResponse({
      nodes: [
        { id: "tactic-a", name: "A", type: "Tactic", confidence: 0.9, collections: ["kc_seo"], entryCount: 2, degree: 1 },
        { id: "tactic-a", name: "A again" },
        { id: "tool-b", name: "B", type: "Tool" }
      ],
      edges: [
        { id: "e1", type: "USES", from: "tactic-a", to: "tool-b", confidence: 0.8 },
        { id: "e2", type: "USES", from: "tactic-a", to: "missing" }
      ],
      truncated: true,
      totals: { nodes: 5000, edges: 9000 }
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.nodes.map((n) => n.name), ["A", "B"]);
    assert.deepEqual(parsed.edges.map((e) => e.id), ["e1"]);
    assert.equal(parsed.truncated, true);
    assert.deepEqual(parsed.totals, { nodes: 5000, edges: 9000 });
    assert.equal(parseKnowledgeGraphResponse({ nodes: [] }), null);
  });

  it("reads both kinds of item and refuses an unknown one", () => {
    const entry = parseKnowledgeItemResponse({
      kind: "entry",
      entry: {
        entry: { ...entryMeta(), body: "Full text" },
        concepts: [{ id: "tactic-a", name: "A", type: "Tactic" }],
        related: [entryMeta({ id: "ke_bbbbbbbbbbbb" }), entryMeta()],
        citation: "[x](orquester-knowledge:entry/ke_aaaaaaaaaaaa)"
      }
    });
    assert.equal(entry?.kind, "entry");
    if (entry?.kind === "entry") {
      assert.equal(entry.entry.entry.body, "Full text");
      assert.deepEqual(entry.entry.related.map((r) => r.id), ["ke_bbbbbbbbbbbb"], "an entry is not related to itself");
    }
    const concept = parseKnowledgeItemResponse({
      kind: "concept",
      concept: {
        concept: { id: "tactic-a", name: "A", type: "Tactic", confidence: 0.7, description: "", aliases: ["a"], attributes: { k: { value: "v", confidence: 1 }, bad: 3 } },
        collections: ["kc_seo"],
        entries: [entryMeta()],
        neighbors: [{ edge: { id: "e1", type: "USES", from: "tactic-a", to: "tool-b" }, concept: { id: "tool-b", name: "B", type: "Tool" } }, { edge: {} }]
      }
    });
    assert.equal(concept?.kind, "concept");
    if (concept?.kind === "concept") {
      assert.equal(concept.concept.concept.description, null);
      assert.deepEqual(Object.keys(concept.concept.concept.attributes), ["k"]);
      assert.equal(concept.concept.neighbors.length, 1);
    }
    assert.equal(parseKnowledgeItemResponse({ kind: "other" }), null);
    assert.equal(parseKnowledgeItemResponse({ kind: "entry", entry: { entry: entryMeta() } }), null, "an entry needs its body");
  });

  it("reads search hits of both kinds", () => {
    const parsed = parseKnowledgeSearchResponse({
      hits: [
        { kind: "entry", score: 0.9, entry: { ...entryMeta(), snippet: "…" } },
        { kind: "concept", score: 0.5, concept: { id: "tool-b", name: "B", type: "Tool", description: "A tool" }, entryIds: ["ke_aaaaaaaaaaaa", 3] },
        { kind: "other" }
      ],
      searched: ["kc_seo"]
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.hits.map((h) => h.kind), ["entry", "concept"]);
    const concept = parsed.hits[1];
    assert.ok(concept?.kind === "concept");
    assert.deepEqual(concept.entryIds, ["ke_aaaaaaaaaaaa"]);
    assert.equal(concept.concept.description, "A tool");
  });

  it("needs enabled and installed in a status, and repairs the rest", () => {
    assert.equal(parseKnowledgeStatus({ installed: true }), null);
    const status = parseKnowledgeStatus({
      enabled: true,
      installed: true,
      entries: 3,
      concepts: "x",
      linking: { state: "running", runId: "r1", mode: "update", step: "pass2", progress: { done: 12, total: 10 }, pendingEntries: 2 },
      recentRuns: [{ id: "r1", mode: "update", startedAt: "t", entries: 3, outcome: "running" }, {}],
      tokens: { week: { in: 10, out: 5 } }
    });
    assert.ok(status);
    assert.equal(status.concepts, 0);
    assert.deepEqual(status.linking, { state: "running", runId: "r1", mode: "update", step: "pass2", progress: { done: 10, total: 10 }, pendingEntries: 2 });
    assert.equal(status.recentRuns.length, 1);
    assert.deepEqual(status.tokens, { week: { in: 10, out: 5 }, total: { in: 0, out: 0 } });
    assert.equal(status.lastError, null);
  });

  it("reads an unknown linking state as idle and an unknown pause reason as an error", () => {
    assert.deepEqual(parseKnowledgeLinkingState({ state: "teleporting" }), { state: "idle" });
    assert.deepEqual(parseKnowledgeLinkingState({ state: "paused", reason: "solar-flare", message: "m", resumesAt: null, pendingEntries: 1 }), {
      state: "paused",
      reason: "error",
      message: "m",
      resumesAt: null,
      pendingEntries: 1
    });
  });

  it("reads a change event's fields and nothing else", () => {
    assert.deepEqual(parseKnowledgeChangedEvent({ entryIds: ["a", 1], graph: true, collections: "yes" }), { entryIds: ["a"], graph: true });
    assert.equal(parseKnowledgeChangedEvent("x"), null);
  });
});
