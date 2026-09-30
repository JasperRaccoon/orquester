/**
 * The agent block's account policy and "Who would run now?" in words
 * (workflows spec §5.2): the one-line summaries the inspector shows on a
 * collapsed chain card, and the daemon's selection decision — its reason and
 * every skip — as sentences with labels instead of ids.
 *
 * Every claim here is the engine's (daemon `workflows/agent/select.ts`):
 *  - a threshold skips an account when a window's usage is AT OR ABOVE it;
 *    without one, the 5-hour and weekly windows still skip it at 100 %;
 *  - a scoped window ("Fable") without a rule stops only the models it covers
 *    (a model id that carries its name, or one a rule names), at 100 %;
 *  - "Most quota left" compares the 5-hour or the weekly window, or the
 *    fuller of the two (`max`), a missing window counting as 0 %;
 *  - unknown usage (no reading, unavailable, or older than 20 min) is tried
 *    after every account with a reading, or not at all.
 * The decision texts parse the daemon's fixed phrasings and fall back to its
 * own text for anything they don't recognise.
 *
 * Pure: no React, no store.
 */

import { SYSTEM_ACCOUNT_ID, type AccountPolicy, type AccountSelectionDecision, type AccountSkip } from "@orquester/api";

import { formatResetIn } from "./inspector-usage";

type ScopedRule = NonNullable<AccountPolicy["scoped"]>[number];

/** The two windows every family may report, as the editor names them. */
const WINDOW_WORDS = { session: "5-hour", weekly: "weekly" } as const;

/** "85%", "87.5%". */
export function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/** The strategy with its sub-choice, for a summary: "Most weekly quota left", "5-hour quota resets soonest". */
function strategyText(policy: Pick<AccountPolicy, "strategy" | "leastUsedMetric" | "soonestResetWindow">): string {
  if (policy.strategy === "fixed") return "Fixed order";
  if (policy.strategy === "soonest-reset") {
    return `${policy.soonestResetWindow === "session" ? "5-hour" : "Weekly"} quota resets soonest`;
  }
  if (policy.leastUsedMetric === "weekly") return "Most weekly quota left";
  if (policy.leastUsedMetric === "session") return "Most 5-hour quota left";
  return "Most quota left";
}

/** Whether a scoped rule is checked for `model` (no model list = every model). */
export function scopedRuleApplies(rule: Pick<ScopedRule, "onlyForModels">, model: string): boolean {
  return !rule.onlyForModels || rule.onlyForModels.includes(model);
}

/**
 * Whether a used-up (100 %) scoped window stops `model` when no threshold
 * catches it first: a rule for the window names the model, or the model's id
 * carries the window's name ("Fable" → a fable model).
 */
export function scopedWindowCovers(label: string, model: string, rules: readonly ScopedRule[]): boolean {
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  const own = rules.filter((rule) => same(rule.label, label));
  return own.some((rule) => rule.onlyForModels?.includes(model) === true) || model.toLowerCase().includes(label.trim().toLowerCase());
}

/**
 * The thresholds, shortest first-to-last: "85% 5-hour", "90% weekly",
 * "80% Fable". A scoped rule limited to models says so: "(not this model)"
 * when `model` is given and not among them, else "(2 models)".
 */
function limitParts(policy: Pick<AccountPolicy, "maxSessionPct" | "maxWeeklyPct" | "scoped">, model?: string): string[] {
  const parts: string[] = [];
  if (policy.maxSessionPct !== undefined) parts.push(`${formatPercent(policy.maxSessionPct)} 5-hour`);
  if (policy.maxWeeklyPct !== undefined) parts.push(`${formatPercent(policy.maxWeeklyPct)} weekly`);
  for (const rule of policy.scoped ?? []) {
    let text = `${formatPercent(rule.maxPct)} ${rule.label}`;
    if (rule.onlyForModels) {
      if (model !== undefined && !rule.onlyForModels.includes(model)) text += " (not this model)";
      else text += ` (${plural(rule.onlyForModels.length, "model")})`;
    }
    parts.push(text);
  }
  return parts;
}

