// Automated workflows — the usage-limit / auth failover loop's decisions (spec §5.4).
//
// The invariant: **a usage limit or an auth failure never fails an agent block while any eligible
// candidate remains in its chain.** The loop, per block (the executor drives it, persisting every
// step — see executor.ts):
//
//   1. cool the account down (`buildCooldown`: the provider's `resetsAt`, else the reset of the
//      account's burnt window in the usage snapshot, else 1 h; an auth failure 1 h and unusable for
//      the rest of the run) — shared by every workflow through the `CooldownStore`;
//   2. interrupt the work (no `turnId`: the turn AND its background work, which run on the same
//      exhausted account) and wait until the session is idle;
//   3. the next eligible account of the SAME chain entry → the in-session account switch
//      (`POST /api/sessions/:id/account`) and the continue message; OpenCode has no accounts, and a
//      switch the host keeps refusing (after one more idle wait) is handed off instead;
//   4. otherwise the next candidate — the same entry's next account in a new session when the switch
//      was refused, else the next chain entry — in a NEW session with the handoff prompt;
//   5. nothing left: `whenAllBurnt: "fail"` fails `all_burnt` with every hop and skip, or
//      `"wait-for-reset"` waits for the earliest reset (≤ `maxWaitHours` from the first wait), then
//      resumes on that account — in the same session when it is the same chain entry.
//
// At most 12 hops (`WORKFLOW_LIMITS.maxAgentHops`, the initial one included); an account is tried
// at most once unless its cooldown expired meanwhile. A hop never spends a `retry`.

import {
  SYSTEM_ACCOUNT_ID,
  WORKFLOW_LIMITS,
  type AccountSelectionDecision,
  type AccountSkip,
  type AgentChainEntry,
  type AgentHop
} from "@orquester/api";
import type { AccountCooldown } from "@orquester/config";
import type { AccountsReader, Clock, CooldownStore, UsageReader } from "../contracts.ts";
import { buildCooldown } from "./cooldowns.ts";
import { accountFamilyOf, cooldownKey, cooldownSubject } from "./families.ts";
import { burntWindowResetAt, formatDuration, selectAccount, type SelectAccountInput } from "./select.ts";

/** The agent/model/account a block runs (or is about to run) on. */
export interface AgentCandidate {
  chainIndex: number;
  agent: string;
  model: string;
  options: { id: string; value: string | boolean }[];
  accountId: string;
  accountLabel?: string;
  /** `cooldownSubject(agent, model, accountId).family` — the key family of its cooldowns and exclusions. */
  family: string;
  /**
   * `cooldownSubject(...).account` — the key's account part: the account id, or the provider for an
   * accountless launch. Absent on a state persisted before it existed (the account id then).
   */
  cooldownAccount?: string;
}

export interface FailoverDeps {
  usage: UsageReader;
  accounts: AccountsReader;
  cooldowns: CooldownStore;
  clock: Pick<Clock, "now">;
}

/** What the block remembers across hops (part of the persisted state). */
export interface FailoverMemory {
  /** `<family>:<accountId>` → until when it was cooled down by THIS block. */
  tried: Record<string, string>;
  /** Keys unusable for the rest of the run (auth failures, an account the daemon refused). */
  unusable: string[];
  /** Chain indices the catalogue refused (unknown model, agent not installed). */
  badChains: number[];
  /** Skips this block recorded itself (catalogue, refused accounts), shown with every selection. */
  extraSkips: AccountSkip[];
  /**
   * `<family>:<accountId>` → how often THIS block cooled it down. A limit that names no reset is
   * cooled 1 h, then 2 h, 4 h … (`buildCooldown`'s `strikes`), so a long wait-for-reset does not
   * wake hourly to hit the same wall. Absent on a state persisted before it existed.
   */
  strikes?: Record<string, number>;
}

export function emptyMemory(): FailoverMemory {
  return { tried: {}, unusable: [], badChains: [], extraSkips: [], strikes: {} };
}

/** Keys the next selection must pass over: unusable ones, and tried ones still cooling down. */
export function excludedKeys(memory: FailoverMemory, now: Date): Set<string> {
  const out = new Set(memory.unusable);
  const nowMs = now.getTime();
  for (const [key, until] of Object.entries(memory.tried)) {
    const t = Date.parse(until);
    if (!Number.isFinite(t) || t > nowMs) out.add(key);
  }
  return out;
}

