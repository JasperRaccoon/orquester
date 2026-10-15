// Workflows family (unified MCP design 2026-10-15 §4.1, §7.1, §7.2, D-25) — owned by plan Task 10.
//
// The pure half the workflow tools (`./workflows.ts`) and the saved-prompt tools (Task 12) share,
// reaching the daemon through `DaemonApi` only (the catalog's import-graph rule):
//
// - the workflow route helpers (errors, problems, reads);
// - a workflow's project UNION (D-25): its project (an existing one, or a temporary one in a
//   workspace), every block's `projectOverride`, a `set_project` op's project, and — recursively —
//   every sub-workflow a `workflow` block runs;
// - the Admin cards' COMPLETE previews (§7.1): triggers, every block with code/shell sources, HTTP
//   requests and agent prompts in full (a saved prompt's current body in full, labelled with its
//   title), the union with each workspace's git identity, validation problems, and for an edit the
//   ops and a graph diff;
// - the pins those previews freeze (§7.2: the workflow revision, each shown prompt's SHA-256) and
//   their re-verification (`PREVIEW_STALE`);
// - for Task 12: which workflows reference a saved prompt (`workflowsReferencingPrompt`).

import { createHash } from "node:crypto";
import {
  downstreamOf,
  isTriggerType,
  reachableFromTriggers,
  triggerSummaryText,
  WORKFLOW_LIMITS,
  workflowRoutes,
  type AccountSummary,
  type ApprovalPreviewSection,
  type GetWorkflowResponse,
  type ListWorkflowsResponse,
  type ProjectSummary,
  type SavedPrompt,
  type SavedPromptListResponse,
  type Workflow,
  type WorkflowNode,
  type WorkflowProblem,
  type WorkflowProject,
  type WorkspaceSummary
} from "@orquester/api";

import { canonicalProject, projectNamesFor } from "../addressing.ts";
import type { ScopeClaim, ThreadCaller, ToolCaller } from "../catalog/contract.ts";
import type { DaemonApi, DaemonResponse } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText } from "../result.ts";

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ERROR_HINTS: Record<string, string> = {
  WORKFLOW_NOT_FOUND: " list_workflows shows the workflows and their ids.",
  RUN_NOT_FOUND: " get_workflow_runs {workflowId} lists a workflow's runs.",
  NODE_NOT_FOUND: " get_workflow lists the blocks' ids and names.",
  REVISION_CONFLICT: " The workflow changed since you read it: re-read it with get_workflow (its current revision), then send your ops again.",
  INVALID_WORKFLOW: " Fix the problems listed; list_workflow_block_types shows each block's config.",
  RUN_NOT_ACTIVE: " The run already ended: get_workflow_runs {runId} shows how.",
  SECRET_INVALID: " A secret name is A-Z, 0-9 and _, starting with a letter; a value is at most 64 KiB."
};

/** Problems listed in a result / an error's detail, and quoted in an error's text. */
const MAX_PROBLEMS = 100;
const MAX_PROBLEMS_IN_MESSAGE = 8;

/** Problems from a daemon body, kept only when they have the shape (a route from another build may send anything). */
export function sanitizeProblems(raw: unknown): WorkflowProblem[] {
  if (!Array.isArray(raw)) return [];
  const problems: WorkflowProblem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.code !== "string" || typeof entry.message !== "string") continue;
    const severity = entry.severity === "warning" || entry.severity === "info" ? entry.severity : "error";
    const problem: WorkflowProblem = { severity, code: entry.code, message: clipText(entry.message, 500) };
    if (typeof entry.nodeId === "string") problem.nodeId = entry.nodeId;
    if (typeof entry.edgeId === "string") problem.edgeId = entry.edgeId;
    if (typeof entry.field === "string") problem.field = clipText(entry.field, 200);
    problems.push(problem);
  }
  return problems;
}

export const problemLine = (p: WorkflowProblem): string => clipText(`${p.severity} ${p.code}${p.field ? ` (${p.field})` : ""}: ${p.message}`, 300);

/** Errors first, then warnings, then infos — the order a reader fixes them in. */
export function sortedProblems(problems: readonly WorkflowProblem[]): WorkflowProblem[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...problems].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface ProblemsView {
  problems: WorkflowProblem[];
  errorCount: number;
  warningCount: number;
  problemsOmitted?: number;
}

/** A result's problems: sorted, at most MAX_PROBLEMS, with counts. */
export function problemsView(problems: readonly WorkflowProblem[]): ProblemsView {
  const sorted = sortedProblems(problems);
  const view: ProblemsView = {
    problems: sorted.slice(0, MAX_PROBLEMS),
    errorCount: sorted.filter((p) => p.severity === "error").length,
    warningCount: sorted.filter((p) => p.severity === "warning").length
  };
  if (sorted.length > MAX_PROBLEMS) view.problemsOmitted = sorted.length - MAX_PROBLEMS;
  return view;
}

function opIndexOf(env: Record<string, unknown>): number | undefined {
  for (const holder of [env, env.detail, env.details]) {
    if (isRecord(holder) && typeof holder.opIndex === "number" && Number.isInteger(holder.opIndex) && holder.opIndex >= 0) return holder.opIndex;
  }
  return undefined;
}

/**
 * A failed workflow route as a ToolError. The workflow envelope `{error: {code, message, problems?}}` passes its code
 * through; its problems go into the text (the part every client shows) and, whole, into `detail.problems`. Anything
 * else falls back to the MCP's generic mapping (daemonError), which never echoes a 5xx body.
 */
