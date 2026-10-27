import assert from "node:assert/strict";
import test from "node:test";

import { costForMinutes, dailyUsd, formatHourlyRate, monthlyUsd } from "./format.ts";

test("hourly rates preserve sub-cent prices and their unit", () => {
  // A quoted VM rate must not become zero cents or a monthly price in the UI.
  assert.match(formatHourlyRate(0.0119), /\$0\.0119\/h$/);
});

test("monthly is 730 hours, daily 24, a lifetime its minutes", () => {
  assert.equal(monthlyUsd(0.0119).toFixed(3), "8.687");
  assert.equal(dailyUsd(4.8).toFixed(2), "115.20");
  assert.equal(costForMinutes(4.8, 7200), 576);
});
