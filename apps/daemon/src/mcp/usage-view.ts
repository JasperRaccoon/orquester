import type { AgentAccount, AgentUsage, UsageAccount, UsageResponse, UsageWindow } from "@orquester/api";

export interface UsageWindowView { id: string; label: string; percentUsed: number; resetsAt?: string; resetsIn?: string }
export interface UsageAccountView { id: string; label: string; plan?: string; available: boolean; stale: boolean; asOf?: string; ageMinutes?: number; needsReauth?: boolean; email?: string; windows: UsageWindowView[] }
export interface UsageAgentView { id: string; name: string; available: boolean; stale: boolean; asOf?: string; ageMinutes?: number; plan?: string; windows?: UsageWindowView[]; accounts: UsageAccountView[]; system?: UsageAccountView; aggregate?: { strategy: string; accountCount: number; staleAccountCount?: number } }

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok Build" };

/** The top-bar countdown (`formatCountdown` in the UI) without the "Resets in" prefix. */
export function formatResetsIn(resetsAt: string | undefined, now: number): string | undefined {
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

function accountRow(row: UsageAccount, managed: AgentAccount | undefined, now: number): UsageAccountView {
  const v: UsageAccountView = { id: row.id, label: row.label ?? managed?.label ?? row.id, available: row.available, stale: row.stale, windows: windows(row, now) };
  if (row.plan) v.plan = row.plan;
  if (row.asOf) { v.asOf = row.asOf; const age = ageMinutes(row.asOf, now); if (age !== undefined) v.ageMinutes = age; }
  if (managed) { v.needsReauth = managed.needsReauth; if (managed.email) v.email = managed.email; }
  return v;
}

export function usageView(res: UsageResponse, accounts: readonly AgentAccount[], now: number): { agents: UsageAgentView[] } {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return {
    agents: res.agents.map((agent) => {
      const v: UsageAgentView = { id: agent.id, name: AGENT_NAMES[agent.id] ?? agent.id, available: agent.available, stale: agent.stale, accounts: (agent.accounts ?? []).map((row) => accountRow(row, byId.get(row.id), now)) };
      if (agent.asOf) { v.asOf = agent.asOf; const age = ageMinutes(agent.asOf, now); if (age !== undefined) v.ageMinutes = age; }
      if (agent.plan) v.plan = agent.plan;
      if (agent.system) v.system = accountRow(agent.system, undefined, now);
      if (agent.aggregate) v.aggregate = { strategy: agent.aggregate.strategy, accountCount: agent.aggregate.accountCount, ...(agent.aggregate.staleAccountCount !== undefined ? { staleAccountCount: agent.aggregate.staleAccountCount } : {}) };
      if (!v.accounts.length && !v.system) v.windows = windows(agent, now);
      return v;
    })
  };
}
