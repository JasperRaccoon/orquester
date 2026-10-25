import test from "node:test";
import assert from "node:assert/strict";

import type { ProjectSummary } from "@orquester/api";

import { groupProjectsByRepo, projectMatchesQuery, type GroupProjectsInput } from "./repo-groups.ts";

const ENGINE = "github.com/jasperraccoon/jasperengine";
const EDITOR = "github.com/jasperraccoon/jaspereditor";

function project(name: string, repo?: { key: string; name?: string; url?: string }): ProjectSummary {
  return {
    name,
    workspace: "ws",
    path: `/w/ws/${name}`,
    ...(repo
      ? {
          repoKey: repo.key,
          ...(repo.name ? { repoName: repo.name } : {}),
          ...(repo.url ? { cloneUrl: repo.url } : {})
        }
      : {})
  };
}

const engine = (name: string, url?: string) =>
  project(name, { key: ENGINE, name: "JasperRaccoon/JasperEngine", ...(url ? { url } : {}) });
const editor = (name: string) => project(name, { key: EDITOR, name: "JasperRaccoon/JasperEditor" });

const PROJECTS = [
  engine("Shader optimization", "git@github.com:JasperRaccoon/JasperEngine.git"),
  project("CRYPTORISK"),
  editor("JasperEditor2"),
  engine("JasperEngine", "https://github.com/JasperRaccoon/JasperEngine.git"),
  project("Aaaaa", undefined),
  editor("JasperEditor"),
  engine("Multiplayer")
];

const group = (overrides: Partial<GroupProjectsInput> = {}) =>
  groupProjectsByRepo({
    projects: PROJECTS,
    identities: new Map(),
    query: "",
    collapsed: new Set(),
    activePath: null,
    ...overrides
  });

const names = (list: ProjectSummary[]) => list.map((p) => p.name);

test("projects with a repoKey group by it; the rest are other projects, all by name", () => {
  const { groups, other } = group();
  assert.deepEqual(
    groups.map((g) => [g.label, names(g.projects)]),
    [
      ["JasperRaccoon/JasperEditor", ["JasperEditor", "JasperEditor2"]],
      ["JasperRaccoon/JasperEngine", ["JasperEngine", "Multiplayer", "Shader optimization"]]
    ]
  );
  assert.deepEqual(names(other), ["Aaaaa", "CRYPTORISK"]);
  assert.ok(groups.every((g) => !g.collapsed && !g.pinnedOpen));
});

test("a repo with one clone still gets a group", () => {
  const { groups, other } = groupProjectsByRepo({
    projects: [project("solo", { key: "gitlab.com/me/solo", name: "me/solo" }), project("plain")],
    identities: new Map(),
    query: "",
    collapsed: new Set()
  });
  assert.deepEqual(groups.map((g) => [g.repoKey, names(g.projects)]), [["gitlab.com/me/solo", ["solo"]]]);
  assert.deepEqual(names(other), ["plain"]);
});

test("the default label is the first project's repoName, else the key without its host", () => {
  const { groups } = groupProjectsByRepo({
    projects: [project("b", { key: "github.com/o/r", name: "O/R" }), project("a", { key: "github.com/o/r" })],
    identities: new Map(),
    query: "",
    collapsed: new Set()
  });
  assert.equal(groups[0]?.defaultLabel, "O/R");
  const bare = groupProjectsByRepo({
    projects: [project("x", { key: "bitbucket.org/team/sub/repo" })],
    identities: new Map(),
    query: "",
    collapsed: new Set()
  });
  assert.equal(bare.groups[0]?.defaultLabel, "team/sub/repo");
  assert.equal(bare.groups[0]?.label, "team/sub/repo");
});

test("a custom label is shown and drives the natural, case-insensitive order", () => {
  const { groups } = group({
    identities: new Map([
      [EDITOR, { label: "zeta editor" }],
      [ENGINE, { label: "Engine 10" }]
    ])
  });
  assert.deepEqual(
    groups.map((g) => [g.label, g.defaultLabel]),
    [
      ["Engine 10", "JasperRaccoon/JasperEngine"],
      ["zeta editor", "JasperRaccoon/JasperEditor"]
    ]
  );
  const numeric = group({
    identities: new Map([
      [EDITOR, { label: "repo 10" }],
      [ENGINE, { label: "Repo 9" }]
    ])
  });
  assert.deepEqual(numeric.groups.map((g) => g.label), ["Repo 9", "repo 10"]);
});

