import type { AgentAccount, AgentUsage, UsageAccount, UsageResponse, UsageTokensResponse, UsageWindow } from "@orquester/api";
import { isSettledConversationCompaction, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
// The Cost tab's own price table (API-equivalent USD per token class): one table for both views.
import { estimateCostParts } from "../usage-tokens.ts";

interface UsageWindowView { id: string; label: string; percentUsed: number; resetsAt?: string; resetsIn?: string }
interface UsageAccountView { id: string; label: string; plan?: string; available: boolean; stale: boolean; asOf?: string; ageMinutes?: number; needsReauth?: boolean; email?: string; windows: UsageWindowView[] }
interface UsageAgentView { id: string; name: string; available: boolean; stale: boolean; asOf?: string; ageMinutes?: number; plan?: string; windows?: UsageWindowView[]; accounts: UsageAccountView[]; system?: UsageAccountView; aggregate?: { strategy: string; accountCount: number; staleAccountCount?: number } }

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok Build" };

/** The top-bar countdown (`formatCountdown` in the UI) without the "Resets in" prefix. */
function formatResetsIn(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined;
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms)) return undefined;
  if (ms <= 60_000) return "now";
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1_440);
  const h = Math.floor((mins % 1_440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ageMinutes(asOf: string | undefined, now: number): number | undefined {
  if (!asOf) return undefined;
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((now - t) / 60_000));
}

function windowView(id: string, label: string, w: UsageWindow | null | undefined, now: number): UsageWindowView | null {
  if (!w) return null;
  const v: UsageWindowView = { id, label, percentUsed: Math.round(w.percent) };
  if (w.resetsAt) { v.resetsAt = w.resetsAt; const rel = formatResetsIn(w.resetsAt, now); if (rel) v.resetsIn = rel; }
  return v;
}

function windows(row: Pick<AgentUsage, "session" | "weekly" | "scopedWindows">, now: number): UsageWindowView[] {
  const out: UsageWindowView[] = [];
  const s = windowView("session", "5h", row.session, now); if (s) out.push(s);
  const w = windowView("weekly", "Week", row.weekly, now); if (w) out.push(w);
  for (const sw of row.scopedWindows ?? []) { const v = windowView(`scoped:${sw.label}`, sw.label, sw, now); if (v) out.push(v); }
  return out;
}

function accountRow(row: UsageAccount, managed: AgentAccount | undefined, now: number, withEmail = true): UsageAccountView {
  const v: UsageAccountView = { id: row.id, label: row.label ?? managed?.label ?? row.id, available: row.available, stale: row.stale, windows: windows(row, now) };
  if (row.plan) v.plan = row.plan;
  if (row.asOf) { v.asOf = row.asOf; const age = ageMinutes(row.asOf, now); if (age !== undefined) v.ageMinutes = age; }
  if (managed) { v.needsReauth = managed.needsReauth; if (managed.email && withEmail) v.email = managed.email; }
  return v;
}

/** The quota windows as the usage widget shows them; `withEmail: false` (chat callers) leaves every account's email out. */
export function usageView(res: UsageResponse, accounts: readonly AgentAccount[], now: number, opts?: { withEmail?: boolean }): { agents: UsageAgentView[] } {
  const withEmail = opts?.withEmail !== false;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return {
    agents: res.agents.map((agent) => {
      const v: UsageAgentView = { id: agent.id, name: AGENT_NAMES[agent.id] ?? agent.id, available: agent.available, stale: agent.stale, accounts: (agent.accounts ?? []).map((row) => accountRow(row, byId.get(row.id), now, withEmail)) };
      if (agent.asOf) { v.asOf = agent.asOf; const age = ageMinutes(agent.asOf, now); if (age !== undefined) v.ageMinutes = age; }
      if (agent.plan) v.plan = agent.plan;
      if (agent.system) v.system = accountRow(agent.system, undefined, now);
      if (agent.aggregate) v.aggregate = { strategy: agent.aggregate.strategy, accountCount: agent.aggregate.accountCount, ...(agent.aggregate.staleAccountCount !== undefined ? { staleAccountCount: agent.aggregate.staleAccountCount } : {}) };
      if (!v.accounts.length && !v.system) v.windows = windows(agent, now);
      return v;
    })
  };
}

// ---------------------------------------------------------------------------
// Cost by day or ISO week (get_usage `cost`, the usage widget's Cost tab) and one session's usage (`session`)
// ---------------------------------------------------------------------------

/**
 * The cost view's own budget, counted as ok() counts (UTF-8 bytes of the JSON, result.ts) and 10 000 under its 60 000-byte
 * cap: an oversized table is shed here, whole buckets oldest first, so it never reaches ok()'s last-resort cut. The head
 * (≤ 90 bucket totals, a few KB) is never shed.
 */
export const MAX_COST_VIEW_BYTES = 50_000;

const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** `YYYY-MM-DD` (UTC) → its ISO week, `YYYY-Www`, and that week's Monday. */
export function isoWeek(day: string): { week: string; from: string } {
  const date = new Date(`${day}T00:00:00.000Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const monday = new Date(date.getTime() - weekday * 86_400_000);
  // The ISO week-year is the year of the week's Thursday.
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return { week: `${year}-W${String(week).padStart(2, "0")}`, from: monday.toISOString().slice(0, 10) };
}

type CostRowView = { agent: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null } & ({ day: string } | { week: string });

/**
 * API-equivalent cost per agent and model, bucketed by UTC day or ISO week (UTC), over the last `days` UTC days — for
 * weeks, from the Monday of the first one (`since`: the first day counted). Unpriced
 * models count as $0 in the totals and keep `costUsd: null` on their rows. Over {@link MAX_COST_VIEW_BYTES} the rows lose
 * whole buckets, oldest first (`truncated`, `rowsDropped`); the totals still count every row.
 */
export function costView(res: UsageTokensResponse, opts: { days: number; bucket: "day" | "week"; now: number }): Record<string, unknown> {
  const today = new Date(opts.now);
  const firstDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (opts.days - 1))).toISOString().slice(0, 10);
  // Weeks are whole: the window starts on the Monday of its first week, so no week is a partial sum (`since` says so).
  const start = opts.bucket === "week" ? isoWeek(firstDay).from : firstDay;
  // Newest first, so a cut below takes the oldest buckets; the daemon's order within a day is kept.
  const inWindow = res.rows.filter((r) => r.day >= start).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const keyOf = (day: string): string => (opts.bucket === "day" ? day : isoWeek(day).week);
  const totals = new Map<string, number>();
  for (const r of inWindow) totals.set(keyOf(r.day), (totals.get(keyOf(r.day)) ?? 0) + (r.costUsd ?? 0));
  const ordered = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
  const byBucket = opts.bucket === "day"
    ? { byDay: ordered.map(([day, usd]) => ({ day, usd: round4(usd) })) }
    : { byWeek: ordered.map(([week, usd]) => ({ week, from: isoWeek(inWindow.find((r) => keyOf(r.day) === week)!.day).from, usd: round4(usd) })) };
  const totalUsd = round4(ordered.reduce((sum, [, usd]) => sum + round4(usd), 0));
  let rows: CostRowView[];
  if (opts.bucket === "day") {
    rows = inWindow.map((r) => ({ agent: r.agent, model: r.model, day: r.day, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costUsd: typeof r.costUsd === "number" ? round4(r.costUsd) : null }));
  } else {
    // One row per agent, model and week, newest week first; a row is priced when any of its days is.
    const merged = new Map<string, CostRowView & { week: string }>();
    for (const r of inWindow) {
      const week = keyOf(r.day);
      const key = `${week}|${r.agent}|${r.model}`;
      const row = merged.get(key) ?? { agent: r.agent, model: r.model, week, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
      row.inputTokens += r.inputTokens; row.outputTokens += r.outputTokens; row.cacheReadTokens += r.cacheReadTokens; row.cacheWriteTokens += r.cacheWriteTokens;
      if (typeof r.costUsd === "number") row.costUsd = (row.costUsd ?? 0) + r.costUsd;
      merged.set(key, row);
    }
    rows = [...merged.values()].map((row) => ({ ...row, costUsd: row.costUsd === null ? null : round4(row.costUsd) }));
  }
  const head = { asOf: res.asOf, days: opts.days, bucket: opts.bucket, since: start, totalUsd, ...byBucket };
  const whole = { ...head, rows };
  if (jsonBytes(whole) <= MAX_COST_VIEW_BYTES) return whole;
  // Over budget: drop whole buckets of rows, oldest first, until the rest fits. Each row is measured once, with the
  // comma that joins it; only the frame around the rows is re-measured, as rowsDropped's digits move.
  const bucketOf = (row: CostRowView): string => ("day" in row ? row.day : row.week);
  const rowBytes = rows.map((row) => jsonBytes(row) + 1);
  let rowsBytes = rowBytes.reduce((sum, n) => sum + n, 0) - 1; // n rows are joined by n - 1 commas
  let kept = rows.length;
  const frame = () => jsonBytes({ ...head, rows: [], truncated: true, rowsDropped: rows.length - kept });
  do {
    const oldest = bucketOf(rows[kept - 1]!);
    while (kept > 0 && bucketOf(rows[kept - 1]!) === oldest) rowsBytes -= rowBytes[--kept]!;
  } while (kept > 0 && frame() + rowsBytes > MAX_COST_VIEW_BYTES);
  return { ...head, rows: rows.slice(0, kept), truncated: true, rowsDropped: rows.length - kept };
}

/** A model's price for `tokens` (fresh input, output, cache reads and writes), or null when the table has no price. */
function priceTurn(model: string, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }, writesOneHour: boolean): number | null {
  // A model whose price row has no cache-write rate (Codex's) bills written tokens as input, as the Cost tab counts them.
  const writeRate = estimateCostParts(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: writesOneHour ? 1_000_000 : 0 });
  const asInput = writeRate !== null && writeRate.cache === 0;
  const parts = estimateCostParts(model, {
    input: tokens.input + (asInput ? tokens.cacheWrite : 0),
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: asInput ? 0 : tokens.cacheWrite,
    cacheWrite1h: asInput || !writesOneHour ? 0 : tokens.cacheWrite
  });
  return parts ? parts.input + parts.output + parts.cache : null;
}

/**
 * One chat session's token usage and cost (get_usage `session`): the per-turn `tokenUsage` of the turns its snapshot
 * holds, summed (`turnsCounted`; `partial` when older turns lie outside the snapshot's window).
 *
 * Cost per turn:
 * - **Claude**: always the API-equivalent ESTIMATE from the turn's own tokens and the Cost tab's price table. The turn's
 *   `totalCostUsd` is the CLI result's `total_cost_usd`, which is CUMULATIVE per CLI process (fixture 11: 0.0348 then
 *   0.0455 in one process, 0.0109 after a resume) — summing it overstates, so it is never used. Claude Code writes the
 *   conversation's prompt cache with the 1-hour TTL (every result frame of fixtures 11, 12, 17, 19), so cache writes
 *   are priced at that rate. The model is the turn's (else the head's) slug resolved through the provider catalogue
 *   (`resolveModel`: `opus` → the `claude-…` id it runs), as the picker names it.
 * - **Other agents** (OpenCode, Grok report a per-turn cost): the provider's `totalCostUsd` where reported, else the
 *   estimate (Codex reports tokens only).
 *
 * `costSource`: `reported`, `estimated` or `mixed`. A turn neither reported nor priceable counts in `unpricedTurns` and
 * adds $0; with no priced turn `costUsd` is null. `mainAgentOnly: true` always: turn usage is the main agent's, so
 * `turnsWithSubagents` and `compactions` (settled conversation compactions in the snapshot) say where the totals and
 * the estimate are a floor.
 */
export function sessionUsageView(snapshot: Pick<ThreadSnapshotPayload, "head" | "turns" | "history" | "items">, opts?: { resolveModel?: (slug: string) => string }): Record<string, unknown> {
  const claude = snapshot.head.adapter === "claude";
  const resolve = opts?.resolveModel ?? ((slug: string) => slug);
  const sums = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
  let reported = 0;
  let estimated = 0;
  let reportedTurns = 0;
  let estimatedTurns = 0;
  let unpricedTurns = 0;
  let turnsWithoutUsage = 0;
  let turnsWithSubagents = 0;
  for (const turn of snapshot.turns) {
    const usage = turn.tokenUsage;
    if (usage?.hasSubagents === true) turnsWithSubagents += 1;
    const input = usage?.inputTokens;
    const output = usage?.outputTokens;
    const hasTokens = typeof input === "number" || typeof output === "number";
    const reportedCost = !claude && typeof turn.totalCostUsd === "number" && Number.isFinite(turn.totalCostUsd) ? turn.totalCostUsd : undefined;
    if (!hasTokens && reportedCost === undefined) {
      turnsWithoutUsage += 1;
      continue;
    }
    if (hasTokens) {
      sums.inputTokens += input ?? 0;
      sums.outputTokens += output ?? 0;
      sums.cachedInputTokens += usage?.cachedInputTokens ?? 0;
      sums.cacheCreationTokens += usage?.cacheCreationTokens ?? 0;
      sums.reasoningTokens += usage?.reasoningTokens ?? 0;
    }
    if (reportedCost !== undefined) {
      reported += reportedCost;
      reportedTurns += 1;
      continue;
    }
    // `inputTokens` holds the cached and cache-written tokens too (the adapters' convention): the fresh rest bills as input.
    const cached = usage?.cachedInputTokens ?? 0;
    const written = usage?.cacheCreationTokens ?? 0;
    const cost = priceTurn(resolve(turn.model || snapshot.head.modelSelection.model), { input: Math.max(0, (input ?? 0) - cached - written), output: output ?? 0, cacheRead: cached, cacheWrite: written }, claude);
    if (cost !== null) {
      estimated += cost;
      estimatedTurns += 1;
    } else {
      unpricedTurns += 1;
    }
  }
  const compactions = snapshot.items.filter(isSettledConversationCompaction).length;
  const costSource = reportedTurns > 0 && estimatedTurns > 0 ? "mixed" : reportedTurns > 0 ? "reported" : estimatedTurns > 0 ? "estimated" : null;
  return {
    sessionId: snapshot.head.id,
    agent: snapshot.head.refId,
    model: snapshot.head.modelSelection.model,
    turnsCounted: snapshot.turns.length,
    ...(snapshot.history ? { totalTurns: Math.max(snapshot.history.totalTurns, snapshot.turns.length) } : {}),
    partial: snapshot.history?.hasOlder === true,
    ...sums,
    costUsd: costSource === null ? null : round4(reported + estimated),
    ...(costSource !== null ? { costSource } : {}),
    ...(estimatedTurns > 0 ? { estimatedUsd: round4(estimated) } : {}),
    ...(unpricedTurns > 0 ? { unpricedTurns } : {}),
    ...(turnsWithoutUsage > 0 ? { turnsWithoutUsage } : {}),
    // Every turn's usage is the main agent's (`usageScope: "main_agent"`): subagents' and compactions' tokens are not in
    // it, so the totals and an estimate are a floor where either happened.
    mainAgentOnly: true,
    ...(turnsWithSubagents > 0 ? { turnsWithSubagents } : {}),
    ...(compactions > 0 ? { compactions } : {})
  };
}
