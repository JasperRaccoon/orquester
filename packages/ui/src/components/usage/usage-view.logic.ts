// Pure derivations behind the Usage view's Cost / Tokens tabs: one pass from a
// `UsageHistoryResponse` (minus the agents the user filtered out) to the hero, totals,
// chart series, share bars, breakdown tables and the per-model dialog.
//
// Unknown cost is never zero: a figure whose every bucket is unpriced is `null`, and a
// share of an unknown cost is `null` too. Unpriced buckets add nothing to cost sums.

import type {
  UsageHistoryBucket,
  UsageHistoryResponse,
  UsageSpeed,
  UsageTokenTotals
} from "@orquester/api";

import { processedTokens, sortAgents, sumCostFigures, type CostFigure, type UnpricedPart } from "../../lib/usage-history-format";
import type { UsageMetric } from "./types";

/** Reported or unsplit cost below this is rounding noise, not an "Other" slice. */
const OTHER_COST_MIN = 0.005;

export interface UsageCostByType {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Cost with no per-type split (provider-reported), when at least half a cent. */
  other: number;
}

export type UsageCostBySpeed = Record<UsageSpeed, number>;

/** The sums every view of a set of buckets starts from. */
export interface UsageSummary {
  tokens: UsageTokenTotals;
  processed: number;
  /** Null when there is usage but none of it has a price. */
  costUsd: number | null;
  unpricedTokens: number;
  /** unpricedTokens / processed (0 with no usage). */
  unpricedShare: number;
  cacheSavingsUsd: number;
  costByType: UsageCostByType;
  costBySpeed: UsageCostBySpeed;
  /** What the estimated fast/ultrafast cells cost over the same tokens at standard rates. */
  speedPremiumUsd: number;
}

export interface UsageTotals extends UsageSummary {
  sessions: number;
  /** Periods with any usage. */
  activePeriods: number;
  /** Processed tokens per active period (0 with none). */
  processedPerActivePeriod: number;
  /** cacheRead / (uncached + cacheRead + cacheWrite); 0 with no input. */
  cachedInputShare: number;
}

export interface UsageAgentRow {
  agent: string;
  sessions: number;
  processed: number;
  costUsd: number | null;
  unpricedTokens: number;
  /** Share of the window's known cost; null when this agent's cost is unknown. */
  costShare: number | null;
  tokenShare: number;
}

export interface UsageSeries {
  agent: string;
  /** One value per period (zero-filled), in the metric; on cost, the known part. */
  values: number[];
  /** On cost, per period: how much of it has no known price (unknown is not $0). */
  unpriced?: UnpricedPart[];
}

export interface UsageModelRow {
  /** `${agent}:${model}`, as the sessions' `byModel`. */
  key: string;
  agent: string;
  model: string;
  sessions: number;
  processed: number;
  costUsd: number | null;
  unpricedTokens: number;
  costShare: number | null;
  tokenShare: number;
  /** The row's figure in the metric (unknown cost counts 0), for the share underline. */
  value: number;
}

export interface UsagePeriodRow {
  /** Index into `periods`. */
  index: number;
  period: string;
  /** Cost per agent with usage in the period; null when it had tokens but no price. */
  costByAgent: Record<string, number | null>;
  costUsd: number | null;
  processed: number;
}

export interface UsageProjectRow {
  /** "<workspace>/<project>", or "" for use outside the workspaces root. */
  project: string;
  workspace: string | null;
  name: string;
  /** Distinct sessions of the visible agents over the range. */
  sessions: number;
  processed: number;
  costUsd: number | null;
  unpricedTokens: number;
  /** Share in the metric; null on Cost when the project's cost is unknown. */
  share: number | null;
}

export interface UsageView {
  /** Visible agents with usage, in the fixed agent order. */
  agents: string[];
  totals: UsageTotals;
  agentRows: UsageAgentRow[];
  /** Per agent of {@link agents}, in the metric. */
  series: UsageSeries[];
  models: UsageModelRow[];
  /** Periods with usage, newest first. */
  periodRows: UsagePeriodRow[];
  /** Projects by the metric, largest first. */
  projects: UsageProjectRow[];
}

