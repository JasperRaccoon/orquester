import { test } from "node:test";
import assert from "node:assert/strict";

import { parseScheduledTasksFile, scheduledTasksPath, serializeScheduledTasksFile } from "./index.ts";

const task = {
  id: "t1",
  threadId: "s1",
  projectPath: "/w/ws/app",
  prompt: "Check the deploy",
  schedule: { kind: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Berlin" },
  createdAt: "2026-10-14T08:00:00.000Z",
  updatedAt: "2026-10-14T08:00:00.000Z"
};

test("scheduledTasksPath lives in the daemon dir", () => {
  assert.match(scheduledTasksPath("/appdir"), /\/appdir\/daemon\/scheduled-tasks\.json$/);
});

test("a minimal record gets its defaults", () => {
  const file = parseScheduledTasksFile({ version: 1, tasks: [task] });
  assert.equal(file.tasks.length, 1);
  assert.deepEqual(
    {
      enabled: file.tasks[0]!.enabled,
      nextRunAt: file.tasks[0]!.nextRunAt,
      lastRunStatus: file.tasks[0]!.lastRunStatus,
      runCount: file.tasks[0]!.runCount,
      pending: file.tasks[0]!.pending,
      createdByThreadId: file.tasks[0]!.createdByThreadId
    },
    { enabled: true, nextRunAt: null, lastRunStatus: null, runCount: 0, pending: null, createdByThreadId: null }
  );
});

test("unknown fields, unknown records and unknown top-level keys survive a rewrite", () => {
  const newer = { ...task, id: "t2", schedule: { kind: "webhook", path: "/x" } };
  const repeated = { ...task, prompt: "second copy" };
  const raw = {
    version: 1,
    note: { kept: true },
    tasks: [{ ...task, futureField: 7, schedule: { ...task.schedule, jitter: 3 } }, newer, repeated, "junk"]
  };
  const file = parseScheduledTasksFile(raw);
  assert.deepEqual(file.tasks.map((t) => t.id), ["t1"]);
  assert.deepEqual(file.rejected, [newer, repeated, "junk"]);
  assert.deepEqual(file.extra, { note: { kept: true } });
  const again = JSON.parse(serializeScheduledTasksFile(file)) as Record<string, unknown>;
  assert.deepEqual(again.note, { kept: true });
  const tasks = again.tasks as Record<string, unknown>[];
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0]!.futureField, 7);
  assert.deepEqual(tasks[0]!.schedule, { ...task.schedule, jitter: 3 });
  assert.deepEqual(tasks.slice(1), [newer, repeated, "junk"]);
});

test("another version or a broken outer shape throws (the daemon moves the file aside)", () => {
  assert.throws(() => parseScheduledTasksFile({ version: 2, tasks: [] }), /version-1/);
  assert.throws(() => parseScheduledTasksFile({ version: 1, tasks: "nope" }), /version-1/);
  assert.throws(() => parseScheduledTasksFile(null), /version-1/);
});
