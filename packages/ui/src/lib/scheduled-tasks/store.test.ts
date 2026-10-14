import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ScheduledTask, ScheduledTaskListResponse } from "@orquester/api";

import {
  applyScheduledTaskEvent,
  cancelScheduledTask,
  loadThreadScheduledTasks,
  markScheduledTasksStale,
  resetScheduledTasks,
  runScheduledTaskNow,
  sanitizeScheduledTask,
  scheduledTasksStore,
  type ScheduledTasksApi
} from "./store";

function task(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
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

function fakeApi(list: () => Promise<{ tasks: unknown[] }>): ScheduledTasksApi & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    connection: { id: "c1" },
    deleted,
    listScheduledTasks: () => list() as Promise<ScheduledTaskListResponse>,
    deleteScheduledTask: async (id) => {
      deleted.push(id);
    },
    runScheduledTaskNow: async (id) => ({ task: task(id, { runCount: 1 }), delivered: true })
  };
}

const ids = (threadId = "s1") =>
  [...scheduledTasksStore.getState().tasks.values()].filter((t) => t.threadId === threadId).map((t) => t.id).sort();

describe("scheduled tasks store", () => {
  beforeEach(() => resetScheduledTasks());

  it("sanitises the wire: a task without a usable schedule is dropped, odd fields repaired", () => {
    assert.equal(sanitizeScheduledTask({ ...task("a"), schedule: { kind: "webhook" } }), null);
    assert.equal(sanitizeScheduledTask({ id: "a" }), null);
    const repaired = sanitizeScheduledTask({ ...task("a"), lastRunStatus: "exploded", runCount: -3, queuedAt: 7 })!;
    assert.equal(repaired.lastRunStatus, null);
    assert.equal(repaired.runCount, 0);
    assert.equal(repaired.queuedAt, null);
  });

  it("a load replaces the thread's tasks; events upsert and delete; a deleted id never comes back", async () => {
    await loadThreadScheduledTasks(fakeApi(async () => ({ tasks: [task("a"), task("b"), task("x", { threadId: "other" })] })), "s1");
    assert.deepEqual(ids(), ["a", "b"]);
    assert.deepEqual(ids("other"), [], "another thread's task in the answer is not taken");
    applyScheduledTaskEvent({ type: "scheduledTask.upserted", payload: task("c") });
    applyScheduledTaskEvent({ type: "scheduledTask.deleted", payload: { id: "a", threadId: "s1" } });
    applyScheduledTaskEvent({ type: "scheduledTask.upserted", payload: task("a") });
    applyScheduledTaskEvent({ type: "scheduledTask.upserted", payload: { nonsense: true } });
    assert.deepEqual(ids(), ["b", "c"]);
  });

  it("an event that lands during a load wins over the load's answer", async () => {
    let answer!: (value: { tasks: unknown[] }) => void;
    const loading = loadThreadScheduledTasks(fakeApi(() => new Promise((resolve) => (answer = resolve))), "s1");
    applyScheduledTaskEvent({ type: "scheduledTask.upserted", payload: task("new", { prompt: "fresh" }) });
    answer({ tasks: [task("old")] });
    await loading;
    assert.deepEqual(ids(), ["new", "old"]);
    assert.equal(scheduledTasksStore.getState().tasks.get("new")!.prompt, "fresh");
    assert.equal(scheduledTasksStore.getState().loads.s1!.status, "loaded");
  });

  it("a reconnect marks loads stale", async () => {
    await loadThreadScheduledTasks(fakeApi(async () => ({ tasks: [] })), "s1");
    markScheduledTasksStale();
    assert.equal(scheduledTasksStore.getState().loads.s1!.stale, true);
  });

  it("cancel deletes; run now applies the daemon's answer; a failure becomes the thread's notice", async () => {
    const api = fakeApi(async () => ({ tasks: [task("a"), task("b")] }));
    await loadThreadScheduledTasks(api, "s1");
    await cancelScheduledTask(api, task("a"));
    assert.deepEqual(api.deleted, ["a"]);
    assert.deepEqual(ids(), ["b"]);
    await runScheduledTaskNow(api, task("b"));
    assert.equal(scheduledTasksStore.getState().tasks.get("b")!.runCount, 1);

    const failing: ScheduledTasksApi = {
      ...api,
      runScheduledTaskNow: async () => {
        throw Object.assign(new Error("409"), { body: { code: "ALREADY_QUEUED", message: "A delivery already waits." } });
      }
    };
    await runScheduledTaskNow(failing, task("b"));
    assert.equal(scheduledTasksStore.getState().notices.s1, "Couldn't run the task: A delivery already waits.");
    assert.equal(scheduledTasksStore.getState().busy.size, 0);
  });
});
