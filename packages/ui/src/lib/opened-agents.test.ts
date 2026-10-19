import test from "node:test";
import assert from "node:assert/strict";

import type { ProjectSummary, RepoIdentity } from "@orquester/api";

import type { AgentSessionEntry } from "../components/attention/agent-sessions";
import { agentRepo, matchesAgentQuery, matchesSidebarQuery } from "./opened-agents.ts";
import type { ProjectIndex } from "./project-index";

test("the sidebar search matches any field, ignoring case and outer spaces", () => {
  assert.equal(matchesSidebarQuery("", "anything"), true);
  assert.equal(matchesSidebarQuery("  ", undefined), true);
  assert.equal(matchesSidebarQuery(" Orq ", "fix the bug", "orquester-4"), true);
  assert.equal(matchesSidebarQuery("mats", "fix the bug", null, "orquester"), false);
});

const KEY = "github.com/jasperraccoon/jasperengine";
const repoProject: ProjectSummary = {
  name: "Shader optimization",
  workspace: "jaspersito",
  path: "/w/jaspersito/Shader optimization",
  repoKey: KEY,
  repoName: "JasperRaccoon/JasperEngine"
};
const plainProject: ProjectSummary = { name: "Aaaaa", workspace: "jaspersito", path: "/w/jaspersito/Aaaaa" };
const index: ProjectIndex = {
  visible: new Map([
    [repoProject.path, repoProject],
    [plainProject.path, plainProject]
  ]),
  incomplete: false
};
const entryFor = (project: ProjectSummary, title = "Fix the bug") =>
  ({ session: { title, projectPath: project.path }, project }) as unknown as AgentSessionEntry;
const labelled = (label: string): ReadonlyMap<string, RepoIdentity> =>
  new Map([[KEY, { repoKey: KEY, label, updatedAt: "2026-10-18T10:00:00.000Z" }]]);
const none: ReadonlyMap<string, RepoIdentity> = new Map();

test("an agent's repo is its project's repoKey with the label it shows", () => {
  assert.deepEqual(agentRepo(entryFor(repoProject), index, none), { repoKey: KEY, label: "JasperRaccoon/JasperEngine" });
  assert.deepEqual(agentRepo(entryFor(repoProject), index, labelled("Engine")), { repoKey: KEY, label: "Engine" });
  assert.equal(agentRepo(entryFor(plainProject), index, none), null);
});

test("the Opened Agents search also matches the repo's shown label", () => {
  assert.equal(matchesAgentQuery("jasperengine", entryFor(repoProject), index, none), true);
  assert.equal(matchesAgentQuery("raccoon engine", entryFor(repoProject), index, labelled("Raccoon engine")), true);
  // The custom label replaces the default one.
  assert.equal(matchesAgentQuery("jasperengine", entryFor(repoProject), index, labelled("Raccoon engine")), false);
  assert.equal(matchesAgentQuery("shader", entryFor(repoProject), index, labelled("Raccoon engine")), true);
  assert.equal(matchesAgentQuery("fix the", entryFor(plainProject), index, none), true);
  assert.equal(matchesAgentQuery("engine", entryFor(plainProject), index, labelled("Engine")), false);
});
