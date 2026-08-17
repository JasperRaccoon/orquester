import type { AgentUsage, ScopedUsageWindow, UsageWindow } from "@orquester/api";

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

/** A window whose reset time has passed no longer describes current usage (the
 *  quota re-filled); serving it would keep e.g. a pre-reset 100% alive. Windows
 *  without a parseable resetsAt are assumed current. */
export function currentWindow(w: UsageWindow | null, now: number): UsageWindow | null {
  if (!w?.resetsAt) return w;
  const t = Date.parse(w.resetsAt);
  return Number.isFinite(t) && t <= now ? null : w;
}

/** Still-current scoped windows, or undefined when none survive (so a stale
 *  reading never keeps e.g. a pre-reset Fable 100% alive past its window). */
export function currentScopedWindows(
  windows: ScopedUsageWindow[] | undefined,
  now: number
): ScopedUsageWindow[] | undefined {
  const kept = (windows ?? []).filter((w) => currentWindow(w, now) != null);
  return kept.length > 0 ? kept : undefined;
}

export function parseClaudeUsage(body: unknown, creds: ClaudeCreds, now: number): AgentUsage {
  const b = (body ?? {}) as Record<string, any>;
  let session: UsageWindow | null = null;
  let weekly: UsageWindow | null = null;

  // Model-scoped weekly caps (e.g. Fable on Max plans) exist ONLY as limits[]
  // entries, so scan for them regardless of which branch fills session/weekly.
  const scoped: ScopedUsageWindow[] = [];
  if (Array.isArray(b.limits)) {
    for (const lim of b.limits) {
      if (lim?.kind !== "weekly_scoped") continue;
      const label = lim?.scope?.model?.display_name;
      if (typeof label !== "string" || !label) continue;
      const p = clampPercent(lim?.percent);
      if (p == null) continue;
      scoped.push({ percent: p, resetsAt: isoOrUndefined(lim?.resets_at), label });
    }
  }

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

  session = currentWindow(session, now);
  weekly = currentWindow(weekly, now);
  const scopedWindows = currentScopedWindows(scoped, now);
  return {
    id: "claude",
    available: session != null || weekly != null || scopedWindows != null,
    stale: false,
    plan: claudePlanLabel(creds),
    session,
    weekly,
    scopedWindows
  };
}

function codexWindow(w: any, now: number): UsageWindow | null {
  if (!w) return null;
  const resetsAt = epochSecondsToIso(w.resets_at);
  if (resetsAt && Date.parse(resetsAt) < now) return null; // stale window
  const percent = clampPercent(w.used_percent);
  return percent == null ? null : { percent, resetsAt };
}

/**
 * Codex historically mapped primary→session (5h) and secondary→weekly (7d).
 * Some plans (and current Pro/Plus) expose only a weekly pool, still under
 * `primary` / `primary_window`. Classify each raw window by its advertised
 * duration so a week-only plan lands in `weekly` instead of the 5h slot:
 *  - WHAM HTTP: `limit_window_seconds`
 *  - rollout token_count: `window_minutes`
 * When duration is missing, fall back to remaining time until reset: a real
 * 5h window never has >6h left.
 */
const SESSION_WINDOW_MAX_SECONDS = 12 * 60 * 60;
const SESSION_REMAINING_MAX_MS = 6 * 60 * 60 * 1000;

function codexLimitSeconds(w: unknown): number | null {
  if (typeof w !== "object" || w === null) return null;
  const o = w as Record<string, unknown>;
  if (typeof o.limit_window_seconds === "number" && Number.isFinite(o.limit_window_seconds) && o.limit_window_seconds > 0) {
    return o.limit_window_seconds;
  }
  // Rollout JSONL token_count events use window_minutes (5h=300, week=10080).
  const minutes = o.window_minutes ?? o.limit_minutes;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    return minutes * 60;
  }
  return null;
}

function codexSlotFor(win: UsageWindow, limitSeconds: number | null, now: number): "session" | "weekly" {
  if (limitSeconds != null) {
    return limitSeconds <= SESSION_WINDOW_MAX_SECONDS ? "session" : "weekly";
  }
  if (win.resetsAt) {
    const remaining = Date.parse(win.resetsAt) - now;
    if (Number.isFinite(remaining) && remaining > SESSION_REMAINING_MAX_MS) return "weekly";
  }
  return "session";
}

/** Slot raw Codex windows into session/weekly by duration, not primary/secondary. */
export function assignCodexWindows(
  windows: Array<{ win: UsageWindow | null; limitSeconds: number | null }>,
  now: number
): { session: UsageWindow | null; weekly: UsageWindow | null } {
  let session: UsageWindow | null = null;
  let weekly: UsageWindow | null = null;
  for (const { win, limitSeconds } of windows) {
    if (!win) continue;
    if (codexSlotFor(win, limitSeconds, now) === "session") session = win;
    else weekly = win;
  }
  return { session, weekly };
}

export function parseCodexUsage(rateLimits: unknown, now: number): AgentUsage {
  const rl = (rateLimits ?? {}) as Record<string, any>;
  const { session, weekly } = assignCodexWindows(
    [
      { win: codexWindow(rl.primary, now), limitSeconds: codexLimitSeconds(rl.primary) },
      { win: codexWindow(rl.secondary, now), limitSeconds: codexLimitSeconds(rl.secondary) }
    ],
    now
  );
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
  const { session, weekly } = assignCodexWindows(
    [
      { win: whamWindow(rl.primary_window, now), limitSeconds: codexLimitSeconds(rl.primary_window) },
      { win: whamWindow(rl.secondary_window, now), limitSeconds: codexLimitSeconds(rl.secondary_window) }
    ],
    now
  );
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

/**
 * Grok Build subscription usage from `GET {cli-chat-proxy}/billing?format=credits`
 * (the endpoint behind the grok CLI's own /usage command). Paid SuperGrok tiers
 * expose exactly ONE window — a shared credit pool over `currentPeriod`
 * (weekly today) — so it lands in the `weekly` slot and `session` stays null.
 * Proto3 gotcha: an omitted `creditUsagePercent` on a live period means 0%,
 * not "unknown" — never render it as unavailable.
 */
export function parseGrokBilling(json: unknown, now: number): AgentUsage {
  const root = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const cfg = typeof root.config === "object" && root.config !== null ? (root.config as Record<string, any>) : null;
  let weekly: UsageWindow | null = null;
  if (cfg) {
    const percent = clampPercent(cfg.creditUsagePercent ?? 0);
    if (percent != null) {
      weekly = { percent, resetsAt: isoOrUndefined(cfg.currentPeriod?.end ?? cfg.billingPeriodEnd) };
    }
  }
  weekly = currentWindow(weekly, now);
  return {
    id: "grok",
    available: weekly != null,
    stale: false,
    plan: typeof root.subscriptionTier === "string" && root.subscriptionTier ? root.subscriptionTier : undefined,
    session: null,
    weekly,
    asOf: weekly != null ? new Date(now).toISOString() : undefined
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
