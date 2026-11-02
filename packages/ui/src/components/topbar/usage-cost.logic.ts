/**
 * The top-bar popover's Cost tab (spec §6.7): today, the last 7 days, 14 daily bars and the
 * per-day groups of per-model rows. Built from the Usage view's 14-day history (local days,
 * every agent), or — from a daemon too old for it — from `/api/usage/tokens` rows (UTC days).
 */

import type { UsageHistoryResponse, UsageTokenRow } from "@orquester/api";

import { formatDayShort, processedTokens } from "../../lib/usage-history-format";

export interface PopoverCostRow {
  agent: string;
  model: string;
  /** Null when nothing in the row has a price. */
  costUsd: number | null;
  /** The estimated part of the cost by type; null when none of it is estimated. */
  split: { input: number; output: number; cache: number } | null;
  /** Uncached input, output and cache (reads + writes) tokens. */
  input: number;
  output: number;
  cache: number;
}

export interface PopoverCostDay {
  /** "YYYY-MM-DD". */
  day: string;
  label: string;
  rows: PopoverCostRow[];
  /** The priced rows' sum; null when no row is priced. */
  total: number | null;
}

export interface PopoverCostSummary {
  /** Days with activity, newest first. */
  days: PopoverCostDay[];
  /** The 14 days of the chart, oldest first (today last). */
  chart: { day: string; label: string; cost: number }[];
  today: number;
  week: number;
  /** Some row has no price (its cost reads "—" and is left out of the totals). */
  hasUnpriced: boolean;
}

const DAY_MS = 86_400_000;

function shiftDay(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) ? day : new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  return formatDayShort(day);
}

function summarize(chartDays: readonly string[], today: string, rowsByDay: Map<string, PopoverCostRow[]>): PopoverCostSummary {
  const days: PopoverCostDay[] = [];
  for (const [day, all] of rowsByDay) {
    const rows = all
      .filter((r) => r.input + r.output + r.cache > 0)
      .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.model.localeCompare(b.model));
    if (rows.length === 0) continue;
    const priced = rows.filter((r) => r.costUsd !== null);
    const total = priced.length === 0 ? null : priced.reduce((sum, r) => sum + r.costUsd!, 0);
    days.push({ day, label: dayLabel(day, today), rows, total });
  }
  days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const totalByDay = new Map(days.map((d) => [d.day, d.total ?? 0]));
  const chart = chartDays.map((day) => ({ day, label: dayLabel(day, today), cost: totalByDay.get(day) ?? 0 }));
  return {
    days,
    chart,
    today: totalByDay.get(today) ?? 0,
    week: chart.slice(-7).reduce((sum, c) => sum + c.cost, 0),
    hasUnpriced: days.some((d) => d.rows.some((r) => r.costUsd === null))
  };
}

/** From a 14-day history answer: today is its last period, the chart its periods. */
export function popoverCostFromHistory(data: UsageHistoryResponse): PopoverCostSummary {
  const rowsByDay = new Map<string, PopoverCostRow[]>();
  const byKey = new Map<string, PopoverCostRow>();
  for (const bucket of data.buckets) {
    const day = data.periods[bucket.period];
    if (day === undefined || processedTokens(bucket.tokens) === 0) continue;
    const key = `${day}\u0000${bucket.agent}\u0000${bucket.model}`;
    let row = byKey.get(key);
    if (!row) {
      row = { agent: bucket.agent, model: bucket.model, costUsd: null, split: null, input: 0, output: 0, cache: 0 };
      byKey.set(key, row);
      const list = rowsByDay.get(day) ?? [];
      list.push(row);
      rowsByDay.set(day, list);
    }
    row.input += bucket.tokens.input;
    row.output += bucket.tokens.output;
    row.cache += bucket.tokens.cacheRead + bucket.tokens.cacheWrite;
    if (bucket.costUsd !== null) row.costUsd = (row.costUsd ?? 0) + bucket.costUsd;
    if (bucket.cost) {
      const split = row.split ?? { input: 0, output: 0, cache: 0 };
      split.input += bucket.cost.input;
      split.output += bucket.cost.output;
      split.cache += bucket.cost.cacheRead + bucket.cost.cacheWrite;
      row.split = split;
    }
  }
  const chartDays = data.periods.slice(-14);
  return summarize(chartDays, chartDays.at(-1) ?? "", rowsByDay);
}

/** From `/api/usage/tokens` rows (an older daemon): UTC days ending today. */
export function popoverCostFromTokenRows(rows: readonly UsageTokenRow[], now: number): PopoverCostSummary {
  const today = new Date(now).toISOString().slice(0, 10);
  const rowsByDay = new Map<string, PopoverCostRow[]>();
  for (const r of rows) {
    const list = rowsByDay.get(r.day) ?? [];
    list.push({
      agent: r.agent,
      model: r.model,
      costUsd: r.costUsd,
      split: r.costBreakdown ?? null,
      input: r.inputTokens,
      output: r.outputTokens,
      cache: r.cacheReadTokens + r.cacheWriteTokens
    });
    rowsByDay.set(r.day, list);
  }
  const chartDays = Array.from({ length: 14 }, (_, i) => shiftDay(today, i - 13));
  return summarize(chartDays, today, rowsByDay);
}
