import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SchedulePreset } from "./types.ts";
import { describeSchedule, isValidTimeZone, nextScheduleRun, nextRuns, presetToCron, validateCron } from "./schedule.ts";

describe("presetToCron", () => {
  it("derives 5-field crons", () => {
    assert.equal(presetToCron({ kind: "minutes", every: 15 }), "*/15 * * * *");
    assert.equal(presetToCron({ kind: "minutes", every: 1 }), "* * * * *");
    assert.equal(presetToCron({ kind: "hours", every: 2, atMinute: 30 }), "30 */2 * * *");
    assert.equal(presetToCron({ kind: "hours", every: 1, atMinute: 0 }), "0 * * * *");
    assert.equal(presetToCron({ kind: "daily", time: "16:00" }), "0 16 * * *");
    assert.equal(presetToCron({ kind: "daily", time: "09:05" }), "5 9 * * *");
    assert.equal(presetToCron({ kind: "weekly", days: [5, 1, 5], time: "16:00" }), "0 16 * * 1,5");
    assert.equal(presetToCron({ kind: "monthly", day: 1, time: "09:00" }), "0 9 1 * *");
    assert.equal(presetToCron({ kind: "cron" }), null);
  });

  it("every derived cron is valid", () => {
    const presets: SchedulePreset[] = [
      { kind: "minutes", every: 59 },
      { kind: "hours", every: 23, atMinute: 59 },
      { kind: "daily", time: "23:59" },
      { kind: "weekly", days: [0, 6], time: "00:00" },
      { kind: "monthly", day: 31, time: "12:00" }
    ];
    for (const preset of presets) {
      assert.equal(validateCron(presetToCron(preset)!, "UTC"), null, JSON.stringify(preset));
    }
  });
});