export function workflowError(res: DaemonResponse): ToolError {
  const body = isRecord(res.body) ? res.body : null;
  const env = body && isRecord(body.error) ? body.error : null;
  if (!env || typeof env.code !== "string") return daemonError(res);
  const code = env.code;
  const problems = sortedProblems(sanitizeProblems(env.problems));
  let message = typeof env.message === "string" && env.message.trim() !== "" ? env.message.trim() : code;
  if (!/[.!?]$/.test(message)) message += ".";
  message += ERROR_HINTS[code] ?? "";
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_PROBLEMS_IN_MESSAGE).map(problemLine);
    message += ` Problems: ${shown.join("; ")}${problems.length > shown.length ? `; … (${problems.length - shown.length} more in detail.problems)` : ""}.`;
  }
  const detail: Record<string, unknown> = {};
  if (problems.length > 0) Object.assign(detail, problemsView(problems));
  const opIndex = opIndexOf(env);
  if (opIndex !== undefined) detail.opIndex = opIndex;
  return new ToolError(code, message, Object.keys(detail).length > 0 ? detail : undefined);
}

export function expectWorkflowOk<T>(res: DaemonResponse): T {
  if (res.status >= 400) throw workflowError(res);
  return res.body as T;
}

/** One workflow's definition and problems (WORKFLOW_NOT_FOUND passes through). */
export async function readWorkflow(api: DaemonApi, workflowId: string): Promise<GetWorkflowResponse> {
  const body = expectWorkflowOk<GetWorkflowResponse>(await api.request("GET", workflowRoutes.workflow(workflowId)));
  return { workflow: body.workflow, problems: sanitizeProblems(body.problems) };
}

/** Validation problems of a definition the daemon has not saved (the validate route). */
export async function validateDefinition(api: DaemonApi, workflow: unknown): Promise<WorkflowProblem[]> {
  const res = await api.request("POST", workflowRoutes.validate, { body: { workflow } });
  return sanitizeProblems(expectWorkflowOk<{ problems?: unknown }>(res).problems);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const AGENT_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

/** "Claude" for a chat caller's agent; "An agent" otherwise. */
export function agentLabel(caller: ToolCaller): string {
  return caller.kind === "thread" ? (AGENT_LABELS[caller.agentId] ?? caller.agentId) : "An agent";
}

/** "ws/project" for an existing project, words for a temp one. */
export function workflowProjectLabel(project: WorkflowProject, workspacesDir: string): string {
  if (project.kind === "existing") {
    const names = projectNamesFor(project.projectPath, workspacesDir);
    return names.workspace && names.name ? `${names.workspace}/${names.name}` : project.projectPath;
  }
  const source = project.source.kind === "clone" ? `a clone of ${project.source.url}${project.source.ref ? ` at ${project.source.ref}` : ""}` : "empty";
  return `temporary project in workspace ${project.workspace} (${source})`;
}

/** "ws/name" of a canonical project path under the (canonical) workspaces root, else the path. */
function canonicalLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : path;
}

// ---------------------------------------------------------------------------
// The project union (D-25)
// ---------------------------------------------------------------------------

/** What one definition names: its project, its blocks' overrides, its sub-workflows. */
export interface WorkflowMembers {
  /** Existing project paths, as stored (absolute). */
  projects: string[];
  /** A temporary project's workspace (one per run, not created yet). */
  pendingWorkspaces: string[];
  /** Workflow ids `workflow` blocks run. */
  childIds: string[];
}

export function membersOf(workflow: { project?: WorkflowProject; nodes?: readonly WorkflowNode[] }): WorkflowMembers {
  const members: WorkflowMembers = { projects: [], pendingWorkspaces: [], childIds: [] };
  const project = workflow.project;
  if (project?.kind === "existing") members.projects.push(project.projectPath);
  else if (project?.kind === "temp") members.pendingWorkspaces.push(project.workspace);
  for (const node of workflow.nodes ?? []) {
    if (typeof node.projectOverride === "string" && node.projectOverride !== "") members.projects.push(node.projectOverride);
    if (node.type === "workflow" && isRecord(node.config) && typeof node.config.workflowId === "string" && node.config.workflowId !== "") {
      members.childIds.push(node.config.workflowId);
    }
  }
  return members;
}

export interface WorkflowUnion {
  /** Canonical project roots, deduplicated, first seen first. */
  projects: string[];
  /** Workspaces of temporary projects not created yet. */
  pendingWorkspaces: string[];
  /** Stored members that resolve to no project any more (the card names them; a run fails there). */
  missing: string[];
  /** Sub-workflows reached through `workflow` blocks (recursively), with their names; `name: null` = not found. */
  children: { workflowId: string; name: string | null; revision?: number; enabled?: boolean; project?: WorkflowProject }[];
}

const emptyUnion = (): WorkflowUnion => ({ projects: [], pendingWorkspaces: [], missing: [], children: [] });

async function addMembers(api: DaemonApi, union: WorkflowUnion, members: WorkflowMembers): Promise<void> {
  for (const path of members.projects) {
    const project = await canonicalProject(api, path);
    if (project === null) {
      if (!union.missing.includes(path)) union.missing.push(path);
    } else if (!union.projects.includes(project.canonical)) {
      union.projects.push(project.canonical);
    }
  }
  for (const workspace of members.pendingWorkspaces) if (!union.pendingWorkspaces.includes(workspace)) union.pendingWorkspaces.push(workspace);
}

/**
 * The union of every project `definitions` touch (D-25), sub-workflows included (a `workflow` block
 * runs its child in the child's own projects: they are part of what the parent does). Stored
 * members are lenient — a project removed since is listed in `missing`, not refused, so a broken
 * workflow can still be fixed or deleted; members a caller names in ARGUMENTS are resolved strictly
 * before they reach here (`PROJECT_NOT_FOUND`). Children are read up to the sub-workflow depth cap,
 * each once (a cycle stops).
 */
