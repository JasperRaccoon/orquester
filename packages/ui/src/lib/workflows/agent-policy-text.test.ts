import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AccountPolicy, AccountSelectionDecision, AccountSkip } from "@orquester/api";

import {
  accountName,
  accountsCountText,
  choiceLine,
  decisionReasonText,
  formatPercent,
  limitsText,
  policySummary,
  scopedRuleApplies,
  scopedWindowCovers,
  skipLine,
  skipReasonText,
  strategyName,
  strategyText,
  type DecisionNames
} from "./agent-policy-text.ts";
import {
  allowAllAccounts,
  allowListView,
  dropMissingAccounts,
  moveAllowedAccount,
  scopedLimitRows,
  setSystemAllowed,
  toggleAllowedAccount,
  withStrategy
} from "./inspector-usage.ts";

const BASE: AccountPolicy = {
  strategy: "least-used",
  includeSystem: false,
  soonestResetWindow: "weekly",
  leastUsedMetric: "max",
  unknownUsage: "last"
};

const NAMES: DecisionNames = {
  agent: (id) => ({ claude: "Claude", codex: "Codex" })[id] ?? id,
  account: (_agent, id, label) => accountName(id, label, { a1: "jasper", a2: "work" }[id]),
  model: (_agent, slug) => ({ "opus[1m]": "Opus" })[slug] ?? slug
};

const skip = (why: AccountSkip["why"], detail: string, accountId = "a1", label?: string): AccountSkip => ({
  agent: "claude",
  accountId,
  ...(label ? { label } : {}),
  why,
  detail
});

describe("the policy in words", () => {
  it("names every strategy and sub-choice", () => {
    assert.equal(strategyName("least-used"), "Most quota left");
    assert.equal(strategyName("soonest-reset"), "Quota that resets soonest");
    assert.equal(strategyName("fixed"), "Fixed order");
    assert.equal(strategyText(BASE), "Most quota left");
    assert.equal(strategyText({ ...BASE, leastUsedMetric: "weekly" }), "Most weekly quota left");
    assert.equal(strategyText({ ...BASE, leastUsedMetric: "session" }), "Most 5-hour quota left");
    assert.equal(strategyText({ ...BASE, strategy: "soonest-reset" }), "Weekly quota resets soonest");
    assert.equal(strategyText({ ...BASE, strategy: "soonest-reset", soonestResetWindow: "session" }), "5-hour quota resets soonest");
    assert.equal(strategyText({ ...BASE, strategy: "fixed", leastUsedMetric: "weekly" }), "Fixed order");
  });

  it("lists thresholds 5-hour, weekly, then scoped, and says when a scoped one is limited to models", () => {
    assert.equal(limitsText(BASE), "");
    assert.equal(limitsText({ ...BASE, maxWeeklyPct: 85 }), "skip at 85% weekly");
    assert.equal(
      limitsText({ ...BASE, maxSessionPct: 90, maxWeeklyPct: 87.5, scoped: [{ label: "Fable", maxPct: 80 }] }),
      "skip at 90% 5-hour, 87.5% weekly, 80% Fable"
    );
    const limited = { ...BASE, scoped: [{ label: "Fable", maxPct: 70, onlyForModels: ["fable", "opus"] }] };
    assert.equal(limitsText(limited), "skip at 70% Fable (2 models)");
    assert.equal(limitsText(limited, "opus"), "skip at 70% Fable (2 models)");
    assert.equal(limitsText(limited, "sonnet"), "skip at 70% Fable (not this model)");
    assert.equal(formatPercent(12.345), "12.3%");
  });

  it("counts accounts", () => {
    assert.equal(accountsCountText(3, 3), "All 3 accounts");
    assert.equal(accountsCountText(2, 3), "2 of 3 accounts");
    assert.equal(accountsCountText(1, 1), "1 account");
    assert.equal(accountsCountText(0, 0), "No accounts");
  });

  it("summarises a policy in one line", () => {
    assert.equal(policySummary(BASE), "Most quota left");
    assert.equal(
      policySummary({ ...BASE, maxWeeklyPct: 85, unknownUsage: "exclude" }, { accounts: { allowed: 2, total: 3 } }),
      "Most quota left · skip at 85% weekly · 2 of 3 accounts · skips unreadable accounts"
    );
    assert.equal(policySummary({ ...BASE, strategy: "fixed" }, { accounts: { allowed: 3, total: 3 } }), "Fixed order · All 3 accounts");
  });

  it("applies scoped rules as the engine does", () => {
    assert.equal(scopedRuleApplies({}, "opus"), true);
    assert.equal(scopedRuleApplies({ onlyForModels: ["opus"] }, "opus"), true);
    assert.equal(scopedRuleApplies({ onlyForModels: ["sonnet"] }, "opus"), false);
    // No rule: a used-up window stops only a model whose id carries its name.
    assert.equal(scopedWindowCovers("Fable", "fable-1", []), true);
    assert.equal(scopedWindowCovers("Fable", "opus", []), false);
    assert.equal(scopedWindowCovers("fable", "opus", [{ label: "Fable", maxPct: 90, onlyForModels: ["opus"] }]), true);
  });
});

