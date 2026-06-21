/** Per-project main-view layout: one tab at a time vs all tabs in a grid. */
export type ViewMode = "tabs" | "grid";

const STORAGE_KEY = "orquester:view-mode-by-project";

/** Load the persisted per-project view-mode map (empty/safe on any failure). */
export function loadViewModes(): Record<string, ViewMode> {
  try {
    if (typeof localStorage === "undefined") {
      return {};
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, ViewMode> = {};
    for (const [path, mode] of Object.entries(parsed)) {
      if (mode === "tabs" || mode === "grid") {
        result[path] = mode;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Persist the per-project view-mode map; a storage failure is non-fatal. */
export function saveViewModes(map: Record<string, ViewMode>): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota/availability errors — view mode stays in-memory only */
  }
}
