/**
 * The Usage view's per-device preferences — its tab, range, the agents filtered
 * out and the breakdown table's grouping — in localStorage. Like the other
 * device-local prefs (`usage-display.ts`, `desktop-prefs.ts`): SSR-safe,
 * sanitized field by field on read (a bad field falls back alone), and writes
 * swallow storage errors.
 */

import type { UsageBreakdownMode, UsageRangeOption, UsageTab } from "../components/usage/types";

export interface UsageViewPrefs {
  tab: UsageTab;
  range: UsageRangeOption;
  hiddenAgents: string[];
  breakdown: UsageBreakdownMode;
}

const STORAGE_KEY = "orquester:usage-view";

export const USAGE_VIEW_PREFS_DEFAULT: Readonly<UsageViewPrefs> = Object.freeze({
  tab: "cost",
  range: "30d",
  hiddenAgents: [] as string[],
  breakdown: "model"
});

const TABS: readonly UsageTab[] = ["cost", "tokens", "limits"];
const RANGES: readonly UsageRangeOption[] = ["24h", "7d", "30d", "90d"];
const BREAKDOWNS: readonly UsageBreakdownMode[] = ["model", "period", "project"];

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function agentList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64);
  return [...new Set(ids)];
}

function sanitize(raw: unknown): UsageViewPrefs {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    tab: oneOf(TABS, record.tab, USAGE_VIEW_PREFS_DEFAULT.tab),
    range: oneOf(RANGES, record.range, USAGE_VIEW_PREFS_DEFAULT.range),
    hiddenAgents: agentList(record.hiddenAgents),
    breakdown: oneOf(BREAKDOWNS, record.breakdown, USAGE_VIEW_PREFS_DEFAULT.breakdown)
  };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved prefs, each field falling back to its default when missing or invalid. */
export function readUsageViewPrefs(): UsageViewPrefs {
  let raw: unknown = undefined;
  try {
    const text = storage()?.getItem(STORAGE_KEY);
    if (text) raw = JSON.parse(text);
  } catch {
    raw = undefined; // unreadable or corrupt JSON → defaults
  }
  return sanitize(raw);
}

export function writeUsageViewPrefs(prefs: UsageViewPrefs): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or unavailable — the choice stays in memory only */
  }
}