export interface UsageModelDetail extends UsageSummary {
  key: string;
  agent: string;
  model: string;
  sessions: number;
  /** The model's cost is unknown: every bucket of it is unpriced. */
  costUnknown: boolean;
  costShare: number | null;
  tokenShare: number;
  /** USD per 1M priced tokens; null when nothing of it was priced. */
  perMillionUsd: number | null;
  /** cacheRead / (uncached + cacheRead + cacheWrite); cache writes are misses. Null with no input. */
  cacheHitRate: number | null;
  /** Its trend: the metric asked for, or tokens when its cost is unknown. */
  chartMetric: UsageMetric;
  values: number[];
  /** On a cost trend, per period: how much of it has no known price. */
  unpriced?: UnpricedPart[];
}

function emptyTokens(): UsageTokenTotals {
  return { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 };
}

function addTokens(into: UsageTokenTotals, t: UsageTokenTotals): void {
  into.input += t.input;
  into.cacheRead += t.cacheRead;
  into.cacheWrite += t.cacheWrite;
  into.cacheWrite1h += t.cacheWrite1h;
  into.output += t.output;
  into.reasoning += t.reasoning;
}

/** Sum of the known costs; null when there were costs to know and none was. */
class CostSum {
  private sum = 0;
  private known = false;
  private any = false;
  add(cost: number | null, processed: number): void {
    if (cost !== null) {
      this.sum += cost;
      this.known = true;
    }
    if (cost !== null || processed > 0) this.any = true;
  }
  get value(): number | null {
    return this.known || !this.any ? this.sum : null;
  }
}

function share(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return part / whole;
}

function summarize(buckets: readonly UsageHistoryBucket[]): UsageSummary {
  const tokens = emptyTokens();
  const cost = new CostSum();
  let unpricedTokens = 0;
  let cacheSavingsUsd = 0;
  let split = 0;
  const costByType: UsageCostByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 };
  const costBySpeed: UsageCostBySpeed = { standard: 0, fast: 0, ultrafast: 0 };
  let speedPremiumUsd = 0;
  for (const b of buckets) {
    addTokens(tokens, b.tokens);
    cost.add(b.costUsd, processedTokens(b.tokens));
    unpricedTokens += b.unpricedTokens;
    cacheSavingsUsd += b.cacheSavingsUsd;
    if (b.cost) {
      costByType.input += b.cost.input;
      costByType.cacheRead += b.cost.cacheRead;
      costByType.cacheWrite += b.cost.cacheWrite;
      costByType.output += b.cost.output;
      split += b.cost.input + b.cost.cacheRead + b.cost.cacheWrite + b.cost.output;
    }
    if (b.costUsd !== null) costBySpeed[b.speed] = (costBySpeed[b.speed] ?? 0) + b.costUsd;
    if (b.speed !== "standard" && b.costUsd !== null && typeof b.standardCostUsd === "number") {
      speedPremiumUsd += b.costUsd - b.standardCostUsd;
    }
  }
  const costUsd = cost.value;
  const unsplit = (costUsd ?? 0) - split;
  costByType.other = unsplit >= OTHER_COST_MIN ? unsplit : 0;
  const processed = processedTokens(tokens);
  return {
    tokens,
    processed,
    costUsd,
    unpricedTokens,
    unpricedShare: processed > 0 ? unpricedTokens / processed : 0,
    cacheSavingsUsd,
    costByType,
    costBySpeed,
    speedPremiumUsd
  };
}

function metricValue(metric: UsageMetric, b: UsageHistoryBucket): number {
  return metric === "cost" ? (b.costUsd ?? 0) : processedTokens(b.tokens);
}

