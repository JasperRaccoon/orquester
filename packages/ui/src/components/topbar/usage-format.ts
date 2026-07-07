import type { AgentUsage } from "@orquester/api";
import type { UsagePrefs as _Prefs } from "@orquester/config";

type Chip = _Prefs["chip"];

export function windowMax(a: AgentUsage): number {
  return Math.max(a.session?.percent ?? 0, a.weekly?.percent ?? 0);
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
  const h = Math.floor(mins / 60);
  const m = mins % 60;
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

/** Progress-bar fill color, green → yellow → orange → red by usage level. */
export function barClass(pct: number): string {
  switch (usageLevel(pct)) {
    case "critical":
      return "bg-red-500";
    case "high":
      return "bg-orange-400";
    case "moderate":
      return "bg-yellow-400";
    default:
      return "bg-emerald-400";
  }
}

/** Chip gauge icon color, same green → yellow → orange → red ramp (text-*). */
export function gaugeClass(pct: number): string {
  switch (usageLevel(pct)) {
    case "critical":
      return "text-red-500";
    case "high":
      return "text-orange-400";
    case "moderate":
      return "text-yellow-400";
    default:
      return "text-emerald-400";
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
