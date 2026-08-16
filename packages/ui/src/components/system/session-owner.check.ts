import assert from "node:assert/strict";
import { resolveSessionOwner } from "./session-owner";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "../../types";

const session = (id: string, projectPath: string, title = id): SessionSummary =>
  ({
    id,
    title,
    kind: "agent",
    refId: "claude",
    status: "running",
    projectPath,
    cwd: projectPath,
    order: 0,
    createdAt: "2026-08-16T00:00:00.000Z"
  }) as SessionSummary;

const workspaces: WorkspaceSummary[] = [
  { name: "ws", path: "/w/ws", projectCount: 2, isArchived: false } as WorkspaceSummary,
  { name: "old", path: "/w/old", projectCount: 1, isArchived: true } as WorkspaceSummary
];
const projects: ProjectSummary[] = [
  { name: "proj", workspace: "ws", path: "/w/ws/proj", isArchived: false },
  { name: "shelved", workspace: "ws", path: "/w/ws/shelved", isArchived: true }
];
const sessions = [
  session("live", "/w/ws/proj", "claude"),
  session("archived-project", "/w/ws/shelved", "SECRET"),
  session("archived-workspace", "/w/old/thing", "SECRET"),
  session("no-project", "")
];

// The happy path names the tab and its project.
assert.deepEqual(resolveSessionOwner("live", sessions, workspaces, projects), {
  title: "claude",
  project: projects[0]
});

// Everything the curtain (or ignorance) must hide resolves to null, never to a
// chip with a leaked title.
for (const id of ["archived-project", "archived-workspace", "no-project", "unknown-id"]) {
  assert.equal(resolveSessionOwner(id, sessions, workspaces, projects), null, `${id} must not resolve`);
}

// Without the project list the workspace path still identifies the owner.
const owner = resolveSessionOwner("live", sessions, workspaces, []);
assert.equal(owner?.project.workspace, "ws");
assert.equal(owner?.project.name, "proj");

console.log("session-owner.check.ts OK");