describe("skip reasons in words", () => {
  it("reads threshold breaches, at and over the limit, and used-up windows", () => {
    assert.equal(skipReasonText(skip("threshold", "weekly 90% ≥ 85%")), "weekly usage is 90%, over your 85% limit");
    assert.equal(skipReasonText(skip("threshold", "session 85% ≥ 85%")), "5-hour usage has reached your 85% limit");
    assert.equal(skipReasonText(skip("threshold", "session 100% (limit reached)")), "5-hour limit is used up (100%)");
    assert.equal(
      skipReasonText(skip("threshold", "session 92% ≥ 90%, Fable 100% (limit reached)")),
      "5-hour usage is 92%, over your 90% limit; Fable limit is used up (100%)"
    );
    assert.equal(skipReasonText(skip("threshold", "something new")), "something new");
  });

  it("reads every other reason", () => {
    assert.equal(skipReasonText(skip("needsReauth", "needs signing in again")), "it needs signing in again (Settings → Accounts)");
    assert.equal(
      skipReasonText(skip("cooldown", "usage limit — cooling down until 2026-09-29T12:00:00.000Z (in 3h 12m)")),
      "it hit a usage limit recently and rests for another 3h 12m"
    );
    assert.equal(
      skipReasonText(skip("cooldown", "sign-in failed — cooling down until 2026-09-29T12:00:00.000Z (in 12m)")),
      "its sign-in failed recently; it rests for another 12m"
    );
    assert.equal(
      skipReasonText(skip("unknownUsage", "usage unknown (usage reading is 34m old)")),
      "its usage can't be read (usage reading is 34m old), and this choice doesn't use such accounts"
    );
    assert.equal(skipReasonText(skip("unavailable", "already tried in this block")), "already tried by this block");
    assert.equal(skipReasonText(skip("unavailable", "not a claude account"), NAMES), "no Claude account on this machine matches it");
    assert.equal(skipReasonText(skip("unavailable", "the session could not be created: boom")), "the session could not be created: boom");
  });

  it("names who was skipped by label, and a catalogue skip by agent", () => {
    assert.deepEqual(skipLine(skip("threshold", "weekly 90% ≥ 85%"), NAMES), {
      who: "Claude · jasper",
      text: "weekly usage is 90%, over your 85% limit"
    });
    assert.deepEqual(skipLine(skip("needsReauth", "needs signing in again", "system", "System"), NAMES).who, "Claude · System login");
    assert.deepEqual(skipLine(skip("unavailable", "not a claude account", "ghost"), NAMES).who, "Claude · ghost");
    assert.deepEqual(skipLine(skip("catalog", 'Unknown model "opus" for claude.'), NAMES), {
      who: "Claude",
      text: 'Unknown model "opus" for claude.'
    });
  });
});

