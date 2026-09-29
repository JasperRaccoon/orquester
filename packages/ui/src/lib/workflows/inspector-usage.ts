/**
 * The agent inspector's account list (workflows spec §5.2, §7.2): each managed
 * account of a chain entry's family — and the System login — with the usage
 * windows the Settings usage overview reads, joined by account id, so the
 * account policy editor shows live 5h / weekly / scoped bars beside the
 * allow-list the engine will filter — and the allow-list edits themselves,
 * written the way the engine reads them.
 *
 * Pure: the caller passes the app store's `usage` and `agentAccounts`.
 */

import type { AccountPolicy, AgentAccount, AgentUsage, UsageAccount, UsageResponse, UsageWindow } from "@orquester/api";

/** The managed-account families (the agent-accounts store); every other agent (OpenCode) has none. */
const ACCOUNT_FAMILIES: ReadonlySet<string> = new Set(["claude", "codex", "grok"]);

export const SYSTEM_ACCOUNT_ID = "system";

/** The managed-account family a registry agent draws from; null when it has no accounts. */
export function accountFamily(agent: string): string | null {
  return ACCOUNT_FAMILIES.has(agent) ? agent : null;
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

// ---------------------------------------------------------------------------
// The allow-list (`AccountPolicy.accounts`), as the engine reads it
// ---------------------------------------------------------------------------
//
// The engine (daemon `workflows/agent/select.ts`): a NON-EMPTY list filters the
// family's accounts and, for `fixed`, orders them; an entry matches an account
// id, else an account label (trimmed, case-insensitive); "system" names the
// System login; an entry naming nothing is skipped. No list (or an empty one) =
// every account, in the family's order. `includeSystem` adds the System login
// after the others unless the list already names it. So an empty list can never
// be written for "none": it would mean "all".

/** A managed account as the allow-list matches it: by id, else by its own label. */
export interface AllowListAccount {
  id: string;
  label: string;
}

export interface AllowListView {
  /** The accounts it may use, in the engine's order (ids; "system" for the System login). */
  candidates: string[];
  /** List entries that name no account of the family (the engine skips them). */
  missing: string[];
  /** A non-empty list is set. */
  explicit: boolean;
}

/** The fields an allow-list edit writes; `accounts: undefined` removes the list. */
export type AllowListPatch = { accounts: string[] | undefined; includeSystem: boolean };

type AllowListPolicy = Pick<AccountPolicy, "accounts" | "includeSystem">;

const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Who a policy lets run, in order, and the entries that name nobody. */
export function allowListView(policy: AllowListPolicy, managed: readonly AllowListAccount[]): AllowListView {
  const list = policy.accounts ?? [];
  if (list.length === 0) {
    return { candidates: [...managed.map((account) => account.id), ...(policy.includeSystem ? [SYSTEM_ACCOUNT_ID] : [])], missing: [], explicit: false };
  }
  const candidates: string[] = [];
  const missing: string[] = [];
  for (const wanted of list) {
    const id =
      wanted === SYSTEM_ACCOUNT_ID
        ? SYSTEM_ACCOUNT_ID
        : (managed.find((account) => account.id === wanted) ?? managed.find((account) => sameLabel(account.label, wanted)))?.id;
    if (id === undefined) {
      if (!missing.includes(wanted)) missing.push(wanted);
    } else if (!candidates.includes(id)) {
      candidates.push(id);
    }
  }
  if (policy.includeSystem && !candidates.includes(SYSTEM_ACCOUNT_ID)) candidates.push(SYSTEM_ACCOUNT_ID);
  return { candidates, missing, explicit: true };
}

/**
 * The patch that makes `candidates` (in this order) the accounts it may use,
 * keeping `missing` entries (dropping them is the owner's call). No list when
 * it would say the same as none (every account; for fixed also in the family's
 * order). Null when the only way to write it is an empty list, which the engine
 * reads as "every account".
 */
function writeCandidates(
  candidates: readonly string[],
  missing: readonly string[],
  managed: readonly AllowListAccount[],
  strategy: AccountPolicy["strategy"]
): AllowListPatch | null {
  const system = candidates.includes(SYSTEM_ACCOUNT_ID);
  const managedIds = managed.map((account) => account.id);
  const defaultOrder = [...managedIds, ...(system ? [SYSTEM_ACCOUNT_ID] : [])];
  const coversAll = managedIds.every((id) => candidates.includes(id));
  const inDefaultOrder = candidates.length === defaultOrder.length && candidates.every((id, index) => id === defaultOrder[index]);
  if (missing.length === 0 && coversAll && (strategy !== "fixed" || inDefaultOrder)) {
    return { accounts: undefined, includeSystem: system };
  }
  // Order matters only for fixed; elsewhere the System login sits last, as the rows show it.
  const ordered = strategy === "fixed" ? [...candidates] : [...candidates.filter((id) => id !== SYSTEM_ACCOUNT_ID), ...(system ? [SYSTEM_ACCOUNT_ID] : [])];
  const accounts = [...ordered, ...missing];
  if (accounts.length === 0) return null;
  // A list of missing entries only lets nobody run; so does no candidate at all when there are accounts.
  if (ordered.length === 0 && managedIds.length > 0) return null;
  return { accounts, includeSystem: system };
}

/** Allow or disallow one managed account; null when it is the last one allowed. */
export function toggleAllowedAccount(
  policy: AllowListPolicy,
  managed: readonly AllowListAccount[],
  strategy: AccountPolicy["strategy"],
  id: string
): AllowListPatch | null {
  const view = allowListView(policy, managed);
  const next = view.candidates.includes(id) ? view.candidates.filter((entry) => entry !== id) : [...view.candidates, id];
  if (next.length === 0 && managed.length > 0) return null;
  return writeCandidates(next, view.missing, managed, strategy);
}

/** Add or remove the System login; null when it is the only account allowed. */
export function setSystemAllowed(
  policy: AllowListPolicy,
  managed: readonly AllowListAccount[],
  strategy: AccountPolicy["strategy"],
  on: boolean
): AllowListPatch | null {
  const view = allowListView(policy, managed);
  const has = view.candidates.includes(SYSTEM_ACCOUNT_ID);
  if (on === has) return { accounts: policy.accounts, includeSystem: on };
  if (!view.explicit) return { accounts: policy.accounts, includeSystem: on };
  const next = on ? [...view.candidates, SYSTEM_ACCOUNT_ID] : view.candidates.filter((entry) => entry !== SYSTEM_ACCOUNT_ID);
  if (next.length === 0 && managed.length > 0) return null;
  return writeCandidates(next, view.missing, managed, strategy);
}

/** Fixed order: move one allowed account up (-1) or down (+1). Null when it can't move. */
export function moveAllowedAccount(
  policy: AllowListPolicy,
  managed: readonly AllowListAccount[],
  id: string,
  delta: number
): AllowListPatch | null {
  const view = allowListView(policy, managed);
  const from = view.candidates.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= view.candidates.length) return null;
  const next = [...view.candidates];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return writeCandidates(next, view.missing, managed, "fixed");
}