export function candidateFromChoice(choice: NonNullable<AccountSelectionDecision["chosen"]>): AgentCandidate {
  const subject = cooldownSubject(choice.agent, choice.model, choice.accountId);
  return {
    chainIndex: choice.chainIndex,
    agent: choice.agent,
    model: choice.model,
    options: choice.options ?? [],
    accountId: choice.accountId,
    ...(choice.accountLabel ? { accountLabel: choice.accountLabel } : {}),
    family: subject.family,
    cooldownAccount: subject.account
  };
}

export function candidateKey(candidate: Pick<AgentCandidate, "family" | "accountId" | "cooldownAccount">): string {
  return cooldownKey(candidate.family, candidate.cooldownAccount ?? candidate.accountId);
}

/** Does this candidate run under a managed account (so an in-session switch means anything)? */
export function isAccountful(candidate: Pick<AgentCandidate, "agent">): boolean {
  return accountFamilyOf(candidate.agent) !== null;
}

/** §5.4 step 1: cool the account down in the shared store and remember it in the block. */
export async function coolDown(
  deps: FailoverDeps,
  memory: FailoverMemory,
  candidate: AgentCandidate,
  failure: { reason: AccountCooldown["reason"]; resetsAt?: string; message?: string }
): Promise<AccountCooldown> {
  const now = deps.clock.now();
  // The usage snapshot describes managed accounts and a family's system login only: an accountless
  // launch (OpenCode) has no row of its own.
  const accountFamily = accountFamilyOf(candidate.agent);
  const usageResetAt =
    failure.reason === "usage_limit" && accountFamily !== null
      ? burntWindowResetAt({ usage: deps.usage.snapshot(), family: accountFamily, accountId: candidate.accountId, now })
      : undefined;
  const key = candidateKey(candidate);
  const strikes = memory.strikes?.[key] ?? 0;
  const cooldown = buildCooldown({
    ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
    ...(usageResetAt ? { usageResetAt } : {}),
    now,
    reason: failure.reason,
    strikes,
    ...(failure.message ? { detail: failure.message.slice(0, 500) } : {})
  });
  memory.tried[key] = cooldown.until;
  memory.strikes = { ...(memory.strikes ?? {}), [key]: strikes + 1 };
  if (failure.reason === "auth" && !memory.unusable.includes(key)) memory.unusable.push(key);
  await deps.cooldowns.set(candidate.family, candidate.cooldownAccount ?? candidate.accountId, cooldown);
  return cooldown;
}

/** The selection input over the live readers. */
function selectionInput(deps: FailoverDeps, chain: AgentChainEntry[], memory: FailoverMemory): SelectAccountInput {
  const now = deps.clock.now();
  return {
    chain,
    usage: deps.usage.snapshot(),
    accounts: deps.accounts.list(),
    cooldowns: deps.cooldowns.list(),
    now,
    exclude: excludedKeys(memory, now)
  };
}

export type CandidateCheck = { ok: true; candidate: AgentCandidate } | { ok: false; scope: "chain" | "account"; skip: AccountSkip };

export type PickResult =
  | { kind: "chosen"; candidate: AgentCandidate; decision: AccountSelectionDecision }
  | { kind: "none"; decision: AccountSelectionDecision };

/**
 * The first eligible candidate from chain entry `from` on (§5.2, entry by entry), each checked by
 * `check` (the catalogue and the family re-check). A refused chain entry is passed over for the rest
 * of the block; a refused account is excluded and its entry evaluated again. The decision carries
 * every skip — selection's and the block's own — and, when nothing is eligible, the earliest instant
 * a candidate frees up.
 */