function hasUsage(b: { tokens: UsageTokenTotals; costUsd: number | null }): boolean {
  return processedTokens(b.tokens) > 0 || (b.costUsd ?? 0) > 0;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function visibleBuckets(data: UsageHistoryResponse, hiddenAgents: readonly string[]): UsageHistoryBucket[] {
  const hidden = new Set(hiddenAgents);
  return data.buckets.filter((b) => !hidden.has(b.agent) && b.period >= 0 && b.period < data.periods.length);
}

/** A bucket's cost as a figure: unknown when unpriced, marked when part of its tokens are. */
function costFigure(b: UsageHistoryBucket): CostFigure {
  if (b.costUsd === null) return { usd: null, unpriced: processedTokens(b.tokens) > 0 ? "all" : "none" };
  return { usd: b.costUsd, unpriced: b.unpricedTokens > 0 ? "some" : "none" };
}

/** Per period (zero-filled): the metric's values and, on cost, how much of each has no known price. */
function seriesValues(
  buckets: readonly UsageHistoryBucket[],
  periods: number,
  metric: UsageMetric
): { values: number[]; unpriced?: UnpricedPart[] } {
  const values = new Array<number>(periods).fill(0);
  for (const b of buckets) values[b.period] = (values[b.period] ?? 0) + metricValue(metric, b);
  if (metric !== "cost") return { values };
  const byPeriod = groupBy(buckets, (b) => String(b.period));
  const unpriced = values.map((_, i) => sumCostFigures((byPeriod.get(String(i)) ?? []).map(costFigure)).unpriced);
  return { values, unpriced };
}

/** Everything the Cost / Tokens tabs show, for `metric`, without `hiddenAgents`. */
export function deriveUsageView(
  data: UsageHistoryResponse,
  metric: UsageMetric,
  hiddenAgents: readonly string[]
): UsageView {
  const hidden = new Set(hiddenAgents);
  const buckets = visibleBuckets(data, hiddenAgents);
  const summary = summarize(buckets);
  const periodCount = data.periods.length;

  const byAgent = groupBy(buckets, (b) => b.agent);
  const agentSummaries = new Map<string, UsageSummary>();
  for (const [agent, list] of byAgent) {
    const s = summarize(list);
    if (s.processed > 0 || (s.costUsd ?? 0) > 0) agentSummaries.set(agent, s);
  }
  const agents = sortAgents(agentSummaries.keys());

  const sessions =
    hidden.size === 0
      ? data.sessions.total
      : // A session belongs to one agent, so the visible agents' counts add up exactly.
        agents.reduce((sum, agent) => sum + (data.sessions.byAgent[agent] ?? 0), 0);

  const activity = new Array<boolean>(periodCount).fill(false);
  for (const b of buckets) if (hasUsage(b)) activity[b.period] = true;
  const activePeriods = activity.filter(Boolean).length;
  const input = summary.tokens.input + summary.tokens.cacheRead + summary.tokens.cacheWrite;

  const totals: UsageTotals = {
    ...summary,
    sessions,
    activePeriods,
    processedPerActivePeriod: activePeriods > 0 ? summary.processed / activePeriods : 0,
    cachedInputShare: input > 0 ? summary.tokens.cacheRead / input : 0
  };

  const agentRows: UsageAgentRow[] = agents.map((agent) => {
    const s = agentSummaries.get(agent)!;
    return {
      agent,
      sessions: data.sessions.byAgent[agent] ?? 0,
      processed: s.processed,
      costUsd: s.costUsd,
      unpricedTokens: s.unpricedTokens,
      costShare: share(s.costUsd, summary.costUsd),
      tokenShare: share(s.processed, summary.processed) ?? 0
    };
  });

  const series: UsageSeries[] = agents.map((agent) => ({
    agent,
    ...seriesValues(byAgent.get(agent) ?? [], periodCount, metric)
  }));

  const models: UsageModelRow[] = [];
  for (const [key, list] of groupBy(buckets, (b) => `${b.agent}:${b.model}`)) {
    const s = summarize(list);
    if (s.processed <= 0 && (s.costUsd ?? 0) <= 0) continue;
    const first = list[0]!;
    models.push({
      key,
      agent: first.agent,
      model: first.model,
      sessions: data.sessions.byModel[key] ?? 0,
      processed: s.processed,
      costUsd: s.costUsd,
      unpricedTokens: s.unpricedTokens,
      costShare: share(s.costUsd, summary.costUsd),
      tokenShare: share(s.processed, summary.processed) ?? 0,
      value: metric === "cost" ? (s.costUsd ?? 0) : s.processed
    });
  }
  models.sort(
    metric === "cost"
      ? (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.processed - a.processed || a.key.localeCompare(b.key)
      : (a, b) => b.processed - a.processed || (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.key.localeCompare(b.key)
  );

  const periodRows: UsagePeriodRow[] = [];
  for (const [index, list] of groupBy(buckets, (b) => String(b.period))) {
    if (!list.some(hasUsage)) continue;
    const costByAgent: Record<string, number | null> = {};
    for (const [agent, ofAgent] of groupBy(list, (b) => b.agent)) {
      const c = new CostSum();
      for (const b of ofAgent) c.add(b.costUsd, processedTokens(b.tokens));
      costByAgent[agent] = c.value;
    }
    const s = summarize(list);
    const i = Number(index);
    periodRows.push({ index: i, period: data.periods[i]!, costByAgent, costUsd: s.costUsd, processed: s.processed });
  }
  periodRows.sort((a, b) => b.index - a.index);

  const projects = deriveProjects(data, metric, hidden);

  return { agents, totals, agentRows, series, models, periodRows, projects };
}

/** Distinct sessions per project of the visible agents (a session belongs to one agent, so they add up). */
function projectSessions(data: UsageHistoryResponse, hidden: ReadonlySet<string>): Record<string, number> {
  if (hidden.size === 0) return data.sessions.byProject;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(data.sessions.byProjectAgent ?? {})) {
    const colon = key.indexOf(":");
    if (colon < 0 || hidden.has(key.slice(0, colon))) continue;
    const project = key.slice(colon + 1);
    out[project] = (out[project] ?? 0) + count;
  }
  return out;
}

function deriveProjects(data: UsageHistoryResponse, metric: UsageMetric, hidden: ReadonlySet<string>): UsageProjectRow[] {
  const visible = data.projectBuckets.filter((b) => !hidden.has(b.agent));
  const sessions = projectSessions(data, hidden);
  const rows: Omit<UsageProjectRow, "share">[] = [];
  const total = new CostSum();
  let totalProcessed = 0;
  for (const [project, list] of groupBy(visible, (b) => b.project)) {
    const tokens = emptyTokens();
    const cost = new CostSum();
    let unpricedTokens = 0;
    for (const b of list) {
      addTokens(tokens, b.tokens);
      cost.add(b.costUsd, processedTokens(b.tokens));
      total.add(b.costUsd, processedTokens(b.tokens));
      unpricedTokens += b.unpricedTokens;
    }
    const processed = processedTokens(tokens);
    if (processed <= 0 && (cost.value ?? 0) <= 0) continue;
    totalProcessed += processed;
    const slash = project.indexOf("/");
    rows.push({
      project,
      workspace: slash > 0 ? project.slice(0, slash) : null,
      name: slash > 0 ? project.slice(slash + 1) : project,
      sessions: sessions[project] ?? 0,
      processed,
      costUsd: cost.value,
      unpricedTokens
    });
  }
  const totalCost = total.value;
  const withShare = rows.map((row) => ({
    ...row,
    share: metric === "cost" ? share(row.costUsd, totalCost) : (share(row.processed, totalProcessed) ?? 0)
  }));
  return withShare.sort(
    metric === "cost"
      ? (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.processed - a.processed || a.project.localeCompare(b.project)
      : (a, b) => b.processed - a.processed || (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.project.localeCompare(b.project)
  );
}

/** One model's drill-down (`key` as {@link UsageModelRow.key}); null when it has no visible usage. */
export function deriveModelDetail(
  data: UsageHistoryResponse,
  key: string,
  metric: UsageMetric,
  hiddenAgents: readonly string[]
): UsageModelDetail | null {
  const all = visibleBuckets(data, hiddenAgents);
  const list = all.filter((b) => `${b.agent}:${b.model}` === key);
  if (list.length === 0) return null;
  const s = summarize(list);
  if (s.processed <= 0 && (s.costUsd ?? 0) <= 0) return null;
  const whole = summarize(all);
  const first = list[0]!;
  const costUnknown = s.costUsd === null;
  const priced = s.processed - s.unpricedTokens;
  const input = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite;
  const chartMetric: UsageMetric = costUnknown ? "tokens" : metric;
  return {
    ...s,
    key,
    agent: first.agent,
    model: first.model,
    sessions: data.sessions.byModel[key] ?? 0,
    costUnknown,
    costShare: share(s.costUsd, whole.costUsd),
    tokenShare: share(s.processed, whole.processed) ?? 0,
    perMillionUsd: s.costUsd === null || priced <= 0 ? null : (s.costUsd / priced) * 1e6,
    cacheHitRate: input > 0 ? s.tokens.cacheRead / input : null,
    chartMetric,
    ...seriesValues(list, data.periods.length, chartMetric)
  };
}