export async function workflowUnion(api: DaemonApi, definitions: readonly { id?: string; project?: WorkflowProject; nodes?: readonly WorkflowNode[] }[]): Promise<WorkflowUnion> {
  const union = emptyUnion();
  const seen = new Set<string>(definitions.map((definition) => definition.id).filter((id): id is string => typeof id === "string"));
  let frontier: string[] = [];
  for (const definition of definitions) {
    const members = membersOf(definition);
    await addMembers(api, union, members);
    frontier.push(...members.childIds);
  }
  for (let depth = 0; depth < WORKFLOW_LIMITS.maxSubWorkflowDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const childId of frontier) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const res = await api.request("GET", workflowRoutes.workflow(childId));
      if (res.status >= 400) {
        // A missing child is a validation problem the card shows; anything else is a real failure.
        if (res.status !== 404) throw workflowError(res);
        union.children.push({ workflowId: childId, name: null });
        continue;
      }
      const child = (res.body as GetWorkflowResponse).workflow;
      union.children.push({ workflowId: childId, name: child.name, revision: child.revision, enabled: child.enabled, project: child.project });
      const members = membersOf(child);
      await addMembers(api, union, members);
      next.push(...members.childIds);
    }
    frontier = next;
  }
  return union;
}

/**
 * What a card needs for grants (§7.6): every sub-workflow the call runs must be covered by the same
 * grant (`childWorkflowIds`), and a member that no longer resolves to a project can be judged by no
 * grant — fail closed (`ungrantable`).
 */
export function unionGrantFields(union: WorkflowUnion): { childWorkflowIds?: string[]; ungrantable?: true } {
  return {
    ...(union.children.length > 0 ? { childWorkflowIds: union.children.map((child) => child.workflowId) } : {}),
    // A member that no longer resolves, or a sub-workflow that does not exist: no grant can judge it.
    ...(union.missing.length > 0 || union.children.some((child) => child.name === null) ? { ungrantable: true as const } : {})
  };
}

/**
 * Whether a chat grant could be offered on this card at all (the executor and the port decide; this
 * only keeps the card's wording true): a full-access chat that is not workflow-owned, a union inside
 * its own project, nothing missing.
 */
export async function unionGrantable(api: DaemonApi, union: WorkflowUnion, caller: ToolCaller): Promise<boolean> {
  if (caller.kind !== "thread" || caller.runtimeMode !== "full-access" || caller.workflowOwned || !caller.projectPath) return false;
  if (unionGrantFields(union).ungrantable || union.pendingWorkspaces.length > 0) return false;
  const own = (await canonicalProject(api, caller.projectPath))?.canonical;
  return own !== undefined && union.projects.every((path) => path === own);
}

/** The union as the gate judges it. */
export function unionScope(union: WorkflowUnion): Pick<ScopeClaim, "projects" | "pendingProjects"> {
  return union.pendingWorkspaces.length > 0
    ? { projects: [...union.projects], pendingProjects: union.pendingWorkspaces.map((workspace) => ({ workspace })) }
    : { projects: [...union.projects] };
}

/**
 * A workflow's HOME as reads and run control judge it: its existing project (when it still is
 * one), or its temporary project's workspace. The definition belongs there; the union is what it
 * changes and runs in (Admin).
 */
export async function homeScope(api: DaemonApi, project: WorkflowProject | undefined): Promise<Pick<ScopeClaim, "projects" | "pendingProjects">> {
  if (project?.kind === "temp") return { projects: [], pendingProjects: [{ workspace: project.workspace }] };
  if (project?.kind !== "existing") return { projects: [] };
  const canonical = await canonicalProject(api, project.projectPath);
  return { projects: canonical ? [canonical.canonical] : [] };
}

// ---------------------------------------------------------------------------
// Saved prompts a workflow references
// ---------------------------------------------------------------------------

