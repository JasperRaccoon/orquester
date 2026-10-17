// Catalog family module `catalog` (Discovery: list_projects, list_agents, list_conversations) — plan Task 9
// (unified MCP design 2026-10-15 §4 rows 1–3, §4.1, §5.5).
import { basename } from "node:path";
import { z } from "zod";
import type { AccountSummary, AgentConversationsResponse, ProjectSummary, RecentProjectSummary, RegistryResponse, WorkspaceGitAccount, WorkspaceSummary } from "@orquester/api";
import { RUNTIME_MODE_HINTS, RUNTIME_MODE_LABELS, RUNTIME_MODES } from "@orquester/api/agent-chat";
import { resolveProject } from "../addressing.ts";
import { findAgent, findModel, fitAgentViews, loadAgents, nameList, type AgentView } from "../agents.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ScopeContext, type ToolCaller } from "../catalog/contract.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError, expectOk } from "../errors.ts";
import { runtimeModesUpTo } from "../gate/turn-policy.ts";
import { listSessions, readThreadHead } from "../reads.ts";
import { MAX_RESULT_BYTES, resultBytes } from "../result.ts";

/**
 * One workspace's projects, or the warning that stands in for them: a workspace that cannot be read is left out
 * rather than failing the whole list (fail-soft, as `/api/agents/conversations` is by design).
 */
async function readWorkspace(api: DaemonApi, workspace: string): Promise<{ projects: ProjectSummary[] } | { warning: string }> {
  try {
    return { projects: expectOk<ProjectSummary[]>(await api.request("GET", `/api/workspaces/${encodeURIComponent(workspace)}/projects`)) };
  } catch (error) {
    // A thrown call's text can name a host path: it is logged here and never returned, as sendCommand does.
    if (!(error instanceof ToolError)) console.error("[mcp] daemon call failed", error);
    const cause = error instanceof ToolError ? `${error.code}: ${error.message}` : "HOST_UNAVAILABLE: The daemon call failed.";
    return { warning: `Workspace "${workspace}" was left out: its projects could not be read (${cause}).` };
  }
}

/**
 * The workspace's git identity as a list may show it (§5.5): label, login, provider — never a key, key path or token.
 * The daemon row's own `gitAccount` wins when it carries one; else `gitAccountId` is joined with `/api/accounts`.
 * `null`: no binding, or an account that no longer exists.
 */
export function workspaceGitAccount(ws: WorkspaceSummary, accounts: readonly AccountSummary[]): WorkspaceGitAccount | null {
  if (ws.gitAccount) return { label: ws.gitAccount.label, login: ws.gitAccount.login, provider: ws.gitAccount.provider };
  const account = ws.gitAccountId ? accounts.find((a) => a.id === ws.gitAccountId) : undefined;
  return account ? { label: account.label, login: account.login, provider: account.provider } : null;
}

interface ProjectRow { workspace: string; name: string; path: string; isArchived: boolean; lastInteractedAt?: string; openSessions: number; repoId?: string; current?: true; sameRepo?: true }

/**
 * Which workspaces a caller sees whole (coordinator ruling on §5.2 S13): an external or Full-access caller every one;
 * a chat below Full access only its own workspace — another one only when it names it (`workspace`, carded by its
 * scope) — and the rest as `excludedWorkspaces` counts. A chat with no project has no own workspace.
 */
function seesWorkspace(caller: ToolCaller, workspace: string, named: string | undefined): boolean {
  if (caller.kind === "external" || caller.runtimeMode === "full-access") return true;
  if (named !== undefined) return workspace === named;
  return caller.projectPath !== "" && workspace === caller.workspace;
}

