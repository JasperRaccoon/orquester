import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SavedPrompt } from "@orquester/api";

import {
  belongsToProject,
  foldSearchText,
  matchesSearch,
  normalizeProjectPath,
  promptContextLine,
  promptsForProject,
  promptsInScope,
  savedPromptSections,
  savedPromptsEmptyState,
  savedPromptsLoadErrorLine,
  searchWords
} from "./list.logic.ts";

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

describe("project paths", () => {
  it("strips trailing separators and keeps the root", () => {
    assert.equal(normalizeProjectPath("/w/acme/app/"), "/w/acme/app");
    assert.equal(normalizeProjectPath("/w/acme/app//"), "/w/acme/app");
    assert.equal(normalizeProjectPath("C:\\w\\app\\"), "C:\\w\\app");
    assert.equal(normalizeProjectPath("/"), "/");
    assert.equal(normalizeProjectPath(""), "");
  });

  it("a prompt belongs to a project whatever trailing slash either side has", () => {
    assert.equal(belongsToProject({ projectPath: "/w/acme/app/" }, PROJECT), true);
    assert.equal(belongsToProject({ projectPath: PROJECT }, "/w/acme/app/"), true);
    assert.equal(belongsToProject({ projectPath: "/w/acme/app2" }, PROJECT), false);
    assert.equal(belongsToProject({ projectPath: null }, PROJECT), false, "global is not the project's own");
    assert.equal(belongsToProject({ projectPath: PROJECT }, ""), false, "no project open");
  });
});

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
    assert.deepEqual(ids(promptsInScope(list, "all", PROJECT)), ["global", "mine"]);
    assert.deepEqual(ids(promptsInScope(list, "project", PROJECT)), ["mine"]);
    assert.deepEqual(ids(promptsInScope(list, "project", "")), []);
  });
});

describe("search", () => {
  it("folds case and accents", () => {
    assert.equal(foldSearchText("Révision ÉTÉ"), "revision ete");
    assert.deepEqual(searchWords("  Résumé   the  DIFF "), ["resume", "the", "diff"]);
    assert.deepEqual(searchWords("   "), []);
  });

  it("folds the letters no decomposition takes apart: ł, ø, ß and their capitals", () => {
    assert.equal(foldSearchText("Łódź"), "lodz");
    assert.equal(foldSearchText("ØRESUND øl"), "oresund ol");
    assert.equal(foldSearchText("Straße STRASSE ẞ"), "strasse strasse ss");
    const entry = prompt({ id: "p", title: "Große Łódź-Prüfung", tags: ["Ørsted"] });
    for (const query of ["grosse", "GROSSE", "lodz", "prufung", "orsted"]) {
      assert.equal(matchesSearch(entry, searchWords(query)), true, query);
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
      assert.equal(matchesSearch(entry, searchWords(query)), true, query);
    }
    assert.equal(matchesSearch(entry, searchWords("missing")), false);
  });

  it("every word must match, each anywhere", () => {
    const entry = prompt({ id: "p", title: "Fix failing tests", body: "Find the root cause" });
    assert.equal(matchesSearch(entry, searchWords("fix root")), true, "title word + body word");
    assert.equal(matchesSearch(entry, searchWords("fix deploy")), false);
    assert.equal(matchesSearch(entry, searchWords("")), true, "a blank query matches everything");
  });

  it("an edited record is searched by its new text", () => {
    const before = prompt({ id: "p", title: "Alpha" });
    assert.equal(matchesSearch(before, ["alpha"]), true);
    const after = { ...before, title: "Beta" };
    assert.equal(matchesSearch(after, ["alpha"]), false);
    assert.equal(matchesSearch(after, ["beta"]), true);
  });
});

