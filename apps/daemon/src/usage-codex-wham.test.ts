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
});

test("unparseable payload → available:false", () => {
  const a = parseCodexWhamUsage({ nope: true }, NOW);
  assert.equal(a.available, false);
});
