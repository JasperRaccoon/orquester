/**
 * Resizable-panel sizes — client-local viewing preferences persisted per device
 * in localStorage. Mirrors the view-mode.ts / terminal-font.ts persistence mold:
 * SSR-safe (`typeof localStorage === "undefined"` guards), swallows storage
 * errors, validates and clamps on load. Deliberately NOT synced via the daemon's
 * app config — sizes are viewport-specific, so they stay per-device.
 *
 * Three independent stores:
 * - the sidebar width (a global scalar),
 * - per-project pane split widths (file tree / git list columns), and
 * - per-project grid-view track fraction weights.
 */

const SIDEBAR_KEY = "orquester:sidebar-width";
const PANE_SIZES_KEY = "orquester:pane-sizes-by-project";
const GRID_TRACKS_KEY = "orquester:grid-tracks-by-project";

/* ── Sidebar (global scalar px) ─────────────────────────────────────────── */

/** Default sidebar width (today's `w-64`). */
export const SIDEBAR_DEFAULT = 256;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;

/* ── Pane splits (per-project px widths) ────────────────────────────────── */

/**
 * The resizable pane split each project remembers independently:
 * - `fileTree` — the FileBrowser tree column (today's `md:w-64`).
 * - `gitChanges` — the git Changes list column (today's `md:w-72`).
 * - `gitHistoryCommits` — the git History commit-list column.
 * - `gitHistoryFiles` — the git History files-list column (nested split).
 */
export interface PaneSizes {
  fileTree?: number;
  gitChanges?: number;
  gitHistoryCommits?: number;
  gitHistoryFiles?: number;
}

/** A concrete pane-split key (`keyof PaneSizes` without the optional modifier). */
export type PaneSizeKey = "fileTree" | "gitChanges" | "gitHistoryCommits" | "gitHistoryFiles";

const PANE_KEYS: readonly PaneSizeKey[] = [
  "fileTree",
  "gitChanges",
  "gitHistoryCommits",
  "gitHistoryFiles"
];

export const PANE_MIN = 180;
export const PANE_MAX = 560;

/**
 * Width (px) a resized pane must leave for its flexible neighbour. On narrow
 * desktop viewports a fixed pane at its default/persisted width can exceed the
 * available row width and collapse the flexible pane (and its divider) out of
 * view; this reserve is the floor the flexible pane always keeps — enforced both
 * at drag time (clamp against the live container) and at render time (an inline
 * `maxWidth` guard on the pane). Kept here so the four seams share one constant.
 */
export const PANE_FLEX_RESERVE = 200;

/** Per-key default width: file tree matches `w-64`, the git panes `w-72`. */
export const PANE_DEFAULTS: Record<PaneSizeKey, number> = {
  fileTree: 256,
  gitChanges: 288,
  gitHistoryCommits: 288,
  gitHistoryFiles: 288
};

/* ── Grid tracks (per-project fraction weights) ─────────────────────────── */

/**
 * Positive fraction weights (analogous to `fr` units) for the grid-view column
 * and row tracks. The sum is arbitrary; consumers normalize at render. An entry
 * whose length no longer matches the current grid's column/row count is ignored
 * for rendering (grid falls back to uniform) but kept until the next drag.
 */
export interface GridTracks {
  cols: number[];
  rows: number[];
}

/** Minimum grid column width (px) enforced during a drag. */
export const GRID_MIN_COL_PX = 140;
/** Minimum grid row height (px) enforced during a drag. */
export const GRID_MIN_ROW_PX = 100;

/**
 * Upper bound on a single stored track weight. Weights are relative fractions
 * normalized at render, so their magnitude is meaningless — but an absurd finite
 * value (e.g. `1e308`) would overflow a track total to `Infinity`, making every
 * `weight/total` percent `NaN` and dropping the whole grid template. Reject any
 * array carrying a weight past this bound on load; normalize on every commit so
 * magnitudes can't creep up through repeated drags.
 */
const MAX_TRACK_WEIGHT = 1e6;

/**
 * Rescale each axis so its weights sum to the track count (mean 1, like `fr`
 * units). Scale-invariant for rendering (consumers divide by the total either
 * way), but it keeps persisted magnitudes bounded regardless of how many drags
 * accumulate. A non-finite/≤0 total falls back to uniform.
 */
export function normalizeGridTracks(tracks: GridTracks): GridTracks {
  return { cols: normalizeAxis(tracks.cols), rows: normalizeAxis(tracks.rows) };
}

