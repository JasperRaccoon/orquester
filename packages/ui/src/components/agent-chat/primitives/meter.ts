// Ported from T3 Code (MIT): apps/web/src/components/chat/ContextWindowMeter.tsx:8-36

/** Above this, the ring turns destructive. */
export const METER_OVERLOAD_PERCENT = 90;

/** Clamps to 0–100 and treats a missing value as empty rather than as an error. */
export function clampMeterPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function isMeterOverloaded(value: number | null | undefined): boolean {
  return clampMeterPercent(value) > METER_OVERLOAD_PERCENT;
}

/**
 * The `stroke-dashoffset` that draws `percent` of a circle whose full
 * circumference is `circumference`. Offset counts *backwards* from a full
 * stroke, so 0% is a full offset and 100% is none.
 */
export function meterDashOffset(value: number | null | undefined, circumference: number): number {
  return circumference * (1 - clampMeterPercent(value) / 100);
}

/**
 * `null` in, `null` out — and that is the point. Without the model's context
 * window size there is no percentage to show, only a token count (spec §7.6);
 * inventing "0%" for an adapter with `reportsContextWindow: false` would be a
 * lie the user cannot detect.
 *
 * Below 10% one decimal is kept (trimming a trailing `.0`), because early in a
 * thread the difference between 2% and 3% is the only movement there is.
 */
export function formatMeterPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}
