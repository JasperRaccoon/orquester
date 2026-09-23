import { z } from "zod";
import type { AgentConversationsResponse, ProjectSummary, RecentProjectSummary, RegistryResponse, WorkspaceSummary } from "@orquester/api";
import { resolveProject } from "../addressing.ts";
import { findAgent, loadAgents } from "../agents.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError, expectOk } from "../errors.ts";
import { listSessions } from "../reads.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";

/** Names for an error message: up to 40, then "…" (as resolveModelSelection lists models). */
function nameList(names: readonly string[]): string {
  return names.length ? `${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}` : "none";
}

/**
 * One workspace's projects, or the warning that stands in for them: a workspace that cannot be read is left out
 * rather than failing the whole list (fail-soft, as `/api/agents/conversations` is by design).
 */
async function readWorkspace(api: DaemonApi, workspace: string): Promise<{ projects: ProjectSummary[] } | { warning: string }> {
  try {
    return { projects: expectOk<ProjectSummary[]>(await api.request("GET", `/api/workspaces/${encodeURIComponent(workspace)}/projects`), "projects") };
  } catch (error) {
    // A thrown call's text can name a host path: it is logged here and never returned, as sendCommand does.
    if (!(error instanceof ToolError)) console.error("[mcp] daemon call failed", error);
    const cause = error instanceof ToolError ? `${error.code}: ${error.message}` : "HOST_UNAVAILABLE: The daemon call failed.";
    return { warning: `Workspace "${workspace}" was left out: its projects could not be read (${cause}).` };
  }
}

const listProjects = defineTool({
  name: "list_projects",
  title: "List projects",
  description: "List projects (workspace/name and absolute path) with recency and open-session counts, recent first; archived ones only with includeArchived. A workspace that cannot be read is left out and named in `warnings`. Use the `path` or `workspace/name` as the `project` argument of other tools.",
  input: {
    workspace: z.string().min(1).optional().describe("Only this workspace (by name; an unknown one is refused)."),
    includeArchived: z.boolean().default(false).describe("Include archived workspaces and projects.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const [workspacesRes, recentRes, sessions] = await Promise.all([api.request("GET", "/api/workspaces"), api.request("GET", "/api/projects/recent"), listSessions(api)]);
    const workspaces = expectOk<WorkspaceSummary[]>(workspacesRes, "workspaces");
    // Recency only orders the list: without it the list is alphabetical, not a failure.
    const recent = recentRes.status < 400 ? (recentRes.body as RecentProjectSummary[]) : [];
    const warnings: string[] = [];
    if (args.workspace !== undefined) {
      const named = workspaces.find((ws) => ws.name === args.workspace);
      if (!named) throw new ToolError("INVALID_ARGUMENT", `Unknown workspace "${args.workspace}". Workspaces: ${nameList(workspaces.map((ws) => ws.name))}.`);
      if (named.isArchived && !args.includeArchived) warnings.push(`Workspace "${named.name}" is archived; pass includeArchived: true to list its projects.`);
    }
    const listed = workspaces.filter((ws) => (args.workspace === undefined || ws.name === args.workspace) && (!ws.isArchived || args.includeArchived));
    const reads = await Promise.all(listed.map((ws) => readWorkspace(api, ws.name)));
    const projects: { workspace: string; name: string; path: string; isArchived: boolean; lastInteractedAt?: string; openSessions: number }[] = [];
    for (const [i, ws] of listed.entries()) {
      const read = reads[i]!;
      if ("warning" in read) { warnings.push(read.warning); continue; }
      for (const p of read.projects) {
        if (p.isArchived && !args.includeArchived) continue;
        const r = recent.find((x) => x.path === p.path);
        // The daemon's project flag is per-project only; a project of an archived workspace is archived too.
        projects.push({ workspace: ws.name, name: p.name, path: p.path, isArchived: ws.isArchived === true || p.isArchived === true, ...(r ? { lastInteractedAt: r.lastInteractedAt } : {}), openSessions: sessions.filter((s) => s.projectPath === p.path).length });
      }
    }
    projects.sort((a, b) => {
      if (a.lastInteractedAt !== b.lastInteractedAt) { if (!a.lastInteractedAt) return 1; if (!b.lastInteractedAt) return -1; return a.lastInteractedAt < b.lastInteractedAt ? 1 : -1; }
      return `${a.workspace}/${a.name}`.localeCompare(`${b.workspace}/${b.name}`);
    });
    return warnings.length ? { projects, warnings } : { projects };
  }
});

const listAgents = defineTool({
  name: "list_agents",
  title: "List launchable agents",
  description: "The chat agents you can open (claude, claudex, claudemix, codex, opencode, grok) with their valid models, model options (effort…), permission modes, capabilities and accounts. Call this before create_session or update_session.",
  input: {
    agent: z.string().min(1).optional().describe("Only this agent id."),
    includeLegacyModels: z.boolean().default(false).describe("Also list models flagged legacy.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const agents = await loadAgents(api, { includeLegacyModels: args.includeLegacyModels });
    return { agents: args.agent !== undefined ? [findAgent(agents, args.agent)] : agents };
  }
});

const listConversations = defineTool({
  name: "list_conversations",
  title: "List past conversations",
  description: "Provider conversations recorded for a project, newest first. A row with `resumable: true` can be resumed: pass its `id` as create_session.resume.conversationId (`agent` is the agent it resumes with).",
  input: {
    project: z.string().describe("Absolute project path or \"<workspace>/<project>\"."),
    agent: z.string().min(1).optional().describe("Only rows whose `agent` is this agent id (an unknown one is refused)."),
    limit: z.number().int().min(1).max(200).default(20).describe("Maximum rows.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const project = await resolveProject(api, args.project);
    const [registry, conversations] = await Promise.all([api.request("GET", "/api/registry"), api.request("GET", "/api/agents/conversations", { query: { path: project.path } })]);
    // As list_agents: without the registry no row's resumability is known, and `false` on every row would be a lie.
    if (registry.status >= 400) throw new ToolError("INTERNAL", "Could not read the agent registry.");
    const agents = (registry.body as RegistryResponse).agents ?? [];
    const chatAgents = new Set(agents.filter((e) => e.chat?.adapter).map((e) => e.id));
    const res = expectOk<AgentConversationsResponse>(conversations, "conversations");
    const rows = res.conversations.map((c) => {
      const agent = c.home === "cliproxy" && c.proxyRefId ? c.proxyRefId : c.agentRefId;
      // A proxy home's transcript is found only by the launcher that owns the home: with none named, nothing resumes it.
      const resumable = chatAgents.has(agent) && !(c.home === "cliproxy" && !c.proxyRefId);
      return { id: c.id, agent, title: c.title, ...(c.preview ? { preview: c.preview } : {}), updatedAt: c.updatedAt, home: c.home ?? "system", ...(c.accountId ? { accountId: c.accountId } : {}), resumable };
    });
    // Unknown = neither a registry agent nor one a row of this project names; a known agent without rows is an honest [].
    if (args.agent !== undefined && !agents.some((e) => e.id === args.agent) && !rows.some((r) => r.agent === args.agent)) {
      throw new ToolError("INVALID_ARGUMENT", `Unknown agent "${args.agent}". Valid agents: ${nameList(agents.map((e) => e.id))}.`);
    }
    const filtered = args.agent !== undefined ? rows.filter((r) => r.agent === args.agent) : rows;
    return { conversations: filtered.slice(0, args.limit) };
  }
});

export const catalogTools: ToolDef[] = [listProjects, listAgents, listConversations];
