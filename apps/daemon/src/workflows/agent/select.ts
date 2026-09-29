// Automated workflows — which agent and account an agent block runs on (spec §5.2).
//
// Pure: everything it reads is handed in (the in-memory usage snapshot, the managed accounts, the
// active cooldowns, the clock), so the editor's "Who would run now?"
// (`POST /api/workflows/account-preview`), the first selection of a block and every failover hop
// (§5.4) decide by the same function.
//
// The owner's invariant (§5.4): a usage limit never stops a workflow while an eligible account
// remains. Selection therefore never refuses a candidate for NOT KNOWING its usage — unknown usage
// is tried last unless the policy says `unknownUsage: "exclude"` — and when nothing is eligible it
// says when the earliest candidate frees up (`earliestResetAt`), so `wait-for-reset` can wait
// exactly that long.
//
// Rules, per chain entry in order (the first entry with an eligible candidate wins):
//   1. Family = `accountFamilyOf(refId)`. No family (opencode) → ONE candidate, "system", subject
//      only to its cooldown.
//   2. Candidates = the family's managed accounts (+ "system" when `includeSystem`, or when the
//      allow-list names it). An allow-list (`accounts`) filters and, for `fixed`, orders them; it
//      matches an account id, else a label.
//   3. Dropped: needs re-auth, cooling down, already tried in this block (`exclude`),
//      over a threshold. Usage is joined BY ACCOUNT ID (`agents[family].accounts[]`; "system" →
//      `.system`, or the family's head row when it has no managed accounts), every window through
//      `currentWindow` (an expired window is the quota refilled, never a reading). `percent ≥ 100`
//      is always burnt. A window that is absent is not a threshold breach (Grok has no 5h window).
//      No row, `available: false`, or a reading older than 20 minutes → unknown usage.
//   4. Ranked: least-used by the metric ascending (ties: soonest weekly reset, then label);
//      soonest-reset by the chosen window's reset ascending (unknown resets last; ties: label);
//      fixed by the allow-list order. Unknown usage after every known one (or dropped).

import {
  SYSTEM_ACCOUNT_ID,
  type AccountSelectionChoice,
  type AccountSelectionDecision,
  type AccountSkip,
  type AgentAccount,
  type AgentAccountsResponse,
  type AgentUsage,
  type ScopedUsageWindow,
  type UsageAccount,
  type UsageResponse,
  type UsageWindow
} from "@orquester/api";
import type { AccountCooldown, AccountPolicy, AgentChainEntry } from "@orquester/config";
import { currentWindow } from "../../usage-parse.ts";
import { accountFamilyOf, cooldownKey, cooldownSubject } from "./families.ts";

/** A usage reading older than this is unknown (the usage service polls every 5 minutes). */
const DEFAULT_USAGE_STALE_AFTER_MS = 20 * 60_000;

export interface SelectAccountInput {
  chain: AgentChainEntry[];
  usage: UsageResponse;
  accounts: AgentAccountsResponse;
  /** Active cooldowns keyed by `cooldownSubject` (`CooldownStore.list()`); expired ones are ignored anyway. */
  cooldowns: Record<string, AccountCooldown>;
  now: Date;
  /** `cooldownSubject` keys already tried in this block (`cooldownKey`). */
  exclude?: Set<string>;
  /** Consider only this chain entry (the in-session account switch). */
  onlyChainIndex?: number;
}

type ResolvedPolicy = Required<Pick<AccountPolicy, "strategy" | "includeSystem" | "soonestResetWindow" | "leastUsedMetric" | "unknownUsage">> &
  Pick<AccountPolicy, "accounts" | "maxSessionPct" | "maxWeeklyPct" | "scoped">;

