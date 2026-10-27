import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, type DevicesSettings } from "@orquester/api";

import { iosRentalSpec, rentalNeedsApproval } from "./rental.ts";

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

  it("needs approval unless renting without asking stays within the monthly cap", () => {
    const spec = { hourlyUsd: 4.8, lifetimeMinutes: 240 };
    assert.equal(rentalNeedsApproval(settings(), spec, 0), true);
    assert.equal(rentalNeedsApproval(settings({ rentWithoutAsking: true }), spec, 0), false);
    // 80.81 + 19.2 > 100.
    assert.equal(rentalNeedsApproval(settings({ rentWithoutAsking: true }), spec, 80.81), true);
    assert.equal(rentalNeedsApproval(settings({ rentWithoutAsking: true }), spec, 80.8), false);
    assert.equal(rentalNeedsApproval(settings({ rentWithoutAsking: true }), { hourlyUsd: null, lifetimeMinutes: 240 }, 0), true);
  });
});
