// Formatting shared by the Usage view and the top-bar popover's Cost tab: token counts, money,
// shares, period labels, model labels, and the per-agent series colour.

import type { UsageTokenTotals } from "@orquester/api";

/** Agents in the order the Usage view lists them (a fixed order, so rows don't jump). */
export const USAGE_AGENT_ORDER: readonly string[] = ["codex", "claude", "grok", "opencode"];

/** Sort agent ids into {@link USAGE_AGENT_ORDER}; unknown agents follow, by id. */
export function sortAgents(ids: Iterable<string>): string[] {
  const rank = (id: string) => {
    const i = USAGE_AGENT_ORDER.indexOf(id);
    return i < 0 ? USAGE_AGENT_ORDER.length : i;
  };
  return [...new Set(ids)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The agent's series colour (a per-mode CSS variable from globals.css). */
export function agentColor(agent: string): string {
  return USAGE_AGENT_ORDER.includes(agent) ? `var(--agent-${agent})` : "var(--agent-other)";
}

/** Processed tokens: uncached input + cache reads + cache writes + output (reasoning is inside output). */
export function processedTokens(t: Pick<UsageTokenTotals, "input" | "cacheRead" | "cacheWrite" | "output">): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

const TOKEN_UNITS: readonly { size: number; suffix: string }[] = [
  { size: 1, suffix: "" },
  { size: 1e3, suffix: "K" },
  { size: 1e6, suffix: "M" },
  { size: 1e9, suffix: "B" },
  { size: 1e12, suffix: "T" }
];

/** 89_812_345_678 → "89.8B", 512_000 → "512K", 999 → "999" (three significant digits). */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  let unit = 0;
  while (unit < TOKEN_UNITS.length - 1 && abs >= TOKEN_UNITS[unit + 1]!.size) unit += 1;
  // Round first, then promote: 999_600 rounds to 1000K, which reads "1M".
  for (;;) {
    const scaled = abs / TOKEN_UNITS[unit]!.size;
    const digits = unit === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    const rounded = scaled.toFixed(digits);
    if (Number(rounded) >= 1000 && unit < TOKEN_UNITS.length - 1) {
      unit += 1;
      continue;
    }
    const sign = value < 0 && Number(rounded) !== 0 ? "-" : "";
    return `${sign}${rounded.replace(/\.0+$/, "")}${TOKEN_UNITS[unit]!.suffix}`;
  }
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INTEGER = new Intl.NumberFormat("en-US");

/** "$11,944.02"; "<$0.01" for a tiny positive amount; "—" for an unknown (null) one. */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.005) return "<$0.01";
  return USD.format(value);
}

/**
 * A money axis label with as many decimals as the tick `step` needs, so a tiny scale
 * reads "$0.001 · $0.002" rather than "<$0.01" on every tick, and a large one "$1,500".
 */
export function formatUsdTick(value: number, step: number): string {
  const decimals = !(step > 0) || step >= 1 ? 0 : Math.min(8, Math.max(2, Math.ceil(-Math.log10(step) - 1e-9)));
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

/** A 0–1 share as "15.0%"; "<0.1%" when tiny but not zero. */
export function formatPercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}

/** 2075 → "2,075". */
export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-08" → "Sep 8" (read from the string: the day is already in the viewer's zone). */
export function formatDayShort(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}` : day;
}

/** The browser's IANA time zone, or "UTC". */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** An ISO hour start as "3 PM" (or "15:00" where the locale uses a 24h clock), in `timeZone`. */
export function formatHourShort(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: "numeric", timeZone: safeZone(timeZone) });
}

/** An ISO instant as "Oct 6, 3 PM" in `timeZone`. */
export function formatDateTimeShort(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", timeZone: safeZone(timeZone) });
}

/** One period's label: "Sep 8" for a day, "3 PM" for an hour. */
export function formatPeriod(period: string, resolution: "hour" | "day", timeZone: string): string {
  return resolution === "day" ? formatDayShort(period) : formatHourShort(period, timeZone);
}

/** One period's long label (tooltips, the day table): "Sep 8", or "Oct 6, 3 PM" for an hour. */
export function formatPeriodLong(period: string, resolution: "hour" | "day", timeZone: string): string {
  return resolution === "day" ? formatDayShort(period) : formatDateTimeShort(period, timeZone);
}

/** The window as "Oct 4 – Nov 2", or "Nov 1, 3 PM – Nov 2, 3 PM" for hours. */
export function formatWindow(periods: readonly string[], resolution: "hour" | "day", timeZone: string): string {
  if (periods.length === 0) return "";
  const first = periods[0]!;
  const last = periods[periods.length - 1]!;
  if (resolution === "day") return first === last ? formatDayShort(first) : `${formatDayShort(first)} – ${formatDayShort(last)}`;
  return `${formatDateTimeShort(first, timeZone)} – ${formatDateTimeShort(last, timeZone)}`;
}

/** "claude-opus-4-8-20260115" → "Opus 4.8", "gpt-5.6-sol" → "GPT-5.6 Sol"; anything else as is. */
export function labelForModel(model: string): string {
  const bare = model.replace(/-\d{8}$/, "");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const claude = bare.match(/^claude-([a-z]+)-([\d-]+)$/);
  if (claude) return `${cap(claude[1]!)} ${claude[2]!.replace(/-/g, ".")}`;
  const gpt = bare.match(/^gpt-([\d.]+)(?:-([a-z-]+))?$/);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split("-").map(cap).join(" ")}` : ""}`;
  return bare;
}