const listProjects = defineTool({
  name: "list_projects",
  title: "List projects",
  description: "Projects (workspace/name, path), recent first, with open-session counts. Clones of one repo share `repoId`; `workspaces` gives each workspace's git account. workspace/name is other tools' `project`.",
  chatNote: "`current`: this chat's project; `sameRepo`: its clones. Below Full access other workspaces are only counted.",
  input: {
    workspace: z.string().min(1).optional().describe("Only this workspace."),
    query: z.string().trim().min(1).max(200).optional().describe("Filter on workspace/name."),
    includeArchived: z.boolean().default(false)
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  /*
   * A discovery list is global metadata (§5.2), except that a chat below Full access naming ANOTHER workspace reads that
   * workspace's projects: their paths are the targets, so the gate raises the cross-workspace metadata card (S13).
   */
  async scope(args, { api, caller }) {
    const none = { projects: [], sessions: [], reads: "metadata" as const, writes: false, causesTurnIn: [] };
    if (caller.kind === "external" || caller.runtimeMode === "full-access" || args.workspace === undefined) return none;
    if (caller.projectPath !== "" && args.workspace === caller.workspace) return none;
    const read = await readWorkspace(api, args.workspace);
    // An unknown or unreadable workspace reveals nothing here; `run` refuses or warns as for anyone.
    if ("warning" in read) return none;
    return { ...none, projects: read.projects.filter((p) => args.includeArchived || !p.isArchived).map((p) => p.path) };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, caller }) {
    const [workspacesRes, recentRes, sessions, accountsRes] = await Promise.all([api.request("GET", "/api/workspaces"), api.request("GET", "/api/projects/recent"), listSessions(api), api.request("GET", "/api/accounts")]);
    const workspaces = expectOk<WorkspaceSummary[]>(workspacesRes);
    // Recency only orders the list: without it the list is alphabetical, not a failure.
    const recent = recentRes.status < 400 ? (recentRes.body as RecentProjectSummary[]) : [];
    // Git identities only label the list: without the accounts store each reads as its row's own (or null).
    const accounts = accountsRes.status < 400 && Array.isArray(accountsRes.body) ? (accountsRes.body as AccountSummary[]) : [];
    const warnings: string[] = [];
    if (args.workspace !== undefined) {
      const named = workspaces.find((ws) => ws.name === args.workspace);
      if (!named) throw new ToolError("INVALID_ARGUMENT", `Unknown workspace "${args.workspace}". Workspaces: ${nameList(workspaces.map((ws) => ws.name))}.`);
      if (named.isArchived && !args.includeArchived) warnings.push(`Workspace "${named.name}" is archived; pass includeArchived: true to list its projects.`);
    }
    const shownArchive = (ws: WorkspaceSummary) => !ws.isArchived || args.includeArchived;
    const listed = workspaces.filter((ws) => (args.workspace === undefined || ws.name === args.workspace) && shownArchive(ws) && seesWorkspace(caller, ws.name, args.workspace));
    const excluded = args.workspace === undefined
      ? workspaces.filter((ws) => shownArchive(ws) && !seesWorkspace(caller, ws.name, undefined))
        .map((ws) => ({ workspace: ws.name, projectCount: Math.max(0, ws.projectCount - (args.includeArchived ? 0 : ws.archivedProjectCount ?? 0)) }))
      : [];
    const reads = await Promise.all(listed.map((ws) => readWorkspace(api, ws.name)));
    const needle = args.query?.toLowerCase();
    // The caller's own project, by name (its path is canonical, a listing's may be spelt through a link).
    const own = caller.kind === "thread" && caller.projectPath ? { workspace: caller.workspace, name: basename(caller.projectPath) } : null;
    // Its repository, whatever the filters list: read from its own workspace when that is not listed.
    let ownRepoId: string | undefined;
    if (own !== null) {
      const at = listed.findIndex((ws) => ws.name === own.workspace);
      const ownRead = at >= 0 ? reads[at]! : await readWorkspace(api, own.workspace);
      if (!("warning" in ownRead)) ownRepoId = ownRead.projects.find((p) => p.name === own.name)?.repoId;
    }
    const projects: ProjectRow[] = [];
    for (const [i, ws] of listed.entries()) {
      const read = reads[i]!;
      if ("warning" in read) { warnings.push(read.warning); continue; }
      for (const p of read.projects) {
        const isOwn = own !== null && ws.name === own.workspace && p.name === own.name;
        if (p.isArchived && !args.includeArchived) continue;
        if (needle !== undefined && !`${ws.name}/${p.name}`.toLowerCase().includes(needle)) continue;
        const r = recent.find((x) => x.path === p.path);
        // The daemon's project flag is per-project only; a project of an archived workspace is archived too.
        projects.push({
          workspace: ws.name, name: p.name, path: p.path, isArchived: ws.isArchived === true || p.isArchived === true,
          ...(r ? { lastInteractedAt: r.lastInteractedAt } : {}),
          openSessions: sessions.filter((s) => s.projectPath === p.path).length,
          ...(p.repoId ? { repoId: p.repoId } : {}),
          ...(isOwn ? { current: true as const } : {}),
          ...(!isOwn && ownRepoId !== undefined && p.repoId === ownRepoId ? { sameRepo: true as const } : {})
        });
      }
    }
    projects.sort((a, b) => {
      if (a.lastInteractedAt !== b.lastInteractedAt) { if (!a.lastInteractedAt) return 1; if (!b.lastInteractedAt) return -1; return a.lastInteractedAt < b.lastInteractedAt ? 1 : -1; }
      return `${a.workspace}/${a.name}`.localeCompare(`${b.workspace}/${b.name}`);
    });
    const shown = new Set(projects.map((row) => row.workspace));
    const workspaceRows = listed.filter((ws) => shown.has(ws.name)).map((ws) => ({ name: ws.name, ...(ws.isArchived ? { isArchived: true } : {}), gitAccount: workspaceGitAccount(ws, accounts) }));
    return { projects, workspaces: workspaceRows, ...(excluded.length ? { excludedWorkspaces: excluded } : {}), ...(warnings.length ? { warnings } : {}) };
  }
});

