import type { SubagentCacheTtlStatus } from "@orquester/api";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * The line under the "Subagent cache lifetime" picker in auto mode: what
 * Claude launches get now, what the last check found, and when it looks again.
 */
export function describeSubagentCacheTtl(
  status: SubagentCacheTtlStatus,
  formatDate: (iso: string) => string = shortDate
): string {
  const current = `Currently ${status.ttl}.`;
  const check = status.lastCheck;
  if (!check) return `${current} The first check runs once recent subagent usage has been read.`;
  const window = `${check.windowDays} days`;
  let found: string;
  if (check.outcome === "insufficient" || check.changePct === null) {
    found = `only ${check.requests} subagent requests in ${window}, too few to judge`;
  } else {
    const pct = Math.abs(check.changePct);
    const cost = pct === 0 ? "the same" : `${pct}% ${check.changePct < 0 ? "less" : "more"}`;
    found = `1h would have cost ${cost} over ${window}${check.outcome === "hold" ? ", too close to change" : ""}`;
  }
  const next = status.nextCheckAt ? ` Next check ${formatDate(status.nextCheckAt)}.` : "";
  return `${current} Last check ${formatDate(check.at)}: ${found}.${next}`;
}
