import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexWhamUsage } from "./usage-parse.ts";

const NOW = Date.parse("2026-07-07T08:00:00Z");
const resetSec = Math.floor(Date.parse("2026-07-07T10:00:00Z") / 1000);

test("maps plan_type and primary/secondary windows", () => {
  const a = parseCodexWhamUsage(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 12, reset_at: resetSec, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 44, reset_at: resetSec, limit_window_seconds: 604800 }
      }
    },
    NOW
  );
  assert.equal(a.id, "codex");
  assert.equal(a.available, true);
  assert.equal(a.plan, "Pro");
  assert.equal(a.session?.percent, 12);
  assert.equal(a.weekly?.percent, 44);
  assert.equal(a.session?.resetsAt, new Date(resetSec * 1000).toISOString());
  assert.deepEqual([a.session?.windowMinutes, a.weekly?.windowMinutes], [300, 10080]);
});

test("a window that does not state its length has no windowMinutes", () => {
  const a = parseCodexWhamUsage({ rate_limit: { primary_window: { used_percent: 5, reset_at: resetSec } } }, NOW);
  assert.equal(a.session?.percent, 5);
  assert.equal(a.session?.windowMinutes, undefined);
});

test("week-only primary_window (7d limit, no secondary) → weekly slot", () => {
  const weekReset = Math.floor(Date.parse("2026-07-08T18:00:00Z") / 1000);
  const a = parseCodexWhamUsage(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 33, reset_at: weekReset, limit_window_seconds: 604800 }
      }
    },
    NOW
  );
  assert.equal(a.session, null);
  assert.equal(a.weekly?.percent, 33);
  assert.equal(a.weekly?.resetsAt, new Date(weekReset * 1000).toISOString());
});

test("unparseable payload → available:false", () => {
  const a = parseCodexWhamUsage({ nope: true }, NOW);
  assert.equal(a.available, false);
});
