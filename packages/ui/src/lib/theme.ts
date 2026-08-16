/**
 * Colour scheme + light/dark mode — two client-local viewing preferences,
 * persisted per device. Mirrors the terminal-font.ts / view-mode.ts persistence
 * pattern (safe defaults on any failure; storage errors swallowed).
 *
 * The palettes themselves live in `styles/globals.css` under
 * `[data-scheme][data-mode]` selectors, and Tailwind's `neutral` scale is
 * pointed at them by `packages/ui/tailwind-preset.ts`. This module only decides
 * WHICH pair of attributes to stamp on `<html>`; the stylesheet does the rest.
 */

export type ColorScheme = "mono" | "warm" | "slate" | "rose" | "matcha" | "dune" | "amethyst";

/** The four settable modes. Only "light"/"dark" ever reach the CSS. */
export type ThemeMode = "system" | "light" | "dark" | "dynamic";

/** Resolved mode — the only two values `data-mode` is ever set to. */
export type ResolvedMode = "light" | "dark";

/** "mono" is the app's stock look: Tailwind's own neutral scale, dark. */
export const DEFAULT_COLOR_SCHEME: ColorScheme = "mono";
export const DEFAULT_THEME_MODE: ThemeMode = "dark";

export const COLOR_SCHEMES: { id: ColorScheme; label: string }[] = [
  { id: "mono", label: "Monochrome" },
  { id: "warm", label: "Warm" },
  { id: "slate", label: "Slate" },
  { id: "rose", label: "Rose" },
  { id: "matcha", label: "Matcha" },
  { id: "dune", label: "Dune" },
  { id: "amethyst", label: "Amethyst" }
];

export const THEME_MODES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "dynamic", label: "Dynamic" }
];

const SCHEME_IDS = new Set<string>(COLOR_SCHEMES.map((s) => s.id));
const MODE_IDS = new Set<string>(THEME_MODES.map((m) => m.id));

/** Hours the "dynamic" mode considers night. */
const DARK_FROM = 19;
const DARK_UNTIL = 7;

const DARK_QUERY = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // No way to ask: keep the app's stock dark look rather than flashing light.
    return true;
  }
  return window.matchMedia(DARK_QUERY).matches;
}

/** Collapse the four settable modes into the two the CSS actually knows. */
export function resolveMode(mode: ThemeMode, now = new Date()): ResolvedMode {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  if (mode === "dynamic") {
    const hour = now.getHours();
    return hour >= DARK_FROM || hour < DARK_UNTIL ? "dark" : "light";
  }
  return prefersDark() ? "dark" : "light";
}

/** Paint the resolved theme onto the document root. */
export function applyTheme(scheme: ColorScheme, mode: ResolvedMode): void {
  if (typeof document === "undefined") {
    return;
  }
  // Two attributes are the whole switch: the stylesheet does the rest
  // (including `color-scheme` for native widgets and scrollbars).
  const root = document.documentElement;
  root.dataset.scheme = scheme;
  root.dataset.mode = mode;
  // The boot script (public/theme-boot.js) stamps `color-scheme` inline before
  // the bundle loads, and an inline style outranks the stylesheet — so it has to
  // be kept in step here or a runtime mode switch would leave native widgets and
  // scrollbars painted for the old mode.
  root.style.colorScheme = mode;

  // One read of the scheme's base surface feeds both host-chrome consumers
  // below, so neither can drift from what the stylesheet actually paints.
  const triple = baseSurfaceTriple(root);
  if (triple) {
    syncThemeColorMeta(triple);
    notifyHostBackground(tripleToHex(triple), mode);
  }
}

/**
 * The scheme's base surface (`--n-950`, what `bg-neutral-950` paints) as an
 * `"r g b"` triple, or null if it can't be read. Taken back off the DOM rather
 * than duplicating the palette in JS so it cannot drift from globals.css.
 */
function baseSurfaceTriple(root: HTMLElement): string | null {
  const triple = getComputedStyle(root).getPropertyValue("--n-950").trim();
  return /^\d{1,3} \d{1,3} \d{1,3}$/.test(triple) ? triple : null;
}

function tripleToHex(triple: string): string {
  const hex = triple
    .split(" ")
    .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

/**
 * Keep the PWA's `theme-color` (Android's address bar / task-switcher tint, and
 * the installed shell's chrome) on the scheme's own base surface. The static
 * `#111111` in index.html would leave a black bar above a light theme.
 */
function syncThemeColorMeta(triple: string): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = `rgb(${triple})`;
  }
}

/**
 * Optional desktop host bridge (apps/desktop/src/preload.cjs). The Electron
 * window's NATIVE background is chosen in the main process, before any renderer
 * code can run, so main can only paint the right colour at launch if the
 * renderer reports the resolved one for it to persist. Optional by design: the
 * web host injects no bridge and this is a silent no-op there.
 */
interface DesktopThemeHost {
  setWindowBackground?: (payload: { background: string; resolvedMode: ResolvedMode }) => void;
}

function notifyHostBackground(background: string, mode: ResolvedMode): void {
  if (typeof window === "undefined") {
    return;
  }
  const host = (window as unknown as { orquesterDesktop?: DesktopThemeHost }).orquesterDesktop;
  try {
    host?.setWindowBackground?.({ background, resolvedMode: mode });
  } catch {
    /* host chrome is cosmetic — a bridge failure must never break theming */
  }
}

/** Subscribe to whatever can change the resolved mode for the given setting. */
export function watchMode(mode: ThemeMode, onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  if (mode === "system") {
    const query = window.matchMedia(DARK_QUERY);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  if (mode === "dynamic") {
    // A minute is plenty: the only boundaries are the two hour marks above.
    const timer = window.setInterval(onChange, 60_000);
    return () => window.clearInterval(timer);
  }
  return () => undefined;
}

const STORAGE_KEY = "orquester:theme";

export interface ThemePrefs {
  scheme: ColorScheme;
  mode: ThemeMode;
}

/**
 * Load the persisted preference, field-validated (repo rule: raw JSON.parse
 * output never reaches typed code — a blob written by an older bundle, or an
 * unknown scheme id from a newer one, must degrade to the stock look rather
 * than stamping a `data-scheme` no stylesheet defines).
 */
export function loadThemePrefs(): ThemePrefs {
  const fallback: ThemePrefs = { scheme: DEFAULT_COLOR_SCHEME, mode: DEFAULT_THEME_MODE };
  try {
    if (typeof localStorage === "undefined") {
      return fallback;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fallback;
    }
    const rec = parsed as Record<string, unknown>;
    return {
      scheme:
        typeof rec.scheme === "string" && SCHEME_IDS.has(rec.scheme)
          ? (rec.scheme as ColorScheme)
          : fallback.scheme,
      mode:
        typeof rec.mode === "string" && MODE_IDS.has(rec.mode)
          ? (rec.mode as ThemeMode)
          : fallback.mode
    };
  } catch {
    return fallback;
  }
}

/** Persist the preference; a storage failure is non-fatal (in-memory only). */
export function saveThemePrefs(prefs: ThemePrefs): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota/availability errors — the theme stays in-memory only */
  }
}
