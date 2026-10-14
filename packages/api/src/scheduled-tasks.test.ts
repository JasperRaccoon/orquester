import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isScheduledTaskMessage,
  scheduledTaskTimeOrder,
  firstScheduledTaskRun,
  scheduledTaskScheduleProblem
} from "./scheduled-tasks.ts";

const now = new Date("2026-10-14T10:07:30.000Z");

test("a cron's first run is computed in its own time zone, strictly after now", () => {
  // 09:00 Berlin is 07:00 UTC in October (CEST): today's has passed, Thursday's is next.
  assert.equal(
    firstScheduledTaskRun({ kind: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Berlin" }, now),
    "2026-10-15T07:00:00.000Z"
  );
  assert.equal(firstScheduledTaskRun({ kind: "cron", cron: "*/15 * * * *", timezone: "UTC" }, now), "2026-10-14T10:15:00.000Z");
  // After the DST switch (25 Oct) the same wall-clock time is an hour later in UTC.
  assert.equal(
    firstScheduledTaskRun({ kind: "cron", cron: "0 9 * * *", timezone: "Europe/Berlin" }, new Date("2026-10-25T12:00:00.000Z")),
    "2026-10-26T08:00:00.000Z"
  );
});

test("a one-shot's first run is its own time, normalised", () => {
  assert.equal(firstScheduledTaskRun({ kind: "once", at: "2026-10-14T12:00:00+02:00" }, now), "2026-10-14T10:00:00.000Z");
});

test("schedule problems", () => {
  assert.equal(scheduledTaskScheduleProblem({ kind: "once", at: "2026-10-14T11:00:00.000Z" }, now), null);
  assert.match(scheduledTaskScheduleProblem({ kind: "once", at: "2026-10-14T10:00:00.000Z" }, now)!, /future/);
  assert.match(scheduledTaskScheduleProblem({ kind: "once", at: "tomorrow" }, now)!, /ISO/);
  assert.match(scheduledTaskScheduleProblem({ kind: "once", at: "2028-01-01T00:00:00.000Z" }, now)!, /within 366 days/);
  assert.equal(scheduledTaskScheduleProblem({ kind: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Berlin" }, now), null);
  assert.match(scheduledTaskScheduleProblem({ kind: "cron", cron: "0 9 * *", timezone: "UTC" }, now)!, /5 fields/);
  assert.match(scheduledTaskScheduleProblem({ kind: "cron", cron: "0 9 * * *", timezone: "Mars/Base" }, now)!, /time zone/);
  assert.match(scheduledTaskScheduleProblem({ kind: "cron", cron: "*/5 * * * * *", timezone: "UTC" }, now)!, /a task runs at most once a minute/);
});

test("a scheduler-sent message is recognised by its context chip", () => {
  assert.equal(isScheduledTaskMessage({ context: [{ kind: "scheduled-task" }] }), true);
  assert.equal(isScheduledTaskMessage({ context: [{ kind: "file" }] }), false);
  assert.equal(isScheduledTaskMessage({}), false);
});

test("time order: numeric, offsets respected, missing last", () => {
  assert.ok(scheduledTaskTimeOrder("2026-10-14T12:00:00+02:00") < scheduledTaskTimeOrder("2026-10-14T10:30:00Z"));
  assert.equal(scheduledTaskTimeOrder(null), Number.MAX_SAFE_INTEGER);
  assert.equal(scheduledTaskTimeOrder("nope"), Number.MAX_SAFE_INTEGER);
});
