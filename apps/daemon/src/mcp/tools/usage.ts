import { z } from "zod";
import type { AgentAccountsResponse, UsageResponse, UsageTokensResponse } from "@orquester/api";
import { expectOk } from "../errors.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";
import { usageView } from "../usage-view.ts";

/** get_cost's own budget: under ok()'s 60 000-byte cap, so that cap's last-resort cut never fires here. */
export const MAX_COST_RESULT_CHARS = 50_000;

const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;

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
  description: "API-equivalent cost estimate per agent, model and UTC day from local transcripts (the usage widget's Cost tab), for the last N days. Unpriced models count as $0 in byDay and totalUsd; their rows keep costUsd:null. A result too large loses rows oldest day first (truncated:true, rowsDropped); byDay and totalUsd still count every row.",
  input: { days: z.number().int().min(1).max(90).default(7).describe("How many UTC days back, including today.") },
  annotations: READ_ONLY,
  async run(args, { api, now }) {
    const res = expectOk<UsageTokensResponse>(await api.request("GET", "/api/usage/tokens"), "cost");
    const today = new Date(now());
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (args.days - 1))).toISOString().slice(0, 10);
    // Newest day first, so a cut below takes the oldest days; the daemon's order within a day is kept.
    const inWindow = res.rows.filter((r) => r.day >= start).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    const byDayMap = new Map<string, number>();
    for (const r of inWindow) byDayMap.set(r.day, (byDayMap.get(r.day) ?? 0) + (r.costUsd ?? 0));
    const byDay = [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, usd]) => ({ day, usd: round4(usd) }));
    const totalUsd = round4(byDay.reduce((sum, d) => sum + d.usd, 0));
    const rows = inWindow.map((r) => ({ agent: r.agent, model: r.model, day: r.day, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costUsd: typeof r.costUsd === "number" ? round4(r.costUsd) : null }));
    const head = { asOf: res.asOf, days: args.days, totalUsd, byDay };
    // Over budget: drop whole days of rows, oldest first, until the rest fits (at most `days` passes).
    let result: Record<string, unknown> = { ...head, rows };
    let kept = rows.length;
    while (kept > 0 && JSON.stringify(result).length > MAX_COST_RESULT_CHARS) {
      const oldest = rows[kept - 1]!.day;
      while (kept > 0 && rows[kept - 1]!.day === oldest) kept -= 1;
      result = { ...head, rows: rows.slice(0, kept), truncated: true, rowsDropped: rows.length - kept };
    }
    return result;
  }
});

export const usageTools: ToolDef[] = [getUsage, getCost] as ToolDef[];