export async function pickCandidate(
  deps: FailoverDeps,
  chain: AgentChainEntry[],
  memory: FailoverMemory,
  from: number,
  check: (candidate: AgentCandidate) => Promise<CandidateCheck>
): Promise<PickResult> {
  const skipped: AccountSkip[] = [];
  const fallenFrom: string[] = [];
  let earliest: number | undefined;
  let usageAsOf: string | undefined;
  const withExtra = (): AccountSkip[] => [...memory.extraSkips, ...skipped];
  for (let index = Math.max(0, from); index < chain.length; index += 1) {
    if (memory.badChains.includes(index)) continue;
    for (let guard = 0; guard < 64; guard += 1) {
      const decision = selectAccount({ ...selectionInput(deps, chain, memory), onlyChainIndex: index });
      if (decision.usageAsOf && (!usageAsOf || Date.parse(decision.usageAsOf) > Date.parse(usageAsOf))) usageAsOf = decision.usageAsOf;
      if (!decision.chosen) {
        skipped.push(...decision.skipped);
        if (decision.earliestResetAt) {
          const t = Date.parse(decision.earliestResetAt);
          if (Number.isFinite(t)) earliest = earliest === undefined ? t : Math.min(earliest, t);
        }
        fallenFrom.push(chain[index]!.agent);
        break;
      }
      const candidate = candidateFromChoice(decision.chosen);
      const checked = await check(candidate);
      if (!checked.ok) {
        memory.extraSkips.push(checked.skip);
        if (checked.scope === "chain") {
          memory.badChains.push(index);
          fallenFrom.push(chain[index]!.agent);
          break;
        }
        const key = candidateKey(candidate);
        if (!memory.unusable.includes(key)) memory.unusable.push(key);
        continue;
      }
      const fallback = fallenFrom.length > 0 ? ` — fallback to ${candidate.agent} (chain entry ${index + 1}): no eligible account for ${[...new Set(fallenFrom)].join(", ")}` : "";
      const chosenDecision: AccountSelectionDecision = {
        chosen: { ...decision.chosen, model: checked.candidate.model, ...(checked.candidate.options.length ? { options: checked.candidate.options } : {}) },
        reason: `${decision.reason}${fallback}`,
        ...(decision.usageAsOf ?? usageAsOf ? { usageAsOf: decision.usageAsOf ?? usageAsOf } : {}),
        skipped: [...withExtra(), ...decision.skipped]
      };
      return { kind: "chosen", candidate: checked.candidate, decision: chosenDecision };
    }
  }
  const now = deps.clock.now().getTime();
  const reason = `No eligible account left in the chain${earliest !== undefined ? ` — the earliest frees up in ${formatDuration(earliest - now)}` : ""}.`;
  return {
    kind: "none",
    decision: {
      chosen: null,
      reason,
      ...(usageAsOf ? { usageAsOf } : {}),
      skipped: withExtra(),
      ...(earliest !== undefined ? { earliestResetAt: new Date(earliest).toISOString() } : {})
    }
  };
}

/**
 * The hop cap (§5.4): a block runs on at most this many hops, the initial one included. A hop that
 * RESUMES after a wait for a reset (`via: "resumed"`) is not counted: it is the same work going on
 * once the quota refilled, and `whenAllBurnt: "wait-for-reset"` bounds those by `maxWaitHours`
 * already — counted, a 48 h wait with hourly unknown-reset cooldowns ran out of hops after 12.
 */
function countedHops(hops: readonly AgentHop[]): number {
  return hops.filter((hop) => hop.via !== "resumed").length;
}

export function hopCapReached(hops: readonly AgentHop[]): boolean {
  return countedHops(hops) >= WORKFLOW_LIMITS.maxAgentHops;
}

/**
 * `whenAllBurnt: "wait-for-reset"`: until when to wait, or null when the earliest reset is unknown
 * or beyond `maxWaitHours` counted from the block's first wait.
 */
export function resetWaitUntil(decision: AccountSelectionDecision, input: { now: Date; firstWaitAt: Date; maxWaitHours: number }): Date | null {
  const earliest = decision.earliestResetAt ? Date.parse(decision.earliestResetAt) : Number.NaN;
  if (!Number.isFinite(earliest)) return null;
  const limit = input.firstWaitAt.getTime() + input.maxWaitHours * 60 * 60_000;
  if (earliest > limit) return null;
  // A reset already past (a stale reading): look again shortly rather than spin.
  return new Date(Math.max(earliest, input.now.getTime() + 1_000));
}

/** One line per hop for an `all_burnt` error: "claude/therealeduard465 → usage limit (resets 22:40)". */
export function describeHops(hops: readonly AgentHop[]): string {
  return hops
    .map((hop) => {
      const who = `${hop.agent}/${hop.accountLabel ?? (hop.accountId === SYSTEM_ACCOUNT_ID ? "system" : hop.accountId)}`;
      if (!hop.reason) return who;
      const why = hop.reason === "auth" ? "sign-in failed" : "usage limit";
      return `${who} → ${why}${hop.resetsAt ? ` (resets ${hop.resetsAt})` : ""}`;
    })
    .join(" → ");
}
