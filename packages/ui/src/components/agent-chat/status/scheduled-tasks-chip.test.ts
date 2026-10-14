import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ScheduledTask } from "@orquester/api";

import { deriveScheduledChip, deriveScheduledTaskRow, formatTaskTime, sortScheduledTasks } from "./scheduled-tasks-chip";

const now = new Date("2026-10-14T10:00:00.000Z");
const opts = { locale: "en-GB", timeZone: "UTC" };

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    threadId: "s1",
    projectPath: "/w/ws/app",
    prompt: "Check CI",
    schedule: { kind: "cron", cron: "0 * * * *", timezone: "UTC" },
    enabled: true,
    createdAt: "2026-10-14T08:00:00.000Z",
    updatedAt: "2026-10-14T08:00:00.000Z",
    createdByThreadId: null,
    nextRunAt: "2026-10-14T11:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    runCount: 0,
    queuedAt: null,
    ...overrides
  };
}

describe("scheduled tasks chip", () => {
  it("is absent without tasks", () => {
    assert.equal(deriveScheduledChip([], now, opts), null);
  });

  it("counts the tasks and names the next run", () => {
    const chip = deriveScheduledChip([task(), task({ id: "t2", nextRunAt: "2026-10-14T10:30:00.000Z" })], now, opts)!;
    assert.equal(chip.label, "2 scheduled");
    assert.equal(chip.title, "2 scheduled tasks · next at 10:30");
    assert.equal(chip.tone, "neutral");
  });

  it("reads in motion while a run waits, warn after a failed or missed run", () => {
    assert.equal(deriveScheduledChip([task({ queuedAt: "2026-10-14T09:59:00.000Z" })], now, opts)!.tone, "info");
    assert.match(deriveScheduledChip([task({ queuedAt: "2026-10-14T09:59:00.000Z" })], now, opts)!.title, /1 waiting for the turn to end/);
    assert.equal(deriveScheduledChip([task({ lastRunStatus: "missed" })], now, opts)!.tone, "warn");
  });

  it("sorts soonest first, paused last", () => {
    const sorted = sortScheduledTasks([task({ id: "paused", enabled: false, nextRunAt: null }), task({ id: "later" }), task({ id: "sooner", nextRunAt: "2026-10-14T10:05:00.000Z" })]);
    assert.deepEqual(sorted.map((t) => t.id), ["sooner", "later", "paused"]);
  });
});

describe("scheduled task rows", () => {
  it("describe the schedule and what happens next", () => {
    assert.deepEqual(deriveScheduledTaskRow(task({ runCount: 2 }), now, opts), {
      id: "t1",
      prompt: "Check CI",
      schedule: "Cron 0 * * * * (UTC)",
      status: "Next 11:00 · ran 2×",
      tone: "neutral"
    });
    const once = deriveScheduledTaskRow(task({ schedule: { kind: "once", at: "2026-10-15T09:00:00.000Z" }, nextRunAt: "2026-10-15T09:00:00.000Z" }), now, opts);
    assert.equal(once.schedule, "Once at 15 Oct, 09:00");
  });

  it("say when a run waits, is paused, failed or was missed", () => {
    assert.equal(deriveScheduledTaskRow(task({ queuedAt: "x" }), now, opts).status, "Due — waiting for the running turn to end");
    assert.equal(deriveScheduledTaskRow(task({ enabled: false, nextRunAt: null }), now, opts).status, "Paused");
    assert.equal(
      deriveScheduledTaskRow(task({ enabled: false, nextRunAt: null, lastRunStatus: "missed" }), now, opts).status,
      "Paused — missed while Orquester was not running"
    );
    const failed = deriveScheduledTaskRow(task({ lastRunStatus: "failed", lastRunError: "The thread refused it." }), now, opts);
    assert.equal(failed.status, "Last run failed: The thread refused it.");
    assert.equal(failed.tone, "warn");
    assert.equal(deriveScheduledTaskRow(task({ lastRunStatus: "missed" }), now, opts).status, "Missed a run · next 11:00");
  });

  it("formats other years with the year", () => {
    assert.equal(formatTaskTime("2027-01-02T03:04:00.000Z", now, opts), "2 Jan 2027, 03:04");
  });
});
