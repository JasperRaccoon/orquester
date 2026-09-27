import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SavedPrompt } from "@orquester/api";

import {
  createRequestFromDraft,
  duplicateRequest,
  duplicateTitle,
  initialDraft,
  insertAtSelection,
  parseTagsText,
  projectScopeAvailable,
  updatePatchFromDraft,
  validateSavedPromptDraft,
  type SavedPromptDraft
} from "./editor.logic.ts";

const PROJECT = "/w/acme/app";

function prompt(overrides: Partial<SavedPrompt> = {}): SavedPrompt {
  return {
    id: "p1",
    title: "Review current changes",
    description: "Review the diff",
    body: "Review {diff}",
    tags: ["Review"],
    projectPath: null,
    pinned: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    useCount: 0,
    ...overrides
  };
}

const draft = (overrides: Partial<SavedPromptDraft> = {}): SavedPromptDraft => ({
  title: "Title",
  description: "",
  tagsText: "",
  scope: "global",
  pinned: false,
  body: "Body",
  ...overrides
});

describe("tags", () => {
  it("splits on commas, trims, collapses spaces, drops empties and repeats", () => {
    assert.deepEqual(parseTagsText(" Review,  code   review ,, review, QA ,"), ["Review", "code review", "QA"]);
    assert.deepEqual(parseTagsText(""), []);
  });
});

describe("the draft a request opens with", () => {
  it("edit: the prompt as it is", () => {
    const editing = prompt({ projectPath: PROJECT, tags: ["a", "b"] });
    assert.deepEqual(initialDraft({ mode: "edit", projectPath: PROJECT, prompt: editing }), {
      title: editing.title,
      description: editing.description,
      tagsText: "a, b",
      scope: "project",
      pinned: true,
      body: editing.body
    });
  });

  it("create: the prefill, global unless a project scope can be had", () => {
    assert.deepEqual(initialDraft({ mode: "create", projectPath: null, initial: { body: "From history" } }), {
      title: "",
      description: "",
      tagsText: "",
      scope: "global",
      pinned: false,
      body: "From history"
    });
    assert.equal(
      initialDraft({ mode: "create", projectPath: PROJECT, initial: { scope: "project" } }).scope,
      "project"
    );
    assert.equal(
      initialDraft({ mode: "create", projectPath: null, initial: { scope: "project" } }).scope,
      "global",
      "no project to save to"
    );
  });

  it("'This project' is offered with an open project, or for a prompt already in one", () => {
    assert.equal(projectScopeAvailable({ mode: "create", projectPath: PROJECT }), true);
    assert.equal(projectScopeAvailable({ mode: "create", projectPath: null }), false);
    assert.equal(projectScopeAvailable({ mode: "create", projectPath: "" }), false);
    assert.equal(
      projectScopeAvailable({ mode: "edit", projectPath: null, prompt: prompt({ projectPath: PROJECT }) }),
      true
    );
  });
});

describe("validation", () => {
  it("a title and a body are required — as missing, not as errors", () => {
    const empty = validateSavedPromptDraft(draft({ title: "  ", body: " \n " }));
    assert.equal(empty.valid, false);
    assert.deepEqual(empty.missing, ["title", "body"]);
    assert.deepEqual(empty.errors, {});
    assert.equal(validateSavedPromptDraft(draft()).valid, true);
  });

  it("mirrors every limit", () => {
    const over = validateSavedPromptDraft(
      draft({
        title: "t".repeat(121),
        description: "d".repeat(301),
        tagsText: "a,b,c,d,e,f,g",
        body: "b".repeat(32_001)
      })
    );
    assert.equal(over.valid, false);
    assert.equal(over.errors.title, "At most 120 characters.");
    assert.equal(over.errors.description, "At most 300 characters.");
    assert.equal(over.errors.tags, "At most 6 tags.");
    assert.equal(over.errors.body, "At most 32,000 characters.");
    const longTag = validateSavedPromptDraft(draft({ tagsText: `ok, ${"x".repeat(25)}` }));
    assert.match(longTag.errors.tags ?? "", /longer than 24 characters/);
    const atLimits = validateSavedPromptDraft(
      draft({ title: "t".repeat(120), description: "d".repeat(300), tagsText: "a,b,c,d,e,f", body: "b".repeat(32_000) })
    );
    assert.equal(atLimits.valid, true, "the limits themselves are allowed");
  });
});

