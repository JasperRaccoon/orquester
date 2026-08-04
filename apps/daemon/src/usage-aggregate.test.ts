import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentUsage, UsageAccount } from "@orquester/api";
import { aggregateWorstAccountUsage } from "./index.ts";

const acct = (over: Partial<UsageAccount>): UsageAccount => ({
  id: "a",
  available: true,
  stale: false,
  session: null,
  weekly: null,
  ...over
});

const NOW = Date.parse("2026-07-21T08:00:00Z");
const PAST = "2026-07-21T07:59:00Z";
const FUTURE = "2026-07-21T12:00:00Z";

test("worst-account picks the highest-percent window per field across accounts", () => {
  const accounts: UsageAccount[] = [
    acct({ id: "a1", session: { percent: 20 }, weekly: { percent: 80 } }),
    acct({ id: "a2", session: { percent: 65 }, weekly: { percent: 30 } })
  ];
  const head = aggregateWorstAccountUsage("claude", null, accounts, NOW);
  assert.equal(head.session?.percent, 65); // worst session is a2
  assert.equal(head.weekly?.percent, 80); // worst weekly is a1
  assert.equal(head.available, true);
  assert.deepEqual(head.aggregate, {
    strategy: "worst-account",
    accountCount: 2,
    staleAccountCount: 0
  });
  // Per-account list is passed through unchanged.
  assert.equal(head.accounts, accounts);
});

test("managed-only (base === null) surfaces the worst managed window, not empty", () => {
  const accounts: UsageAccount[] = [acct({ id: "a1", session: { percent: 95 }, weekly: { percent: 10 } })];
  const head = aggregateWorstAccountUsage("codex", null, accounts, NOW);
  assert.equal(head.id, "codex");
  assert.equal(head.session?.percent, 95);
  assert.equal(head.weekly?.percent, 10);
});

test("System base participates in the pool and can be the worst source", () => {
  const base: AgentUsage = {
    id: "claude",
    available: true,
    stale: false,
    plan: "Max 20x",
    session: { percent: 99 },
    weekly: { percent: 5 }
  };
  const accounts: UsageAccount[] = [acct({ id: "a1", session: { percent: 40 }, weekly: { percent: 88 } })];
  const head = aggregateWorstAccountUsage("claude", base, accounts, NOW);
  assert.equal(head.session?.percent, 99); // System is worst for session
  assert.equal(head.weekly?.percent, 88); // account is worst for weekly
  assert.equal(head.plan, "Max 20x");
  assert.equal(head.id, "claude");
});

test("carries the resets/capacity of the chosen worst window and its freshness", () => {
  const accounts: UsageAccount[] = [
    acct({ id: "a1", stale: true, asOf: "2026-07-21T07:00:00Z", session: { percent: 10 }, weekly: null }),
    acct({
      id: "a2",
      stale: false,
      asOf: "2026-07-21T08:00:00Z",
      session: { percent: 70, resetsAt: "2026-07-21T12:00:00Z", used: 700, limit: 1000, remaining: 300 },
      weekly: null
    })
  ];
  const head = aggregateWorstAccountUsage("claude", null, accounts, NOW);
  assert.deepEqual(head.session, {
    percent: 70,
    resetsAt: "2026-07-21T12:00:00Z",
    used: 700,
    limit: 1000,
    remaining: 300
  });
  assert.equal(head.asOf, "2026-07-21T08:00:00Z"); // from the fresh a2 that supplied the shown session
});

test("null windows everywhere leave head windows null and mark stale", () => {
  const accounts: UsageAccount[] = [acct({ id: "a1", stale: true, session: null, weekly: null })];
  const head = aggregateWorstAccountUsage("claude", null, accounts, NOW);
  assert.equal(head.session, null);
  assert.equal(head.weekly, null);
  assert.equal(head.stale, true);
  assert.equal(head.aggregate?.staleAccountCount, 1);
});

test("an expired window (resetsAt in the past) never wins the worst-account pick", () => {
  // The live-bug shape: a stale System reading frozen at 100% from a weekly
  // window that has since reset, next to fresh low per-account readings.
  const base: AgentUsage = {
    id: "claude",
    available: true,
    stale: true,
    session: null,
    weekly: { percent: 100, resetsAt: PAST }
  };
  const accounts: UsageAccount[] = [
    acct({ id: "a1", weekly: { percent: 2, resetsAt: FUTURE } }),
    acct({ id: "a2", weekly: { percent: 23, resetsAt: FUTURE } })
  ];
  const head = aggregateWorstAccountUsage("claude", base, accounts, NOW);
  assert.equal(head.weekly?.percent, 23);
});

test("windows that all expired leave the head window null", () => {
  const accounts: UsageAccount[] = [
    acct({ id: "a1", session: { percent: 90, resetsAt: PAST }, weekly: { percent: 100, resetsAt: PAST } })
  ];
  const head = aggregateWorstAccountUsage("claude", null, accounts, NOW);
  assert.equal(head.session, null);
  assert.equal(head.weekly, null);
});

test("a window without resetsAt is treated as current", () => {
  const accounts: UsageAccount[] = [acct({ id: "a1", weekly: { percent: 55 } })];
  const head = aggregateWorstAccountUsage("claude", null, accounts, NOW);
  assert.equal(head.weekly?.percent, 55);
});

test("the System base is exposed as a `system` row (expired windows scrubbed)", () => {
  const base: AgentUsage = {
    id: "claude",
    available: true,
    stale: true,
    plan: "Max 20x",
    session: { percent: 10, resetsAt: FUTURE },
    weekly: { percent: 100, resetsAt: PAST },
    asOf: "2026-07-21T07:00:00Z"
  };
  const accounts: UsageAccount[] = [acct({ id: "a1", weekly: { percent: 23, resetsAt: FUTURE } })];
  const head = aggregateWorstAccountUsage("claude", base, accounts, NOW);
  assert.deepEqual(head.system, {
    id: "system",
    label: "System",
    available: true,
    stale: true,
    plan: "Max 20x",
    session: { percent: 10, resetsAt: FUTURE },
    weekly: null, // reset already passed → the row must not show the dead 100%
    asOf: "2026-07-21T07:00:00Z"
  });
});

test("no System base ⇒ no system row", () => {
  const head = aggregateWorstAccountUsage("claude", null, [acct({ id: "a1" })], NOW);
  assert.equal(head.system, undefined);
});

test("head is not stale when a fresh window is shown even if another account is stale", () => {
  const accounts: UsageAccount[] = [
    acct({ id: "a1", stale: true, session: null, weekly: null }),
    acct({ id: "a2", stale: false, session: { percent: 50 }, weekly: { percent: 50 } })
  ];
  const head = aggregateWorstAccountUsage("claude", null, accounts, NOW);
  assert.equal(head.stale, false);
  assert.equal(head.aggregate?.staleAccountCount, 1);
});