export interface ReferencedPrompt {
  id: string;
  title: string;
  body: string;
  /** `null` = global. */
  projectPath: string | null;
  sha256: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Every saved-prompt id the definition's agent blocks reference, in block order, each once. */
export function savedPromptIdsOf(workflow: { nodes?: readonly WorkflowNode[] }): string[] {
  const ids: string[] = [];
  for (const node of workflow.nodes ?? []) {
    if (node.type !== "agent" || !isRecord(node.config) || !isRecord(node.config.prompt)) continue;
    const prompt = node.config.prompt;
    if (prompt.kind === "saved" && typeof prompt.promptId === "string" && !ids.includes(prompt.promptId)) ids.push(prompt.promptId);
  }
  return ids;
}

async function listPrompts(api: DaemonApi, projectPath: string | null): Promise<SavedPrompt[]> {
  const res = await api.request("GET", "/api/saved-prompts", projectPath ? { query: { projectPath } } : undefined);
  if (res.status >= 400) return [];
  const prompts = (res.body as SavedPromptListResponse | null)?.prompts;
  return Array.isArray(prompts) ? prompts : [];
}

/**
 * The current body of every prompt in `ids` (`null`: no such prompt — the block fails at run, and
 * validation says so). Saved prompts are global or per project and the list route is per project:
 * the globals and the `hintProjects` (the workflow's union) are read first, then every other
 * project only while some prompt is still unfound.
 */
export async function resolveSavedPrompts(api: DaemonApi, ids: readonly string[], hintProjects: readonly string[]): Promise<Map<string, ReferencedPrompt | null>> {
  const found = new Map<string, ReferencedPrompt | null>();
  if (ids.length === 0) return found;
  const wanted = new Set(ids);
  const take = (prompts: readonly SavedPrompt[]) => {
    for (const prompt of prompts) {
      if (!wanted.has(prompt.id) || found.has(prompt.id) || typeof prompt.body !== "string") continue;
      found.set(prompt.id, { id: prompt.id, title: String(prompt.title ?? ""), body: prompt.body, projectPath: prompt.projectPath ?? null, sha256: sha256(prompt.body) });
    }
  };
  const done = () => ids.every((id) => found.has(id));
  take(await listPrompts(api, null));
  const tried = new Set<string>();
  for (const project of hintProjects) {
    if (done()) break;
    tried.add(project);
    take(await listPrompts(api, project));
  }
  if (!done()) {
    const workspaces = await api.request("GET", "/api/workspaces");
    for (const workspace of Array.isArray(workspaces.body) ? (workspaces.body as WorkspaceSummary[]) : []) {
      if (done()) break;
      const projects = await api.request("GET", `/api/workspaces/${encodeURIComponent(workspace.name)}/projects`);
      for (const project of Array.isArray(projects.body) ? (projects.body as ProjectSummary[]) : []) {
        if (done()) break;
        if (tried.has(project.path)) continue;
        tried.add(project.path);
        take(await listPrompts(api, project.path));
      }
    }
  }
  for (const id of ids) if (!found.has(id)) found.set(id, null);
  return found;
}

/** A workflow that references a saved prompt, and the blocks that do. */
export interface PromptWorkflowUse {
  workflowId: string;
  name: string;
  revision: number;
  project: WorkflowProject;
  /** The agent blocks whose prompt is `{kind: "saved", promptId}`. */
  nodes: { id: string; name: string }[];
}

/**
 * For Task 12's `update_saved_prompts` (spec §4.1 "Saved prompts", §7.1 "saved prompt edit"):
 * every workflow whose agent blocks reference `promptId`. A non-empty answer makes an agent's
 * update/delete of that prompt Admin `workflows` (`ApprovalPreview.workflowReferencedPrompt: true`,
 * never grantable); the card names these workflows, and `workflowUnion(api, <their definitions>)`
 * is the scope such an edit touches. Reads every definition (the list route carries no blocks).
 */
export async function workflowsReferencingPrompt(api: DaemonApi, promptId: string): Promise<PromptWorkflowUse[]> {
  const listed = expectWorkflowOk<ListWorkflowsResponse>(await api.request("GET", workflowRoutes.list));
  const uses: PromptWorkflowUse[] = [];
  for (const summary of listed.workflows ?? []) {
    const res = await api.request("GET", workflowRoutes.workflow(summary.id));
    if (res.status === 404) continue; // deleted meanwhile
    const workflow = expectWorkflowOk<GetWorkflowResponse>(res).workflow;
    const nodes = workflow.nodes
      .filter((node) => node.type === "agent" && isRecord(node.config) && isRecord(node.config.prompt) && node.config.prompt.kind === "saved" && node.config.prompt.promptId === promptId)
      .map((node) => ({ id: node.id, name: node.name }));
    if (nodes.length > 0) uses.push({ workflowId: workflow.id, name: workflow.name, revision: workflow.revision, project: workflow.project, nodes });
  }
  return uses;
}

// ---------------------------------------------------------------------------
// Pins (§7.2)
// ---------------------------------------------------------------------------

const WORKFLOW_PIN = "workflow:";
const PROMPT_PIN = "prompt:";
const MISSING = "missing";

export function workflowPin(workflowId: string): string {
  return `${WORKFLOW_PIN}${workflowId}`;
}

/**
 * Pins for a preview: the workflow's revision (when it exists), every sub-workflow's revision (or
 * `missing`) the union reached, and every prompt the card showed.
 */
export function previewPins(workflow: { id: string; revision: number } | null, prompts: ReadonlyMap<string, ReferencedPrompt | null>, union?: WorkflowUnion): Record<string, string> {
  const pins: Record<string, string> = {};
  if (workflow) pins[workflowPin(workflow.id)] = String(workflow.revision);
  for (const child of union?.children ?? []) pins[workflowPin(child.workflowId)] = child.name === null || child.revision === undefined ? MISSING : String(child.revision);
  for (const [id, prompt] of prompts) pins[`${PROMPT_PIN}${id}`] = prompt ? prompt.sha256 : MISSING;
  return pins;
}

/** How a gated call passed: a card the user approved, or this chat's grant (no card). */
export type PassedBy = "approved" | "granted";

/** "after the user approved the card" / "after this chat's grant allowed the call". */
export function passedPhrase(via: PassedBy | undefined): string {
  return via === "granted" ? "after this chat's grant allowed the call" : "after the user approved the card";
}

const stale = (what: string, via: PassedBy | undefined) =>
  new ToolError("PREVIEW_STALE", `${what} changed ${passedPhrase(via)}; nothing was done. Re-read it (get_workflow) and call again: what was allowed is what runs.`);

/**
 * Re-verify a card's pins immediately before the write (§7.2): the workflow's revision, then each
 * shown prompt's body hash. Any mismatch is `PREVIEW_STALE`, nothing written. `current` is the
 * definition the caller just read (it saves a read); prompts are looked up in `hintProjects` first.
 */
export async function verifyPins(
  api: DaemonApi,
  pins: Readonly<Record<string, string>> | undefined,
  opts: { current?: { id: string; revision: number }; hintProjects?: readonly string[]; via?: PassedBy; creating?: boolean } = {}
): Promise<void> {
  if (!pins) return;
  // The workflow the call is about: the one read, else the first workflow pin (`previewPins` writes it
  // first). A create has none yet: every workflow pin is a sub-workflow.
  const parentId = opts.creating ? undefined : (opts.current?.id ?? Object.keys(pins).find((key) => key.startsWith(WORKFLOW_PIN))?.slice(WORKFLOW_PIN.length));
  for (const [key, value] of Object.entries(pins)) {
    if (!key.startsWith(WORKFLOW_PIN)) continue;
    const id = key.slice(WORKFLOW_PIN.length);
    const current = opts.current && opts.current.id === id ? opts.current : await readWorkflow(api, id).then((r) => r.workflow, (error) => {
      if (error instanceof ToolError && error.code === "WORKFLOW_NOT_FOUND") return null;
      throw error;
    });
    const what = id === parentId ? "The workflow" : `The sub-workflow ${id}`;
    if (current === null) {
      if (value !== MISSING) throw stale(what, opts.via);
      continue;
    }
    if (String(current.revision) !== value) throw stale(`${what} (revision ${value === MISSING ? "missing" : value} → ${current.revision})`, opts.via);
  }
  const promptIds = Object.keys(pins).filter((key) => key.startsWith(PROMPT_PIN)).map((key) => key.slice(PROMPT_PIN.length));
  if (promptIds.length === 0) return;
  const now = await resolveSavedPrompts(api, promptIds, opts.hintProjects ?? []);
  for (const id of promptIds) {
    const prompt = now.get(id) ?? null;
    if ((prompt ? prompt.sha256 : MISSING) !== pins[`${PROMPT_PIN}${id}`]) throw stale(`The saved prompt ${prompt ? `"${clipText(prompt.title, 80)}"` : id}`, opts.via);
  }
}

// ---------------------------------------------------------------------------
// Preview sections (§7.1)
// ---------------------------------------------------------------------------

/** Each workspace's git account label (best effort: a card still opens without them). */
export async function gitIdentities(api: DaemonApi): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  try {
    const [workspaces, accounts] = await Promise.all([api.request("GET", "/api/workspaces"), api.request("GET", "/api/accounts")]);
    if (workspaces.status >= 400 || !Array.isArray(workspaces.body)) return labels;
    const byId = new Map<string, AccountSummary>(accounts.status < 400 && Array.isArray(accounts.body) ? (accounts.body as AccountSummary[]).map((account) => [account.id, account]) : []);
    for (const workspace of workspaces.body as WorkspaceSummary[]) {
      const account = workspace.gitAccount ?? (workspace.gitAccountId ? byId.get(workspace.gitAccountId) : undefined);
      if (account?.label) labels.set(workspace.name, `${account.label}${account.login ? ` (${account.login})` : ""}`);
    }
  } catch {
    // A card names what it can.
  }
  return labels;
}

