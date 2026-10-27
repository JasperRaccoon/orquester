import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, type DevicesSettings } from "@orquester/api";

import type { StoredBox } from "@orquester/config";

import { deviceHostSpend, iosRentalSpec, rentalNeedsApproval } from "./rental.ts";

const settings = (ios: Partial<DevicesSettings["ios"]> = {}): DevicesSettings => ({ ...DEFAULT_DEVICES_SETTINGS, ios: { ...DEFAULT_DEVICES_SETTINGS.ios, ...ios } });

describe("Mac host rental", () => {
  it("reads a Blacksmith runner label into size, image and price", () => {
    assert.deepEqual(iosRentalSpec(settings()), {
      provider: "blacksmith",
      size: "6vcpu",
      sizeLabel: "6 vCPU M4 · 24 GB",
      image: "macos-26",
      hourlyUsd: 4.8,
      lifetimeMinutes: 240
    });
    assert.equal(iosRentalSpec(settings({ size: "12vcpu" })).image, null);
    assert.equal(iosRentalSpec(settings({ size: "blacksmith-12vcpu-macos-27" })).hourlyUsd, 9.6);
  });

  it("takes other providers' labels and prices from their offers", () => {
    const spec = iosRentalSpec(settings({ provider: "aws", size: "mac2.metal" }), [
      { id: "mac2.metal", label: "mac2.metal · 12 cores", vcpu: 12, ramGb: 16, diskGb: null, gpu: null, hourlyUsd: 0.65, regions: [] }
    ]);
    assert.deepEqual([spec.sizeLabel, spec.hourlyUsd, spec.image], ["mac2.metal · 12 cores", 0.65, null]);
    assert.equal(iosRentalSpec(settings({ provider: "aws", size: "x" })).hourlyUsd, null);
  });

  it("needs approval unless the pool's one switch is on and the monthly cap holds (spent + committed + the new host)", () => {
    const spec = { hourlyUsd: 4.8, lifetimeMinutes: 240 };
    const on = (cap = 100): DevicesSettings => ({ ...settings(), pool: { ...DEFAULT_DEVICES_SETTINGS.pool, rentWithoutAsking: true, monthlyCapUsd: cap } });
    assert.equal(rentalNeedsApproval(settings(), spec, 0), true);
    // The superseded Mac switch alone approves nothing.
    assert.equal(rentalNeedsApproval(settings({ rentWithoutAsking: true }), spec, 0), true);
    assert.equal(rentalNeedsApproval(on(), spec, 0), false);
    // 80.81 + 19.2 > 100.
    assert.equal(rentalNeedsApproval(on(), spec, 80.81), true);
    assert.equal(rentalNeedsApproval(on(), spec, 80.8), false);
    // Committed cost of running hosts counts: 40 spent + 41 committed + 19.2 > 100.
    assert.equal(rentalNeedsApproval(on(), spec, { monthUsd: 40, committedUsd: 41 }), true);
    assert.equal(rentalNeedsApproval(on(), spec, { monthUsd: 40, committedUsd: 40 }), false);
    assert.equal(rentalNeedsApproval(on(), { hourlyUsd: null, lifetimeMinutes: 240 }, 0), true);
  });

  it("spend: device-host boxes today, this month, and committed until their deadline", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    const box = (over: Partial<StoredBox>): StoredBox => ({ id: "x", purpose: "device-host", state: "ready", hourlyUsd: 2, createdAt: "2026-10-27T10:00:00.000Z", ...over }) as StoredBox;
    const spend = deviceHostSpend(
      [
        // Up 2 h today, 2 h left: $4 spent, $4 committed.
        box({ deadlineAt: "2026-10-27T14:00:00.000Z" }),
        // Ran yesterday 22:00 → today 01:00 (gone): $6 this month, $2 today, nothing committed.
        box({ id: "y", state: "destroyed", providerRef: { runId: 1 }, createdAt: "2026-10-26T22:00:00.000Z", destroyedAt: "2026-10-27T01:00:00.000Z", deadlineAt: "2026-10-27T20:00:00.000Z" }),
        // Not a device host.
        box({ id: "z", purpose: "chat", deadlineAt: "2026-10-27T20:00:00.000Z" })
      ],
      now
    );
    assert.deepEqual(
      [spend.todayUsd, spend.monthUsd, spend.committedUsd].map((usd) => Math.round(usd * 100) / 100),
      [6, 10, 4]
    );
  });
});