describe("what a save sends", () => {
  it("a create: the whole record, normalised; This project = the open project", () => {
    assert.deepEqual(
      createRequestFromDraft(
        draft({
          title: "  Fix tests ",
          description: " Find the\nroot cause ",
          tagsText: "tests, fix",
          scope: "project",
          pinned: true,
          body: "  Run {changedFiles}  "
        }),
        PROJECT
      ),
      {
        title: "Fix tests",
        description: "Find the root cause",
        tags: ["tests", "fix"],
        projectPath: PROJECT,
        pinned: true,
        body: "  Run {changedFiles}  "
      }
    );
    assert.equal(createRequestFromDraft(draft({ scope: "project" }), null).projectPath, null);
  });

  it("an edit: only the fields that changed", () => {
    const original = prompt();
    assert.deepEqual(updatePatchFromDraft(original, initialDraft({ mode: "edit", projectPath: PROJECT, prompt: original }), PROJECT), {});
    assert.deepEqual(
      updatePatchFromDraft(
        original,
        { ...initialDraft({ mode: "edit", projectPath: PROJECT, prompt: original }), title: "Renamed ", tagsText: "Review, QA", pinned: false },
        PROJECT
      ),
      { title: "Renamed", tags: ["Review", "QA"], pinned: false }
    );
  });

  it("an edit moves a prompt only when its scope changes — and to the open project", () => {
    const global = prompt();
    const projectPrompt = prompt({ projectPath: "/w/acme/app/" });
    const base = (from: SavedPrompt) => initialDraft({ mode: "edit", projectPath: PROJECT, prompt: from });
    assert.deepEqual(updatePatchFromDraft(global, { ...base(global), scope: "project" }, PROJECT), {
      projectPath: PROJECT
    });
    assert.deepEqual(updatePatchFromDraft(projectPrompt, { ...base(projectPrompt), scope: "global" }, PROJECT), {
      projectPath: null
    });
    assert.deepEqual(
      updatePatchFromDraft(projectPrompt, base(projectPrompt), "/w/acme/elsewhere"),
      {},
      "a kept scope never re-homes the prompt"
    );
  });
});

describe("duplicate", () => {
  it("adds (copy) and keeps it within the title limit", () => {
    assert.equal(duplicateTitle("Plan before coding"), "Plan before coding (copy)");
    const long = duplicateTitle("x".repeat(120));
    assert.equal(long.length, 120);
    assert.ok(long.endsWith(" (copy)"));
  });

  it("never cuts an emoji in half", () => {
    // 120 − " (copy)".length = 113 units of room: 112 x's, then a surrogate
    // pair (2 units) that would straddle the cut.
    const title = `${"x".repeat(112)}😀${"y".repeat(20)}`;
    const copy = duplicateTitle(title);
    assert.ok(copy.length <= 120, "within the limit, in UTF-16 units");
    assert.equal(copy, `${"x".repeat(112)} (copy)`, "the emoji that would not fit whole is dropped whole");
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(copy), "no lone high surrogate");
    // One that fits whole stays.
    const fits = duplicateTitle(`${"x".repeat(111)}😀${"y".repeat(20)}`);
    assert.equal(fits, `${"x".repeat(111)}😀 (copy)`);
    assert.equal(fits.length, 120);
  });

  it("opens a prefilled create in the prompt's own scope", () => {
    const source = prompt({ projectPath: PROJECT, tags: ["a"] });
    const request = duplicateRequest(source, PROJECT);
    assert.deepEqual(request, {
      mode: "create",
      projectPath: PROJECT,
      initial: {
        title: "Review current changes (copy)",
        body: source.body,
        description: source.description,
        tags: ["a"],
        scope: "project"
      }
    });
    assert.notEqual(request.mode === "create" ? request.initial?.tags : null, source.tags, "a copy of the tags");
  });
});

describe("a variable chip lands at the caret", () => {
  it("inserts at the caret, or over the selection, and puts the caret after it", () => {
    assert.deepEqual(insertAtSelection("Review  now", 7, 7, "{diff}"), { text: "Review {diff} now", caret: 13 });
    assert.deepEqual(insertAtSelection("Review THIS", 7, 11, "{diff}"), { text: "Review {diff}", caret: 13 });
    assert.deepEqual(insertAtSelection("abc", 99, 99, "{x}"), { text: "abc{x}", caret: 6 });
    assert.deepEqual(insertAtSelection("abc", 2, 1, "{x}"), { text: "ab{x}c", caret: 5 });
  });
});
