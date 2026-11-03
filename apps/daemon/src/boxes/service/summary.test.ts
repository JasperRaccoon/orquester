import assert from "node:assert/strict";
import test from "node:test";

import type { StoredBox } from "@orquester/config";

import { boxesTotals, estimatedCostUsd, lentAccountsOf, monthCostUsd, toBoxSummary, utcMonthStart } from "./summary.ts";
import { FakeAdapter } from "./testing.ts";

function box(extra: Partial<StoredBox>): StoredBox {
  return {
    id: "aaaaaaaaaaaa",
    purpose: "project",
    kind: "linux",
    provider: "hetzner",
    region: "fsn1",
    size: "small",
    name: "orq-aaaaaaaaaaaa",
    createdAt: "2026-10-20T10:00:00.000Z",
    state: "ready",
    hourlyUsd: 0.5,
    ...extra
  };
}

const at = (iso: string) => Date.parse(iso);

test("estimated cost is uptime × the hourly price, frozen once destroyed", () => {
  assert.equal(estimatedCostUsd(box({}), at("2026-10-20T13:00:00.000Z")), 1.5);
  const destroyed = box({ state: "destroyed", destroyedAt: "2026-10-20T11:30:00.000Z", providerRef: { id: 1 } });
  assert.equal(estimatedCostUsd(destroyed, at("2026-10-25T00:00:00.000Z")), 0.75);
  assert.equal(estimatedCostUsd(box({ hourlyUsd: null }), at("2026-10-21T00:00:00.000Z")), 0);
});

test("a box whose create call failed never had an instance and costs nothing", () => {
  const failed = box({ state: "destroyed", destroyedReason: "provisioning-failed", destroyedAt: "2026-10-20T10:00:30.000Z" });
  const now = at("2026-10-20T11:00:00.000Z");
  assert.equal(estimatedCostUsd(failed, now), 0);
  assert.equal(monthCostUsd(failed, now), 0);
  // Still being created: the instance may exist, so its time counts.
  assert.equal(estimatedCostUsd(box({ state: "provisioning" }), now), 0.5);
});

test("the month estimate counts only this UTC month's part of each box's uptime", () => {
  const now = at("2026-11-01T02:00:00.000Z");
  assert.equal(utcMonthStart(now), at("2026-11-01T00:00:00.000Z"));
  // Running since October: only the 2 hours of November count.
  assert.equal(monthCostUsd(box({ createdAt: "2026-10-31T20:00:00.000Z" }), now), 1);
  // Destroyed in October: nothing this month.
  assert.equal(monthCostUsd(box({ createdAt: "2026-10-31T20:00:00.000Z", state: "destroyed", destroyedAt: "2026-10-31T23:00:00.000Z" }), now), 0);
  const totals = boxesTotals(
    [
      box({ id: "a", createdAt: "2026-11-01T00:00:00.000Z", hourlyUsd: 1 }),
      box({ id: "b", createdAt: "2026-11-01T00:00:00.000Z", hourlyUsd: 0.25, state: "destroyed", destroyedAt: "2026-11-01T01:00:00.000Z", providerRef: { id: 2 } }),
      box({ id: "c", createdAt: "2026-11-01T01:00:00.000Z", hourlyUsd: null, state: "provisioning" })
    ],
    now
  );
  assert.deepEqual(totals, { activeCount: 2, hourlyUsd: 1, monthEstimatedUsd: 2.25 });
});

test("a record with a kind, provider or state this build does not know has no summary", () => {
  const providers = new Map([["hetzner" as const, new FakeAdapter()]]);
  const now = at("2026-10-20T11:00:00.000Z");
  assert.ok(toBoxSummary(box({}), { providers, connected: true, now }));
  assert.equal(toBoxSummary(box({ state: "hibernating" }), { providers, connected: true, now }), null);
  assert.equal(toBoxSummary(box({ provider: "aws" }), { providers, connected: true, now }), null);
  const summary = toBoxSummary(box({ state: "destroyed", destroyedReason: "provider-gone" }), { providers, connected: true, now })!;
  assert.equal(summary.connected, false, "a destroyed box is never connected");
  assert.equal(summary.destroyedReason, "provider-gone");
  assert.equal(summary.providerLabel, "Fake Cloud");
});

test("a summary lists active lends only: not ended ones, not an agent this build does not know, never a stored extra", () => {
  const lend = { accountId: "acct", agent: "claude", label: "me@example.com", createdAt: "2026-10-20T10:00:00.000Z", expiresAt: "2026-10-20T14:00:00.000Z" };
  const record = box({
    accountLends: [
      { ...lend, id: "active", threadId: "chat", purposeNote: "evals", futureField: "kept" },
      { ...lend, id: "ended", endedAt: "2026-10-20T11:00:00.000Z", endReason: "returned" },
      { ...lend, id: "future", agent: "gemini" }
    ]
  });
  const options = { providers: new Map([["hetzner" as const, new FakeAdapter({ id: "hetzner" })]]), connected: true, now: at("2026-10-20T12:00:00.000Z") };
  const lendRuntime = () => ({ status: "active" as const, statusMessage: null, tokenExpiresAt: null, home: "/home" });
  assert.deepEqual(lentAccountsOf(record, lendRuntime), [
    { id: "active", accountId: "acct", agent: "claude", label: "me@example.com", threadId: "chat", purposeNote: "evals", createdAt: lend.createdAt, expiresAt: lend.expiresAt, status: "active", statusMessage: null, tokenExpiresAt: null, home: "/home" }
  ]);
  assert.deepEqual(toBoxSummary(record, { ...options, lendRuntime })?.lentAccounts?.map((lent) => lent.id), ["active"]);
  assert.equal("lentAccounts" in toBoxSummary(box({}), { ...options, lendRuntime })!, false);
});
