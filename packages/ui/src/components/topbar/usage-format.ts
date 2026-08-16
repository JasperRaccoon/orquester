import type { AgentUsage, UsageWindow } from "@orquester/api";
import { usageAgentEnabled, type UsagePrefs as _Prefs } from "@orquester/config";
import { REGISTRY } from "@orquester/registry";
import type { UsageResetFormat } from "../../lib/usage-display";

type Chip = _Prefs["chip"];

/** The agents the daemon can report usage for (source of truth for defaults). */
export const USAGE_AGENT_IDS = ["claude", "codex", "grok"] as const;

/** A reading older than this reads as stale on every usage surface. */
export const STALE_MIN = 10;

/** Registry display name for a usage agent id ("claude" → "Claude Code"). */
export function labelForAgent(id: string): string {
  const entry = REGISTRY.agents?.find((a) => a.id === id);
  return entry ? entry.name : id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * The actionable hint for an enabled-but-absent usage agent. Claude/Codex are
 * CLI logins; Grok's credential is the xai link (or a grok CLI login) — "run
 * grok login" alone would send the user to the wrong place on a proxy-only box.
 */
export function usageLoginHint(id: string): string {
  return id === "grok" ? "link or import a Grok account in Settings → Accounts, or run grok login" : `run ${id} login`;
}

/**
 * Enabled usage agents that aren't in the live snapshot (not logged in), so the
 * panel can show an actionable "run <id> login" hint. Derives the candidate set
 * from every known usage agent filtered by `usageAgentEnabled` — the same source
 * of truth that decides an agent is enabled — so default-enabled agents (absent
 * from `prefs.agents`) still surface their hint.
 */
export function missingUsageAgents(prefs: _Prefs, presentIds: Iterable<string>): string[] {
  const present = new Set(presentIds);
  return USAGE_AGENT_IDS.filter((id) => usageAgentEnabled(prefs, id) && !present.has(id));
}

export function windowMax(a: AgentUsage): number {
  return Math.max(a.session?.percent ?? 0, a.weekly?.percent ?? 0);
}

/**
 * Collapsed chip text: only the windows that actually have a reading.
 * Claude (5h+week) → "13% • 38%"; week-only Codex/Grok → "33%". Avoids a
 * misleading "33% • —" when the sole pool was historically slotted as session.
 */
export function formatChipWindows(a: Pick<AgentUsage, "session" | "weekly">): string {
  const parts: string[] = [];
  if (a.session) parts.push(`${Math.round(a.session.percent)}%`);
  if (a.weekly) parts.push(`${Math.round(a.weekly.percent)}%`);
  return parts.length > 0 ? parts.join(" • ") : "—";
}

/** The agent whose numbers drive the collapsed chip. */
export function pickDriver(agents: AgentUsage[], chip: Chip): AgentUsage | null {
  if (agents.length === 0) return null;
  if (chip !== "busiest") {
    const pinned = agents.find((a) => a.id === chip);
    if (pinned) return pinned;
  }
  return agents.reduce((best, a) => (windowMax(a) > windowMax(best) ? a : best), agents[0]);
}

export function formatCountdown(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms) || ms <= 60_000) return "Resets now.";
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1_440);
  const h = Math.floor((mins % 1_440) / 60);
  const m = mins % 60;
  if (d > 0) return `Resets in ${d}d ${h}h ${m}m`;
  return h > 0 ? `Resets in ${h}h ${m}m` : `Resets in ${m}m`;
}

export type UsageLevel = "ok" | "moderate" | "high" | "critical";

/** How close a percentage is to its limit: <50 ok, <75 moderate, <90 high, else critical. */
export function usageLevel(pct: number): UsageLevel {
  if (pct >= 90) return "critical";
  if (pct >= 75) return "high";
  if (pct >= 50) return "moderate";
  return "ok";
}

/**
 * Progress-bar fill color, green → yellow → orange → red by usage level.
 *
 * A four-step ramp, not four semantic colours: the middle two have no
 * danger/warn/ok/info meaning of their own, so the ramp lives as its own
 * per-mode variable set (`--usage-*` in styles/globals.css) rather than being
 * folded into the semantic scale. Dark keeps the original literals exactly;
 * light darkens each step so a label at that colour still reads on white.
 */
export function barClass(pct: number): string {
  switch (usageLevel(pct)) {
    case "critical":
      return "bg-[color:var(--usage-crit)]";
    case "high":
      return "bg-[color:var(--usage-high)]";
    case "moderate":
      return "bg-[color:var(--usage-med)]";
    default:
      return "bg-[color:var(--usage-ok)]";
  }
}

/** Chip gauge icon color, same green → yellow → orange → red ramp (text-*). */
export function gaugeClass(pct: number): string {
  switch (usageLevel(pct)) {
    case "critical":
      return "text-[color:var(--usage-crit)]";
    case "high":
      return "text-[color:var(--usage-high)]";
    case "moderate":
      return "text-[color:var(--usage-med)]";
    default:
      return "text-[color:var(--usage-ok)]";
  }
}

