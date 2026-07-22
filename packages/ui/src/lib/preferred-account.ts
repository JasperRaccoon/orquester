/** Client-local memory of the last account chosen per agent in the new-tab
 *  launcher, so opening several tabs for the same account doesn't re-prompt. */
const STORAGE_KEY = "orquester:preferred-account-by-agent";

/** Load the persisted per-agent account map (empty/safe on any failure). */
export function loadPreferredAccounts(): Record<string, string> {
  try {
    if (typeof localStorage === "undefined") {
      return {};
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [agent, id] of Object.entries(parsed)) {
      if (typeof id === "string") {
        result[agent] = id;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Persist the per-agent account map; a storage failure is non-fatal. */
export function savePreferredAccounts(map: Record<string, string>): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota/availability errors — the selection stays in-memory only */
  }
}