/**
 * The union with each member's git identity (§5.5: a workflow runs with each member project's
 * workspace identity), the caller's own project marked, temp workspaces and missing members named.
 */
export async function unionSections(api: DaemonApi, union: WorkflowUnion, caller: ToolCaller, opts: { childrenJoinGrant?: boolean } = {}): Promise<ApprovalPreviewSection[]> {
  const identities = await gitIdentities(api);
  const own = caller.kind === "thread" && caller.projectPath ? (await canonicalProject(api, caller.projectPath))?.canonical ?? "" : "";
  const identity = (workspace: string) => (identities.has(workspace) ? `git: ${identities.get(workspace)}` : "git: the default identity");
  const rows: { label: string; value: string; state?: "flagged" }[] = [];
  for (const path of union.projects) {
    const label = canonicalLabel(path);
    const workspace = label.split("/")[0] ?? "";
    rows.push({ label: path === own ? `${label} (this chat's project)` : label, value: identity(workspace), ...(path === own ? {} : { state: "flagged" as const }) });
  }
  for (const workspace of union.pendingWorkspaces) rows.push({ label: `A new temporary project in workspace ${workspace} (each run)`, value: identity(workspace), state: "flagged" });
  const sections: ApprovalPreviewSection[] = [{ kind: "fields", title: "Runs in these projects", rows: rows.length > 0 ? rows : [{ label: "Projects", value: "none" }] }];
  for (const child of union.children) {
    if (child.name === null) {
      sections.push({ kind: "warning", level: "caution", text: `A block runs the workflow ${child.workflowId}, which does not exist: that block will fail.` });
      continue;
    }
    // A disabled workflow still runs when another one calls it: say so where it cannot be missed.
    if (child.enabled === false) {
      sections.push({ kind: "warning", level: "danger", text: `A block runs the DISABLED workflow "${child.name}" (${child.workflowId}): being disabled does not stop it running as a sub-workflow.` });
    }
    sections.push({ kind: "text", title: "Sub-workflow", text: `Runs the workflow "${child.name}" (${child.workflowId}, revision ${child.revision ?? "?"}${child.enabled === false ? ", disabled" : ""}) in ${child.project ? workflowProjectLabel(child.project, api.workspacesDir) : "its project"}; its projects are counted above.` });
  }
  if (union.children.length > 0) {
    // A chat grant chosen on this card covers these too (§7.6): each is named, with the revision it is at.
    sections.push({
      kind: "fields",
      // Only where a grant chosen on this card really records them (grantable update / run / create cards).
      title: opts.childrenJoinGrant ? "Workflows it also runs (a chat grant chosen here covers them too)" : "Workflows it also runs",
      rows: union.children.map((child) => ({
        label: child.name === null ? child.workflowId : `${child.name} (${child.workflowId})`,
        value: child.name === null ? "missing" : `revision ${child.revision ?? "?"}${child.enabled === false ? ", disabled" : ""}`,
        state: "flagged" as const
      }))
    });
  }
  for (const path of union.missing) sections.push({ kind: "warning", level: "caution", text: `${path} is no longer a project: blocks that run there will fail.` });
  return sections;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? "null";

function nodeTitle(node: WorkflowNode, label: string): string {
  return `${label} · ${node.name}${node.disabled ? " (disabled)" : ""}`;
}

/** The fields every block may carry beside its config. */
function nodeExtras(node: WorkflowNode, workspacesDir: string): { label: string; value: string; state?: "flagged" }[] {
  const rows: { label: string; value: string; state?: "flagged" }[] = [];
  if (node.projectOverride) {
    const names = projectNamesFor(node.projectOverride, workspacesDir);
    rows.push({ label: "Runs in", value: names.workspace && names.name ? `${names.workspace}/${names.name}` : node.projectOverride, state: "flagged" });
  }
  if (node.retry) rows.push({ label: "Retry", value: `${node.retry.maxTries} tries, ${node.retry.delaySeconds}s apart` });
  if (node.timeoutMinutes !== undefined) rows.push({ label: "Timeout", value: `${node.timeoutMinutes} min` });
  return rows;
}

const keyValues = (list: unknown): { name: string; value: string }[] =>
  Array.isArray(list) ? list.filter(isRecord).map((entry) => ({ name: String(entry.name ?? ""), value: String(entry.value ?? "") })) : [];

/**
 * One block, complete (§7.1): code and shell sources in full, an HTTP request whole (secret refs by
 * name — a definition never holds a value), an agent's chain, session, accounts and its prompt in
 * full (a saved prompt's current body, labelled with its title), anything else as its config JSON.
 */
export function blockSections(node: WorkflowNode, prompts: ReadonlyMap<string, ReferencedPrompt | null>, workspacesDir: string): ApprovalPreviewSection[] {
  const config: Record<string, unknown> = isRecord(node.config) ? (node.config as Record<string, unknown>) : {};
  const extras = nodeExtras(node, workspacesDir);
  const sections: ApprovalPreviewSection[] = [];
  switch (node.type) {
    case "code":
      sections.push({ kind: "code", title: nodeTitle(node, "Code"), language: "javascript", text: String(config.source ?? "") });
      if (extras.length > 0) sections.push({ kind: "fields", title: nodeTitle(node, "Code"), rows: extras });
      return sections;
    case "shell": {
      sections.push({ kind: "code", title: nodeTitle(node, `Shell (${String(config.shell ?? "bash")})`), language: "bash", text: String(config.script ?? "") });
      const env = keyValues(config.env);
      const rows = [...env.map((entry) => ({ label: `env ${entry.name}`, value: entry.value })), ...extras];
      if (rows.length > 0) sections.push({ kind: "fields", title: nodeTitle(node, "Shell environment"), rows });
      return sections;
    }
    case "http": {
      const rows = [
        { label: "Request", value: `${String(config.method ?? "GET")} ${String(config.url ?? "")}` },
        ...keyValues(config.headers).map((h) => ({ label: `Header ${h.name}`, value: h.value })),
        ...keyValues(config.query).map((q) => ({ label: `Query ${q.name}`, value: q.value })),
        ...extras
      ];
      sections.push({ kind: "fields", title: nodeTitle(node, "HTTP"), rows });
      const body = isRecord(config.body) ? config.body : null;
      if (body) {
        const text = body.kind === "form" ? keyValues(body.fields).map((f) => `${f.name}=${f.value}`).join("\n") : String(body.value ?? "");
        sections.push({ kind: "code", title: nodeTitle(node, `HTTP body (${String(body.kind)})`), language: body.kind === "json" ? "json" : "text", text });
      }
      return sections;
    }
    case "agent": {
      const chain = Array.isArray(config.chain) ? config.chain.filter(isRecord) : [];
      const session = isRecord(config.session) ? config.session : { kind: "new" };
      const rows = [
        ...chain.map((entry, index) => {
          const accounts = isRecord(entry.accounts) ? entry.accounts : {};
          const options = Array.isArray(entry.options) ? entry.options.filter(isRecord).map((o) => `${String(o.id)}=${String(o.value)}`).join(", ") : "";
          const pool = Array.isArray(accounts.accounts) && accounts.accounts.length > 0 ? `accounts ${accounts.accounts.join(", ")}` : "any account";
          return { label: index === 0 ? "Agent" : `Fallback ${index}`, value: `${String(entry.agent)} · ${String(entry.model)}${options ? ` (${options})` : ""} · ${String(accounts.strategy ?? "least-used")}, ${pool}` };
        }),
        // Workflow agent sessions run unattended in Full access (`workflows/agent/create.ts`).
        { label: "Permission mode", value: "Full access, unattended", state: "flagged" as const },
        { label: "Session", value: session.kind === "continue" ? `continues the session of block ${String(session.fromNode)}` : `a new chat${session.title ? ` "${String(session.title)}"` : ""}` },
        { label: "Runs up to", value: `${String(config.maxMinutes ?? 240)} min` },
        ...extras
      ];
      sections.push({ kind: "fields", title: nodeTitle(node, "Agent"), rows });
      const prompt = isRecord(config.prompt) ? config.prompt : null;
      if (prompt?.kind === "saved") {
        const saved = prompts.get(String(prompt.promptId)) ?? null;
        if (saved) sections.push({ kind: "code", title: `Saved prompt "${saved.title}" · ${node.name}`, language: "markdown", text: saved.body, sha256: saved.sha256 });
        else sections.push({ kind: "warning", level: "caution", text: `Block ${node.name} uses the saved prompt ${String(prompt.promptId)}, which does not exist: it will fail.` });
        if (typeof prompt.append === "string" && prompt.append !== "") sections.push({ kind: "code", title: `Appended to the prompt · ${node.name}`, language: "markdown", text: prompt.append });
      } else {
        sections.push({ kind: "code", title: `Prompt · ${node.name}`, language: "markdown", text: prompt ? String(prompt.text ?? "") : "" });
      }
      return sections;
    }
    case "note":
      return [{ kind: "text", title: nodeTitle(node, "Note"), text: String(config.text ?? "") }];
    default:
      sections.push({ kind: "code", title: nodeTitle(node, node.type), language: "json", text: json(config) });
      if (extras.length > 0) sections.push({ kind: "fields", title: nodeTitle(node, node.type), rows: extras });
      return sections;
  }
}

/** Every trigger, one line each. */
export function triggerSection(workflow: Pick<Workflow, "nodes">): ApprovalPreviewSection {
  const lines = workflow.nodes.filter((node) => isTriggerType(node.type)).map((node) => {
    let text: string;
    try { text = triggerSummaryText(node); } catch { text = node.type; }
    const git = node.type === "trigger.git" && isRecord(node.config) && isRecord(node.config.repo) && node.config.repo.kind === "url"
      ? ` (repo ${String(node.config.repo.url)}${node.config.repo.accountId ? `, git account ${String(node.config.repo.accountId)}` : ""})`
      : "";
    return `${node.name}${node.disabled ? " (disabled)" : ""}: ${text}${git}`;
  });
  return { kind: "text", title: "Triggers", text: lines.length > 0 ? lines.join("\n") : "No trigger: it runs only when started by hand or by another workflow." };
}

/** Every edge in block names: "HasTickets (true) → FixTickets" — `(success)` left implicit. */
export function connectionsOf(workflow: Pick<Workflow, "nodes" | "edges">): string[] {
  const names = new Map(workflow.nodes.map((n) => [n.id, n.name]));
  return workflow.edges.map((e) => `${names.get(e.source) ?? e.source}${e.sourceHandle === "success" ? "" : ` (${e.sourceHandle})`} → ${names.get(e.target) ?? e.target}`);
}

function settingsRows(workflow: Pick<Workflow, "settings" | "enabled" | "description">): { label: string; value: string; state?: "flagged" }[] {
  const s: Record<string, unknown> = isRecord(workflow.settings) ? (workflow.settings as Record<string, unknown>) : {};
  const rows: { label: string; value: string; state?: "flagged" }[] = [
    { label: "Enabled", value: workflow.enabled ? "yes — schedule and git triggers fire" : "no", ...(workflow.enabled ? { state: "flagged" as const } : {}) },
    { label: "Overlap", value: `${String(s.overlap ?? "skip")}, at most ${String(s.maxConcurrent ?? 2)} at once` },
    { label: "Time zone", value: String(s.timezone ?? "UTC") }
  ];
  if (s.runTimeoutMinutes !== undefined) rows.push({ label: "Run timeout", value: `${String(s.runTimeoutMinutes)} min` });
  if (workflow.description) rows.push({ label: "Description", value: workflow.description });
  return rows;
}

export function problemSections(problems: readonly WorkflowProblem[]): ApprovalPreviewSection[] {
  if (problems.length === 0) return [];
  const sorted = sortedProblems(problems);
  const errors = sorted.filter((p) => p.severity === "error").length;
  return [
    { kind: "warning", level: "caution", text: errors > 0 ? `${errors} validation error(s): it cannot be enabled until they are fixed.` : `${sorted.length} validation warning(s).` },
    { kind: "text", title: "Validation problems", text: sorted.map(problemLine).join("\n") }
  ];
}

/** The whole definition, complete: settings, triggers, every block, connections. */
export function definitionSections(workflow: Workflow, prompts: ReadonlyMap<string, ReferencedPrompt | null>, workspacesDir: string, only?: ReadonlySet<string>): ApprovalPreviewSection[] {
  const sections: ApprovalPreviewSection[] = [triggerSection(workflow)];
  const unchanged: string[] = [];
  for (const node of workflow.nodes) {
    if (isTriggerType(node.type) && node.type !== "trigger.git") continue;
    if (only && !only.has(node.id)) {
      unchanged.push(`${node.type} · ${node.name}${node.disabled ? " (disabled)" : ""}`);
      continue;
    }
    sections.push(...blockSections(node, prompts, workspacesDir));
  }
  if (unchanged.length > 0) sections.push({ kind: "text", title: "Unchanged blocks", text: unchanged.join("\n") });
  const connections = connectionsOf(workflow);
  sections.push({ kind: "text", title: "Connections", text: connections.length > 0 ? connections.join("\n") : "none" });
  return sections;
}

export function workflowFields(workflow: Workflow, workspacesDir: string, title = "Workflow"): ApprovalPreviewSection {
  return {
    kind: "fields",
    title,
    rows: [
      { label: "Name", value: workflow.name },
      { label: "Project", value: workflowProjectLabel(workflow.project, workspacesDir) },
      ...settingsRows(workflow)
    ]
  };
}

// ---------------------------------------------------------------------------
// Graph diff (update cards)
// ---------------------------------------------------------------------------

/** A node without its canvas position (moving a block changes nothing that runs). */
function comparable(node: WorkflowNode): Record<string, unknown> {
  const { position: _position, ...rest } = node as WorkflowNode & Record<string, unknown>;
  return rest;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What changed in a block: top-level fields, and config keys one level deep. */
function changedFields(before: WorkflowNode, after: WorkflowNode): string[] {
  const a = comparable(before);
  const b = comparable(after);
  const fields: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "config" && isRecord(a.config) && isRecord(b.config)) {
      for (const sub of new Set([...Object.keys(a.config), ...Object.keys(b.config)])) if (!same(a.config[sub], b.config[sub])) fields.push(`config.${sub}`);
    } else if (!same(a[key], b[key])) {
      fields.push(key);
    }
  }
  return fields;
}

