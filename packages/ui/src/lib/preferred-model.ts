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

import type { ModelSelection } from "@orquester/api/agent-chat";

/**
 * The whole last selection per agent — model AND its options (effort,
 * thinking, fast mode, ultracode…) — so a new chat opens exactly as the last
 * one was left (owner request 2026-09-22: "not have to pick Fable 5.1 /
 * effort high every time"). Written from the composer's own pickers as well
 * as the launcher chips. Loaded field-wise with a fallback (persisted-shape
 * rule): a blob from an older bundle must never reach typed code raw.
 */
const SELECTION_STORAGE_KEY = "orquester:preferred-model-selection-by-agent";

function sanitizeSelection(value: unknown): ModelSelection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model.length === 0) return null;
  const options: ModelSelection["options"] = [];
  if (Array.isArray(record.options)) {
    for (const option of record.options) {
      if (typeof option !== "object" || option === null) continue;
      const { id, value: optionValue } = option as Record<string, unknown>;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof optionValue !== "string" && typeof optionValue !== "boolean") continue;
      options.push({ id, value: optionValue });
    }
  }
  return { model: record.model, ...(options.length > 0 ? { options } : {}) };
}

export function loadPreferredModelSelections(): Record<string, ModelSelection> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, ModelSelection> = {};
    for (const [agent, value] of Object.entries(parsed as Record<string, unknown>)) {
      const selection = sanitizeSelection(value);
      if (agent.length > 0 && selection) result[agent] = selection;
    }
    return result;
  } catch {
    return {};
  }
}

export function savePreferredModelSelections(map: Record<string, ModelSelection>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota/availability errors — the selection stays in-memory only */
  }
}

/**
 * The selection a new chat launches with: the remembered options ride along
 * only when the remembered model is the one being launched — options are
 * per-model (an effort level Fable knows may not exist on Haiku).
 */
export function launchModelSelection(
  model: string,
  preferred: ModelSelection | undefined
): ModelSelection {
  if (preferred && preferred.model === model && preferred.options && preferred.options.length > 0) {
    return { model, options: preferred.options };
  }
  return { model };
}
