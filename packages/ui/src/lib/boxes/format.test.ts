import assert from "node:assert/strict";
import test from "node:test";

import {
  HOURS_PER_MONTH,
  costForMinutes,
  dailyUsd,
  formatCountdown,
  formatHourlyRate,
  formatHourlyUsd,
  formatLifetime,
  formatUsd,
  monthlyUsd
} from "./format.ts";

test("hourly prices keep three significant digits below a dollar, two decimals at least", () => {
  assert.equal(formatHourlyUsd(4.8), "$4.80");
  assert.equal(formatHourlyUsd(1), "$1.00");
  assert.equal(formatHourlyUsd(12.345), "$12.35");
  assert.equal(formatHourlyUsd(0.5), "$0.50");
  assert.equal(formatHourlyUsd(0.25), "$0.25");
  assert.equal(formatHourlyUsd(0.125), "$0.125");
  assert.equal(formatHourlyUsd(0.1), "$0.10");
  assert.equal(formatHourlyUsd(0.0119), "$0.0119");
  assert.equal(formatHourlyUsd(0.012), "$0.012");
  assert.equal(formatHourlyUsd(0.00694), "$0.00694");
  assert.equal(formatHourlyUsd(0.011923), "$0.0119");
  // Rounding that carries into a whole dollar reads as one.
  assert.equal(formatHourlyUsd(0.99996), "$1.00");
  assert.equal(formatHourlyUsd(1234.5), "$1,234.50");
});

test("a zero, negative or non-finite price reads as nothing", () => {
  assert.equal(formatHourlyUsd(0), "$0.00");
  assert.equal(formatHourlyUsd(-1), "$0.00");
  assert.equal(formatHourlyUsd(Number.NaN), "$0.00");
  assert.equal(formatUsd(Number.POSITIVE_INFINITY), "$0.00");
});

test("rates carry the per-hour suffix", () => {
  assert.equal(formatHourlyRate(4.8), "$4.80/h");
  assert.equal(formatHourlyRate(0.0119), "$0.0119/h");
});

test("amounts: whole dollars from $100, cents below, a sliver as <$0.01", () => {
  assert.equal(formatUsd(576), "$576");
  assert.equal(formatUsd(115.2), "$115");
  assert.equal(formatUsd(3504), "$3,504");
  assert.equal(formatUsd(8.687), "$8.69");
  assert.equal(formatUsd(0.42), "$0.42");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(0), "$0.00");
});

test("monthly is 730 hours, daily 24, a lifetime its minutes", () => {
  assert.equal(HOURS_PER_MONTH, 730);
  assert.equal(monthlyUsd(0.0119).toFixed(3), "8.687");
  assert.equal(dailyUsd(4.8), 115.19999999999999);
  assert.equal(formatUsd(dailyUsd(4.8)), "$115");
  assert.equal(costForMinutes(4.8, 7200), 576);
});

test("lifetimes read in days, hours or minutes", () => {
  assert.equal(formatLifetime(7200), "5 days");
  assert.equal(formatLifetime(1440), "1 day");
  assert.equal(formatLifetime(360), "6 hours");
  assert.equal(formatLifetime(60), "1 hour");
  assert.equal(formatLifetime(90), "90 minutes");
  assert.equal(formatLifetime(1), "1 minute");
});

test("countdowns read in the largest two units", () => {
  const now = Date.parse("2026-10-20T10:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(formatCountdown(at((4 * 24 + 6) * 3_600_000 + 59_000), now), "4d 6h left");
  assert.equal(formatCountdown(at((3 * 60 + 12) * 60_000), now), "3h 12m left");
  assert.equal(formatCountdown(at(12 * 60_000 + 30_000), now), "12m left");
  assert.equal(formatCountdown(at(30_000), now), "<1m left");
  assert.equal(formatCountdown(at(0), now), "Time limit reached");
  assert.equal(formatCountdown(at(-5_000), now), "Time limit reached");
  assert.equal(formatCountdown(null, now), null);
  assert.equal(formatCountdown("not a date", now), null);
});
