import test from "node:test";
import assert from "node:assert/strict";
import {
  clampMeterPercent,
  isMeterOverloaded,
  meterDashOffset,
  formatMeterPercent,
  METER_OVERLOAD_PERCENT
} from "./meter.ts";

test("clampMeterPercent bounds the value and treats absence as empty", () => {
  assert.equal(clampMeterPercent(50), 50);
  assert.equal(clampMeterPercent(-10), 0);
  assert.equal(clampMeterPercent(140), 100);
  assert.equal(clampMeterPercent(null), 0);
  assert.equal(clampMeterPercent(undefined), 0);
  assert.equal(clampMeterPercent(Number.NaN), 0);
  assert.equal(clampMeterPercent(Number.POSITIVE_INFINITY), 0);
});

test("the overload threshold is exclusive: 90% is still normal", () => {
  assert.equal(METER_OVERLOAD_PERCENT, 90);
  assert.equal(isMeterOverloaded(90), false);
  assert.equal(isMeterOverloaded(90.1), true);
  assert.equal(isMeterOverloaded(null), false);
});

test("meterDashOffset counts backwards from a full stroke", () => {
  const circumference = 100;
  assert.equal(meterDashOffset(0, circumference), 100);
  assert.equal(meterDashOffset(25, circumference), 75);
  assert.equal(meterDashOffset(100, circumference), 0);
  // Out of range must not draw a negative (over-full) arc.
  assert.equal(meterDashOffset(150, circumference), 0);
  assert.equal(meterDashOffset(null, circumference), 100);
});

test("formatMeterPercent keeps one decimal below 10 and trims a bare .0", () => {
  assert.equal(formatMeterPercent(2.34), "2.3%");
  assert.equal(formatMeterPercent(4), "4%");
  // 9.96 rounds up across the threshold: toFixed(1) gives "10.0", and the
  // trailing-.0 trim then yields a clean "10%" rather than "10.0%".
  assert.equal(formatMeterPercent(9.96), "10%");
});

test("formatMeterPercent rounds at and above 10", () => {
  assert.equal(formatMeterPercent(10), "10%");
  assert.equal(formatMeterPercent(63.4), "63%");
  assert.equal(formatMeterPercent(99.6), "100%");
});

test("formatMeterPercent is null without a context window, never a fake 0%", () => {
  // An adapter with reportsContextWindow: false has no percentage to show;
  // inventing one is a lie the user cannot detect (spec §7.6).
  assert.equal(formatMeterPercent(null), null);
  assert.equal(formatMeterPercent(undefined), null);
  assert.equal(formatMeterPercent(Number.NaN), null);
});
