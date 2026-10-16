// Catalog family module `usage` (get_usage) — plan Task 9 (unified MCP design 2026-10-15 §4 row 18, §4.1, ruling S9):
// quota windows, cost by day or ISO week, and one chat session's tokens and cost.
import { z } from "zod";
import type { AgentAccountsResponse, ChatThreadUsageResponse, UsageResponse, UsageTokensResponse } from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { canonicalProject } from "../addressing.ts";
import { providerRows } from "../agents.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ScopeClaim } from "../catalog/contract.ts";
import { expectOk, ToolError } from "../errors.ts";
import { readThread, requireChatSession } from "../reads.ts";
import { costView, sessionUsageView, usageView } from "../usage-view.ts";

const INCLUDES = ["quota", "cost", "session"] as const;
type Include = (typeof INCLUDES)[number];

/** `include` as given, else `session` when a sessionId is named, else `quota` (§4.1). */
function includes(args: { include?: readonly Include[]; sessionId?: string }): Set<Include> {
  return new Set(args.include ?? (args.sessionId !== undefined ? ["session"] : ["quota"]));
}

/** `sessionId` only with `session`, and `session` only with a `sessionId`: an argument that would be ignored is refused. */
function assertArgs(args: { include?: readonly Include[]; sessionId?: string }): void {
  const wanted = includes(args);
  if (wanted.has("session") && args.sessionId === undefined) throw new ToolError("INVALID_ARGUMENT", "include \"session\" needs sessionId (list_sessions).");
  if (!wanted.has("session") && args.sessionId !== undefined) throw new ToolError("INVALID_ARGUMENT", "sessionId applies to include \"session\" only: add it to include.");
}

/**
 * The model id a session's slug runs, from the provider catalogue (a Claude slug like `opus` or `default` names its
 * resolved `claude-…` id as `subProvider`), so the price table can price it; the slug itself when the catalogue says
 * nothing (or cannot be read).
 */
async function modelResolver(api: DaemonApi, adapter: string): Promise<(slug: string) => string> {
  const res = await api.request("GET", agentChatRoutes.providers);
  const row = res.status < 400 ? providerRows(res.body).get(adapter) : undefined;
  const resolved = new Map((row?.models ?? []).filter((m) => m.subProvider).map((m) => [m.slug, m.subProvider!] as const));
  return (slug) => resolved.get(slug) ?? slug;
}

const getUsage = defineTool({
  name: "get_usage",
  title: "Get usage and cost",
  description: "quota: % USED per account window, with resets. cost: API-equivalent USD per agent/model by UTC day or ISO week (Grok: its reported cost in Orquester chats only). session: one chat's tokens and cost (see costSource; partial: older turns uncounted). Never poll.",
  input: {
    include: z.array(z.enum(INCLUDES)).min(1).max(3).optional().describe("Default quota (session with sessionId)."),
    bucket: z.enum(["day", "week"]).default("day"),
    days: z.number().int().min(1).max(90).default(7),
    sessionId: z.string().min(1).max(200).optional(),
    refresh: z.boolean().default(false)
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  async scope(args, { api }): Promise<ScopeClaim> {
    assertArgs(args);
    if (!includes(args).has("session") || args.sessionId === undefined) return { projects: [], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] };
    // One session's usage is that session's metadata: its project is the target the gate classifies (§5.2).
    const session = await requireChatSession(api, args.sessionId);
    const project = session.projectPath ? await canonicalProject(api, session.projectPath) : null;
    return { projects: project ? [project.canonical] : [], sessions: [args.sessionId], reads: "metadata", writes: false, causesTurnIn: [] };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, now, caller }) {
    assertArgs(args);
    const wanted = includes(args);
    const result: Record<string, unknown> = {};
    if (wanted.has("quota")) {
      const usage = expectOk<UsageResponse>(await api.request("GET", "/api/usage", args.refresh ? { query: { refresh: "1" } } : undefined));
      const accountsRes = await api.request("GET", "/api/agent-accounts");
      const accounts = accountsRes.status < 400 ? (accountsRes.body as AgentAccountsResponse).accounts ?? [] : [];
      // Chat callers never see an account's email (§4.1).
      Object.assign(result, usageView(usage, accounts, now(), { withEmail: caller.kind === "external" }));
    }
    if (wanted.has("cost")) {
      const tokens = expectOk<UsageTokensResponse>(await api.request("GET", "/api/usage/tokens"));
      // Grok has no transcript the Cost tab scans: its reported cost from Orquester's own chats (labelled so).
      const grokRes = await api.request("GET", "/api/usage/chat-threads", { query: { agent: "grok" } }).catch(() => null);
      const grok = grokRes !== null && grokRes.status < 400 ? (grokRes.body as ChatThreadUsageResponse) : null;
      result.cost = costView(tokens, { days: args.days, bucket: args.bucket, now: now() }, [{ agent: "grok", usage: grok }]);
    }
    if (wanted.has("session") && args.sessionId !== undefined) {
      await requireChatSession(api, args.sessionId);
      const snapshot = await readThread(api, args.sessionId);
      result.session = sessionUsageView(snapshot, { resolveModel: await modelResolver(api, snapshot.head.adapter) });
    }
    return result;
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const usageFamily: readonly AnyOrquesterTool[] = [getUsage];
