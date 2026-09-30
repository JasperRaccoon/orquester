import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SavedPrompt } from "@orquester/api";

import {
  createRequestFromDraft,
  duplicateRequest,
  initialDraft,
  insertAtSelection,
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
    assert.deepEqual(Object.keys(over.errors).sort(), ["body", "description", "tags", "title"]);
    const longTag = validateSavedPromptDraft(draft({ tagsText: `ok, ${"x".repeat(25)}` }));
    assert.equal(longTag.valid, false);
    assert.ok(longTag.errors.tags);
    const atLimits = validateSavedPromptDraft(
      draft({ title: "t".repeat(120), description: "d".repeat(300), tagsText: `${"x".repeat(24)},b,c,d,e,f`, body: "b".repeat(32_000) })
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
          tagsText: " tests, fix, TESTS, code   review, ,",
          scope: "project",
          pinned: true,
          body: "  Run {changedFiles}  "
        }),
        PROJECT
      ),
      {
        title: "Fix tests",
        description: "Find the root cause",
        tags: ["tests", "fix", "code review"],
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
  it("never cuts an emoji in half", () => {
    for (const prefixLength of [111, 112]) {
      const request = duplicateRequest(prompt({ title: `${"x".repeat(prefixLength)}😀${"y".repeat(20)}` }), PROJECT);
      assert.equal(request.mode, "create");
      const title = request.mode === "create" ? request.initial?.title ?? "" : "";
      assert.ok(title.length > 0 && title.length <= 120);
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title), "no lone high surrogate");
    }
  });
});

describe("a variable chip lands at the caret", () => {
  it("inserts at the caret, or over the selection, and puts the caret after it", () => {
    assert.deepEqual(insertAtSelection("Review  now", 7, 7, "{diff}"), { text: "Review {diff} now", caret: 13 });
    assert.deepEqual(insertAtSelection("Review THIS", 7, 11, "{diff}"), { text: "Review {diff}", caret: 13 });
  });
});