/** The permission modes with the composer's labels and hints (`@orquester/api` model-selection.ts). */
const PERMISSION_MODES = RUNTIME_MODES.map((id) => ({ id, label: RUNTIME_MODE_LABELS[id], hint: RUNTIME_MODE_HINTS[id] }));

/** Whether a model matches a `query`: slug, name, chip label or sub-provider contain it (any case). */
function modelMatches(model: AgentView["models"][number], needle: string): boolean {
  return [model.slug, model.name, model.shortName, model.subProvider].some((text) => typeof text === "string" && text.toLowerCase().includes(needle));
}

/** An agent as a chat caller sees it: accounts and the provider login without email; modes are `allowedRuntimeModes`. */
function chatAgentView({ runtimeModes: _modes, defaultRuntimeMode: _default, auth, accounts, ...agent }: AgentView) {
  const { email: _email, ...login } = auth;
  return { ...agent, auth: login, accounts: accounts.map(({ email: _accountEmail, ...account }) => account) };
}

/** This chat's own agent, model, options, permission mode and account: what a chat it opens with the same agent inherits. */
async function thisThread(api: DaemonApi, caller: Extract<ToolCaller, { kind: "thread" }>) {
  const [sessions, own] = await Promise.all([listSessions(api), readThreadHead(api, caller.threadId)]);
  const tab = sessions.find((s) => s.id === caller.threadId);
  if (!tab) throw new ToolError("THREAD_NOT_FOUND", "This chat is no longer open.");
  return {
    agent: tab.refId,
    model: own.head.modelSelection.model,
    options: Object.fromEntries((own.head.modelSelection.options ?? []).map((o) => [o.id, o.value])),
    runtimeMode: caller.runtimeMode,
    // The tab record spells the system identity as an absent id.
    accountId: tab.accountId || "system"
  };
}