/** Fills the schema's defaults, for a chain entry that did not go through the zod parse (a preview body). */
function resolvePolicy(policy: Partial<AccountPolicy> | undefined): ResolvedPolicy {
  const p = policy ?? {};
  return {
    strategy: p.strategy ?? "least-used",
    includeSystem: p.includeSystem ?? false,
    soonestResetWindow: p.soonestResetWindow ?? "weekly",
    leastUsedMetric: p.leastUsedMetric ?? "max",
    unknownUsage: p.unknownUsage ?? "last",
    ...(p.accounts ? { accounts: p.accounts } : {}),
    ...(p.maxSessionPct !== undefined ? { maxSessionPct: p.maxSessionPct } : {}),
    ...(p.maxWeeklyPct !== undefined ? { maxWeeklyPct: p.maxWeeklyPct } : {}),
    ...(p.scoped ? { scoped: p.scoped } : {})
  };
}

// ---------------------------------------------------------------------------
// Usage join
// ---------------------------------------------------------------------------

interface UsageReading {
  known: boolean;
  /** Why the usage is unknown, e.g. "no usage reading", "usage reading is 34m old". */
  unknownWhy?: string;
  asOf?: string;
  /** Current windows only (expired ones are null / left out). */
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  scoped: ScopedUsageWindow[];
}

type UsageSource = Pick<UsageAccount | AgentUsage, "available" | "stale" | "session" | "weekly" | "scopedWindows" | "asOf">;

/**
 * The usage row describing one account: a managed account's own row by id; "system" → the family's
 * `system` row, or its head row when the family has no managed accounts (the head IS the system
 * login's reading then). `hasManagedAccounts` defaults to what the usage row says (the worst-account
 * aggregate is built only when managed accounts exist).
 */
function usageSourceFor(usage: UsageResponse, family: string, accountId: string, hasManagedAccounts?: boolean): UsageSource | undefined {
  const row = usage.agents.find((agent) => agent.id === family);
  if (!row) return undefined;
  if (accountId === SYSTEM_ACCOUNT_ID) {
    if (row.system) return row.system;
    const managed = hasManagedAccounts ?? row.aggregate !== undefined;
    return managed ? undefined : row;
  }
  return row.accounts?.find((account) => account.id === accountId);
}

function readUsage(
  usage: UsageResponse,
  family: string,
  accountId: string,
  opts: { now: Date; hasManagedAccounts?: boolean }
): UsageReading {
  const nowMs = opts.now.getTime();
  const empty = { session: null, weekly: null, scoped: [] };
  const source = usageSourceFor(usage, family, accountId, opts.hasManagedAccounts);
  if (!source) return { known: false, unknownWhy: "no usage reading", ...empty };
  const asOf = source.asOf;
  const base = { ...(asOf ? { asOf } : {}) };
  if (!source.available) return { known: false, unknownWhy: "usage unavailable", ...base, ...empty };
  const asOfMs = asOf ? Date.parse(asOf) : Number.NaN;
  if (Number.isFinite(asOfMs)) {
    const age = nowMs - asOfMs;
    if (age > DEFAULT_USAGE_STALE_AFTER_MS) {
      return { known: false, unknownWhy: `usage reading is ${formatDuration(age)} old`, ...base, ...empty };
    }
  } else if (source.stale) {
    return { known: false, unknownWhy: "usage reading is stale", ...base, ...empty };
  }
  return {
    known: true,
    ...base,
    session: currentWindow(source.session, nowMs),
    weekly: currentWindow(source.weekly, nowMs),
    scoped: (source.scopedWindows ?? []).filter((window) => currentWindow(window, nowMs) !== null)
  };
}

/**
 * The reset of an account's burnt windows (`percent ≥ 100`) in the usage snapshot — the latest of
 * them, since the account frees only when every one has reset. Undefined when no current window is
 * burnt or a burnt one names no reset. The cooldown's second choice (§5.4 step 1).
 */
