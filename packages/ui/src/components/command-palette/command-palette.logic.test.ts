/**
 * The "go to" palette's ranking: whole, then start, then word-start, then
 * mid-word matches; the most recent breaks ties; the group holding the best
 * match leads; an empty query lists the most recent first.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectSummary, SessionSummary } from "../../types";
import {
  createRecencySnapshot,
  matchRanges,
  normalizeSearchText,
  paletteResults,
  rankField,
  rankFields,
  sessionRecency,
  type PaletteSession
} from "./command-palette.logic";

const project = (name: string, workspace = "main"): ProjectSummary =>
  ({ name, workspace, path: `/w/${workspace}/${name}`, isArchived: false }) as ProjectSummary;

let nextId = 0;
const session = (title: string, owner: ProjectSummary, createdAt = "2026-10-01T00:00:00.000Z"): PaletteSession => ({
  session: { id: `s${(nextId += 1)}`, title, projectPath: owner.path, createdAt, order: nextId } as SessionSummary,
  project: owner
});

const titles = (rows: PaletteSession[]): string[] => rows.map((row) => row.session.title);

function results(query: string, sessions: PaletteSession[], projects: ProjectSummary[] = [], recency: Record<string, number> = {}) {
  return paletteResults({
    query,
    sessions,
    projects,
    sessionRecency: (s) => recency[s.title] ?? 0,
    projectRecency: (p) => recency[p.name] ?? 0
  });
}

describe("matching a field", () => {
  it("ranks whole, start, word-start and mid-word matches", () => {
    const rank = (field: string, query: string) => rankField(field, normalizeSearchText(query), normalizeSearchText(query).split(" "));
    assert.equal(rank("Fix", "fix"), 3);
    assert.equal(rank("Fix the login", "fix"), 2);
    assert.equal(rank("Quick fix", "fix"), 1);
    assert.equal(rank("prefix tree", "fix"), 0);
    assert.equal(rank("Login page", "nothing"), null);
    assert.equal(rank("Refactor auth-flow", "auth flow"), 1, "every word starts a word");
  });

  it("ignores case and accents", () => {
    assert.equal(normalizeSearchText("  Café  Crème "), "cafe creme");
    assert.ok(rankFields(["Café review"], "cafe") !== null);
  });

  it("finds words spread over fields, ranked below a match within one", () => {
    const across = rankFields(["Auth chat", "app", "main"], "auth main");
    const within = rankFields(["Auth main chat", "app", "main"], "auth main");
    assert.ok(across !== null && within !== null);
    assert.ok(within > across);
    assert.equal(rankFields(["Auth chat", "app", "main"], "auth other"), null);
  });

  it("a word-start match in any field beats a mid-word match; then the earlier field wins", () => {
    // "app" starts the project name but is mid-word in the title "Mapper".
    assert.ok(rankFields(["Mapper", "app"], "app")! > rankFields(["Mapper", "other"], "app")!);
    // A title prefix beats an exact project-name match.
    assert.ok(rankFields(["App setup", "x"], "app")! > rankFields(["Other", "app"], "app")!);
  });
});

describe("palette results", () => {
  const app = project("app");
  const api = project("api", "tools");

  it("orders exact, prefix, word-start, mid-word", () => {
    const rows = [session("prefix trees", app), session("Quick fix", app), session("Fix login", app), session("fix", app)];
    assert.deepEqual(titles(results("fix", rows).sessions), ["fix", "Fix login", "Quick fix", "prefix trees"]);
  });

  it("breaks ties by recency, then by the tab order", () => {
    const rows = [session("Fix A", app), session("Fix B", app), session("Fix C", app)];
    assert.deepEqual(titles(results("fix", rows, [], { "Fix B": 5, "Fix C": 9 }).sessions), ["Fix C", "Fix B", "Fix A"]);
    assert.deepEqual(titles(results("fix", rows).sessions), ["Fix A", "Fix B", "Fix C"]);
  });

  it("recency never lifts a weaker match over a stronger one", () => {
    const rows = [session("Quick fix", app), session("Fix login", app)];
    assert.deepEqual(titles(results("fix", rows, [], { "Quick fix": 100 }).sessions), ["Fix login", "Quick fix"]);
  });

  it("matches session titles, project names and workspace names; projects by name and workspace", () => {
    const rows = [session("Rename helper", app), session("Docs", api)];
    assert.deepEqual(titles(results("tools", rows).sessions), ["Docs"]);
    assert.deepEqual(titles(results("app", rows).sessions), ["Rename helper"]);
    assert.deepEqual(results("tools", rows, [app, api]).projects, [api]);
  });

  it("lists delegated and forked chats like any other tab", () => {
    const child = session("Auth: write tests", app);
    child.session.lineage = { kind: "delegate", parentSessionId: "s0" } as unknown as SessionSummary["lineage"];
    assert.deepEqual(titles(results("auth", [child]).sessions), ["Auth: write tests"]);
  });

  it("the group with the best match leads", () => {
    const rows = [session("Mapper", app)];
    const projects = [project("map")];
    assert.equal(results("map", rows, projects).projectsFirst, true, "an exact project name beats a title prefix");
    assert.equal(results("mapper", rows, projects).projectsFirst, false);
    assert.equal(results("map", [session("map", app)], projects).projectsFirst, false, "a tie keeps sessions first");
    assert.equal(results("map", [], projects).projectsFirst, true);
  });

  it("an empty query lists the most recent first, and the active projects", () => {
    const rows = [session("Old", app), session("New", api), session("Mid", app)];
    const out = results("  ", rows, [app, api, project("idle")], { Old: 1, New: 9, Mid: 5, api: 3, app: 7 });
    assert.deepEqual(titles(out.sessions), ["New", "Mid", "Old"]);
    assert.deepEqual(out.projects.map((p) => p.name), ["app", "api"]);
    assert.equal(out.projectsLabel, "Active");
    assert.equal(out.projectsFirst, false);
    const none = results("", [], [app, api], { api: 3 });
    assert.deepEqual(none.projects.map((p) => p.name), ["api", "app"]);
    assert.equal(none.projectsLabel, "Projects");
  });
});

describe("recency", () => {
  it("a session's latest turn, this client's visit, else its creation", () => {
    const created = "2026-10-01T00:00:00.000Z";
    assert.equal(sessionRecency({ createdAt: created, latestTurn: null }, undefined), Date.parse(created));
    assert.equal(
      sessionRecency(
        { createdAt: created, latestTurn: { turnId: "t", state: "completed", startedAt: "2026-10-02T00:00:00.000Z", completedAt: "2026-10-03T00:00:00.000Z" } },
        "2026-10-04T00:00:00.000Z"
      ),
      Date.parse("2026-10-04T00:00:00.000Z")
    );
    assert.equal(sessionRecency({ createdAt: "garbage", latestTurn: undefined }, "nope"), 0);
  });
});

describe("highlight ranges", () => {
  it("marks each word, preferring a word start, merged where they touch", () => {
    assert.deepEqual(matchRanges("prefix fix", "fix"), [[7, 10]]);
    assert.deepEqual(matchRanges("prefix", "fix"), [[3, 6]]);
    assert.deepEqual(matchRanges("Auth main chat", "main auth"), [[0, 4], [5, 9]]);
    assert.deepEqual(matchRanges("abc", "ab bc"), [[0, 3]]);
    assert.deepEqual(matchRanges("abc", "zz"), []);
  });
});

describe("the recency snapshot", () => {
  it("a row keeps the stamp it was first ranked with while the palette is open", () => {
    const app = project("app");
    const rows = [session("Fix A", app), session("Fix B", app)];
    const live: Record<string, number> = { "Fix A": 1, "Fix B": 2 };
    const snapshot = createRecencySnapshot();
    const rank = () =>
      titles(
        paletteResults({
          query: "fix",
          sessions: rows,
          projects: [],
          sessionRecency: (s) => snapshot.get(s.id, () => live[s.title] ?? 0),
          projectRecency: () => 0
        }).sessions
      );
    assert.deepEqual(rank(), ["Fix B", "Fix A"]);
    live["Fix A"] = 99; // a turn finished in the background
    assert.deepEqual(rank(), ["Fix B", "Fix A"], "nothing moves under the highlight");
    const reopened = createRecencySnapshot();
    assert.equal(reopened.get(rows[0]!.session.id, () => live["Fix A"]!), 99, "the next opening sees it");
  });

  it("asks for a key's live stamp once", () => {
    const snapshot = createRecencySnapshot();
    let asked = 0;
    const live = () => {
      asked += 1;
      return asked;
    };
    assert.equal(snapshot.get("k", live), 1);
    assert.equal(snapshot.get("k", live), 1);
    assert.equal(asked, 1);
  });
});
