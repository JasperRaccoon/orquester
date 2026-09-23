import { z } from "zod";
import type { AgentConversationsResponse, ProjectSummary, RecentProjectSummary, RegistryResponse, WorkspaceSummary } from "@orquester/api";
import { resolveProject } from "../addressing.ts";
import { findAgent, loadAgents } from "../agents.ts";
import { expectOk } from "../errors.ts";
import { listSessions } from "../reads.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";

const listProjects = defineTool({
  name: "list_projects",
  title: "List projects",
  description: "List every project (workspace/name and absolute path) with recency and open-session counts. Use the `path` or `workspace/name` as the `project` argument of other tools.",
  input: {
    workspace: z.string().optional().describe("Only this workspace."),
    includeArchived: z.boolean().default(false).describe("Include archived workspaces and projects.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const workspaces = expectOk<WorkspaceSummary[]>(await api.request("GET", "/api/workspaces"), "workspaces");
    const recentRes = await api.request("GET", "/api/projects/recent");
    const recent = recentRes.status < 400 ? (recentRes.body as RecentProjectSummary[]) : [];
    const sessions = await listSessions(api);
    const projects: { workspace: string; name: string; path: string; isArchived: boolean; lastInteractedAt?: string; openSessions: number }[] = [];
    for (const ws of workspaces) {
      if (args.workspace && ws.name !== args.workspace) continue;
      if (ws.isArchived && !args.includeArchived) continue;
      const list = expectOk<ProjectSummary[]>(await api.request("GET", `/api/workspaces/${encodeURIComponent(ws.name)}/projects`), "projects");
      for (const p of list) {
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
    return { projects };
  }
});

const listAgents = defineTool({
  name: "list_agents",
  title: "List launchable agents",
  description: "The chat agents you can open (claude, claudex, claudemix, codex, opencode, grok) with their valid models, model options (effort…), permission modes, capabilities and accounts. Call this before create_session or update_session.",
  input: {
    agent: z.string().optional().describe("Only this agent id."),
    includeLegacyModels: z.boolean().default(false).describe("Also list models flagged legacy.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const agents = await loadAgents(api, { includeLegacyModels: args.includeLegacyModels });
    return { agents: args.agent ? [findAgent(agents, args.agent)] : agents };
  }
});

const listConversations = defineTool({
  name: "list_conversations",
  title: "List resumable conversations",
  description: "Past provider conversations recorded for a project, newest first. Pass a row's `id` as create_session.resume.conversationId; `agent` is the agent to resume it with.",
  input: {
    project: z.string().describe("Absolute project path or \"<workspace>/<project>\"."),
    agent: z.string().optional().describe("Only conversations resumable with this agent id."),
    limit: z.number().int().min(1).max(200).default(20).describe("Maximum rows.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const project = await resolveProject(api, args.project);
    const registry = await api.request("GET", "/api/registry");
    const chatAgents = new Set(registry.status < 400 ? ((registry.body as RegistryResponse).agents ?? []).filter((e) => e.chat?.adapter).map((e) => e.id) : []);
    const res = expectOk<AgentConversationsResponse>(await api.request("GET", "/api/agents/conversations", { query: { path: project.path } }), "conversations");
    const rows = res.conversations.map((c) => {
      const agent = c.home === "cliproxy" && c.proxyRefId ? c.proxyRefId : c.agentRefId;
      return { id: c.id, agent, title: c.title, ...(c.preview ? { preview: c.preview } : {}), updatedAt: c.updatedAt, home: c.home ?? "system", ...(c.accountId ? { accountId: c.accountId } : {}), resumable: chatAgents.has(agent) };
    });
    const filtered = args.agent ? rows.filter((r) => r.agent === args.agent) : rows;
    return { conversations: filtered.slice(0, args.limit) };
  }
});

export const catalogTools: ToolDef[] = [listProjects, listAgents, listConversations];