const listAgents = defineTool({
  name: "list_agents",
  title: "List launchable agents",
  description: "Per chat agent: enabled, installed, status, models (isDefault: used when a launch names none; options with values and default), permission modes, capabilities, accounts. Only enabled agents open. Legacy models (isLegacy) only with includeLegacy. Cut catalogue (optionsOmitted, modelsTruncated): ask {agent, model}.",
  chatNote: "`thisThread`: this chat's settings, inherited by same-agent chats you open; `allowedRuntimeModes`: modes those may take.",
  input: {
    agent: z.string().min(1).max(64).optional().describe("Only this agent."),
    model: z.string().min(1).max(200).optional().describe("With agent: this model only, options whole."),
    query: z.string().trim().min(1).max(200).optional().describe("Filter models by slug, name, shortName, subProvider."),
    includeLegacy: z.boolean().default(false),
    includeLegacyModels: z.boolean().optional().describe("Old includeLegacy.")
  },
  externalOnlyInput: ["includeLegacyModels"],
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  scope: async () => ({ projects: [], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] }),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, caller }) {
    if (args.model !== undefined && args.agent === undefined) throw new ToolError("INVALID_ARGUMENT", "model needs agent: a model is looked up in one agent's catalogue — list_agents {agent, model}.");
    const includeLegacy = args.includeLegacy || args.includeLegacyModels === true;
    if (caller.kind === "external") {
      const frame = { permissionModes: PERMISSION_MODES };
      return { agents: await agentCatalog(api, { ...args, includeLegacyModels: includeLegacy }, MAX_RESULT_BYTES - resultBytes(frame) - 12), ...frame };
    }
    const frame = { thisThread: await thisThread(api, caller), allowedRuntimeModes: runtimeModesUpTo(caller.runtimeMode), permissionModes: PERMISSION_MODES };
    const agents = await agentCatalog(api, { ...args, includeLegacyModels: includeLegacy }, MAX_RESULT_BYTES - resultBytes(frame) - 12, chatAgentView);
    return { agents, ...frame };
  }
});

/**
 * list_agents' listing (also the legacy session tools' `agent_catalog`): every agent, one agent, or one agent's model
 * with its full options, the models narrowed by `query`, within `budget` bytes of `{agents}` JSON (`fitAgentViews`),
 * each agent shaped by `view` (the chat caller's). A `model` without an `agent` is the caller's to refuse first.
 */
export async function agentCatalog(api: DaemonApi, args: { agent?: string; model?: string; query?: string; includeLegacyModels?: boolean }, budget: number, view?: (agent: AgentView) => object): Promise<ReturnType<typeof fitAgentViews>> {
  // A model named outright is found even when legacy: the flag only trims a listing.
  let agents = await loadAgents(api, { includeLegacyModels: args.includeLegacyModels === true || (args.agent !== undefined && args.model !== undefined) });
  const shape = (list: AgentView[]): AgentView[] => (view ? (list.map(view) as unknown as AgentView[]) : list);
  if (args.agent !== undefined) {
    const agent = findAgent(agents, args.agent);
    if (args.model !== undefined) return shape([{ ...agent, models: [findModel(agent, args.model)] }]);
    agents = [agent];
  }
  if (args.query !== undefined) {
    const needle = args.query.toLowerCase();
    // An agent none of whose models matches is left out, unless it was named.
    agents = agents.map((agent) => ({ ...agent, models: agent.models.filter((m) => modelMatches(m, needle)) })).filter((agent) => args.agent !== undefined || agent.models.length > 0);
  }
  return fitAgentViews(shape(agents), budget);
}

/**
 * Conversation rows (newest first) that fit one result: the oldest are left out — ok() would otherwise cut the JSON
 * and lose them all — `truncated` and `omitted` saying so. Linear: each row is measured once, with the comma before
 * it (every row but the first); only the small frame is re-measured, as `omitted`'s digits move.
 */
