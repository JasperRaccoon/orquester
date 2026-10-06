import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextScheduleRun, nextRuns, presetToCron, scheduleIntervalProblem, validateCron } from "./schedule.ts";

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
    for (const [cron, zone] of [
      ["", "UTC"], ["* * *", "UTC"], ["* * * * * * *", "UTC"],
      ["*/10 * * * * *", "UTC"], ["0,30 * * * * *", "UTC"], ["61 * * * *", "UTC"],
      ["0 0 30 2 *", "UTC"], ["0 9 * * *", "Mars/Olympus"], ["0 9 * * *", ""]
    ]) {
      assert.ok(validateCron(cron!, zone!), `${cron} in ${zone} must be rejected`);
    }
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

describe("DST", () => {
  it("America/New_York fall-back: a sub-daily cron fires in the repeated hour too", () => {
    // 2026-11-01: 01:00–02:00 EDT (05:00–06:00Z), then 01:00–02:00 EST again (06:00–07:00Z).
    assert.deepEqual(nextRuns("*/30 * * * *", "America/New_York", 6, "2026-11-01T04:50:00Z"), [
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:30:00.000Z"
    ]);
    assert.deepEqual(nextRuns("0 * * * *", "America/New_York", 3, "2026-11-01T04:50:00Z"), [
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T07:00:00.000Z"
    ]);
    // One step at a time, as the scheduler chains it, reaches the repeated hour too.
    const chained: string[] = [];
    let at = "2026-11-01T05:15:00.000Z";
    for (let i = 0; i < 4; i += 1) {
      at = nextScheduleRun("*/30 * * * *", "America/New_York", at)!;
      chained.push(at);
    }
    assert.deepEqual(chained, ["2026-11-01T05:30:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T07:00:00.000Z"]);
  });

  it("Europe/Berlin fall-back: the repeated 02:00–03:00 fires twice for an hourly cron", () => {
    // 2026-10-25: 02:00–03:00 CEST (00:00–01:00Z), then 02:00–03:00 CET (01:00–02:00Z).
    assert.deepEqual(nextRuns("15 * * * *", "Europe/Berlin", 4, "2026-10-24T23:30:00Z"), [
      "2026-10-25T00:15:00.000Z",
      "2026-10-25T01:15:00.000Z",
      "2026-10-25T02:15:00.000Z",
      "2026-10-25T03:15:00.000Z"
    ]);
  });

  it("spring-forward never repeats or reorders instants", () => {
    for (const [zone, from] of [
      ["America/New_York", "2026-03-08T06:10:00Z"],
      ["Europe/Berlin", "2026-03-29T00:10:00Z"]
    ] as const) {
      const runs = nextRuns("*/30 * * * *", zone, 8, from);
      assert.equal(runs.length, 8);
      for (let i = 1; i < runs.length; i += 1) assert.ok(runs[i]! > runs[i - 1]!, `${zone}: ${runs.join(", ")}`);
      assert.equal(new Set(runs).size, runs.length);
    }
    assert.deepEqual(nextRuns("*/30 * * * *", "America/New_York", 4, "2026-03-08T06:10:00Z"), [
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T08:00:00.000Z"
    ]);
  });
});

describe("scheduleIntervalProblem", () => {
  it("accepts exactly the divisors of 60 (minutes) and 24 (hours)", () => {
    for (let every = 1; every <= 59; every += 1) {
      assert.equal(scheduleIntervalProblem({ kind: "minutes", every }) === null, 60 % every === 0 && every < 60, `minutes ${every}`);
    }
    for (let every = 1; every <= 23; every += 1) {
      assert.equal(scheduleIntervalProblem({ kind: "hours", every, atMinute: 0 }) === null, 24 % every === 0, `hours ${every}`);
    }
    assert.equal(scheduleIntervalProblem({ kind: "daily", time: "09:00" }), null);
  });
});
