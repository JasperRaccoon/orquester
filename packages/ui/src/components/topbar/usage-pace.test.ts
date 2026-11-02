import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeUsageWindows, providerWindowsToNormalized } from "./usage-format.ts";
import { usagePace } from "./usage-pace.ts";

const now = Date.parse("2026-11-02T12:00:00Z");
const inHours = (h: number) => new Date(now + h * 3_600_000).toISOString();

test("the pace tick sits at the share of the window that has passed, and labels the spend against it", () => {
  // A 5h session resetting in 2h is 60% through.
  const [session, weekly] = normalizeUsageWindows("claude", {
    session: { percent: 80, resetsAt: inHours(2) },
    weekly: { percent: 10, resetsAt: inHours(84) }
  });
  const sessionPace = usagePace(session!, now);
  assert.ok(sessionPace);
  assert.ok(Math.abs(sessionPace.elapsed - 0.6) < 1e-9);
  assert.equal(sessionPace.label, "ahead of pace");

  // A week resetting in 3.5 days is half through; 10% used is well under it.
  const weeklyPace = usagePace(weekly!, now);
  assert.ok(weeklyPace && Math.abs(weeklyPace.elapsed - 0.5) < 1e-9);
  assert.equal(weeklyPace.label, "under pace");

  assert.equal(usagePace({ percent: 64, resetsAt: inHours(2), durationMins: 300 }, now)?.label, "on pace");
});

test("a provider window is paced by its own length; no length or no reset means no tick", () => {
  const [known, unknown] = providerWindowsToNormalized("codex", [
    { id: "p", kind: "other", label: "Daily", usedPercent: 50, resetsAt: inHours(12), windowDurationMins: 24 * 60 },
    { id: "q", kind: "other", label: "Burst", usedPercent: 50, resetsAt: inHours(1) }
  ]);
  assert.ok(Math.abs((usagePace(known!, now)?.elapsed ?? -1) - 0.5) < 1e-9);
  assert.equal(usagePace(unknown!, now), null);
  assert.equal(usagePace({ percent: 50, durationMins: 300 }, now), null);
});

test("a weekly window is paced by the length the provider states, and an unstated non-Claude length gets no tick", () => {
  // A 14-day Codex window resetting in 7 days is half through, not at its start.
  const [stated] = normalizeUsageWindows("codex", {
    session: null,
    weekly: { percent: 50, resetsAt: inHours(7 * 24), windowMinutes: 14 * 24 * 60 }
  });
  assert.ok(Math.abs((usagePace(stated!, now)?.elapsed ?? -1) - 0.5) < 1e-9);

  // Grok's billing-period pool and a Codex week with no stated length are unknown.
  for (const agent of ["grok", "codex"]) {
    const [weekly] = normalizeUsageWindows(agent, { session: null, weekly: { percent: 50, resetsAt: inHours(24) } });
    assert.equal(usagePace(weekly!, now), null, agent);
  }
});

test("a reset outside one window from now gets no tick rather than a wrong one", () => {
  assert.equal(usagePace({ percent: 50, resetsAt: inHours(-1), durationMins: 300 }, now), null);
  assert.equal(usagePace({ percent: 50, resetsAt: inHours(6), durationMins: 300 }, now), null);
});
