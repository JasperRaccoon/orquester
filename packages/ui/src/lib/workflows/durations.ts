/**
 * Durations as people read them ("4 h", "2 h 30 min", "7 days") and the unit
 * arithmetic behind the inspector's `DurationInput`: configs store one
 * canonical unit (minutes, seconds…), the form shows the largest unit that
 * says the same number exactly.
 */

export type DurationUnit = "seconds" | "minutes" | "hours" | "days";

/** Seconds in one of each unit. */
export const UNIT_SECONDS: Readonly<Record<DurationUnit, number>> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

const LARGEST_FIRST: readonly DurationUnit[] = ["days", "hours", "minutes", "seconds"];

/** Drops float noise (0.1 h → 6 min, not 6.000000000000001). */
function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** `value` in `from` units, expressed in `to` units. */
export function convertDuration(value: number, from: DurationUnit, to: DurationUnit): number {
  return tidy((value * UNIT_SECONDS[from]) / UNIT_SECONDS[to]);
}

/**
 * The unit a stored value reads best in: the largest of `offered` that holds it
 * as a whole number (240 min → hours, 90 min → minutes). An empty or zero value,
 * or one no offered unit divides, shows in `canonical` when offered, else the
 * smallest offered unit.
 */
export function displayUnitFor(value: number | undefined, canonical: DurationUnit, offered: readonly DurationUnit[]): DurationUnit {
  const smallestFirst = LARGEST_FIRST.filter((unit) => offered.includes(unit)).reverse();
  const fallback = offered.includes(canonical) ? canonical : (smallestFirst[0] ?? canonical);
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  const seconds = tidy(value * UNIT_SECONDS[canonical]);
  for (const unit of LARGEST_FIRST) {
    if (!offered.includes(unit)) continue;
    const count = seconds / UNIT_SECONDS[unit];
    if (Math.abs(count - Math.round(count)) < 1e-6) return unit;
  }
  return fallback;
}

const SHORT: Readonly<Record<DurationUnit, (count: number) => string>> = {
  days: (count) => (count === 1 ? "1 day" : `${count} days`),
  hours: (count) => `${count} h`,
  minutes: (count) => `${count} min`,
  seconds: (count) => `${count} s`
};

/** A count in one unit, as the readout writes it: "1 day", "4 h", "30 min", "1.5 h". */
export function formatUnitCount(count: number, unit: DurationUnit): string {
  return SHORT[unit](tidy(count));
}

/**
 * A duration broken into every non-zero part, largest first: "4 h",
 * "2 h 30 min", "1 day 2 h", "1 min 30 s". Sub-second remainders round to the
 * nearest second; zero reads "0 min" in minutes and "0 s" in seconds.
 */
export function formatDurationIn(value: number, unit: DurationUnit): string {
  if (!Number.isFinite(value) || value < 0) return "";
  let seconds = Math.round(value * UNIT_SECONDS[unit]);
  if (seconds === 0) return SHORT[unit === "seconds" ? "seconds" : "minutes"](0);
  const parts: string[] = [];
  for (const part of LARGEST_FIRST) {
    const size = UNIT_SECONDS[part];
    const count = Math.floor(seconds / size);
    if (count > 0) parts.push(SHORT[part](count));
    seconds -= count * size;
  }
  return parts.join(" ");
}

/** `formatDurationIn(minutes, "minutes")`: 240 → "4 h", 150 → "2 h 30 min", 10080 → "7 days". */
export function formatMinutes(minutes: number): string {
  return formatDurationIn(minutes, "minutes");
}

/** `formatDurationIn(seconds, "seconds")`: 30 → "30 s", 300 → "5 min". */
export function formatSeconds(seconds: number): string {
  return formatDurationIn(seconds, "seconds");
}

/**
 * What a duration field stores for `count` typed in `inUnit`: converted to the
 * `canonical` unit, clamped there (never to a converted bound, which would
 * carry float noise back: 1 min as hours is 0.016667), and rounded to a
 * thousandth of the canonical unit.
 */
export function canonicalDuration(count: number, inUnit: DurationUnit, canonical: DurationUnit, min?: number, max?: number): number {
  let next = convertDuration(count, inUnit, canonical);
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return Math.round(next * 1000) / 1000;
}
