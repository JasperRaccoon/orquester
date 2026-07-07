import type { AgentUsage } from "@orquester/api";
import type { UsagePrefs as _Prefs } from "@orquester/config";

type Chip = _Prefs["chip"];

function windowMax(a: AgentUsage): number {
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

/** Fill color for a percentage: emerald < 75, amber < 90, red otherwise. */
export function barClass(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 75) return "bg-amber-400";
  return "bg-emerald-400";
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
