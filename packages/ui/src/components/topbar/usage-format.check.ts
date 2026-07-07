import assert from "node:assert/strict";
import type { AgentUsage } from "@orquester/api";
import { barClass, formatCountdown, pickDriver } from "./usage-format";

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

// Color ramp thresholds.
assert.match(barClass(10), /emerald/);
assert.match(barClass(80), /amber/);
assert.match(barClass(95), /red/);

console.log("usage-format.check OK");