/** "skip at 85% 5-hour, 90% weekly"; "" when no threshold is set. */
export function limitsText(policy: Pick<AccountPolicy, "maxSessionPct" | "maxWeeklyPct" | "scoped">, model?: string): string {
  const parts = limitParts(policy, model);
  return parts.length > 0 ? `skip at ${parts.join(", ")}` : "";
}

/** "All 3 accounts", "2 of 3 accounts", "1 account", "No accounts". */
export function accountsCountText(allowed: number, total: number): string {
  if (total === 0) return "No accounts";
  if (total === 1) return allowed >= 1 ? "1 account" : "0 of 1 account";
  if (allowed >= total) return `All ${total} accounts`;
  return `${allowed} of ${total} accounts`;
}

/**
 * A chain entry's policy in one line: "Most quota left · skip at 85% weekly ·
 * 2 of 3 accounts". `accounts` (allowed / total, System login included when
 * it is allowed) is left out when unknown.
 */
export function policySummary(
  policy: AccountPolicy,
  options: { model?: string; accounts?: { allowed: number; total: number } } = {}
): string {
  const parts = [strategyText(policy)];
  const limits = limitsText(policy, options.model);
  if (limits) parts.push(limits);
  if (options.accounts) parts.push(accountsCountText(options.accounts.allowed, options.accounts.total));
  if (policy.unknownUsage === "exclude") parts.push("skips unreadable accounts");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// "Who would run now?"
// ---------------------------------------------------------------------------

/** How the texts name agents and accounts (labels, not ids). */
export interface DecisionNames {
  agent: (refId: string) => string;
  /** An account's label; `label` is what the daemon sent, when it sent one. */
  account: (agent: string, accountId: string, label?: string) => string;
  /** A model's short name. */
  model?: (agent: string, slug: string) => string;
}

/** The window a daemon detail names ("session", "weekly", a scoped label), in the editor's words. */
function windowWords(name: string): string {
  if (name === "session") return WINDOW_WORDS.session;
  if (name === "weekly") return WINDOW_WORDS.weekly;
  return name;
}

/** One threshold breach ("weekly 90% ≥ 85%", "session 100% (limit reached)") as words. */
function breachText(part: string): string | null {
  const over = /^(.+) (\d+(?:\.\d+)?)% ≥ (\d+(?:\.\d+)?)%$/.exec(part);
  if (over) {
    const [, name, used, max] = over;
    const window = windowWords(name!);
    return Number(used) > Number(max)
      ? `${window} usage is ${used}%, over your ${max}% limit`
      : `${window} usage has reached your ${max}% limit`;
  }
  const full = /^(.+) (\d+(?:\.\d+)?)% \(limit reached\)$/.exec(part);
  if (full) return `${windowWords(full[1]!)} limit is used up (${full[2]}%)`;
  return null;
}

/** Why the engine passed an account (or a whole chain entry) over, in words. */
function skipReasonText(skip: AccountSkip, names?: Pick<DecisionNames, "agent">): string {
  const detail = skip.detail.trim();
  switch (skip.why) {
    case "threshold": {
      const parts = detail.split(", ").map(breachText);
      return parts.every((part): part is string => part !== null) ? parts.join("; ") : detail;
    }
    case "needsReauth":
      return "it needs signing in again (Settings → Accounts)";
    case "cooldown": {
      const match = /^(sign-in failed|usage limit) — cooling down until \S+ \(in (.+)\)$/.exec(detail);
      if (!match) return detail;
      return match[1] === "usage limit"
        ? `it hit a usage limit recently and rests for another ${match[2]}`
        : `its sign-in failed recently; it rests for another ${match[2]}`;
    }
    case "unknownUsage": {
      const match = /^usage unknown \((.+)\)$/.exec(detail);
      return `its usage can't be read${match ? ` (${match[1]})` : ""}, and this choice doesn't use such accounts`;
    }
    case "unavailable": {
      if (detail === "already tried in this block") return "already tried by this block";
      const family = /^not a (.+) account$/.exec(detail);
      if (family) return `no ${names?.agent(family[1]!) ?? family[1]} account on this machine matches it`;
      return detail;
    }
    default:
      return detail;
  }
}

/** A skip as a line: who (a label) and why. A catalogue skip is about the agent, not the account. */
export function skipLine(skip: AccountSkip, names: DecisionNames): { who: string; text: string } {
  const agent = names.agent(skip.agent);
  if (skip.why === "catalog") return { who: agent, text: skip.detail.trim() };
  return { who: `${agent} · ${names.account(skip.agent, skip.accountId, skip.label)}`, text: skipReasonText(skip, names) };
}

/** Why the chosen candidate was picked (the daemon's reason, without the "<account>: " lead), in words. */
function choiceText(reason: string): string | null {
  const least = /: least used \((max|weekly|session) (\d+(?:\.\d+)?)%\)(?: under .+)?$/.exec(reason);
  if (least) {
    const [, metric, used] = least;
    if (metric === "weekly") return `It has the most weekly quota left (${used}% used).`;
    if (metric === "session") return `It has the most 5-hour quota left (${used}% used).`;
    return `It has the most quota left (${used}% used on its fuller limit).`;
  }
  const soonest = /: soonest (weekly|session) reset \((.+?)\)(?: under \d+(?:\.\d+)?%)?$/.exec(reason);
  if (soonest) {
    const window = soonest[1] === "session" ? "5-hour" : "weekly";
    const when = soonest[2] === "reset time unknown" ? "its reset time isn't known" : `resets ${soonest[2]}`;
    return `Its ${window} quota resets soonest (${when}).`;
  }
  if (/: first eligible in the fixed order$/.test(reason)) return "It's the first account in your order that can run now.";
  const nth = /: #(\d+) eligible in the fixed order$/.exec(reason);
  if (nth) return `It's number ${nth[1]} among the accounts in your order that can run now.`;
  const unknown = /: usage unknown \((.+)\) — tried after every account with known usage$/.exec(reason);
  if (unknown) return `No account with a usage reading can run, so it goes to one whose usage can't be read (${unknown[1]}).`;
  if (/: has no managed accounts — runs on the system login$/.test(reason)) return "It has no accounts to pick from, so it runs on the daemon's own sign-in.";
  return null;
}

/**
 * The decision's reason in words: why the pick won (and when it is a
 * fallback, which agents had nobody), or why nobody can run it and when the
 * first account frees up. The daemon's own text when it can't be read.
 */
export function decisionReasonText(decision: AccountSelectionDecision, names: DecisionNames, now: number): string {
  if (!decision.chosen) {
    const frees = decision.earliestResetAt ? formatResetIn(decision.earliestResetAt, now) : "";
    if (!/^No eligible account/.test(decision.reason) && !/^No chain entry/.test(decision.reason)) return decision.reason;
    if (/^No chain entry/.test(decision.reason)) return "There is no agent to choose from.";
    return `No account can run it right now.${frees && frees !== "now" ? ` The first one frees up in ${frees}.` : ""}`;
  }
  const fallback = / — fallback to (\S+) \(chain entry (\d+)\): no eligible account for (.+)$/.exec(decision.reason);
  const main = fallback ? decision.reason.slice(0, fallback.index) : decision.reason;
  const why = choiceText(main);
  if (why === null) return decision.reason;
  if (!fallback) return why;
  const others = fallback[3]!
    .split(", ")
    .map((agent) => names.agent(agent.trim()))
    .join(", ");
  const index = Number(fallback[2]) - 1;
  return `${why} It's fallback ${index}: the earlier choices (${others}) have no account that can run now.`;
}

/** The chosen candidate as "Claude · Opus · jasper" (labels; the System login by name). */
export function choiceLine(chosen: NonNullable<AccountSelectionDecision["chosen"]>, names: DecisionNames): string {
  const model = names.model?.(chosen.agent, chosen.model) ?? chosen.model;
  return `${names.agent(chosen.agent)} · ${model} · ${names.account(chosen.agent, chosen.accountId, chosen.accountLabel)}`;
}

/** An account id's label for texts: the System login by name, else the lookup's, else the id. */
export function accountName(accountId: string, label: string | undefined, known?: string): string {
  if (accountId === SYSTEM_ACCOUNT_ID) return "System login";
  return known ?? label ?? accountId;
}
