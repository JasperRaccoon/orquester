/**
 * The facts the gate judges (unified MCP design 2026-10-15 §5.1, §5.2, §5.4), read through
 * `DaemonApi` only: the class of every target project (own / same workspace / other workspace),
 * path classification (inside a project, else denied), own children (lineage parent = caller and
 * `agentCreated`), the workflow-owned trait (owner + lineage walk), and the project union a
 * workflow's scope is (§4.1, D-25).
 */

import type { SessionSummary } from "@orquester/api";

import { canonicalProject, classifyPath, resolveProject, type CanonicalProject } from "../addressing.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { listSessions } from "../reads.ts";
import { clipText, MAX_ECHO_CHARS } from "../result.ts";
import type { ScopeClaim, ThreadCaller } from "../catalog/contract.ts";
import type { GateInput, GateTarget, TargetClass } from "./policy.ts";

type Paths = Pick<DaemonApi, "fsRoot" | "workspacesDir">;

/** Where `target` lies relative to the caller's own project (null: the caller has none — every target is "other"). */
export function classifyTarget(own: CanonicalProject | null, target: { canonical: string; workspace: string }): TargetClass {
  if (own === null) return "other-workspace";
  if (target.canonical === own.canonical) return "own";
  return target.workspace === own.workspace ? "same-workspace" : "other-workspace";
}

/** The caller's own project, canonical, or null when it is bound to none. */
export async function callerProject(api: Paths, caller: Pick<ThreadCaller, "projectPath">): Promise<CanonicalProject | null> {
  return caller.projectPath ? canonicalProject(api, caller.projectPath) : null;
}

/** The caller's own children among `ids`: lineage parent = the caller AND `agentCreated` (§13 c). */
export function ownChildren(callerId: string, sessions: readonly SessionSummary[], ids: readonly string[]): Set<string> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return new Set(
    ids.filter((id) => {
      const lineage = byId.get(id)?.lineage;
      return lineage?.parentThreadId === callerId && lineage.agentCreated === true;
    })
  );
}

/**
 * Everything {@link import("./policy.ts").gate} needs beyond the caller and the claim. A project
 * the claim names that is no project under the workspaces root is `PROJECT_NOT_FOUND` (never
 * confirmed to exist).
 */
export async function gateFacts(
  api: DaemonApi,
  caller: ThreadCaller,
  scope: ScopeClaim
): Promise<Pick<GateInput, "targets" | "pendingTargets" | "workspaceTargets" | "deniedPaths" | "notOwnChildren">> {
  // Read only when something is to be classified (most calls claim no project at all).
  const needsOwn = scope.projects.length > 0 || (scope.paths?.length ?? 0) > 0 || (scope.pendingProjects?.length ?? 0) > 0;
  const own = needsOwn ? await callerProject(api, caller) : null;
  const targets: GateTarget[] = [];
  const add = (project: CanonicalProject) => {
    if (!targets.some((target) => target.project === project.canonical)) {
      targets.push({ project: project.canonical, workspace: project.workspace, class: classifyTarget(own, project) });
    }
  };
  for (const path of scope.projects) {
    const project = await canonicalProject(api, path);
    if (project === null) throw new ToolError("PROJECT_NOT_FOUND", `No project at "${clipText(path, MAX_ECHO_CHARS)}". Use list_projects.`);
    add(project);
  }
  const deniedPaths: string[] = [];
  for (const path of scope.paths ?? []) {
    const where = await classifyPath(api, path, caller.cwd);
    if (where.kind === "outside") deniedPaths.push(path);
    else add(where.project);
  }
  const pendingTargets = (scope.pendingProjects ?? []).map((pending) => ({
    workspace: pending.workspace,
    class: (own !== null && pending.workspace === own.workspace ? "same-workspace" : "other-workspace") as Exclude<TargetClass, "own">
  }));
  // Workspace-level data: the caller's own workspace (it has a project there), else another.
  const workspaceTargets = [...new Set(scope.workspaces ?? [])].map((workspace) => ({
    workspace,
    class: (caller.projectPath !== "" && caller.workspace !== "" && workspace === caller.workspace ? "own" : "other-workspace") as "own" | "other-workspace"
  }));
  let notOwnChildren: string[] = [];
  if (scope.ownChildrenOnly !== undefined) {
    // Self is judged by `scope.self`, never as a child of itself.
    const others = scope.sessions.filter((id) => id !== caller.threadId);
    if (others.length > 0) {
      const children = ownChildren(caller.threadId, await listSessions(api), others);
      notOwnChildren = others.filter((id) => !children.has(id));
    }
  }
  return { targets, pendingTargets, workspaceTargets, deniedPaths, notOwnChildren };
}

