import test from "node:test";
import assert from "node:assert/strict";

import type { ProjectSummary, RepoIdentity } from "@orquester/api";

import type { AgentSessionEntry } from "../components/attention/agent-sessions";
import { agentRepo } from "./opened-agents.ts";
import type { ProjectIndex } from "./project-index";

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
