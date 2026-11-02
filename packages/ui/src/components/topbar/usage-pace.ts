// Even-spend pace for a quota window: how much of the window's time has passed, against how
// much of its quota is used (spec §6.2 "Limits tab").

export type UsagePaceStatus = "ahead" | "on" | "under";

export interface UsagePace {
  /** Share of the window's time that has passed, 0–1: where the pace tick sits on the bar. */
  elapsed: number;
  status: UsagePaceStatus;
  label: string;
}

const LABELS: Record<UsagePaceStatus, string> = {
  ahead: "ahead of pace",
  on: "on pace",
  under: "under pace"
};

/** Points of quota used beyond (or short of) the time passed that still count as "on pace". */
const ON_PACE_POINTS = 5;

/**
 * The pace of a window that is `percent` used and resets at `resetsAt` after `durationMins`.
 * Null when the window's length or reset is unknown, or the reset does not fit inside one
 * window from now (the assumed length is wrong, or the reading is past its reset).
 */
export function usagePace(
  window: { percent: number; resetsAt?: string; durationMins?: number },
  now: number
): UsagePace | null {
  if (!window.durationMins || window.durationMins <= 0 || !window.resetsAt) return null;
  const resetsAt = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAt)) return null;
  const duration = window.durationMins * 60_000;
  const remaining = resetsAt - now;
  if (remaining <= 0 || remaining > duration) return null;
  const elapsed = 1 - remaining / duration;
  const gap = window.percent - elapsed * 100;
  const status: UsagePaceStatus = gap > ON_PACE_POINTS ? "ahead" : gap < -ON_PACE_POINTS ? "under" : "on";
  return { elapsed, status, label: LABELS[status] };
}