/**
 * A minimal unified diff of two texts: the common head and tail kept as context, the middle as
 * one hunk. Exact (applying it gives `after`), linear, and never cut.
 */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  if (head === a.length && head === b.length) return "";
  const start = Math.max(0, head - context);
  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  const after_ = Math.min(tail, context);
  const lines = [
    `@@ -${start + 1},${aEnd + after_ - start} +${start + 1},${bEnd + after_ - start} @@`,
    ...a.slice(start, head).map((line) => ` ${line}`),
    ...a.slice(head, aEnd).map((line) => `-${line}`),
    ...b.slice(head, bEnd).map((line) => `+${line}`),
    ...a.slice(aEnd, aEnd + after_).map((line) => ` ${line}`)
  ];
  return lines.join("\n");
}

export interface GraphDiff {
  /** Block ids added or whose content changed (their full content goes on the card). */
  touched: Set<string>;
  sections: ApprovalPreviewSection[];
}

/** The graph diff of an edit (§7.1): blocks, connections, settings, project, name, enabled, pinned data. */
export function graphDiff(before: Workflow, after: Workflow, workspacesDir: string): GraphDiff {
  const items: { label: string; change: "added" | "removed" | "changed"; detail?: string }[] = [];
  const diffs: ApprovalPreviewSection[] = [];
  const touched = new Set<string>();
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));
  for (const node of after.nodes) {
    const old = beforeById.get(node.id);
    if (!old) {
      items.push({ label: `${node.type} · ${node.name}`, change: "added" });
      touched.add(node.id);
      continue;
    }
    const fields = changedFields(old, node);
    if (fields.length === 0) continue;
    items.push({ label: `${node.type} · ${old.name === node.name ? node.name : `${old.name} → ${node.name}`}`, change: "changed", detail: fields.join(", ") });
    touched.add(node.id);
    const diff = unifiedDiff(json(comparable(old)), json(comparable(node)));
    if (diff) diffs.push({ kind: "diff", title: `Block ${node.name}`, unifiedDiff: diff });
  }
  for (const node of before.nodes) if (!afterById.has(node.id)) items.push({ label: `${node.type} · ${node.name}`, change: "removed" });
  // What can now run differently is part of the change: an added edge's target and everything
  // downstream of it, every block whose reachability from a trigger changed, and everything
  // downstream of a block whose routing (if/switch) or enabled state changed.
  const withDownstream = (id: string) => {
    if (!afterById.has(id)) return;
    touched.add(id);
    for (const next of downstreamOf(after, id)) touched.add(next);
  };
  const [reachBefore, reachAfter] = [reachableFromTriggers(before), reachableFromTriggers(after)];
  for (const node of after.nodes) {
    if (reachBefore.has(node.id) !== reachAfter.has(node.id)) touched.add(node.id);
    const old = beforeById.get(node.id);
    if (old && (node.type === "if" || node.type === "switch" || old.disabled !== node.disabled) && changedFields(old, node).length > 0) withDownstream(node.id);
  }
  // Connections by block ids (a renamed block keeps its connections), labelled with names.
  const edgeKeys = (workflow: Workflow) => {
    const labels = connectionsOf(workflow);
    return new Map(workflow.edges.map((e, i) => [`${e.source}|${e.sourceHandle}|${e.target}`, labels[i]!]));
  };
  const [edgesBefore, edgesAfter] = [edgeKeys(before), edgeKeys(after)];
  for (const [key, label] of edgesAfter) {
    if (edgesBefore.has(key)) continue;
    items.push({ label: `connection ${label}`, change: "added" });
    withDownstream(key.split("|")[2]!);
  }
  for (const [key, label] of edgesBefore) if (!edgesAfter.has(key)) items.push({ label: `connection ${label}`, change: "removed" });
  if (!same(before.project, after.project)) {
    items.push({ label: "project", change: "changed", detail: `${workflowProjectLabel(before.project, workspacesDir)} → ${workflowProjectLabel(after.project, workspacesDir)}` });
  }
  if (!same(before.settings, after.settings)) {
    items.push({ label: "settings", change: "changed" });
    diffs.push({ kind: "diff", title: "Settings", unifiedDiff: unifiedDiff(json(before.settings), json(after.settings)) });
  }
  if (before.name !== after.name) items.push({ label: "name", change: "changed", detail: `${before.name} → ${after.name}` });
  if ((before.description ?? "") !== (after.description ?? "")) items.push({ label: "description", change: "changed" });
  if (before.enabled !== after.enabled) items.push({ label: after.enabled ? "enabled (triggers fire)" : "disabled", change: "changed" });
  if (!same(before.pinned ?? {}, after.pinned ?? {})) items.push({ label: "pinned test data", change: "changed" });
  const sections: ApprovalPreviewSection[] = [{ kind: "changes", title: "Changes", items: items.length > 0 ? items : [{ label: "nothing that runs", change: "changed" }] }, ...diffs];
  return { touched, sections };
}
