/** Client-local memory of the last backing model chosen per agent in the new-tab
 *  launcher (claudex/claudemix), so opening several tabs for the same launcher
 *  reuses the pick instead of falling back to the proxy default each time. */
const STORAGE_KEY = "orquester:preferred-model-by-agent";

/** Load the persisted per-agent model map (empty/safe on any failure). */
export function loadPreferredModels(): Record<string, string> {
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
    for (const [agent, model] of Object.entries(parsed)) {
      if (typeof model === "string") {
        result[agent] = model;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Persist the per-agent model map; a storage failure is non-fatal. */
export function savePreferredModels(map: Record<string, string>): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota/availability errors — the selection stays in-memory only */
  }
}
