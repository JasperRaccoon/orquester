/**
 * The scheduling toolkit end to end through the daemon's own routes: the strict argument parse
 * (`executeSessionToolCall`), the handlers, `/api/scheduled-tasks` and the scheduler behind it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { Broadcaster } from "../../broadcaster.ts";
import { InjectDaemonApi } from "../../mcp/daemon-api.ts";
import { registerScheduledTaskRoutes } from "../../scheduled-tasks/routes.ts";
import { ScheduledTasksService } from "../../scheduled-tasks/service.ts";
import { ScheduledTasksStore } from "../../scheduled-tasks/store.ts";
import { ManualClock } from "../../workflows/testing/manual-trigger-clock.ts";
import { silentLogger } from "../../workflows/triggers/test-support.ts";
import type { SessionToolContext } from "../contract.ts";
import { executeSessionToolCall } from "../executor.ts";
import { createSessionToolRegistry } from "../registry.ts";
import { schedulingToolkit } from "./index.ts";

const NOW = "2026-10-14T10:00:00.000Z";
const APP = "/w/ws/app";

const sessions = [
  { id: "me", kind: "agent-chat", projectPath: APP, chatSessionStatus: "ready", latestTurn: null },
  { id: "sibling", kind: "agent-chat", projectPath: APP, chatSessionStatus: "ready", latestTurn: null },
  { id: "elsewhere", kind: "agent-chat", projectPath: "/w/ws/other", chatSessionStatus: "ready", latestTurn: null },
  { id: "loose", kind: "agent-chat", projectPath: "", chatSessionStatus: "ready", latestTurn: null },
  { id: "loose-2", kind: "agent-chat", projectPath: "", chatSessionStatus: "ready", latestTurn: null },
  { id: "term", kind: "shell", projectPath: APP }
];

async function rig(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orq-scheduling-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(NOW);
  const app = Fastify();
  const turns: { threadId: string; body: unknown }[] = [];
  app.get("/api/sessions", async () => sessions);
  for (const session of sessions) {
    app.get(agentChatRoutes.thread(session.id), async () => ({
      kind: "snapshot",
      thread: { head: { session: { status: "ready", activeTurnId: null } }, items: [], turns: [], checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: 0 }
    }));
    app.post(agentChatRoutes.turn(session.id), async (request) => {
      turns.push({ threadId: session.id, body: request.body });
      return { seq: turns.length };
    });
  }
  const store = new ScheduledTasksStore(join(root, "scheduled-tasks.json"));
  await store.load();
  const service = new ScheduledTasksService({ store, clock, logger: silentLogger, publish() {} });
  registerScheduledTaskRoutes(app, { service: () => service });
  await app.ready();
  t.after(() => app.close());
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/w", workspacesDir: "/w" });
  await service.start(api);
  t.after(() => service.stop());
  const registry = createSessionToolRegistry([schedulingToolkit]);
  const call = async (threadId: string, name: string, args: unknown) => {
    const session = sessions.find((s) => s.id === threadId)!;
    const ctx: SessionToolContext = {
      threadId,
      projectPath: session.projectPath,
      cwd: session.projectPath,
      agentId: "claude",
      callId: "call-1",
      signal: new AbortController().signal,
      api,
      now: () => clock.now().getTime()
    };
    const result = await executeSessionToolCall(registry, { name, arguments: args }, ctx);
    return { error: result.isError === true, value: result.structuredContent as Record<string, any> };
  };
  return { call, turns, service, clock };
}

test("schedule_task: inMinutes, at and cron, defaulting to the calling thread", async (t) => {
  const { call } = await rig(t);
  const soon = await call("me", "schedule_task", { prompt: "Check CI", inMinutes: 30 });
  assert.equal(soon.error, false);
  assert.equal(soon.value.task.threadId, "me");
  assert.deepEqual(soon.value.task.schedule, { kind: "once", at: "2026-10-14T10:30:00.000Z" });
  assert.equal(soon.value.task.nextRunAt, "2026-10-14T10:30:00.000Z");
  assert.equal(soon.value.now, NOW);

  const at = await call("me", "schedule_task", { prompt: "Standup", at: "2026-10-15T09:00:00+02:00" });
  assert.equal(at.value.task.nextRunAt, "2026-10-15T07:00:00.000Z");

  const weekly = await call("me", "schedule_task", { prompt: "Report", cron: "0 9 * * 1", timezone: "Europe/Berlin" });
  assert.deepEqual(weekly.value.task.schedule, { kind: "cron", cron: "0 9 * * 1", timezone: "Europe/Berlin" });
  assert.equal(weekly.value.task.nextRunAt, "2026-10-19T07:00:00.000Z");
});

test("schedule_task: argument rules", async (t) => {
  const { call } = await rig(t);
  const codes = async (args: unknown) => (await call("me", "schedule_task", args)).value.code as string;
  assert.equal(await codes({ prompt: "x" }), "INVALID_ARGUMENT");
  assert.equal(await codes({ prompt: "x", inMinutes: 5, cron: "* * * * *" }), "INVALID_ARGUMENT");
  assert.equal(await codes({ prompt: "x", at: "2026-10-15T09:00:00Z", timezone: "UTC" }), "INVALID_ARGUMENT");
  assert.equal(await codes({ prompt: "x", inMinutes: 5, projectPath: "/w/ws/other" }), "INVALID_ARGUMENT", "unknown keys are refused");
  assert.equal(await codes({ prompt: "x", at: "2026-10-14T09:00:00Z" }), "INVALID_REQUEST", "the daemon refuses a past time");
  assert.equal(await codes({ prompt: "x", cron: "bad" }), "INVALID_REQUEST");
});

test("another thread: only a chat thread of the same project", async (t) => {
  const { call } = await rig(t);
  const ok = await call("me", "schedule_task", { prompt: "Hello sibling", inMinutes: 5, threadId: "sibling" });
  assert.equal(ok.value.task.threadId, "sibling");
  for (const threadId of ["elsewhere", "term", "nope"]) {
    const refused = await call("me", "schedule_task", { prompt: "x", inMinutes: 5, threadId });
    assert.equal(refused.value.code, "THREAD_NOT_FOUND", threadId);
  }
  // A thread bound to no project may target only itself.
  assert.equal((await call("loose", "schedule_task", { prompt: "x", inMinutes: 5, threadId: "loose-2" })).value.code, "THREAD_NOT_FOUND");
});

test("list, update, run now and delete stay inside the caller's project", async (t) => {
  const { call, turns } = await rig(t);
  const mine = (await call("me", "schedule_task", { prompt: "Mine", cron: "0 * * * *", timezone: "UTC" })).value.task;
  await call("sibling", "schedule_task", { prompt: "x".repeat(800), inMinutes: 10 });
  const theirs = (await call("elsewhere", "schedule_task", { prompt: "Other project", inMinutes: 10 })).value.task;

  const listed = await call("me", "list_scheduled_tasks", {});
  assert.deepEqual(listed.value.tasks.map((task: { threadId: string }) => task.threadId), ["sibling", "me"], "soonest first, this project only");
  assert.equal(listed.value.tasks[0].promptTruncated, true);
  assert.equal(listed.value.tasks[0].prompt.length, 500);
  assert.deepEqual((await call("me", "list_scheduled_tasks", { threadId: "me" })).value.tasks.map((task: { taskId: string }) => task.taskId), [mine.taskId]);

  for (const name of ["update_scheduled_task", "delete_scheduled_task", "run_scheduled_task_now"]) {
    const args = name === "update_scheduled_task" ? { taskId: theirs.taskId, enabled: false } : { taskId: theirs.taskId };
    assert.equal((await call("me", name, args)).value.code, "SCHEDULED_TASK_NOT_FOUND", name);
  }

  const rezoned = await call("me", "update_scheduled_task", { taskId: mine.taskId, timezone: "Asia/Kolkata" });
  assert.deepEqual(rezoned.value.task.schedule, { kind: "cron", cron: "0 * * * *", timezone: "Asia/Kolkata" });
  assert.equal(rezoned.value.task.nextRunAt, "2026-10-14T10:30:00.000Z", "on the hour in +05:30");
  assert.equal((await call("me", "update_scheduled_task", { taskId: mine.taskId })).value.code, "INVALID_ARGUMENT");

  const ran = await call("me", "run_scheduled_task_now", { taskId: mine.taskId });
  assert.equal(ran.value.delivered, true);
  assert.equal(ran.value.task.runCount, 1);
  assert.deepEqual(turns.map((turn) => turn.threadId), ["me"]);

  const deleted = await call("me", "delete_scheduled_task", { taskId: mine.taskId });
  assert.deepEqual(deleted.value, { deleted: true, taskId: mine.taskId });
  assert.equal((await call("me", "delete_scheduled_task", { taskId: mine.taskId })).value.code, "SCHEDULED_TASK_NOT_FOUND");
});
