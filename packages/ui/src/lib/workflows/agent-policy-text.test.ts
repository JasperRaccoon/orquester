import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AccountPolicy } from "@orquester/api";

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
