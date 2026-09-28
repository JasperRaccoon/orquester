import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SavedPrompt } from "@orquester/api";
import { promptsForProject, savedPromptSections, type SavedPromptScopeFilter } from "./list.logic.ts";

const PROJECT = "/w/acme/app";

function prompt(overrides: Partial<SavedPrompt> & { id: string }): SavedPrompt {
  return {
    title: overrides.id,
    description: "",
    body: "",
    tags: [],
    projectPath: null,
    pinned: false,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: null,
    useCount: 0,
    ...overrides
  };
}

const ids = (list: readonly SavedPrompt[]): string[] => list.map((entry) => entry.id);

function listed(prompts: SavedPrompt[], query = "", scope: SavedPromptScopeFilter = "all", projectPath = PROJECT): string[] {
  const sections = savedPromptSections(prompts, { query, scope, projectPath });
  return ids([...sections.pinned, ...sections.others]);
}

describe("scopes", () => {
  const list = [
    prompt({ id: "global" }),
    prompt({ id: "mine", projectPath: `${PROJECT}/` }),
    prompt({ id: "other", projectPath: "/w/acme/other" })
  ];

  it("the project can use every global prompt and its own, never another project's", () => {
    assert.deepEqual(ids(promptsForProject(list, PROJECT)), ["global", "mine"]);
    assert.deepEqual(ids(promptsForProject(list, "")), ["global"], "no project: global only");
  });

  it("All is global + this project's; Project is this project's only", () => {
    assert.deepEqual(listed(list), ["global", "mine"]);
    assert.deepEqual(listed(list, "", "project"), ["mine"]);
    assert.deepEqual(listed(list, "", "project", ""), []);
  });
});

describe("search", () => {
  it("folds the letters no decomposition takes apart: ł, ø, ß and their capitals", () => {
    const entry = prompt({ id: "p", title: "Große Łódź-Prüfung", tags: ["Ørsted"] });
    for (const query of ["grosse", "GROSSE", "lodz", "prufung", "orsted"]) {
      assert.deepEqual(listed([entry], query), ["p"], query);
    }
  });

  it("matches title, description, tags and body, case- and accent-insensitively", () => {
    const entry = prompt({
      id: "p",
      title: "Réviser le code",
      description: "Find regressions",
      tags: ["Review", "QA"],
      body: "Look at {diff} carefully"
    });
    for (const query of ["reviser", "RÉVISER", "regressions", "review", "qa", "carefully", "{diff}"]) {
      assert.deepEqual(listed([entry], query), ["p"], query);
    }
    assert.deepEqual(listed([entry], "missing"), []);
  });

  it("every word must match, each anywhere", () => {
    const entry = prompt({ id: "p", title: "Fix failing tests", body: "Find the root cause" });
    assert.deepEqual(listed([entry], "fix root"), ["p"], "title word + body word");
    assert.deepEqual(listed([entry], "fix deploy"), []);
    assert.deepEqual(listed([entry], ""), ["p"], "a blank query matches everything");
  });

  it("an edited record is searched by its new text", () => {
    const before = prompt({ id: "p", title: "Alpha" });
    assert.deepEqual(listed([before], "alpha"), ["p"]);
    const after = { ...before, title: "Beta" };
    assert.deepEqual(listed([after], "alpha"), []);
    assert.deepEqual(listed([after], "beta"), ["p"]);
  });
});

it("favorites are separated from unpinned prompts", () => {
  const sections = savedPromptSections([
    prompt({ id: "ordinary" }),
    prompt({ id: "favorite", pinned: true })
  ], { scope: "all", projectPath: PROJECT, query: "" });
  assert.deepEqual(ids(sections.pinned), ["favorite"]);
  assert.deepEqual(ids(sections.others), ["ordinary"]);
});
