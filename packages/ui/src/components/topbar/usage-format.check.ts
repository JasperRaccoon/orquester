import assert from "node:assert/strict";
import type { AgentUsage } from "@orquester/api";
import { barClass, formatAgo, formatCountdown, gaugeClass, minutesSince, pickDriver, usageLevel, windowMax } from "./usage-format";

const claude: AgentUsage = { id: "claude", available: true, stale: false, session: { percent: 10 }, weekly: { percent: 20 } };
const codex: AgentUsage = { id: "codex", available: true, stale: false, session: { percent: 80 }, weekly: { percent: 5 } };

// "busiest" = highest single window (codex's 80 beats claude's 20).
assert.equal(pickDriver([claude, codex], "busiest")?.id, "codex");
// pinned choice wins when available…
assert.equal(pickDriver([claude, codex], "claude")?.id, "claude");
// …but falls back to busiest when the pinned agent is absent.
assert.equal(pickDriver([codex], "claude")?.id, "codex");
assert.equal(pickDriver([], "busiest"), null);

// Countdown formatting.
const now = Date.parse("2026-07-07T08:00:00Z");
assert.equal(formatCountdown("2026-07-07T10:29:00Z", now), "Resets in 2h 29m");
assert.equal(formatCountdown("2026-07-07T07:59:00Z", now), "Resets now.");
assert.equal(formatCountdown(undefined, now), "");

// Color ramp: green → yellow → orange → red by nearness to the limit.
assert.equal(usageLevel(10), "ok");
assert.equal(usageLevel(60), "moderate");
assert.equal(usageLevel(80), "high");
assert.equal(usageLevel(95), "critical");
assert.match(barClass(10), /emerald/);
assert.match(barClass(60), /yellow/);
assert.match(barClass(80), /orange/);
assert.match(barClass(95), /red/);
assert.match(gaugeClass(10), /emerald/);
assert.match(gaugeClass(95), /red/);
// windowMax = the worse of session/weekly (codex: max(80, 5)).
assert.equal(windowMax(codex), 80);

// "as of" age helpers.
const t0 = Date.parse("2026-07-07T08:00:00Z");
assert.equal(minutesSince(undefined, t0), Infinity);
assert.equal(minutesSince("2026-07-07T07:50:00Z", t0), 10);
assert.equal(formatAgo("2026-07-07T07:59:40Z", t0), "just now");
assert.equal(formatAgo("2026-07-07T07:46:00Z", t0), "14m ago");
assert.equal(formatAgo("2026-07-07T06:00:00Z", t0), "2h ago");
assert.equal(formatAgo(undefined, t0), "");

console.log("usage-format.check OK");
