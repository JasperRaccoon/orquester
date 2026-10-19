/**
 * Ephemeral AI VMs — how prices, lifetimes and countdowns read, in the plugin
 * settings, the Runs on row and the sidebar badges. Prices are USD.
 */

/** Hours in the "a month" estimate (365 × 24 / 12, how providers quote monthly caps). */
export const HOURS_PER_MONTH = 730;

const MINUTES_PER_DAY = 24 * 60;

const grouped = (value: number, decimals: number): string =>
  value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/**
 * An hourly price: two decimals from $1 up ("$4.80"); below that, enough
 * decimals for three significant digits, never fewer than two ("$0.50",
 * "$0.0119", "$0.00694") — small GPU-marketplace and VM prices differ in the
 * third digit.
 */
export function formatHourlyUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value >= 1) return `$${grouped(value, 2)}`;
  const decimals = Math.max(2, Math.ceil(-Math.log10(value)) + 2);
  let text = value.toFixed(decimals);
  // "0.500" → "0.50": significant zeros past the cents say nothing.
  while (text.endsWith("0") && text.length - text.indexOf(".") - 1 > 2) text = text.slice(0, -1);
  // Rounding can carry into a whole dollar (0.9996 → "1.000").
  return Number(text) >= 1 ? `$${grouped(Number(text), 2)}` : `$${text}`;
}

/** "$4.80/h" */
export function formatHourlyRate(value: number): string {
  return `${formatHourlyUsd(value)}/h`;
}

/**
 * An amount (a total, a month, the cost so far): whole dollars from $100
 * ("$576", "$3,504"), cents below ("$8.69"), and "<$0.01" for a sliver.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value >= 100) return `$${grouped(Math.round(value), 0)}`;
  if (value < 0.01) return "<$0.01";
  return `$${grouped(value, 2)}`;
}

/** The monthly equivalent of an hourly price (always-on). */
export function monthlyUsd(hourlyUsd: number): number {
  return hourlyUsd * HOURS_PER_MONTH;
}

/** The daily equivalent of an hourly price. */
export function dailyUsd(hourlyUsd: number): number {
  return hourlyUsd * 24;
}

/** What `minutes` of uptime cost at `hourlyUsd`. */
export function costForMinutes(hourlyUsd: number, minutes: number): number {
  return (hourlyUsd * minutes) / 60;
}

/** A lifetime: "5 days", "1 day", "6 hours", "90 minutes". */
export function formatLifetime(minutes: number): string {
  if (minutes >= MINUTES_PER_DAY && minutes % MINUTES_PER_DAY === 0) {
    const days = minutes / MINUTES_PER_DAY;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * Time left until `deadline` as a badge reads it: "4d 6h left", "3h 12m left",
 * "12m left", "<1m left"; "Time limit reached" once it passed. Null without a
 * readable deadline.
 */
export function formatCountdown(deadline: string | null, now: number): string | null {
  if (!deadline) return null;
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return null;
  const left = at - now;
  if (left <= 0) return "Time limit reached";
  const minutes = Math.floor(left / 60_000);
  if (minutes < 1) return "<1m left";
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const hours = Math.floor((minutes % MINUTES_PER_DAY) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}
