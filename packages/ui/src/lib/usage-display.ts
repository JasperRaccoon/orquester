/**
 * Usage-surface display preferences — client-local, persisted per device in
 * localStorage. Mirrors the view-mode.ts / panel-sizes.ts persistence mold:
 * SSR-safe (`typeof localStorage === "undefined"` guards), swallows storage
 * errors, validates on load (a raw `JSON.parse` result must never reach typed
 * code). Deliberately NOT part of the daemon's app config — how reset times
 * render is a per-device viewing choice, not shared server state.
 *
 * Also hosts the shared minute ticker the usage surfaces re-render on: one
 * process-wide interval feeds every bar instead of each one owning a timer.
 */

/** How a window's reset time renders: countdown, wall clock, or both. */
export type UsageResetFormat = "relative" | "absolute" | "both";

export const USAGE_RESET_FORMAT_DEFAULT: UsageResetFormat = "relative";

const STORAGE_KEY = "orquester:usage-reset-format";

function isResetFormat(value: unknown): value is UsageResetFormat {
  return value === "relative" || value === "absolute" || value === "both";
}

/** Load the persisted reset format, or the default on any failure. */
export function loadUsageResetFormat(): UsageResetFormat {
  try {
    if (typeof localStorage === "undefined") {
      return USAGE_RESET_FORMAT_DEFAULT;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    return isResetFormat(raw) ? raw : USAGE_RESET_FORMAT_DEFAULT;
  } catch {
    return USAGE_RESET_FORMAT_DEFAULT;
  }
}

/** Persist the reset format; a storage failure is non-fatal (in-memory only). */
function saveUsageResetFormat(format: UsageResetFormat): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, format);
  } catch {
    /* ignore quota/availability errors — the choice stays in-memory only */
  }
}

/* ── Reset-format store (useSyncExternalStore backing) ──────────────────── */

const formatListeners = new Set<() => void>();
let formatSnapshot: UsageResetFormat | null = null;

/** The current format; reads localStorage once, then serves the cached value. */
export function getUsageResetFormat(): UsageResetFormat {
  if (formatSnapshot === null) {
    formatSnapshot = loadUsageResetFormat();
  }
  return formatSnapshot;
}

/** Persist a new format and wake every subscribed usage surface. */
export function setUsageResetFormat(format: UsageResetFormat): void {
  if (getUsageResetFormat() === format) {
    return;
  }
  formatSnapshot = format;
  saveUsageResetFormat(format);
  for (const listener of formatListeners) {
    listener();
  }
}

export function subscribeUsageResetFormat(listener: () => void): () => void {
  formatListeners.add(listener);
  return () => {
    formatListeners.delete(listener);
  };
}

/* ── Shared minute ticker ───────────────────────────────────────────────── */

/** How often relative reset times are re-rendered. */
export const USAGE_TICK_MS = 60_000;

const tickListeners = new Set<() => void>();
let tickNow = Date.now();
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** The shared "now" every usage surface renders against (ms epoch). */
export function getUsageNow(): number {
  return tickNow;
}

/**
 * Subscribe to the shared minute tick. The interval only runs while at least
 * one surface is mounted, and `now` is refreshed on the first subscribe so a
 * panel reopened after an hour doesn't paint a stale countdown for a minute.
 */
export function subscribeUsageTick(listener: () => void): () => void {
  // Keyed on the timer, not the listener count, so start and stop test the same
  // invariant ("a timer runs iff someone is listening") from both directions —
  // a size-based entry check could start a second interval if the two ever
  // disagreed, and the extra one would never be cleared.
  if (tickTimer === null) {
    tickNow = Date.now();
    tickTimer = setInterval(() => {
      tickNow = Date.now();
      for (const l of tickListeners) {
        l();
      }
    }, USAGE_TICK_MS);
  }
  tickListeners.add(listener);
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}
