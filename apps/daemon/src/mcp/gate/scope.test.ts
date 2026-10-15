/**
 * The gate's facts (unified MCP design 2026-10-15 §5.1, §5.4, §13 c): target classes, path
 * classification against a real directory tree (symlinks included), own children, the
 * workflow-owned lineage walk, and a workflow's project union.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionSummary } from "@orquester/api";

import { canonicalProject, classifyPath } from "../addressing.ts";
import type { ScopeClaim, ThreadCaller } from "../catalog/contract.ts";
import { chatSummary } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";
import { classifyTarget, gateFacts, isWorkflowOwned, ownChildren, workflowProjectUnion } from "./scope.ts";

async function tree(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "umcp-scope-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, "workspaces");
  for (const dir of ["acme/api/src", "acme/web", "beta/app", "outside"]) await mkdir(join(ws, dir), { recursive: true });
  await mkdir(join(root, "elsewhere"), { recursive: true });
  // A link inside a project that points into another workspace's project, and one out of the workspaces.
  await symlink(join(ws, "beta/app"), join(ws, "acme/api/link-to-beta"));
  await symlink(join(root, "elsewhere"), join(ws, "acme/api/link-out"));
  const api = new FakeDaemonApi();
  api.fsRoot = root;
  api.workspacesDir = ws;
  return { root, ws, api };
}

const caller = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
  kind: "thread", threadId: "me", title: "Me", projectPath: "", workspace: "", cwd: "", agentId: "claude", callId: "c",
  runtimeMode: "auto", planning: false, workflowOwned: false, exchange: null, ...over
});
const claim = (over: Partial<ScopeClaim> = {}): ScopeClaim => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [], ...over });

test("paths: inside a project (symlinks resolved) → that project; the root, a workspace, outside the sandbox → outside", async (t) => {
  const { root, ws, api } = await tree(t);
  const cwd = join(ws, "acme/api");
  const inside = await classifyPath(api, "src/missing-file.ts", cwd);
  assert.equal(inside.kind === "project" && `${inside.project.workspace}/${inside.project.name}`, "acme/api");
  const projectItself = await classifyPath(api, join(ws, "acme/web"), cwd);
  assert.equal(projectItself.kind === "project" && projectItself.project.name, "web");
  const linked = await classifyPath(api, join(ws, "acme/api/link-to-beta/x"), cwd);
  assert.equal(linked.kind === "project" && `${linked.project.workspace}/${linked.project.name}`, "beta/app", "a link classifies by its target");
  for (const path of [ws, join(ws, "acme"), join(root, "elsewhere"), "/etc/passwd", join(ws, "acme/api/link-out/x"), join(ws, "acme/../../elsewhere")]) {
    assert.equal((await classifyPath(api, path, cwd)).kind, "outside", path);
  }
  assert.equal(await canonicalProject(api, join(ws, "acme")), null, "a workspace is no project");
  assert.equal(await canonicalProject(api, join(ws, "acme/api/src")), null, "nor is a directory inside one");
  assert.equal(await canonicalProject(api, join(ws, "acme/removed")), null, "a removed project is none (PROJECT_NOT_FOUND)");
});

test("target classes, and a caller bound to no project: every target is other", async (t) => {
  const { ws, api } = await tree(t);
  const own = await canonicalProject(api, join(ws, "acme/api"));
  assert.equal(classifyTarget(own, (await canonicalProject(api, join(ws, "acme/api")))!), "own");
  assert.equal(classifyTarget(own, (await canonicalProject(api, join(ws, "acme/web")))!), "same-workspace");
  assert.equal(classifyTarget(own, (await canonicalProject(api, join(ws, "beta/app")))!), "other-workspace");
  assert.equal(classifyTarget(null, (await canonicalProject(api, join(ws, "acme/api")))!), "other-workspace");

  const me = caller({ projectPath: join(ws, "acme/api"), workspace: "acme", cwd: join(ws, "acme/api") });
  const facts = await gateFacts(api, me, claim({
    projects: [join(ws, "acme/web"), join(ws, "acme/web")],
    paths: ["src/a.ts", "/etc/hosts", join(ws, "beta/app/README.md")],
    pendingProjects: [{ workspace: "acme" }, { workspace: "zeta" }]
  }));
  assert.deepEqual(facts.targets.map((target) => [target.workspace, target.class]), [["acme", "same-workspace"], ["acme", "own"], ["beta", "other-workspace"]]);
  assert.deepEqual(facts.deniedPaths, ["/etc/hosts"]);
  assert.deepEqual(facts.pendingTargets, [{ workspace: "acme", class: "same-workspace" }, { workspace: "zeta", class: "other-workspace" }]);
  await assert.rejects(gateFacts(api, me, claim({ projects: [join(ws, "acme")] })), { code: "PROJECT_NOT_FOUND" });
});

test("own children: lineage parent = the caller AND agentCreated; a GUI fork is never the agent's", async () => {
  const sessions = [
    chatSummary({ id: "kid", lineage: { parentThreadId: "me", relation: "delegate", createdAt: "x", agentCreated: true } }),
    chatSummary({ id: "gui-fork", lineage: { parentThreadId: "me", relation: "fork", createdAt: "x" } }),
    chatSummary({ id: "cousin", lineage: { parentThreadId: "other", relation: "opened", createdAt: "x", agentCreated: true } })
  ];
  assert.deepEqual([...ownChildren("me", sessions, ["kid", "gui-fork", "cousin", "ghost"])], ["kid"]);

  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: sessions });
  const facts = await gateFacts(api, caller(), claim({ sessions: ["me", "kid", "gui-fork"], ownChildrenOnly: "only yours" }));
  assert.deepEqual(facts.notOwnChildren, ["gui-fork"], "self is judged by scope.self, not as a child");
  const none = new FakeDaemonApi();
  assert.deepEqual((await gateFacts(none, caller(), claim({ sessions: ["kid"] }))).notOwnChildren, [], "no ownChildrenOnly: nothing read");
  assert.deepEqual(none.calls, []);
});

test("workflow-owned: owner on the tab or any ancestor; a closed ancestor fails closed only behind an agent-made link", () => {
  const tab = (id: string, over: Partial<SessionSummary> = {}) => chatSummary({ id, ...over });
  const link = (parent: string, agentCreated: boolean) => ({ parentThreadId: parent, relation: "delegate" as const, createdAt: "x", ...(agentCreated ? { agentCreated: true as const } : {}) });
  const owner = { kind: "workflow" as const, workflowId: "wf", runId: "r", nodeId: "n" };
  const sessions = [
    tab("root", { owner }),
    tab("child", { lineage: link("root", true) }),
    tab("grandchild", { lineage: { ...link("child", false), relation: "fork" } }),
    tab("user", {}),
    tab("user-kid", { lineage: link("user", true) }),
    tab("orphan-agent", { lineage: link("closed", true) }),
    tab("orphan-gui", { lineage: { ...link("closed", false), relation: "fork" } }),
    tab("orphan-legacy-delegate", { lineage: link("closed", false) }),
    tab("orphan-opened", { lineage: { ...link("closed", false), relation: "opened" } }),
    tab("loop-a", { lineage: link("loop-b", true) }),
    tab("loop-b", { lineage: link("loop-a", true) })
  ];
  assert.equal(isWorkflowOwned(sessions, "root"), true);
  assert.equal(isWorkflowOwned(sessions, "child"), true);
  assert.equal(isWorkflowOwned(sessions, "grandchild"), true, "a fork of a workflow-owned chat is workflow-owned");
  assert.equal(isWorkflowOwned(sessions, "user"), false);
  assert.equal(isWorkflowOwned(sessions, "user-kid"), false);
  assert.equal(isWorkflowOwned(sessions, "orphan-agent"), true, "an agent made it and its parent is gone: fail closed");
  assert.equal(isWorkflowOwned(sessions, "orphan-gui"), false, "a person forked it: not owned");
  assert.equal(isWorkflowOwned(sessions, "orphan-legacy-delegate"), true, "an unflagged (legacy) delegate behind a closed parent fails closed");
  assert.equal(isWorkflowOwned(sessions, "orphan-opened"), true, "an unflagged opened chat behind a closed parent fails closed");
  assert.equal(isWorkflowOwned(sessions, "loop-a"), true, "a lineage cycle fails closed");
  assert.equal(isWorkflowOwned(sessions, "unknown"), true, "a thread with no tab fails closed");
});

test("workflow-owned: the inheritable lineage marker is proof on its own — even behind a GUI fork of a closed parent", () => {
  const marked = { parentThreadId: "closed", relation: "fork" as const, createdAt: "x", workflowOwned: true as const };
  const sessions = [
    chatSummary({ id: "marked-fork", lineage: marked }),
    chatSummary({ id: "kid", lineage: { parentThreadId: "marked-fork", relation: "fork", createdAt: "x" } }),
    chatSummary({ id: "plain-fork", lineage: { ...marked, workflowOwned: undefined } })
  ];
  assert.equal(isWorkflowOwned(sessions, "marked-fork"), true, "without the marker this GUI fork of a closed parent would read as not owned");
  assert.equal(isWorkflowOwned(sessions, "kid"), true, "a descendant of a marked thread is owned through the walk");
  assert.equal(isWorkflowOwned(sessions, "plain-fork"), false);
});

test("a workflow's project union: names and paths, deduplicated and canonical; temp projects by workspace", async (t) => {
  const { ws, api } = await tree(t);
  const union = await workflowProjectUnion(api, { projects: ["acme/api", join(ws, "acme/api"), "beta/app"], pendingWorkspaces: ["acme", "acme"] });
  assert.deepEqual(union, { projects: [join(ws, "acme/api"), join(ws, "beta/app")], pendingProjects: [{ workspace: "acme" }] });
  assert.deepEqual(await workflowProjectUnion(api, { projects: ["acme/web"] }), { projects: [join(ws, "acme/web")] });
  await assert.rejects(workflowProjectUnion(api, { projects: ["acme/nope"] }), { code: "PROJECT_NOT_FOUND" });
});