function normalizeAxis(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return weights.map(() => 1);
  }
  const scale = weights.length / total;
  return weights.map((w) => w * scale);
}

/* ── Clamps ─────────────────────────────────────────────────────────────── */

/** Round to an integer px and clamp into the sidebar range. */
export function clampSidebarWidth(px: number): number {
  return clampInt(px, SIDEBAR_MIN, SIDEBAR_MAX);
}

/** Round to an integer px and clamp into the pane-split range. */
export function clampPaneSize(px: number): number {
  return clampInt(px, PANE_MIN, PANE_MAX);
}

/**
 * Clamp a proposed pane width to the pane range AND, when a live container
 * element is supplied, to `containerWidth - PANE_FLEX_RESERVE` so the flexible
 * neighbour always keeps a usable floor and its divider stays reachable. The
 * effective max never drops below `PANE_MIN` (a pane can't be dragged narrower
 * than its own minimum even on a tiny container).
 */
export function clampPaneWidth(px: number, container: HTMLElement | null): number {
  let max = PANE_MAX;
  if (container) {
    const avail = container.getBoundingClientRect().width - PANE_FLEX_RESERVE;
    if (Number.isFinite(avail)) {
      max = Math.min(max, Math.max(PANE_MIN, avail));
    }
  }
  return clampInt(px, PANE_MIN, max);
}