describe("the decision in words", () => {
  const chosen = { agent: "claude", model: "opus[1m]", accountId: "a1", accountLabel: "jasper", chainIndex: 0 };
  const decision = (reason: string, extra: Partial<AccountSelectionDecision> = {}): AccountSelectionDecision => ({
    chosen,
    reason,
    skipped: [],
    ...extra
  });
  const now = Date.parse("2026-09-29T10:00:00.000Z");

  it("reads each strategy's reason", () => {
    assert.equal(decisionReasonText(decision("jasper: least used (max 40%) under weekly 85%"), NAMES, now), "It has the most quota left (40% used on its fuller limit).");
    assert.equal(decisionReasonText(decision("jasper: least used (weekly 12%)"), NAMES, now), "It has the most weekly quota left (12% used).");
    assert.equal(decisionReasonText(decision("jasper: least used (session 3%)"), NAMES, now), "It has the most 5-hour quota left (3% used).");
    assert.equal(decisionReasonText(decision("jasper: soonest weekly reset (in 4d 2h) under 85%"), NAMES, now), "Its weekly quota resets soonest (resets in 4d 2h).");
    assert.equal(decisionReasonText(decision("jasper: soonest session reset (reset time unknown)"), NAMES, now), "Its 5-hour quota resets soonest (its reset time isn't known).");
    assert.equal(decisionReasonText(decision("jasper: first eligible in the fixed order"), NAMES, now), "It's the first account in your order that can run now.");
    assert.equal(
      decisionReasonText(decision("System: usage unknown (no usage reading) — tried after every account with known usage"), NAMES, now),
      "No account with a usage reading can run, so it goes to one whose usage can't be read (no usage reading)."
    );
    assert.equal(
      decisionReasonText(decision("opencode: has no managed accounts — runs on the system login"), NAMES, now),
      "It has no accounts to pick from, so it runs on the daemon's own sign-in."
    );
    assert.equal(decisionReasonText(decision("something the daemon says now"), NAMES, now), "something the daemon says now");
  });

  it("says when the pick is a fallback, with agent labels", () => {
    assert.equal(
      decisionReasonText(
        decision("work: least used (max 10%) — fallback to codex (chain entry 2): no eligible account for claude", {
          chosen: { ...chosen, agent: "codex", chainIndex: 1 }
        }),
        NAMES,
        now
      ),
      "It has the most quota left (10% used on its fuller limit). It's fallback 1: the earlier choices (Claude) have no account that can run now."
    );
  });

  it("says when nobody can run it and when the first account frees up", () => {
    const none = (reason: string, earliestResetAt?: string): AccountSelectionDecision => ({
      chosen: null,
      reason,
      skipped: [],
      ...(earliestResetAt ? { earliestResetAt } : {})
    });
    assert.equal(
      decisionReasonText(none("No eligible account left in the chain — the earliest frees up in 2h 0m.", "2026-09-29T12:00:00.000Z"), NAMES, now),
      "No account can run it right now. The first one frees up in 2h."
    );
    assert.equal(decisionReasonText(none("No eligible account in the chain entry."), NAMES, now), "No account can run it right now.");
    assert.equal(decisionReasonText(none("No chain entry to choose from."), NAMES, now), "There is no agent to choose from.");
  });

  it("names the pick by labels", () => {
    assert.equal(choiceLine(chosen, NAMES), "Claude · Opus · jasper");
    assert.equal(choiceLine({ ...chosen, accountId: "system", accountLabel: "System" }, NAMES), "Claude · Opus · System login");
  });
});