test("equal labels fall back to the repo key", () => {
  const { groups } = group({
    identities: new Map([
      [EDITOR, { label: "Same" }],
      [ENGINE, { label: "same" }]
    ])
  });
  assert.deepEqual(groups.map((g) => g.repoKey), [EDITOR, ENGINE]);
});

test("a search on the label or key shows the whole group; on project names only those", () => {
  const byLabel = group({ query: "engine" });
  assert.deepEqual(
    byLabel.groups.map((g) => [g.repoKey, names(g.projects)]),
    [[ENGINE, ["JasperEngine", "Multiplayer", "Shader optimization"]]]
  );
  assert.deepEqual(names(byLabel.other), []);

  const byKey = group({ query: "github.com/jasperraccoon/jaspered" });
  assert.deepEqual(byKey.groups.map((g) => g.repoKey), [EDITOR]);

  const byCustom = group({ query: "raccoon tools", identities: new Map([[EDITOR, { label: "Raccoon tools" }]]) });
  assert.deepEqual(byCustom.groups.map((g) => [g.repoKey, g.projects.length]), [[EDITOR, 2]]);

  const byProject = group({ query: "multi" });
  assert.deepEqual(byProject.groups.map((g) => [g.repoKey, names(g.projects)]), [[ENGINE, ["Multiplayer"]]]);

  const otherOnly = group({ query: "crypto" });
  assert.deepEqual(otherOnly.groups, []);
  assert.deepEqual(names(otherOnly.other), ["CRYPTORISK"]);
});

test("a saved collapse holds until a search or the open project pins the group open", () => {
  const collapsed = new Set([ENGINE, EDITOR]);
  const plain = group({ collapsed });
  assert.deepEqual(plain.groups.map((g) => g.collapsed), [true, true]);

  const searching = group({ collapsed, query: "jasper" });
  assert.deepEqual(searching.groups.map((g) => [g.collapsed, g.pinnedOpen]), [
    [false, true],
    [false, true]
  ]);

  const active = group({ collapsed, activePath: "/w/ws/Multiplayer" });
  assert.deepEqual(active.groups.map((g) => [g.repoKey, g.collapsed, g.pinnedOpen]), [
    [EDITOR, true, false],
    [ENGINE, false, true]
  ]);
});

test("the clone URL prefers the active project's, else the first by name that has one", () => {
  const first = group().groups.find((g) => g.repoKey === ENGINE);
  assert.equal(first?.cloneUrl, "https://github.com/JasperRaccoon/JasperEngine.git");
  const active = group({ activePath: "/w/ws/Shader optimization" }).groups.find((g) => g.repoKey === ENGINE);
  assert.equal(active?.cloneUrl, "git@github.com:JasperRaccoon/JasperEngine.git");
  const activeWithout = group({ activePath: "/w/ws/Multiplayer" }).groups.find((g) => g.repoKey === ENGINE);
  assert.equal(activeWithout?.cloneUrl, "https://github.com/JasperRaccoon/JasperEngine.git");
  const none = group().groups.find((g) => g.repoKey === EDITOR);
  assert.equal(none?.cloneUrl, undefined);
  assert.ok(none && !("cloneUrl" in none));
});

test("the input list is not reordered", () => {
  const before = names(PROJECTS);
  group();
  assert.deepEqual(names(PROJECTS), before);
});

test("a project matches the search by its name or its repo's shown label, owner or key", () => {
  const custom = new Map([[ENGINE, { label: "Engine" }]]);
  const multiplayer = engine("Multiplayer");
  assert.ok(projectMatchesQuery("multi", multiplayer, new Map()));
  assert.ok(projectMatchesQuery("jasperraccoon", multiplayer, new Map()), "the owner in the default label");
  assert.ok(projectMatchesQuery("github.com/jasperraccoon", multiplayer, new Map()), "the key");
  assert.ok(projectMatchesQuery("engine", multiplayer, custom), "the custom label");
  assert.ok(!projectMatchesQuery("editor", multiplayer, custom));
  // No repoName: the key without its host stands in, as for a group's default label.
  assert.ok(projectMatchesQuery("o/r", project("x", { key: "github.com/o/r" }), new Map()));
  assert.ok(!projectMatchesQuery("jasperraccoon", project("CRYPTORISK"), new Map()), "no repo: the name only");
});