/** The deepest lineage walk (well past the agent-depth cap; a cycle stops at the first repeat). */
const MAX_LINEAGE_WALK = 64;

/**
 * Whether a thread is workflow-owned (§5.4): its tab, or any lineage ancestor's, has
 * `owner.kind === "workflow"`. The walk follows open tabs' `lineage.parentThreadId`.
 *
 * The inheritable marker comes first: a lineage stamped `workflowOwned: true` at creation (its
 * creator was owned, or carried the marker) is owned without walking further — it survives the
 * creator's tab closing. Its absence proves nothing (older records), so the walk below still runs.
 *
 * A closed ancestor's owner is unknowable (it lived on its tab record only). The walk then fails
 * CLOSED (owned) behind any link an agent may have made — `agentCreated`, or relation `delegate` /
 * `opened` ({@link isAgentMadeLink}) — and stops as not owned only behind a `fork` without
 * `agentCreated` (a GUI fork: a person made it and is watching it). A thread with no tab
 * (the caller itself unknown) is treated as owned.
 */
/**
 * Whether an agent (maybe a workflow's) may have made this lineage link: `agentCreated`, or any
 * `delegate` / `opened` link — legacy delegates carry no flag, and only an agent delegates or opens
 * a chat as a child. Only a `fork` without `agentCreated` is the user's (a GUI fork).
 */
function isAgentMadeLink(lineage: { relation: string; agentCreated?: true }): boolean {
  return lineage.agentCreated === true || lineage.relation !== "fork";
}

export function isWorkflowOwned(sessions: readonly SessionSummary[], threadId: string): boolean {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  let id = threadId;
  let agentMadeLink = true;
  for (let depth = 0; depth < MAX_LINEAGE_WALK; depth += 1) {
    // A lineage cycle is no lineage the daemon writes: fail closed.
    if (seen.has(id)) return true;
    seen.add(id);
    const session = byId.get(id);
    if (session === undefined) return agentMadeLink;
    if (session.owner?.kind === "workflow") return true;
    const lineage = session.lineage;
    if (!lineage) return false;
    if (lineage.workflowOwned === true) return true;
    agentMadeLink = isAgentMadeLink(lineage);
    id = lineage.parentThreadId;
  }
  // A chain this deep is no lineage the daemon writes: fail closed.
  return true;
}

/** {@link isWorkflowOwned}, reading the tabs now. */
export async function readWorkflowOwned(api: DaemonApi, threadId: string): Promise<boolean> {
  return isWorkflowOwned(await listSessions(api), threadId);
}

/**
 * A workflow's scope (§4.1, D-25): the UNION of its project, every `set_project` op's project and
 * every block's `projectOverride` (each `"<ws>/<project>"` or an absolute path; unresolvable →
 * `PROJECT_NOT_FOUND`), plus a temp project not created yet by workspace. Deduplicated, canonical.
 */
export async function workflowProjectUnion(
  api: Paths,
  members: { projects: readonly string[]; pendingWorkspaces?: readonly string[] }
): Promise<Pick<ScopeClaim, "projects" | "pendingProjects">> {
  const projects: string[] = [];
  for (const member of members.projects) {
    const ref = await resolveProject(api, member);
    const project = await canonicalProject(api, ref.path);
    if (project === null) throw new ToolError("PROJECT_NOT_FOUND", `No project at "${clipText(member, MAX_ECHO_CHARS)}". Use list_projects.`);
    if (!projects.includes(project.canonical)) projects.push(project.canonical);
  }
  const pending = [...new Set(members.pendingWorkspaces ?? [])].map((workspace) => ({ workspace }));
  return pending.length > 0 ? { projects, pendingProjects: pending } : { projects };
}
