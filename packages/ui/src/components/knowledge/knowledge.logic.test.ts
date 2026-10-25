import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KNOWLEDGE_COLORS } from "@orquester/api";

import { entry } from "../../lib/knowledge/fixtures.test-helpers.ts";
import {
  collectionFormError,
  entryFormOf,
  entryFormPatch,
  entryPostUrl,
  knowledgeErrorCode,
  knowledgeErrorText,
  linkingView,
  nextKnowledgeColor,
  patchNeedsLinking
} from "./knowledge.logic.ts";

describe("knowledge colours", () => {

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

  it("does not call idle linking complete while some entries failed", () => {
    const now = Date.parse("2026-10-20T10:00:00Z");
    const allLinked = linkingView({ state: "idle" }, [], now, 0);
    assert.equal(allLinked.tone, "idle");
    assert.equal(allLinked.detail, "Every entry is linked.");

    const failed = linkingView({ state: "idle" }, [], now, 3);
    assert.equal(failed.tone, "failed");
    assert.equal(failed.label, "3 entries could not be linked");
    assert.equal(failed.detail, "See Settings → Plugins → Knowledge Graph for the last error.");
    assert.doesNotMatch(`${failed.label} ${failed.detail}`, /Every entry is linked/);
    assert.equal(linkingView({ state: "idle" }, [], now, 1).label, "1 entry could not be linked");
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
});

describe("entry display", () => {

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

  it("refuses before sending what the daemon refuses: an empty title, a date that is not ISO", () => {
    const original = entry();
    assert.deepEqual(entryFormPatch(original, { ...entryFormOf(original), title: "  " }), { error: "Give the entry a title." });
    for (const postedAt of ["Oct 11 2026", "2026/10/11", "11-10-2026"]) {
      assert.ok("error" in entryFormPatch(original, { ...entryFormOf(original), postedAt }), postedAt);
    }
    for (const postedAt of ["2026-10-12", "2026-10-12T09:30", "2026-10-12T09:30:00.000Z", "2026-10-12T09:30:00+02:00"]) {
      assert.deepEqual(entryFormPatch(original, { ...entryFormOf(original), postedAt }), { patch: { postedAt } }, postedAt);
    }
  });

  it("knows a relabel alone does not re-link", () => {
    assert.equal(patchNeedsLinking({ collections: ["kc_ads"] }), false);
    assert.equal(patchNeedsLinking({ collections: ["kc_ads"], body: "x" }), true);
    // The URL is metadata myKG never reads (the daemon files it as a relabel): no re-link.
    assert.equal(patchNeedsLinking({ url: "https://x.com/a/status/1" }), false);
    assert.equal(patchNeedsLinking({ url: null, collections: [] }), false);
    assert.equal(patchNeedsLinking({ url: null, title: "New title" }), true);
  });
});
