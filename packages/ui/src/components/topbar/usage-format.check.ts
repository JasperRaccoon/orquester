import assert from "node:assert/strict";
import type { AgentUsage, UsageWindow } from "@orquester/api";
import { usagePrefsSchema } from "@orquester/config";
import { barClass, compactCount, formatAgo, formatChipWindows, formatCountdown, formatReset, formatUsageAmount, formatUsageCapacity, gaugeClass, labelForAgent, minutesSince, missingUsageAgents, normalizeUsageWindows, pickDriver, resetClock, usageLevel, usageUnitFor, windowMax } from "./usage-format";

const claude: AgentUsage = { id: "claude", available: true, stale: false, session: { percent: 10 }, weekly: { percent: 20 } };
const codex: AgentUsage = { id: "codex", available: true, stale: false, session: { percent: 80 }, weekly: { percent: 5 } };
const weekOnly: AgentUsage = { id: "grok", available: true, stale: false, session: null, weekly: { percent: 24 } };

// "busiest" = highest single window (codex's 80 beats claude's 20).
assert.equal(pickDriver([claude, codex], "busiest")?.id, "codex");
// pinned choice wins when available…
assert.equal(pickDriver([claude, codex], "claude")?.id, "claude");
// …but falls back to busiest when the pinned agent is absent.
assert.equal(pickDriver([codex], "claude")?.id, "codex");
assert.equal(pickDriver([], "busiest"), null);

// Countdown formatting.
const now = Date.parse("2026-07-07T08:00:00Z");
assert.equal(formatCountdown("2026-07-07T08:29:00Z", now), "Resets in 29m");
assert.equal(formatCountdown("2026-07-07T10:29:00Z", now), "Resets in 2h 29m");
assert.equal(formatCountdown("2026-07-13T01:20:00Z", now), "Resets in 5d 17h 20m");
assert.equal(formatCountdown("2026-07-07T07:59:00Z", now), "Resets now.");
assert.equal(formatCountdown(undefined, now), "");

// Color ramp: green → yellow → orange → red by nearness to the limit.
assert.equal(usageLevel(10), "ok");
assert.equal(usageLevel(60), "moderate");
assert.equal(usageLevel(80), "high");
assert.equal(usageLevel(95), "critical");
assert.match(barClass(10), /usage-ok/);
assert.match(barClass(60), /usage-med/);
assert.match(barClass(80), /usage-high/);
assert.match(barClass(95), /usage-crit/);
assert.match(gaugeClass(10), /usage-ok/);
assert.match(gaugeClass(95), /usage-crit/);
// windowMax = the worse of session/weekly (codex: max(80, 5)).
assert.equal(windowMax(codex), 80);

// Chip shows only present windows (no "— • 24%" or "33% • —" for week-only).
assert.equal(formatChipWindows(claude), "10% • 20%");
assert.equal(formatChipWindows(weekOnly), "24%");
assert.equal(formatChipWindows({ session: null, weekly: null }), "—");

// Agent labels come from the registry, with a capitalized-id fallback.
assert.equal(labelForAgent("claude"), "Claude Code");
assert.equal(labelForAgent("grok"), "Grok Build");
assert.equal(labelForAgent("mystery"), "Mystery");

// "as of" age helpers.
const t0 = Date.parse("2026-07-07T08:00:00Z");
assert.equal(minutesSince(undefined, t0), Infinity);
assert.equal(minutesSince("2026-07-07T07:50:00Z", t0), 10);
assert.equal(formatAgo("2026-07-07T07:59:40Z", t0), "just now");
assert.equal(formatAgo("2026-07-07T07:46:00Z", t0), "14m ago");
assert.equal(formatAgo("2026-07-07T06:00:00Z", t0), "2h ago");
assert.equal(formatAgo(undefined, t0), "");

// missingUsageAgents: default-enabled (absent from prefs.agents) but logged-out
// agents still surface a hint; present or explicitly-disabled ones don't.
const freshPrefs = usagePrefsSchema.parse({}); // enabled, agents: {}
assert.deepEqual(missingUsageAgents(freshPrefs, []), ["claude", "codex", "grok"]);
assert.deepEqual(missingUsageAgents(freshPrefs, ["claude"]), ["codex", "grok"]);
const codexOff = usagePrefsSchema.parse({ agents: { codex: false } });
assert.deepEqual(missingUsageAgents(codexOff, []), ["claude", "grok"]);
// Master switch off → nothing is enabled, so nothing is "missing".
const allOff = usagePrefsSchema.parse({ enabled: false });
assert.deepEqual(missingUsageAgents(allOff, []), []);