/** Allow every managed account (fixed: the newly allowed ones after the current order). */
export function allowAllAccounts(
  policy: AllowListPolicy,
  managed: readonly AllowListAccount[],
  strategy: AccountPolicy["strategy"]
): AllowListPatch | null {
  const view = allowListView(policy, managed);
  const next = [...view.candidates, ...managed.map((account) => account.id).filter((id) => !view.candidates.includes(id))];
  return writeCandidates(next, view.missing, managed, strategy);
}

/** Drop the entries that name no account. */
export function dropMissingAccounts(
  policy: AllowListPolicy,
  managed: readonly AllowListAccount[],
  strategy: AccountPolicy["strategy"]
): AllowListPatch | null {
  const view = allowListView(policy, managed);
  return writeCandidates(view.candidates, [], managed, strategy);
}

/**
 * The policy after a strategy change. Leaving fixed order drops a list that
 * allows every account (it only ordered them); entering it keeps the list.
 */
export function withStrategy<P extends AccountPolicy>(policy: P, managed: readonly AllowListAccount[], strategy: AccountPolicy["strategy"]): P {
  if (strategy === "fixed" || !policy.accounts || policy.accounts.length === 0) return { ...policy, strategy };
  const view = allowListView(policy, managed);
  const patch = writeCandidates(view.candidates, view.missing, managed, strategy);
  return patch ? { ...policy, strategy, ...patch } : { ...policy, strategy };
}

/** One scoped-limit row: a rule of `policy.scoped` (by index), or a window the usage reports that has none. */
export interface ScopedLimitRow {
  label: string;
  ruleIndex: number | null;
}

/**
 * The scoped-limit rows: per window label the usage reports, its rules (a label
 * may carry several, e.g. one per model list) or one empty row; then the rules
 * for labels the usage does not report (yet). Labels match as the engine
 * matches them: trimmed, case-insensitive.
 */
export function scopedLimitRows(scoped: AccountPolicy["scoped"], usageLabels: readonly string[]): ScopedLimitRow[] {
  const rules = scoped ?? [];
  const rows: ScopedLimitRow[] = [];
  const used = new Set<number>();
  const seen: string[] = [];
  for (const label of usageLabels) {
    if (seen.some((other) => sameLabel(other, label))) continue;
    seen.push(label);
    const matching = rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => sameLabel(rule.label, label));
    if (matching.length === 0) rows.push({ label, ruleIndex: null });
    for (const { rule, index } of matching) {
      used.add(index);
      rows.push({ label: rule.label, ruleIndex: index });
    }
  }
  rules.forEach((rule, index) => {
    if (!used.has(index)) rows.push({ label: rule.label, ruleIndex: index });
  });
  return rows;
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