function clampInt(px: number, min: number, max: number): number {
  const rounded = Math.round(px);
  if (!Number.isFinite(rounded) || rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

/* ── Sidebar load/save ──────────────────────────────────────────────────── */

/** Load the persisted sidebar width (clamped), or the default on any failure. */
export function loadSidebarWidth(): number {
  try {
    if (typeof localStorage === "undefined") {
      return SIDEBAR_DEFAULT;
    }
    const raw = localStorage.getItem(SIDEBAR_KEY);
    if (!raw) {
      return SIDEBAR_DEFAULT;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return SIDEBAR_DEFAULT;
    }
    return clampSidebarWidth(parsed);
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

/** Persist the sidebar width; a storage failure is non-fatal (in-memory only). */
export function saveSidebarWidth(px: number): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(SIDEBAR_KEY, String(px));
  } catch {
    /* ignore quota/availability errors — width stays in-memory only */
  }
}

/* ── Pane-sizes load/save ───────────────────────────────────────────────── */

/** Load the per-project pane-split map (empty/safe on any failure). */
export function loadPaneSizes(): Record<string, PaneSizes> {
  try {
    if (typeof localStorage === "undefined") {
      return {};
    }
    const raw = localStorage.getItem(PANE_SIZES_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, PaneSizes> = {};
    for (const [path, value] of Object.entries(parsed)) {
      const sizes = validatePaneSizes(value);
      if (sizes) {
        result[path] = sizes;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Keep only finite, positive, clamped per-key widths; drop everything else. */
function validatePaneSizes(value: unknown): PaneSizes | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sizes: PaneSizes = {};
  for (const key of PANE_KEYS) {
    const n = record[key];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
      sizes[key] = clampPaneSize(n);
    }
  }
  return Object.keys(sizes).length > 0 ? sizes : null;
}

/** Persist the pane-split map; a storage failure is non-fatal. */
export function savePaneSizes(map: Record<string, PaneSizes>): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(PANE_SIZES_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota/availability errors — sizes stay in-memory only */
  }
}

/**
 * Read-merge-write a single pane-split field. Re-loading the freshest map from
 * localStorage before writing means one tab committing (say) `gitChanges` can't
 * clobber another tab's just-persisted `fileTree` for the same project — each
 * tab's in-memory map is stale w.r.t. the other's writes, so a whole-map write
 * would drop them. Same error-swallowing contract as the other save helpers.
 */
export function persistPaneSize(projectPath: string, key: PaneSizeKey, px: number): void {
  const map = loadPaneSizes();
  map[projectPath] = { ...map[projectPath], [key]: clampPaneSize(px) };
  savePaneSizes(map);
}

/** Read-merge-write the removal of a single pane-split field (see persistPaneSize). */
export function persistPaneSizeReset(projectPath: string, key: PaneSizeKey): void {
  const map = loadPaneSizes();
  const entry = { ...map[projectPath] };
  delete entry[key];
  if (Object.keys(entry).length === 0) {
    delete map[projectPath];
  } else {
    map[projectPath] = entry;
  }
  savePaneSizes(map);
}

/* ── Grid-tracks load/save ──────────────────────────────────────────────── */

/** Load the per-project grid-track map (empty/safe on any failure). */
export function loadGridTracks(): Record<string, GridTracks> {
  try {
    if (typeof localStorage === "undefined") {
      return {};
    }
    const raw = localStorage.getItem(GRID_TRACKS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, GridTracks> = {};
    for (const [path, value] of Object.entries(parsed)) {
      const tracks = validateGridTracks(value);
      if (tracks) {
        result[path] = tracks;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Both `cols` and `rows` must be arrays of positive finite numbers, else drop. */
function validateGridTracks(value: unknown): GridTracks | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const cols = validateTrackArray(record.cols);
  const rows = validateTrackArray(record.rows);
  if (!cols || !rows) {
    return null;
  }
  return { cols, rows };
}

function validateTrackArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: number[] = [];
  for (const n of value) {
    // Reject non-positive/non-finite AND absurdly large weights: a value near
    // Number.MAX_VALUE keeps the array "valid" yet overflows the total to
    // Infinity at render (→ NaN% offsets → a broken grid that persists).
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > MAX_TRACK_WEIGHT) {
      return null;
    }
    out.push(n);
  }
  if (out.length === 0) {
    return null;
  }
  // Belt-and-suspenders: the total must stay finite for `weight/total` to hold.
  const total = out.reduce((a, b) => a + b, 0);
  return Number.isFinite(total) ? out : null;
}

/** Persist the grid-track map; a storage failure is non-fatal. */
export function saveGridTracks(map: Record<string, GridTracks>): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(GRID_TRACKS_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota/availability errors — tracks stay in-memory only */
  }
}

/**
 * Read-merge-write one project's grid tracks (normalized). Re-loads the freshest
 * map first so a commit from one tab can't clobber another tab's entry for a
 * different project (see persistPaneSize).
 */
export function persistGridTracks(projectPath: string, tracks: GridTracks): void {
  const map = loadGridTracks();
  map[projectPath] = normalizeGridTracks(tracks);
  saveGridTracks(map);
}

/** Read-merge-write the removal of one project's grid tracks (see persistGridTracks). */
export function persistGridTracksReset(projectPath: string): void {
  const map = loadGridTracks();
  delete map[projectPath];
  saveGridTracks(map);
}

/* ── Browser DevTools split (global width fraction) ─────────────────────── */

/**
 * Width of the DevTools dock as a fraction of the browser tab's row. A global
 * scalar (not per-project): DevTools wants roughly the same share everywhere,
 * and the fraction adapts to any container width. Same persistence contract
 * as the stores above: SSR-safe, error-swallowing, validated + clamped on load.
 */
const DEVTOOLS_SPLIT_KEY = "orquester:devtools-split";

export const DEVTOOLS_SPLIT_DEFAULT = 0.45;
export const DEVTOOLS_SPLIT_MIN = 0.2;
export const DEVTOOLS_SPLIT_MAX = 0.8;

/** Clamp into the split range; non-finite input falls back to the default. */
export function clampDevtoolsSplit(fraction: number): number {
  if (!Number.isFinite(fraction)) {
    return DEVTOOLS_SPLIT_DEFAULT;
  }
  return Math.min(DEVTOOLS_SPLIT_MAX, Math.max(DEVTOOLS_SPLIT_MIN, fraction));
}

/** Load the persisted split fraction (clamped), or the default on any failure. */
export function loadDevtoolsSplit(): number {
  try {
    if (typeof localStorage === "undefined") {
      return DEVTOOLS_SPLIT_DEFAULT;
    }
    const raw = localStorage.getItem(DEVTOOLS_SPLIT_KEY);
    if (!raw) {
      return DEVTOOLS_SPLIT_DEFAULT;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      return DEVTOOLS_SPLIT_DEFAULT;
    }
    return clampDevtoolsSplit(parsed);
  } catch {
    return DEVTOOLS_SPLIT_DEFAULT;
  }
}

/** Persist the split fraction; a storage failure is non-fatal. */
export function persistDevtoolsSplit(fraction: number): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(DEVTOOLS_SPLIT_KEY, String(clampDevtoolsSplit(fraction)));
  } catch {
    /* ignore quota/availability errors — the split stays in-memory only */
  }
}
