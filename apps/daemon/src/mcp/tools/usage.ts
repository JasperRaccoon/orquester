// Catalog family module `usage` (get_usage) — plan Task 9 (unified MCP design 2026-10-15 §4 row 18, §4.1, ruling S9):
// quota windows, cost by day or ISO week, and one chat session's tokens and cost.
import { z } from "zod";
import type { AgentAccountsResponse, UsageResponse, UsageTokensResponse } from "@orquester/api";
import { canonicalProject } from "../addressing.ts";
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

const getUsage = defineTool({
  name: "get_usage",
  title: "Get usage and cost",
  description: "quota: % USED per agent/account window, with resets. cost: API-equivalent USD per agent/model by UTC day or ISO week. session: one chat's tokens and cost; costSource reported, estimated or mixed; partial: older turns uncounted. Never poll.",
  input: {
    include: z.array(z.enum(INCLUDES)).min(1).max(3).optional().describe("Default quota; session with sessionId."),
    bucket: z.enum(["day", "week"]).default("day"),
    days: z.number().int().min(1).max(90).default(7).describe("cost: days back."),
    sessionId: z.string().min(1).max(200).optional(),
    refresh: z.boolean().default(false)
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  async scope(args, { api }): Promise<ScopeClaim> {
    if (!includes(args).has("session") || args.sessionId === undefined) return { projects: [], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] };
    // One session's usage is that session's metadata: its project is the target the gate classifies (§5.2).
    const session = await requireChatSession(api, args.sessionId);
    const project = session.projectPath ? await canonicalProject(api, session.projectPath) : null;
    return { projects: project ? [project.canonical] : [], sessions: [args.sessionId], reads: "metadata", writes: false, causesTurnIn: [] };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, now, caller }) {
    const wanted = includes(args);
    if (wanted.has("session") && args.sessionId === undefined) throw new ToolError("INVALID_ARGUMENT", "include \"session\" needs sessionId (list_sessions).");
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
      result.cost = costView(tokens, { days: args.days, bucket: args.bucket, now: now() });
    }
    if (wanted.has("session") && args.sessionId !== undefined) {
      await requireChatSession(api, args.sessionId);
      result.session = sessionUsageView(await readThread(api, args.sessionId));
    }
    return result;
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const usageFamily: readonly AnyOrquesterTool[] = [getUsage];
