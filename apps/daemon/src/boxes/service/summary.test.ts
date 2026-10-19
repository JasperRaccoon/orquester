import assert from "node:assert/strict";
import test from "node:test";

import type { StoredBox } from "@orquester/config";

import { boxesTotals, estimatedCostUsd, monthCostUsd, toBoxSummary, utcMonthStart } from "./summary.ts";
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
  const destroyed = box({ state: "destroyed", destroyedAt: "2026-10-20T11:30:00.000Z" });
  assert.equal(estimatedCostUsd(destroyed, at("2026-10-25T00:00:00.000Z")), 0.75);
  assert.equal(estimatedCostUsd(box({ hourlyUsd: null }), at("2026-10-21T00:00:00.000Z")), 0);
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
      box({ id: "b", createdAt: "2026-11-01T00:00:00.000Z", hourlyUsd: 0.25, state: "destroyed", destroyedAt: "2026-11-01T01:00:00.000Z" }),
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
  assert.deepEqual(
    summary.setup.map((step) => step.id),
    ["create", "connect", "paths", "config", "tooling", "clone", "toolchain", "ready"]
  );
});