function fitConversations<T>(rows: readonly T[]): { conversations: T[]; truncated?: true; omitted?: number } {
  const sizes = rows.map((row, i) => resultBytes(row) + (i > 0 ? 1 : 0));
  if (resultBytes({ conversations: [] }) + sizes.reduce((sum, n) => sum + n, 0) <= MAX_RESULT_BYTES) return { conversations: [...rows] };
  const frame = (omitted: number): number => resultBytes({ conversations: [], truncated: true, omitted });
  let used = 0;
  let kept = 0;
  // The rows kept are the newest ones, a prefix: the first row that does not fit ends it.
  while (kept < rows.length && frame(rows.length - kept - 1) + used + sizes[kept]! <= MAX_RESULT_BYTES) used += sizes[kept++]!;
  return { conversations: rows.slice(0, kept), truncated: true, omitted: rows.length - kept };
}

/** list_conversations' project: the named one, else the chat caller's own; an external caller must name one. */
async function conversationsProject(project: string | undefined, ctx: Pick<ScopeContext, "api" | "caller">): Promise<{ path: string }> {
  if (project !== undefined) return resolveProject(ctx.api, project);
  // The plain `<workspacesDir>/<ws>/<name>` the GUI records conversations under (the caller's own path is canonical).
  if (ctx.caller.kind === "thread" && ctx.caller.projectPath) return resolveProject(ctx.api, `${ctx.caller.workspace}/${basename(ctx.caller.projectPath)}`);
  throw new ToolError(ctx.caller.kind === "thread" ? "PROJECT_NOT_FOUND" : "INVALID_ARGUMENT", ctx.caller.kind === "thread" ? "This chat has no project: pass project (list_projects)." : "project is required: an absolute path or \"<workspace>/<project>\".");
}

const listConversations = defineTool({
  name: "list_conversations",
  title: "List past conversations",
  description: "A project's provider conversations, newest first. Resume a `resumable` row: create_session {agent: its `agent`, resume: {conversationId: its `id`}}. Over the size cap the oldest rows are left out (truncated, omitted).",
  input: {
    project: z.string().min(1).optional().describe("Path or \"workspace/project\"."),
    agent: z.string().min(1).optional().describe("Only this agent's rows."),
    limit: z.number().int().min(1).max(200).default(20)
  },
  audiences: ["external", "chat"],
  toolset: "chat-extras",
  tier: "read",
  scope: async (args, ctx) => ({ projects: [(await conversationsProject(args.project, ctx)).path], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] }),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const project = await conversationsProject(args.project, ctx);
    const [registry, conversations] = await Promise.all([api.request("GET", "/api/registry"), api.request("GET", "/api/agents/conversations", { query: { path: project.path } })]);
    // As list_agents: without the registry no row's resumability is known, and `false` on every row would be a lie.
    if (registry.status >= 400) throw new ToolError("INTERNAL", "Could not read the agent registry.");
    const agents = (registry.body as RegistryResponse).agents ?? [];
    // The GUI's `isResumableByInstalledAgent`: a chat agent, and an enabled one — create_session refuses any other.
    const launchable = new Set(agents.filter((e) => e.chat?.adapter && e.enabled).map((e) => e.id));
    const res = expectOk<AgentConversationsResponse>(conversations);
    const rows = res.conversations.map((c) => {
      const agent = c.agentRefId;
      const resumable = launchable.has(agent);
      return { id: c.id, agent, title: c.title, ...(c.preview ? { preview: c.preview } : {}), updatedAt: c.updatedAt, home: c.home ?? "system", ...(c.accountId ? { accountId: c.accountId } : {}), resumable };
    });
    // Unknown = neither a registry agent nor one a row of this project names; a known agent without rows is an honest [].
    if (args.agent !== undefined && !agents.some((e) => e.id === args.agent) && !rows.some((r) => r.agent === args.agent)) {
      throw new ToolError("INVALID_ARGUMENT", `Unknown agent "${args.agent}". Valid agents: ${nameList(agents.map((e) => e.id))}.`);
    }
    const filtered = args.agent !== undefined ? rows.filter((r) => r.agent === args.agent) : rows;
    return fitConversations(filtered.slice(0, args.limit));
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const catalogFamily: readonly AnyOrquesterTool[] = [listProjects, listAgents, listConversations];
