/**
 * Adaptive video quality for a desktop viewer (spec §11.2).
 *
 * Input: the relay's ping/pong round trip (sampled every 2 s). The pong is
 * queued behind any RFB data the relay still has to send, so the RTT rises when
 * video exceeds what the link carries — it is the congestion signal.
 *
 * - 3 consecutive samples above 150 ms step `qualityLevel` down 6 → 4 → 2.
 * - 5 consecutive samples below 50 ms step it back up.
 * - Any sample in between breaks both streaks.
 */

export const DESKTOP_QUALITY_LEVELS = [2, 4, 6] as const;
export const DESKTOP_QUALITY_INITIAL = 6;
export const DESKTOP_COMPRESSION_LEVEL = 2;

export const QUALITY_HIGH_RTT_MS = 150;
export const QUALITY_LOW_RTT_MS = 50;
export const QUALITY_STEP_DOWN_SAMPLES = 3;
export const QUALITY_STEP_UP_SAMPLES = 5;

export interface DesktopQualityState {
  level: number;
  /** Consecutive samples above the high threshold. */
  highStreak: number;
  /** Consecutive samples below the low threshold. */
  lowStreak: number;
}

export function initialDesktopQuality(): DesktopQualityState {
  return { level: DESKTOP_QUALITY_INITIAL, highStreak: 0, lowStreak: 0 };
}

function stepDown(level: number): number {
  const lower = DESKTOP_QUALITY_LEVELS.filter((l) => l < level);
  return lower.length > 0 ? lower[lower.length - 1] : level;
}

function stepUp(level: number): number {
  return DESKTOP_QUALITY_LEVELS.find((l) => l > level) ?? level;
}

/** Fold one RTT sample into the state. Pure. */
export function nextDesktopQuality(state: DesktopQualityState, rttMs: number): DesktopQualityState {
  if (rttMs > QUALITY_HIGH_RTT_MS) {
    const highStreak = state.highStreak + 1;
    if (highStreak >= QUALITY_STEP_DOWN_SAMPLES) {
      return { level: stepDown(state.level), highStreak: 0, lowStreak: 0 };
    }
    return { level: state.level, highStreak, lowStreak: 0 };
  }
  if (rttMs < QUALITY_LOW_RTT_MS) {
    const lowStreak = state.lowStreak + 1;
    if (lowStreak >= QUALITY_STEP_UP_SAMPLES) {
      return { level: stepUp(state.level), highStreak: 0, lowStreak: 0 };
    }
    return { level: state.level, highStreak: 0, lowStreak };
  }
  return { level: state.level, highStreak: 0, lowStreak: 0 };
}