describe("describeSchedule", () => {
  it("speaks the preset", () => {
    assert.equal(describeSchedule({ kind: "minutes", every: 15 }, "*/15 * * * *"), "Every 15 min");
    assert.equal(describeSchedule({ kind: "minutes", every: 1 }, "* * * * *"), "Every minute");
    assert.equal(describeSchedule({ kind: "hours", every: 2, atMinute: 30 }, "30 */2 * * *"), "Every 2 h at :30");
    assert.equal(describeSchedule({ kind: "hours", every: 2, atMinute: 0 }, "0 */2 * * *"), "Every 2 h");
    assert.equal(describeSchedule({ kind: "hours", every: 1, atMinute: 5 }, "5 * * * *"), "Every hour at :05");
    assert.equal(describeSchedule({ kind: "daily", time: "16:00" }, "0 16 * * *"), "Daily at 16:00");
    assert.equal(describeSchedule({ kind: "weekly", days: [1, 5], time: "16:00" }, "0 16 * * 1,5"), "Mon, Fri at 16:00");
    assert.equal(describeSchedule({ kind: "weekly", days: [0, 3], time: "08:00" }, "0 8 * * 0,3"), "Wed, Sun at 08:00");
    assert.equal(
      describeSchedule({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" }, "30 7 * * 1,2,3,4,5"),
      "Weekdays at 07:30"
    );
    assert.equal(describeSchedule({ kind: "weekly", days: [0, 6], time: "10:00" }, "0 10 * * 0,6"), "Weekends at 10:00");
    assert.equal(
      describeSchedule({ kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "10:00" }, "0 10 * * 0,1,2,3,4,5,6"),
      "Daily at 10:00"
    );
    assert.equal(describeSchedule({ kind: "monthly", day: 1, time: "09:00" }, "0 9 1 * *"), "Monthly on day 1 at 09:00");
  });

  it("falls back to the cron when the preset is cron or no longer matches", () => {
    assert.equal(describeSchedule({ kind: "cron" }, "0 16 * * 1,5"), "Cron 0 16 * * 1,5");
    assert.equal(describeSchedule({ kind: "daily", time: "16:00" }, "0  17 * * *"), "Cron 0 17 * * *");
  });
});

describe("validateCron", () => {
  it("accepts 5 fields, nicknames and 6 fields with a fixed second", () => {
    assert.equal(validateCron("*/5 * * * *", "UTC"), null);
    assert.equal(validateCron("  0 16 * * 1,5 ", "Europe/Madrid"), null);
    assert.equal(validateCron("@daily", "UTC"), null);
    assert.equal(validateCron("30 0 12 * * *", "UTC"), null);
    assert.equal(validateCron("0 0 L * *", "UTC"), null, "croner's last-day-of-month");
  });

  it("refuses the rest with a reason", () => {
    assert.match(validateCron("", "UTC")!, /no cron/);
    assert.match(validateCron("* * *", "UTC")!, /5 fields/);
    assert.match(validateCron("* * * * * * *", "UTC")!, /5 fields/);
    assert.match(validateCron("*/10 * * * * *", "UTC")!, /once a minute/);
    assert.match(validateCron("0,30 * * * * *", "UTC")!, /once a minute/);
    assert.match(validateCron("61 * * * *", "UTC")!, /Invalid cron/);
    assert.match(validateCron("0 0 30 2 *", "UTC")!, /never fires/);
    assert.match(validateCron("0 9 * * *", "Mars/Olympus")!, /Unknown time zone/);
    assert.match(validateCron("0 9 * * *", "")!, /Unknown time zone/);
  });

  it("time zones", () => {
    assert.equal(isValidTimeZone("Europe/Madrid"), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Nowhere/Land"), false);
    assert.equal(isValidTimeZone(""), false);
  });
});

describe("nextRuns", () => {
  it("every 15 minutes, from a given instant, in UTC ISO", () => {
    assert.deepEqual(nextRuns("*/15 * * * *", "UTC", 3, "2026-09-28T10:07:00Z"), [
      "2026-09-28T10:15:00.000Z",
      "2026-09-28T10:30:00.000Z",
      "2026-09-28T10:45:00.000Z"
    ]);
    assert.equal(nextScheduleRun("0 16 * * *", "UTC", new Date("2026-09-28T17:00:00Z")), "2026-09-29T16:00:00.000Z");
  });

  it("a daily time follows the zone's wall clock across the spring DST change", () => {
    // Europe/Madrid moves from UTC+1 to UTC+2 on 2026-03-29.
    assert.deepEqual(nextRuns("0 16 * * *", "Europe/Madrid", 4, "2026-03-27T00:00:00Z"), [
      "2026-03-27T15:00:00.000Z",
      "2026-03-28T15:00:00.000Z",
      "2026-03-29T14:00:00.000Z",
      "2026-03-30T14:00:00.000Z"
    ]);
  });

  it("a time that does not exist on the spring-forward day still fires once that day", () => {
    const runs = nextRuns("30 2 * * *", "Europe/Madrid", 4, "2026-03-27T00:00:00Z");
    assert.equal(runs.length, 4);
    assert.equal(runs.filter((run) => run.startsWith("2026-03-29")).length, 1);
    assert.equal(runs[3], "2026-03-30T00:30:00.000Z");
  });

  it("a time repeated on the fall-back day fires once", () => {
    // Europe/Madrid returns to UTC+1 on 2026-10-25; 02:30 happens twice.
    const runs = nextRuns("30 2 * * *", "Europe/Madrid", 4, "2026-10-23T00:00:00Z");
    assert.deepEqual(runs, [
      "2026-10-23T00:30:00.000Z",
      "2026-10-24T00:30:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z"
    ]);
  });

  it("other zones", () => {
    // New York on the day it leaves DST.
    assert.deepEqual(nextRuns("0 9 * * *", "America/New_York", 2, "2026-10-31T00:00:00Z"), [
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z"
    ]);
    assert.deepEqual(nextRuns("0 9 * * 1", "Asia/Kolkata", 1, "2026-09-28T00:00:00Z"), ["2026-09-28T03:30:00.000Z"]);
  });

  it("an invalid cron or zone yields nothing", () => {
    assert.deepEqual(nextRuns("nope", "UTC", 3), []);
    assert.deepEqual(nextRuns("* * * * *", "Nowhere/Land", 3), []);
    assert.deepEqual(nextRuns("* * * * *", "UTC", 0), []);
    assert.equal(nextScheduleRun("0 0 30 2 *", "UTC"), null);
  });
});
