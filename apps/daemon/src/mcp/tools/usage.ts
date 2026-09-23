import { z } from "zod";
import type { AgentAccountsResponse, UsageResponse, UsageTokensResponse } from "@orquester/api";
import { expectOk } from "../errors.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";
import { usageView } from "../usage-view.ts";

/**
 * get_cost's own budget, counted as ok() counts (UTF-8 bytes of the JSON, result.ts) and 10 000 under its 60 000-byte
 * cap: an oversized cost table is shed here, whole days oldest first, so it never reaches ok()'s last-resort cut,
 * which would keep only the head of the text. The head itself (≤ 90 byDay rows, a few KB) is never shed.
 */
export const MAX_COST_RESULT_BYTES = 50_000;

const jsonByteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

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
    const whole = { ...head, rows };
    if (jsonByteSize(whole) <= MAX_COST_RESULT_BYTES) return whole;
    // Over budget: drop whole days of rows, oldest first, until the rest fits. Each row is measured once, with the
    // comma that joins it; only the frame around the rows is re-measured, as rowsDropped's digits move.
    const rowBytes = rows.map((row) => jsonByteSize(row) + 1);
    let rowsBytes = rowBytes.reduce((sum, n) => sum + n, 0) - 1; // n rows are joined by n - 1 commas
    let kept = rows.length;
    const frame = () => jsonByteSize({ ...head, rows: [], truncated: true, rowsDropped: rows.length - kept });
    do {
      const oldest = rows[kept - 1]!.day;
      while (kept > 0 && rows[kept - 1]!.day === oldest) rowsBytes -= rowBytes[--kept]!;
    } while (kept > 0 && frame() + rowsBytes > MAX_COST_RESULT_BYTES);
    return { ...head, rows: rows.slice(0, kept), truncated: true, rowsDropped: rows.length - kept };
  }
});

export const usageTools: ToolDef[] = [getUsage, getCost] as ToolDef[];
