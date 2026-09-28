/**
 * The agent inspector's account list (workflows spec §5.2, §7.2): each managed
 * account of a chain entry's family — and the System login — with the usage
 * windows the Settings usage overview reads, joined by account id, so the
 * account policy editor shows live 5h / weekly / scoped bars beside the
 * allow-list the engine will filter.
 *
 * Pure: the caller passes the app store's `usage` and `agentAccounts`.
 */

import type { AgentAccount, AgentUsage, UsageAccount, UsageResponse, UsageWindow } from "@orquester/api";

/** Launchers whose accounts are another family's (seeded into the model proxy). */
const PROXY_FAMILY: Record<string, string> = { claudex: "codex", claudemix: "claude" };

/** Agents with no per-thread account at all. */
const ACCOUNTLESS: ReadonlySet<string> = new Set(["opencode"]);

export const SYSTEM_ACCOUNT_ID = "system";

/** The managed-account family a registry agent draws from; null when it has no accounts. */
export function accountFamily(agent: string): string | null {
  if (ACCOUNTLESS.has(agent)) return null;
  return PROXY_FAMILY[agent] ?? agent;
}

export interface UsageBar {
  label: string;
  percent: number;
  resetsAt?: string;
}

export interface AccountUsageRow {
  id: string;
  label: string;
  needsReauth: boolean;
  isSystem: boolean;
  session: UsageBar | null;
  weekly: UsageBar | null;
  scoped: UsageBar[];
  /** No reading, an unavailable source, or a stale one. */
  unknown: boolean;
  asOf?: string;
}

function current(window: UsageWindow | null | undefined, now: number): UsageWindow | null {
  if (!window) return null;
  if (window.resetsAt) {
    const reset = Date.parse(window.resetsAt);
    // An expired window says nothing about now (the engine's `currentWindow` rule).
    if (!Number.isNaN(reset) && reset <= now) return null;
  }
  return window;
}

function bar(label: string, window: UsageWindow | null): UsageBar | null {
  if (!window) return null;
  return window.resetsAt ? { label, percent: window.percent, resetsAt: window.resetsAt } : { label, percent: window.percent };
}

function readingOf(entry: UsageAccount | AgentUsage | undefined, now: number): Omit<AccountUsageRow, "id" | "label" | "needsReauth" | "isSystem"> {
  if (!entry) return { session: null, weekly: null, scoped: [], unknown: true };
  const session = bar("5h", current(entry.session, now));
  const weekly = bar("Week", current(entry.weekly, now));
  const scoped = (entry.scopedWindows ?? [])
    .map((window) => bar(window.label, current(window, now)))
    .filter((value): value is UsageBar => value !== null);
  const unknown = !entry.available || entry.stale || (session === null && weekly === null && scoped.length === 0);
  return { session, weekly, scoped, unknown, ...(entry.asOf ? { asOf: entry.asOf } : {}) };
}

/**
 * The accounts of `family` (managed ones, then System when asked), each with
 * its usage. `family` is `accountFamily(agent)`.
 */
export function accountUsageRows(input: {
  family: string;
  accounts: readonly AgentAccount[] | undefined;
  usage: UsageResponse | null | undefined;
  includeSystem: boolean;
  now: number;
}): AccountUsageRow[] {
  const agentUsage = input.usage?.agents.find((agent) => agent.id === input.family);
  const managed = (input.accounts ?? []).filter((account) => account.agent === input.family);
  const rows: AccountUsageRow[] = managed.map((account) => ({
    id: account.id,
    label: account.label || account.email || account.id,
    needsReauth: account.needsReauth,
    isSystem: false,
    ...readingOf(agentUsage?.accounts?.find((entry) => entry.id === account.id), input.now)
  }));
  if (input.includeSystem) {
    // With no managed accounts the family head IS the system login's reading.
    const system = agentUsage?.system ?? (managed.length === 0 ? agentUsage : undefined);
    rows.push({ id: SYSTEM_ACCOUNT_ID, label: "System login", needsReauth: false, isSystem: true, ...readingOf(system, input.now) });
  }
  return rows;
}

/** The scoped window labels a family reports ("Fable"), for the scoped threshold sliders. */
export function scopedWindowLabels(usage: UsageResponse | null | undefined, family: string): string[] {
  const agentUsage = usage?.agents.find((agent) => agent.id === family);
  const labels = new Set<string>();
  for (const window of agentUsage?.scopedWindows ?? []) labels.add(window.label);
  for (const account of agentUsage?.accounts ?? []) for (const window of account.scopedWindows ?? []) labels.add(window.label);
  for (const window of agentUsage?.system?.scopedWindows ?? []) labels.add(window.label);
  return [...labels];
}

/** "4d 2h", "3h 10m", "12m", "now" — until `iso`. */
export function formatResetIn(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** The colour step of a usage percentage, the Settings overview's (`--usage-*`). */
export function usageTone(percent: number): "ok" | "med" | "high" | "crit" {
  if (percent >= 90) return "crit";
  if (percent >= 75) return "high";
  if (percent >= 50) return "med";
  return "ok";
}
