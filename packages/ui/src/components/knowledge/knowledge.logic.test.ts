import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KNOWLEDGE_COLORS } from "@orquester/api";

import { entry } from "../../lib/knowledge/fixtures.test-helpers.ts";
import {
  collectionFormError,
  deleteCollectionMessage,
  entryByline,
  entryFormOf,
  entryFormPatch,
  entryPostUrl,
  formatKnowledgeDate,
  knowledgeColorCss,
  knowledgeCountsText,
  knowledgeErrorCode,
  knowledgeErrorText,
  linkingView,
  nextKnowledgeColor,
  patchNeedsLinking
} from "./knowledge.logic.ts";

describe("knowledge colours", () => {
  it("map palette keys to the theme's lane colours", () => {
    assert.equal(knowledgeColorCss("chart-3"), "rgb(var(--lane-3))");
  });

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
  it("counts with singular and plural", () => {
    assert.equal(knowledgeCountsText({ entries: 1, concepts: 1200, collections: 0 }), "1 entry · 1,200 concepts · 0 collections");
  });

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

  it("explains what deleting does to the entries", () => {
    assert.match(deleteCollectionMessage({ name: "SEO", entryCount: 3 }), /Its 3 entries lose the label; an entry with no other collection becomes Unfiled/);
    assert.match(deleteCollectionMessage({ name: "SEO", entryCount: 0 }), /It has no entries\. No entry is deleted\./);
  });
});

describe("entry display", () => {
  it("shows who and when", () => {
    assert.equal(entryByline({ author: "Om Patel", handle: "om_patel5" }), "Om Patel · @om_patel5");
    assert.equal(entryByline({ author: null, handle: null }), null);
    assert.equal(formatKnowledgeDate("2026-10-11"), "Oct 11, 2026");
    assert.equal(formatKnowledgeDate("last week"), "last week");
    assert.equal(formatKnowledgeDate(null), null);
  });

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

  it("knows a relabel alone does not re-link", () => {
    assert.equal(patchNeedsLinking({ collections: ["kc_ads"] }), false);
    assert.equal(patchNeedsLinking({ collections: ["kc_ads"], body: "x" }), true);
  });
});
