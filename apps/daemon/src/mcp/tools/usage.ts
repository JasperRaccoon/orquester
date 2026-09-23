import { z } from "zod";
import type { AgentAccountsResponse, UsageResponse, UsageTokensResponse } from "@orquester/api";
import { expectOk } from "../errors.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";
import { usageView } from "../usage-view.ts";

const getUsage = defineTool({
  name: "get_usage",
  title: "Get subscription usage",
  description: "Quota per agent family and per managed account — the 5h, weekly and per-model (e.g. Fable) windows as % USED with reset times — exactly as the usage widget shows them. An absent family is not signed in; stale:true with no asOf means no reading yet. refresh:true may still return last-known data; never call it in a loop.",
  input: { refresh: z.boolean().default(false).describe("Ask the daemon to re-fetch before answering.") },
  annotations: READ_ONLY,
  async run(args, { api, now }) {
    const usage = expectOk<UsageResponse>(await api.request("GET", "/api/usage", args.refresh ? { query: { refresh: "1" } } : undefined), "usage");
    const accountsRes = await api.request("GET", "/api/agent-accounts");
    const accounts = accountsRes.status < 400 ? (accountsRes.body as AgentAccountsResponse).accounts ?? [] : [];
    return usageView(usage, accounts, now()) as unknown as Record<string, unknown>;
  }
});

const getCost = defineTool({
  name: "get_cost",
  title: "Get estimated cost",
  description: "API-equivalent cost estimate per agent, model and UTC day from local transcripts (the usage widget's Cost tab), for the last N days.",
  input: { days: z.number().int().min(1).max(90).default(7).describe("How many UTC days back, including today.") },
  annotations: READ_ONLY,
  async run(args, { api, now }) {
    const res = expectOk<UsageTokensResponse>(await api.request("GET", "/api/usage/tokens"), "cost");
    const today = new Date(now());
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (args.days - 1))).toISOString().slice(0, 10);
    const rows = res.rows.filter((r) => r.day >= start).map((r) => ({ agent: r.agent, model: r.model, day: r.day, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costUsd: r.costUsd }));
    const byDayMap = new Map<string, number>();
    for (const r of rows) byDayMap.set(r.day, (byDayMap.get(r.day) ?? 0) + (r.costUsd ?? 0));
    const byDay = [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, usd]) => ({ day, usd: Math.round(usd * 10_000) / 10_000 }));
    const totalUsd = Math.round(byDay.reduce((sum, d) => sum + d.usd, 0) * 10_000) / 10_000;
    return { asOf: res.asOf, days: args.days, totalUsd, byDay, rows };
  }
});

export const usageTools: ToolDef[] = [getUsage, getCost] as ToolDef[];