export function burntWindowResetAt(input: {
  usage: UsageResponse;
  family: string;
  accountId: string;
  now: Date;
  hasManagedAccounts?: boolean;
}): string | undefined {
  const source = usageSourceFor(input.usage, input.family, input.accountId, input.hasManagedAccounts);
  if (!source) return undefined;
  const nowMs = input.now.getTime();
  const windows = [source.session, source.weekly, ...(source.scopedWindows ?? [])]
    .map((window) => currentWindow(window ?? null, nowMs))
    .filter((window): window is UsageWindow => window !== null && window.percent >= 100);
  if (windows.length === 0) return undefined;
  let latest: number | undefined;
  for (const window of windows) {
    const t = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (!Number.isFinite(t)) return undefined;
    latest = latest === undefined ? t : Math.max(latest, t);
  }
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

interface Blocker {
  text: string;
  resetsAt?: string;
}

const pct = (value: number): string => `${Math.round(value)}%`;
const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every threshold a known reading breaks for this model (empty = within policy). */
function thresholdBlockers(reading: UsageReading, policy: ResolvedPolicy, model: string): Blocker[] {
  const blockers: Blocker[] = [];
  const check = (name: string, window: UsageWindow | null, max: number | undefined): void => {
    if (!window) return;
    const at = window.resetsAt ? { resetsAt: window.resetsAt } : {};
    if (max !== undefined && window.percent >= max) blockers.push({ text: `${name} ${pct(window.percent)} ≥ ${pct(max)}`, ...at });
    else if (window.percent >= 100) blockers.push({ text: `${name} ${pct(window.percent)} (limit reached)`, ...at });
  };
  check("session", reading.session, policy.maxSessionPct);
  check("weekly", reading.weekly, policy.maxWeeklyPct);
  const modelLower = model.toLowerCase();
  for (const window of reading.scoped) {
    const at = window.resetsAt ? { resetsAt: window.resetsAt } : {};
    const rules = (policy.scoped ?? []).filter((rule) => sameLabel(rule.label, window.label));
    const applicable = rules.filter((rule) => !rule.onlyForModels || rule.onlyForModels.includes(model));
    const breached = applicable.find((rule) => window.percent >= rule.maxPct);
    if (breached) {
      blockers.push({ text: `${window.label} ${pct(window.percent)} ≥ ${pct(breached.maxPct)}`, ...at });
      continue;
    }
    // A burnt scoped window stops only the models it covers: the ones a rule names for it, else a
    // model whose id carries the scope's name (Claude's "Fable" cap and its fable models).
    const covers = rules.some((rule) => rule.onlyForModels?.includes(model)) || modelLower.includes(window.label.trim().toLowerCase());
    if (covers && window.percent >= 100) blockers.push({ text: `${window.label} ${pct(window.percent)} (limit reached)`, ...at });
  }
  return blockers;
}

/** When every blocker has reset (the latest reset), or undefined when one names none. */
function freedAt(blockers: Blocker[]): number | undefined {
  let latest: number | undefined;
  for (const blocker of blockers) {
    const t = blocker.resetsAt ? Date.parse(blocker.resetsAt) : Number.NaN;
    if (!Number.isFinite(t)) return undefined;
    latest = latest === undefined ? t : Math.max(latest, t);
  }
  return latest;
}

// ---------------------------------------------------------------------------
// One chain entry
// ---------------------------------------------------------------------------

interface RankedCandidate {
  accountId: string;
  label?: string;
  /** The key family (`cooldownSubject(...).family`): the account family, or the refId when accountless. */
  family: string;
  /** "none" = an accountless launch (no usage applies). */
  usage: "known" | "unknown" | "none";
  reading?: UsageReading;
  /** The human-readable reason it would be chosen. */
  reason: string;
}

interface ChainEntryEvaluation {
  chainIndex: number;
  entry: AgentChainEntry;
  family: string;
  /** Best first. */
  ranked: RankedCandidate[];
  skipped: AccountSkip[];
  /** The earliest instant (ms) a skipped candidate frees up, when any names one. */
  earliestFreeAt?: number;
}

interface Candidate {
  accountId: string;
  label?: string;
  account?: AgentAccount;
  /** Position in the allow-list (fixed order), else in the family list. */
  order: number;
}

function rankChainEntry(input: SelectAccountInput, chainIndex: number): ChainEntryEvaluation {
  const entry = input.chain[chainIndex]!;
  const policy = resolvePolicy(entry.accounts);
  const now = input.now;
  const nowMs = now.getTime();
  const accountFamily = accountFamilyOf(entry.agent);
  const family = accountFamily ?? entry.agent;
  const keyOf = (accountId: string): string => {
    const subject = cooldownSubject(entry.agent, entry.model, accountId);
    return cooldownKey(subject.family, subject.account);
  };
  const skipped: AccountSkip[] = [];
  let earliestFreeAt: number | undefined;
  const freesAt = (t: number | undefined): void => {
    if (t === undefined || !Number.isFinite(t) || t <= nowMs) return;
    earliestFreeAt = earliestFreeAt === undefined ? t : Math.min(earliestFreeAt, t);
  };
  const skip = (candidate: Pick<Candidate, "accountId" | "label">, why: AccountSkip["why"], detail: string): void => {
    skipped.push({ agent: entry.agent, accountId: candidate.accountId, ...(candidate.label ? { label: candidate.label } : {}), why, detail });
  };
  // Cooldown, then "already tried": true when the candidate is out.
  const cooledOrTried = (candidate: Candidate): boolean => {
    const key = keyOf(candidate.accountId);
    const cooldown = input.cooldowns[key];
    const until = cooldown ? Date.parse(cooldown.until) : Number.NaN;
    if (cooldown && Number.isFinite(until) && until > nowMs) {
      const cause = cooldown.reason === "auth" ? "sign-in failed" : "usage limit";
      skip(candidate, "cooldown", `${cause} — cooling down until ${new Date(until).toISOString()} (in ${formatDuration(until - nowMs)})`);
      freesAt(until);
      return true;
    }
    if (input.exclude?.has(key)) {
      skip(candidate, "unavailable", "already tried in this block");
      return true;
    }
    return false;
  };

  if (accountFamily === null) {
    const system: Candidate = { accountId: SYSTEM_ACCOUNT_ID, label: "System", order: 0 };
    const ranked: RankedCandidate[] = [];
    if (!cooledOrTried(system)) {
      ranked.push({ accountId: SYSTEM_ACCOUNT_ID, label: "System", family, usage: "none", reason: `${entry.agent}: has no managed accounts — runs on the system login` });
    }
    return { chainIndex, entry, family, ranked, skipped, ...(earliestFreeAt !== undefined ? { earliestFreeAt } : {}) };
  }

  // Candidates, in allow-list order when there is one.
  const managed = input.accounts.accounts.filter((account) => account.agent === accountFamily);
  const systemCandidate = (order: number): Candidate => ({ accountId: SYSTEM_ACCOUNT_ID, label: "System", order });
  let candidates: Candidate[];
  if (policy.accounts && policy.accounts.length > 0) {
    candidates = [];
    const seen = new Set<string>();
    policy.accounts.forEach((wanted, order) => {
      if (wanted === SYSTEM_ACCOUNT_ID) {
        if (!seen.has(SYSTEM_ACCOUNT_ID)) candidates.push(systemCandidate(order));
        seen.add(SYSTEM_ACCOUNT_ID);
        return;
      }
      const account = managed.find((a) => a.id === wanted) ?? managed.find((a) => sameLabel(a.label, wanted));
      if (!account) {
        skip({ accountId: wanted }, "unavailable", `not a ${accountFamily} account`);
        return;
      }
      if (seen.has(account.id)) return;
      seen.add(account.id);
      candidates.push({ accountId: account.id, label: account.label, account, order });
    });
    if (policy.includeSystem && !seen.has(SYSTEM_ACCOUNT_ID)) candidates.push(systemCandidate(policy.accounts.length));
  } else {
    candidates = managed.map((account, order) => ({ accountId: account.id, label: account.label, account, order }));
    if (policy.includeSystem) candidates.push(systemCandidate(managed.length));
  }

  type Eligible = Candidate & { reading: UsageReading };
  const known: Eligible[] = [];
  const unknown: Eligible[] = [];
  for (const candidate of candidates) {
    if (candidate.account?.needsReauth) {
      skip(candidate, "needsReauth", "needs signing in again");
      continue;
    }
    if (cooledOrTried(candidate)) continue;
    const reading = readUsage(input.usage, accountFamily, candidate.accountId, {
      now,
      hasManagedAccounts: managed.length > 0
    });
    if (!reading.known) {
      if (policy.unknownUsage === "exclude") skip(candidate, "unknownUsage", `usage unknown (${reading.unknownWhy})`);
      else unknown.push({ ...candidate, reading });
      continue;
    }
    const blockers = thresholdBlockers(reading, policy, entry.model);
    if (blockers.length > 0) {
      skip(candidate, "threshold", blockers.map((b) => b.text).join(", "));
      freesAt(freedAt(blockers));
      continue;
    }
    known.push({ ...candidate, reading });
  }

  const labelOf = (c: Candidate): string => c.label ?? c.accountId;
  const byLabel = (a: Candidate, b: Candidate): number => labelOf(a).localeCompare(labelOf(b));
  const resetMs = (window: UsageWindow | null): number => {
    const t = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const metricOf = (reading: UsageReading): number => {
    const session = reading.session?.percent ?? 0;
    const weekly = reading.weekly?.percent ?? 0;
    if (policy.leastUsedMetric === "session") return session;
    if (policy.leastUsedMetric === "weekly") return weekly;
    return Math.max(session, weekly);
  };
  const compareResets = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);
  if (policy.strategy === "fixed") {
    known.sort((a, b) => a.order - b.order);
    unknown.sort((a, b) => a.order - b.order);
  } else if (policy.strategy === "soonest-reset") {
    const windowOf = (c: Eligible): UsageWindow | null => (policy.soonestResetWindow === "session" ? c.reading.session : c.reading.weekly);
    known.sort((a, b) => compareResets(resetMs(windowOf(a)), resetMs(windowOf(b))) || byLabel(a, b));
    unknown.sort((a, b) => a.order - b.order);
  } else {
    known.sort(
      (a, b) =>
        metricOf(a.reading) - metricOf(b.reading) || compareResets(resetMs(a.reading.weekly), resetMs(b.reading.weekly)) || byLabel(a, b)
    );
    unknown.sort((a, b) => a.order - b.order);
  }

  const under = (window: "session" | "weekly"): string => {
    const max = window === "session" ? policy.maxSessionPct : policy.maxWeeklyPct;
    return max !== undefined ? ` under ${pct(max)}` : "";
  };
  const knownReason = (c: Eligible, position: number): string => {
    if (policy.strategy === "soonest-reset") {
      const which = policy.soonestResetWindow;
      const window = which === "session" ? c.reading.session : c.reading.weekly;
      const t = resetMs(window);
      const when = Number.isFinite(t) ? `in ${formatDuration(t - nowMs)}` : "reset time unknown";
      return `${labelOf(c)}: soonest ${which} reset (${when})${under(which)}`;
    }
    if (policy.strategy === "fixed") {
      return `${labelOf(c)}: ${position === 0 ? "first" : `#${position + 1}`} eligible in the fixed order`;
    }
    const metric = policy.leastUsedMetric;
    const limits = [policy.maxSessionPct !== undefined ? `session ${pct(policy.maxSessionPct)}` : "", policy.maxWeeklyPct !== undefined ? `weekly ${pct(policy.maxWeeklyPct)}` : ""]
      .filter(Boolean)
      .join(", ");
    return `${labelOf(c)}: least used (${metric} ${pct(metricOf(c.reading))})${limits ? ` under ${limits}` : ""}`;
  };
  const ranked: RankedCandidate[] = [
    ...known.map((c, position) => ({ accountId: c.accountId, ...(c.label ? { label: c.label } : {}), family, usage: "known" as const, reading: c.reading, reason: knownReason(c, position) })),
    ...unknown.map((c) => ({
      accountId: c.accountId,
      ...(c.label ? { label: c.label } : {}),
      family,
      usage: "unknown" as const,
      reading: c.reading,
      reason: `${labelOf(c)}: usage unknown (${c.reading.unknownWhy}) — tried after every account with known usage`
    }))
  ];
  return { chainIndex, entry, family, ranked, skipped, ...(earliestFreeAt !== undefined ? { earliestFreeAt } : {}) };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export function selectAccount(input: SelectAccountInput): AccountSelectionDecision {
  const indices: number[] = [];
  if (input.onlyChainIndex !== undefined) {
    if (input.onlyChainIndex >= 0 && input.onlyChainIndex < input.chain.length) indices.push(input.onlyChainIndex);
  } else {
    for (let i = 0; i < input.chain.length; i++) indices.push(i);
  }
  const skipped: AccountSkip[] = [];
  let earliest: number | undefined;
  let newestAsOf: string | undefined;
  const fallenFrom: string[] = [];
  for (const index of indices) {
    const evaluation = rankChainEntry(input, index);
    skipped.push(...evaluation.skipped);
    if (evaluation.earliestFreeAt !== undefined) earliest = earliest === undefined ? evaluation.earliestFreeAt : Math.min(earliest, evaluation.earliestFreeAt);
    for (const candidate of evaluation.ranked) {
      const asOf = candidate.reading?.asOf;
      if (asOf && (!newestAsOf || Date.parse(asOf) > Date.parse(newestAsOf))) newestAsOf = asOf;
    }
    const best = evaluation.ranked[0];
    if (!best) {
      fallenFrom.push(evaluation.entry.agent);
      continue;
    }
    const entry = evaluation.entry;
    const chosen: AccountSelectionChoice = {
      agent: entry.agent,
      model: entry.model,
      ...(entry.options && entry.options.length > 0 ? { options: entry.options } : {}),
      accountId: best.accountId,
      ...(best.label ? { accountLabel: best.label } : {}),
      chainIndex: index
    };
    const fallback = fallenFrom.length > 0 ? ` — fallback to ${entry.agent} (chain entry ${index + 1}): no eligible account for ${[...new Set(fallenFrom)].join(", ")}` : "";
    const asOf = best.reading?.asOf;
    return { chosen, reason: `${best.reason}${fallback}`, ...(asOf ? { usageAsOf: asOf } : {}), skipped };
  }
  const reason =
    indices.length === 0
      ? "No chain entry to choose from."
      : `No eligible account in ${indices.length === 1 ? "the chain entry" : `any of ${indices.length} chain entries`}${
          earliest !== undefined ? ` — the earliest frees up in ${formatDuration(earliest - input.now.getTime())}` : ""
        }.`;
  return {
    chosen: null,
    reason,
    ...(newestAsOf ? { usageAsOf: newestAsOf } : {}),
    skipped,
    ...(earliest !== undefined ? { earliestResetAt: new Date(earliest).toISOString() } : {})
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** "4d 2h", "3h 12m", "12m", "<1m" (floored). */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** "therealeduard465: weekly 90% ≥ 85%". */
function describeSkip(skip: AccountSkip): string {
  return `${skip.label ?? skip.accountId}: ${skip.detail}`;
}

/** One line per skip, grouped by agent: "claude — therealeduard465: weekly 90% ≥ 85%; …". */
export function describeSkips(skips: AccountSkip[]): string {
  const byAgent = new Map<string, string[]>();
  for (const skip of skips) {
    const list = byAgent.get(skip.agent) ?? [];
    list.push(describeSkip(skip));
    byAgent.set(skip.agent, list);
  }
  return [...byAgent].map(([agent, lines]) => `${agent} — ${lines.join("; ")}`).join("\n");
}
