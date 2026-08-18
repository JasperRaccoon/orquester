/**
 * Collapse state for the sidebar's "Opened Agents" section. Stored as the
 * literal "1"/"0" so the load is validated by construction — anything else
 * (including a stale payload from an old bundle) falls back to expanded.
 */
const STORAGE_KEY = "orquester:opened-agents-collapsed";

export function loadOpenedAgentsCollapsed(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the collapse choice; a storage failure is non-fatal. */
export function saveOpenedAgentsCollapsed(collapsed: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    }
  } catch {
    /* ignore quota/availability errors — the choice stays in-memory only */
  }
}