describe("the allow-list, as the engine reads it", () => {
  const managed = [
    { id: "a1", label: "jasper" },
    { id: "a2", label: "work" },
    { id: "a3", label: "spare" }
  ];

  it("reads no list as every account, the System login last when included", () => {
    assert.deepEqual(allowListView(BASE, managed), { candidates: ["a1", "a2", "a3"], missing: [], explicit: false });
    assert.deepEqual(allowListView({ ...BASE, accounts: [], includeSystem: true }, managed).candidates, ["a1", "a2", "a3", "system"]);
  });

  it("matches ids, then labels, keeps list order, and reports entries naming nobody", () => {
    const view = allowListView({ ...BASE, accounts: ["WORK", "a1", "gone", "a1"], includeSystem: true }, managed);
    assert.deepEqual(view, { candidates: ["a2", "a1", "system"], missing: ["gone"], explicit: true });
    assert.deepEqual(allowListView({ ...BASE, accounts: ["system", "a3"] }, managed).candidates, ["system", "a3"]);
  });

  it("unticks an account into a list, and back to no list when all are ticked", () => {
    const off = toggleAllowedAccount(BASE, managed, "least-used", "a2");
    assert.deepEqual(off, { accounts: ["a1", "a3"], includeSystem: false });
    assert.deepEqual(toggleAllowedAccount({ ...BASE, ...off! }, managed, "least-used", "a2"), { accounts: undefined, includeSystem: false });
  });

  it("never writes an empty list (the engine would read it as every account)", () => {
    const only = { ...BASE, accounts: ["a1"] };
    assert.equal(toggleAllowedAccount(only, managed, "least-used", "a1"), null);
    const systemOnly = { ...BASE, accounts: ["system"], includeSystem: true };
    assert.equal(setSystemAllowed(systemOnly, managed, "least-used", false), null);
    // With no managed account, "nobody" is no list and no System login.
    assert.deepEqual(setSystemAllowed({ ...BASE, includeSystem: true }, [], "least-used", false), { accounts: undefined, includeSystem: false });
  });

  it("excludes accounts in fixed order, keeping the order of the rest", () => {
    const ordered = { ...BASE, strategy: "fixed" as const, accounts: ["a3", "a1", "a2"] };
    assert.deepEqual(toggleAllowedAccount(ordered, managed, "fixed", "a1"), { accounts: ["a3", "a2"], includeSystem: false });
    // Re-ticked: it joins at the end.
    assert.deepEqual(toggleAllowedAccount({ ...ordered, accounts: ["a3", "a2"] }, managed, "fixed", "a1"), {
      accounts: ["a3", "a2", "a1"],
      includeSystem: false
    });
  });

  it("moves accounts in fixed order and drops a list that is back in the family's order", () => {
    const fixed = { ...BASE, strategy: "fixed" as const };
    assert.deepEqual(moveAllowedAccount(fixed, managed, "a2", -1), { accounts: ["a2", "a1", "a3"], includeSystem: false });
    assert.deepEqual(moveAllowedAccount({ ...fixed, accounts: ["a2", "a1", "a3"] }, managed, "a2", 1), { accounts: undefined, includeSystem: false });
    assert.equal(moveAllowedAccount(fixed, managed, "a1", -1), null);
    // The System login moves like any account; the list then names it.
    const withSystem = { ...fixed, includeSystem: true };
    assert.deepEqual(moveAllowedAccount(withSystem, managed, "system", -1), { accounts: ["a1", "a2", "system", "a3"], includeSystem: true });
  });

  it("adds and removes the System login in a list", () => {
    const list = { ...BASE, accounts: ["a1"] };
    assert.deepEqual(setSystemAllowed(list, managed, "least-used", true), { accounts: ["a1", "system"], includeSystem: true });
    assert.deepEqual(setSystemAllowed({ ...list, accounts: ["a1", "system"], includeSystem: true }, managed, "least-used", false), {
      accounts: ["a1"],
      includeSystem: false
    });
    assert.deepEqual(setSystemAllowed(BASE, managed, "least-used", true), { accounts: undefined, includeSystem: true });
  });

  it("keeps entries naming nobody until they are dropped", () => {
    const stale = { ...BASE, accounts: ["a1", "a2", "a3", "gone"] };
    assert.deepEqual(toggleAllowedAccount(stale, managed, "least-used", "a3"), { accounts: ["a1", "a2", "gone"], includeSystem: false });
    assert.deepEqual(dropMissingAccounts(stale, managed, "least-used"), { accounts: undefined, includeSystem: false });
    assert.deepEqual(allowAllAccounts({ ...BASE, accounts: ["a2"] }, managed, "fixed"), { accounts: ["a2", "a1", "a3"], includeSystem: false });
  });

  it("drops an order-only list when leaving fixed order, and keeps a real restriction", () => {
    const ordered = { ...BASE, strategy: "fixed" as const, accounts: ["a3", "a1", "a2"] };
    const leastUsed = withStrategy(ordered, managed, "least-used");
    assert.equal(leastUsed.strategy, "least-used");
    assert.equal(leastUsed.accounts, undefined);
    const restricted = withStrategy({ ...ordered, accounts: ["a3", "a1"] }, managed, "soonest-reset");
    assert.deepEqual(restricted.accounts, ["a3", "a1"]);
    assert.deepEqual(withStrategy({ ...BASE, accounts: ["a2", "a1"] }, managed, "fixed").accounts, ["a2", "a1"]);
  });
});

describe("scoped limit rows", () => {
  it("lists reported windows, each rule for them, then rules for windows not reported", () => {
    assert.deepEqual(scopedLimitRows(undefined, ["Fable"]), [{ label: "Fable", ruleIndex: null }]);
    assert.deepEqual(
      scopedLimitRows(
        [
          { label: "Other", maxPct: 50 },
          { label: "fable", maxPct: 80, onlyForModels: ["opus"] },
          { label: "Fable", maxPct: 90 }
        ],
        ["Fable", "fable"]
      ),
      [
        { label: "fable", ruleIndex: 1 },
        { label: "Fable", ruleIndex: 2 },
        { label: "Other", ruleIndex: 0 }
      ]
    );
  });
});