describe("sections and order", () => {
  const list = [
    prompt({ id: "zeta", title: "Zeta", pinned: true }),
    prompt({ id: "alpha", title: "alpha", pinned: true }),
    prompt({ id: "a10", title: "Item 10", pinned: true }),
    prompt({ id: "a9", title: "Item 9", pinned: true }),
    prompt({ id: "never", title: "Never used", updatedAt: "2026-09-05T00:00:00.000Z" }),
    prompt({ id: "old-edit", title: "Old edit", updatedAt: "2026-09-02T00:00:00.000Z" }),
    prompt({ id: "used-late", title: "Used late", lastUsedAt: "2026-09-20T00:00:00.000Z" }),
    prompt({ id: "used-early", title: "Used early", lastUsedAt: "2026-09-10T00:00:00.000Z" }),
    prompt({ id: "b-tie", title: "B tie", updatedAt: "2026-09-02T00:00:00.000Z" }),
    prompt({ id: "elsewhere", projectPath: "/w/acme/other", pinned: true })
  ];

  it("pinned first, alphabetical (case-insensitive, numeric-aware)", () => {
    const sections = savedPromptSections(list, { scope: "all", projectPath: PROJECT, query: "" });
    assert.deepEqual(ids(sections.pinned), ["alpha", "a9", "a10", "zeta"]);
  });

  it("the rest: last used first, never used after, then last edited, then title", () => {
    const sections = savedPromptSections(list, { scope: "all", projectPath: PROJECT, query: "" });
    assert.deepEqual(ids(sections.others), ["used-late", "used-early", "never", "b-tie", "old-edit"]);
    assert.equal(sections.inScope, 9, "another project's prompt is not in scope");
  });

  it("the search filters both sections; inScope counts before it", () => {
    const sections = savedPromptSections(list, { scope: "all", projectPath: PROJECT, query: "used" });
    assert.deepEqual(ids(sections.pinned), []);
    assert.deepEqual(ids(sections.others), ["used-late", "used-early", "never"]);
    assert.equal(sections.inScope, 9);
  });
});

describe("the Context line", () => {
  it("names the git context a body reads, in first-use order", () => {
    assert.equal(promptContextLine("Review {diff} on {branch}"), "Context: current diff, branch");
    assert.equal(promptContextLine("{changedFiles}\n{diff}"), "Context: changed files, current diff");
    assert.equal(promptContextLine("{branch} {branch}"), "Context: branch");
  });

  it("is absent without git variables — other variables and escapes do not count", () => {
    assert.equal(promptContextLine("Hello {project} at {time}"), null);
    assert.equal(promptContextLine("Literal {{diff}} and {unknown}"), null);
    assert.equal(promptContextLine(""), null);
  });
});

describe("the load-error line over shown rows", () => {
  it("says refresh only for rows that were loaded", () => {
    assert.equal(savedPromptsLoadErrorLine("loaded", "offline"), "Couldn't refresh saved prompts: offline");
    assert.equal(
      savedPromptsLoadErrorLine("error", "offline"),
      "Couldn't load saved prompts: offline",
      "a first load that failed under rows that arrived by event"
    );
    assert.equal(savedPromptsLoadErrorLine("loaded", null), null);
    assert.equal(savedPromptsLoadErrorLine("loading", null), null);
  });
});

describe("empty states", () => {
  const none = { pinned: [], others: [], inScope: 0 };
  const base = { error: null, scope: "all" as const, sections: none, query: "" };

  it("rows win over every empty state", () => {
    const sections = { pinned: [prompt({ id: "p" })], others: [], inScope: 1 };
    assert.equal(savedPromptsEmptyState({ ...base, status: "loading", sections }), null);
    assert.equal(savedPromptsEmptyState({ ...base, status: "error", error: "x", sections }), null);
  });

  it("loading, then a load error, then the scope's own emptiness", () => {
    assert.deepEqual(savedPromptsEmptyState({ ...base, status: "loading" }), { kind: "loading" });
    assert.deepEqual(savedPromptsEmptyState({ ...base, status: "error", error: "boom" }), {
      kind: "error",
      message: "boom"
    });
    assert.deepEqual(savedPromptsEmptyState({ ...base, status: "loaded" }), { kind: "none" });
    assert.deepEqual(savedPromptsEmptyState({ ...base, status: "loaded", scope: "project" }), {
      kind: "no-project-prompts"
    });
  });

  it("a search with nothing matching says so, with the query as typed", () => {
    assert.deepEqual(
      savedPromptsEmptyState({
        ...base,
        status: "loaded",
        sections: { pinned: [], others: [], inScope: 3 },
        query: "  deploy "
      }),
      { kind: "no-matches", query: "deploy" }
    );
  });
});
