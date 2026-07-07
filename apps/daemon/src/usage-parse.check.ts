import assert from "node:assert/strict";
import { parseClaudeUsage, parseCodexUsage, findLastCodexTokenCount } from "./usage-parse";

const NOW = Date.parse("2026-07-07T08:00:00Z");
const future = "2026-07-07T10:00:00Z";
const futureSec = Math.floor(Date.parse(future) / 1000);
const pastSec = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);

// Claude legacy top-level shape (the shape verified live on-host: 45 / 69).
const claudeLegacy = parseClaudeUsage(
  { five_hour: { utilization: 45, resets_at: future }, seven_day: { utilization: 69, resets_at: future } },
  { subscriptionType: "max", rateLimitTier: "max_20x" },
  NOW
);
assert.equal(claudeLegacy.available, true);
assert.equal(claudeLegacy.session?.percent, 45);
assert.equal(claudeLegacy.weekly?.percent, 69);
assert.equal(claudeLegacy.plan, "Max 20x");
assert.equal(claudeLegacy.stale, false);

// Claude newer limits[] shape → same numbers.
const claudeLimits = parseClaudeUsage(
  { limits: [
    { kind: "session", percent: 45, resets_at: future },
    { kind: "weekly_all", percent: 69, resets_at: future }
  ] },
  { subscriptionType: "max", rateLimitTier: "max_20x" },
  NOW
);
assert.equal(claudeLimits.session?.percent, 45);
assert.equal(claudeLimits.weekly?.percent, 69);

// Leak bug #52326: a reset epoch bled into utilization → drop the window.
const leak = parseClaudeUsage({ five_hour: { utilization: 1783000000 }, seven_day: { utilization: 69 } }, {}, NOW);
assert.equal(leak.session, null);
assert.equal(leak.weekly?.percent, 69);

// Codex object with primary(5h)/secondary(weekly).
const codex = parseCodexUsage(
  { limit_id: "codex", plan_type: "pro",
    primary: { used_percent: 3, window_minutes: 300, resets_at: futureSec },
    secondary: { used_percent: 37, window_minutes: 10080, resets_at: futureSec } },
  NOW
);
assert.equal(codex.session?.percent, 3);
assert.equal(codex.weekly?.percent, 37);
assert.equal(codex.plan, "Pro");

// Codex stale window (resets_at already past) → nulled.
const codexStale = parseCodexUsage(
  { primary: { used_percent: 3, resets_at: futureSec }, secondary: { used_percent: 37, resets_at: pastSec } },
  NOW
);
assert.equal(codexStale.session?.percent, 3);
assert.equal(codexStale.weekly, null);

// findLastCodexTokenCount returns the LAST token_count's rate_limits.
const lines = [
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 1 } } } }),
  JSON.stringify({ type: "event_msg", payload: { type: "agent_message", text: "hi" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 9 } } } }),
  ""
];
const rl = findLastCodexTokenCount(lines) as any;
assert.equal(rl.primary.used_percent, 9);
assert.equal(findLastCodexTokenCount(["", "not json"]), null);

console.log("usage-parse.check OK");