/** Minutes since an ISO timestamp (Infinity when absent/unparseable). */
export function minutesSince(asOf: string | undefined, now: number): number {
  if (!asOf) return Infinity;
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? Infinity : Math.max(0, (now - t) / 60_000);
}

/** Human "as of" age: "just now" / "Xm ago" / "Xh ago" ("" when absent). */
export function formatAgo(asOf: string | undefined, now: number): string {
  const m = minutesSince(asOf, now);
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "just now";
  if (m < 60) return `${Math.floor(m)}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ── Reset-time rendering (honours the persisted display format) ────────── */

/**
 * The wall-clock a window resets at, without a "Resets" prefix: bare time when
 * that lands today ("14:32"), date + time otherwise ("Jul 21, 14:32"). "" when
 * the timestamp is absent or unparseable, so callers can fall back.
 */
export function resetClock(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return "";
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * One reset line honouring the user's display preference: a countdown, the
 * wall clock, or both ("Resets in 2h 14m · 14:32"). Falls back to whichever
 * half is renderable; "" when the window carries no reset time at all.
 */
export function formatReset(
  resetsAt: string | undefined,
  format: UsageResetFormat,
  now: number
): string {
  if (!resetsAt) return "";
  const clock = resetClock(resetsAt, now);
  const countdown = formatCountdown(resetsAt, now);
  if (format === "absolute") return clock ? `Resets ${clock}` : countdown;
  if (format === "relative" || !clock) return countdown;
  // "Resets now." keeps its period only when it ends the line.
  return `${countdown.replace(/\.$/, "")} · ${clock}`;
}

/* ── Normalized windows (presentation shape) ────────────────────────────── */

/** What a window's absolute numbers count, when a source reports any. */
export type UsageUnit = "credits" | "requests" | "tokens" | "unknown";

/** A window ready to render: labels, unit, and whichever numbers exist. */
export interface NormalizedUsageWindow {
  id: "session" | "weekly";
  /** Compact bar label, as the top-bar panel uses ("5h" / "Week"). */
  label: string;
  /** Spelled-out label for the wider cards. */
  longLabel: string;
  period: "rolling" | "weekly";
  unit: UsageUnit;
  percent: number;
  used?: number;
  limit?: number;
  remaining?: number;
  resetsAt?: string;
}

/**
 * The unit an agent's pool is denominated in. No daemon source declares one on
 * the wire, so it is inferred per agent: Grok's weekly pool is a credit pool,
 * the Claude/Codex windows are percent-only.
 */
export function usageUnitFor(agentId: string): UsageUnit {
  return agentId === "grok" ? "credits" : "unknown";
}

/**
 * The windows that actually have a reading, in display order — the same rule
 * the chip uses, so a week-only agent never renders an empty "5h —" row.
 */
export function normalizeUsageWindows(
  agentId: string,
  src: { session: UsageWindow | null; weekly: UsageWindow | null }
): NormalizedUsageWindow[] {
  const unit = usageUnitFor(agentId);
  const out: NormalizedUsageWindow[] = [];
  // `...src.*` FIRST: the wire window only carries numbers today, but spreading
  // it last would let a future field silently clobber the presentation ones.
  if (src.session) {
    out.push({ ...src.session, id: "session", label: "5h", longLabel: "Session (5h)", period: "rolling", unit });
  }
  if (src.weekly) {
    // "Current period", not "This week": Grok's pool is a billing period and
    // Codex's weekly window is longer than 7 days for some plans.
    out.push({ ...src.weekly, id: "weekly", label: "Week", longLabel: "Current period", period: "weekly", unit });
  }
  return out;
}

/** 84_812_345 → "84.8M", 137_333 → "137k", 616 → "616". */
export function compactCount(n: number): string {
  const fmt = (v: number) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ""));
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000_000) return `${fmt(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)}M`;
  if (n >= 1_000) return `${fmt(n / 1_000)}k`;
  return String(n);
}

/** Exact, locale-grouped count for capacity readouts ("1,000"). */
export function exactCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** An absolute amount with its unit ("1,000 credits"); "—" when absent. */
export function formatUsageAmount(value: number | undefined, unit: UsageUnit): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = exactCount(value);
  return unit === "unknown" ? n : `${n} ${unit}`;
}

/** A finite number, or undefined — so the capacity line can skip missing halves. */
function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The absolute-numbers line for a window ("700 / 1,000 credits · 300 left").
 * "" when the source reported percentages only — most windows today — so the
 * card simply omits the row instead of printing placeholders.
 */
export function formatUsageCapacity(w: NormalizedUsageWindow): string {
  const used = finite(w.used);
  const limit = finite(w.limit);
  const remaining = finite(w.remaining);
  const parts: string[] = [];
  if (used !== undefined && limit !== undefined) {
    parts.push(`${exactCount(used)} / ${formatUsageAmount(limit, w.unit)}`);
  } else if (used !== undefined) {
    parts.push(`${formatUsageAmount(used, w.unit)} used`);
  } else if (limit !== undefined) {
    parts.push(`${formatUsageAmount(limit, w.unit)} limit`);
  }
  if (remaining !== undefined) {
    parts.push(`${exactCount(remaining)} left`);
  }
  return parts.join(" · ");
}
