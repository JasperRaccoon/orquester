/**
 * The skill catalogue a thread's messages are read against (§4.6.4, §4.6.7):
 * the composer offers its cwd's overlay where the overlay lists skills, else
 * the provider's machine-level catalogue — and the timeline re-chips a sent
 * `$mention` against the same names, in the thread's view and a drill-in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Skill } from "@orquester/api/agent-chat";

import { workspaceSkills } from "./composer-menu.ts";

const skill = (name: string): Skill => ({ name, path: `/skills/${name}/SKILL.md`, enabled: true });

const provider = {
  skills: [skill("review"), skill("deploy")],
  workspaceSnapshots: [
    { cwd: "/w/p", checkedAt: "2026-09-27T00:00:00.000Z", slashCommands: [], skills: [skill("lint")] },
    { cwd: "/w/empty", checkedAt: "2026-09-27T00:00:00.000Z", slashCommands: [], skills: [] }
  ]
};

describe("workspaceSkills", () => {
  it("the cwd's overlay wins where it lists any skill", () => {
    assert.deepEqual(workspaceSkills(provider, "/w/p").map((entry) => entry.name), ["lint"]);
  });

  it("an empty overlay, another cwd, or none: the machine-level catalogue", () => {
    assert.deepEqual(workspaceSkills(provider, "/w/empty").map((entry) => entry.name), ["review", "deploy"]);
    assert.deepEqual(workspaceSkills(provider, "/elsewhere").map((entry) => entry.name), ["review", "deploy"]);
    assert.deepEqual(workspaceSkills(provider, null).map((entry) => entry.name), ["review", "deploy"]);
  });

  it("no snapshot, no skills", () => {
    assert.deepEqual(workspaceSkills(null, "/w/p"), []);
  });
});