// Normalized windows: only the ones with a reading, in display order, carrying
// the agent's inferred unit and whatever absolute numbers the source reported.
assert.deepEqual(
  normalizeUsageWindows("claude", claude).map((w) => [w.id, w.label, w.period, w.unit, w.percent]),
  [
    ["session", "5h", "rolling", "unknown", 10],
    ["weekly", "Week", "weekly", "unknown", 20]
  ]
);
assert.deepEqual(
  normalizeUsageWindows("grok", weekOnly).map((w) => [w.id, w.unit]),
  [["weekly", "credits"]]
);
assert.deepEqual(normalizeUsageWindows("claude", { session: null, weekly: null }), []);
assert.equal(usageUnitFor("grok"), "credits");
assert.equal(usageUnitFor("codex"), "unknown");
// Long labels: the weekly slot is not always a calendar week (Grok bills a
// period, some Codex plans run longer than 7 days), so it stays generic.
assert.deepEqual(
  normalizeUsageWindows("claude", claude).map((w) => w.longLabel),
  ["Session (5h)", "Current period"]
);
// Presentation fields win over the wire window: the daemon shape only carries
// numbers today, but a future `label`/`period`/`unit` field must not clobber
// them (i.e. `...src` has to be spread FIRST).
const intruder = { percent: 42, id: "wire", label: "wire", longLabel: "wire", period: "hourly", unit: "tokens" } as unknown as UsageWindow;
assert.deepEqual(normalizeUsageWindows("grok", { session: null, weekly: intruder }), [
  { id: "weekly", label: "Week", longLabel: "Current period", period: "weekly", unit: "credits", percent: 42 }
]);
// Model-scoped weekly caps (Claude's Fable bar) append after session/weekly,
// labeled with the provider's model name and keyed uniquely per label.
assert.deepEqual(
  normalizeUsageWindows("claude", {
    session: { percent: 10 },
    weekly: { percent: 96, resetsAt: "2026-08-17T03:00:00Z" },
    scopedWindows: [{ label: "Fable", percent: 100, resetsAt: "2026-08-17T03:00:00Z" }]
  }).map((w) => [w.id, w.label, w.longLabel, w.period, w.percent, w.resetsAt]),
  [
    ["session", "5h", "Session (5h)", "rolling", 10, undefined],
    ["weekly", "Week", "Current period", "weekly", 96, "2026-08-17T03:00:00Z"],
    ["scoped:Fable", "Fable", "Fable (week)", "weekly", 100, "2026-08-17T03:00:00Z"]
  ]
);
// A scoped window still renders when the main windows are absent.
assert.deepEqual(
  normalizeUsageWindows("claude", { session: null, weekly: null, scopedWindows: [{ label: "Fable", percent: 40 }] }).map(
    (w) => [w.id, w.percent]
  ),
  [["scoped:Fable", 40]]
);

// Capacity fields survive normalization.
const capped = normalizeUsageWindows("grok", {
  session: null,
  weekly: { percent: 70, used: 700, limit: 1000, remaining: 300, resetsAt: "2026-07-07T10:00:00Z" }
})[0];
assert.equal(capped.used, 700);
assert.equal(capped.resetsAt, "2026-07-07T10:00:00Z");

// Compact counts and unit-suffixed amounts.
assert.equal(compactCount(616), "616");
assert.equal(compactCount(137_333), "137k");
assert.equal(compactCount(84_812_345), "84.8M");
assert.equal(compactCount(2_500_000_000), "2.5B");
// Capacity amounts stay exact (locale-grouped), unlike the compact token counts.
const grouped = (n: number) => new Intl.NumberFormat().format(n);
assert.equal(formatUsageAmount(1_500, "credits"), `${grouped(1500)} credits`);
assert.equal(formatUsageAmount(1_500, "unknown"), grouped(1500));
assert.equal(formatUsageAmount(undefined, "credits"), "—");

// Capacity line: only rendered from numbers that exist.
assert.equal(formatUsageCapacity(capped), `${grouped(700)} / ${grouped(1000)} credits · ${grouped(300)} left`);
assert.equal(
  formatUsageCapacity({ id: "weekly", label: "Week", longLabel: "This week", period: "weekly", unit: "unknown", percent: 20 }),
  ""
);

// Reset rendering per display format. The absolute half is locale/timezone
// dependent, so assert against the same Intl output rather than a fixed string.
const resetAt = "2026-07-07T10:29:00Z";
const clock = resetClock(resetAt, now);
assert.ok(clock.length > 0);
// A reset days out carries the date as well as the time.
const far = "2026-07-13T01:20:00Z";
assert.ok(resetClock(far, now).length > new Date(far).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }).length);
assert.equal(formatReset(resetAt, "relative", now), "Resets in 2h 29m");
assert.equal(formatReset(resetAt, "absolute", now), `Resets ${clock}`);
assert.equal(formatReset(resetAt, "both", now), `Resets in 2h 29m · ${clock}`);
// A reset already due keeps its period only when it ends the line.
assert.equal(formatReset("2026-07-07T07:59:00Z", "relative", now), "Resets now.");
assert.match(formatReset("2026-07-07T07:59:00Z", "both", now), /^Resets now · /);
// No reset time → no line at all, in every format.
for (const f of ["relative", "absolute", "both"] as const) assert.equal(formatReset(undefined, f, now), "");
// Unparseable timestamps degrade instead of printing "Invalid Date".
assert.equal(resetClock("not-a-date", now), "");
assert.equal(formatReset("not-a-date", "absolute", now), "Resets now.");

console.log("usage-format.check OK");
