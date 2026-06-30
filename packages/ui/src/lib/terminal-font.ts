/**
 * Terminal font size (px) — a single client-local viewing preference, persisted
 * per device. Mirrors the view-mode.ts persistence pattern (safe defaults on any
 * failure; storage errors swallowed). The stored value is absolute px, exactly
 * what xterm's `fontSize` option wants.
 */

const STORAGE_KEY = "orquester:terminal-font-size";

export const TERMINAL_FONT_MIN = 5;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_FONT_STEP = 1;

const DESKTOP_DEFAULT = 13;
const MOBILE_DEFAULT = 11;

/** Round to an integer px and clamp into [MIN, MAX]. */
export function clampTerminalFontSize(size: number): number {
  const rounded = Math.round(size);
  if (rounded < TERMINAL_FONT_MIN) {
    return TERMINAL_FONT_MIN;
  }
  if (rounded > TERMINAL_FONT_MAX) {
    return TERMINAL_FONT_MAX;
  }
  return rounded;
}

/**
 * Device-appropriate default: smaller on phones (more columns), 13 on desktop.
 * SSR-safe — falls back to the desktop default when matchMedia is unavailable.
 */
export function defaultTerminalFontSize(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return DESKTOP_DEFAULT;
  }
  return window.matchMedia("(min-width: 768px)").matches ? DESKTOP_DEFAULT : MOBILE_DEFAULT;
}

/** Load the persisted size (clamped), or the device default on any failure. */
export function loadTerminalFontSize(): number {
  try {
    if (typeof localStorage === "undefined") {
      return defaultTerminalFontSize();
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultTerminalFontSize();
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return defaultTerminalFontSize();
    }
    return clampTerminalFontSize(parsed);
  } catch {
    return defaultTerminalFontSize();
  }
}

/** Persist the size; a storage failure is non-fatal (stays in-memory only). */
export function saveTerminalFontSize(size: number): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    /* ignore quota/availability errors — size stays in-memory only */
  }
}
