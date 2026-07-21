import type { AgentUsage, UsageWindow } from "@orquester/api";

export type ClaudeCreds = { subscriptionType?: string; rateLimitTier?: string };

/** 0–100, or null when absent/garbage. Drops the leak-bug value (>101) and clamps 100–101→100. */
function clampPercent(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v > 101) return null;
  if (v >= 100) return 100;
  return v < 0 ? 0 : v;
}

function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return v;
  return undefined;
}

function epochSecondsToIso(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return new Date(v * 1000).toISOString();
}

export function claudePlanLabel(creds: ClaudeCreds): string | undefined {
  if (!creds.subscriptionType) return undefined;
  const base = creds.subscriptionType.charAt(0).toUpperCase() + creds.subscriptionType.slice(1);
  const m = /(\d+)\s*x/i.exec(creds.rateLimitTier ?? "");
  return m ? `${base} ${m[1]}x` : base;
}

function codexPlanLabel(planType: unknown): string | undefined {
  if (typeof planType !== "string" || !planType) return undefined;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

export function parseClaudeUsage(body: unknown, creds: ClaudeCreds, _now: number): AgentUsage {
  const b = (body ?? {}) as Record<string, any>;
  let session: UsageWindow | null = null;
  let weekly: UsageWindow | null = null;

  if (b.five_hour || b.seven_day) {
    const s = clampPercent(b.five_hour?.utilization);
    if (s != null) session = { percent: s, resetsAt: isoOrUndefined(b.five_hour?.resets_at) };
    const w = clampPercent(b.seven_day?.utilization);
    if (w != null) weekly = { percent: w, resetsAt: isoOrUndefined(b.seven_day?.resets_at) };
  } else if (Array.isArray(b.limits)) {
    for (const lim of b.limits) {
      const p = clampPercent(lim?.percent);
      if (p == null) continue;
      const win = { percent: p, resetsAt: isoOrUndefined(lim?.resets_at) };
      if (lim?.kind === "session") session = win;
      else if (lim?.kind === "weekly_all") weekly = win;
    }
  }

  return {
    id: "claude",
    available: session != null || weekly != null,
    stale: false,
    plan: claudePlanLabel(creds),
    session,
    weekly
  };
}

function codexWindow(w: any, now: number): UsageWindow | null {
  if (!w) return null;
  const resetsAt = epochSecondsToIso(w.resets_at);
  if (resetsAt && Date.parse(resetsAt) < now) return null; // stale window
  const percent = clampPercent(w.used_percent);
  return percent == null ? null : { percent, resetsAt };
}

export function parseCodexUsage(rateLimits: unknown, now: number): AgentUsage {
  const rl = (rateLimits ?? {}) as Record<string, any>;
  const session = codexWindow(rl.primary, now);
  const weekly = codexWindow(rl.secondary, now);
  return {
    id: "codex",
    available: session != null || weekly != null,
    stale: false,
    plan: codexPlanLabel(rl.plan_type),
    session,
    weekly
  };
}

function whamWindow(w: unknown, now: number): UsageWindow | null {
  if (typeof w !== "object" || w === null) return null;
  const o = w as Record<string, unknown>;
  const pct = typeof o.used_percent === "number" ? o.used_percent : null;
  if (pct === null) return null;
  const resetSec = typeof o.reset_at === "number" ? o.reset_at : null;
  const win: UsageWindow = { percent: Math.max(0, Math.min(100, pct)) };
  if (resetSec !== null && resetSec * 1000 > now - 86_400_000) win.resetsAt = new Date(resetSec * 1000).toISOString();
  return win;
}

function titleCasePlan(plan: unknown): string | undefined {
  if (typeof plan !== "string" || !plan) return undefined;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function parseCodexWhamUsage(json: unknown, now: number): AgentUsage {
  const root = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const rl = typeof root.rate_limit === "object" && root.rate_limit !== null ? (root.rate_limit as Record<string, unknown>) : {};
  const session = whamWindow(rl.primary_window, now);
  const weekly = whamWindow(rl.secondary_window, now);
  const available = session !== null || weekly !== null;
  return {
    id: "codex",
    available,
    stale: false,
    plan: titleCasePlan(root.plan_type),
    session,
    weekly,
    asOf: available ? new Date(now).toISOString() : undefined
  };
}

/** Scan rollout JSONL lines from the end for the last token_count event's rate_limits. */
export function findLastCodexTokenCount(lines: string[]): unknown | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === "event_msg" && obj?.payload?.type === "token_count" && obj.payload.rate_limits) {
      return obj.payload.rate_limits;
    }
  }
  return null;
}
