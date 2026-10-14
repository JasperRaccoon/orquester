import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { scheduledTaskRoutes, type ScheduledTaskErrorCode } from "@orquester/api";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { ManualClock } from "../workflows/testing/manual-trigger-clock.ts";
import { silentLogger } from "../workflows/triggers/test-support.ts";
import { registerScheduledTaskRoutes } from "./routes.ts";
import { ScheduledTasksService } from "./service.ts";
import { ScheduledTasksStore } from "./store.ts";

async function app(t: test.TestContext, withService = true) {
  const root = await mkdtemp(join(tmpdir(), "orq-scheduled-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = new FakeDaemonApi().on("GET", "/api/sessions", {
    status: 200,
    body: [{ id: "chat-1", kind: "agent-chat", projectPath: "/w/ws/app" }]
  });
  const store = new ScheduledTasksStore(join(root, "scheduled-tasks.json"));
  await store.load();
  const service = new ScheduledTasksService({ store, clock: new ManualClock("2026-10-14T10:00:00.000Z"), logger: silentLogger, publish() {} });
  await service.start(api);
  t.after(() => service.stop());
  const server = Fastify();
  registerScheduledTaskRoutes(server, { service: () => (withService ? service : null) });
  t.after(() => server.close());
  return server;
}

test("create, read, list by thread and by project, update, delete", async (t) => {
  const server = await app(t);
  const created = await server.inject({
    method: "POST",
    url: scheduledTaskRoutes.list,
    payload: { threadId: "chat-1", prompt: "Hi", schedule: { kind: "cron", cron: "0 9 * * *", timezone: "UTC" } }
  });
  assert.equal(created.statusCode, 201);
  const task = created.json() as { id: string; nextRunAt: string };
  assert.equal(task.nextRunAt, "2026-10-15T09:00:00.000Z");
  assert.equal((await server.inject({ method: "GET", url: scheduledTaskRoutes.item(task.id) })).statusCode, 200);
  const byThread = await server.inject({ method: "GET", url: `${scheduledTaskRoutes.list}?threadId=chat-1` });
  assert.equal((byThread.json() as { tasks: unknown[] }).tasks.length, 1);
  const otherProject = await server.inject({ method: "GET", url: `${scheduledTaskRoutes.list}?projectPath=/w/ws/other` });
  assert.equal((otherProject.json() as { tasks: unknown[] }).tasks.length, 0);
  const updated = await server.inject({ method: "PUT", url: scheduledTaskRoutes.item(task.id), payload: { enabled: false } });
  assert.equal((updated.json() as { enabled: boolean }).enabled, false);
  assert.equal((await server.inject({ method: "DELETE", url: scheduledTaskRoutes.item(task.id) })).statusCode, 204);
  const gone = await server.inject({ method: "DELETE", url: scheduledTaskRoutes.item(task.id) });
  assert.equal(gone.statusCode, 404);
  assert.deepEqual(gone.json(), { code: "SCHEDULED_TASK_NOT_FOUND", message: `No scheduled task with id "${task.id}".` });
});

test("refusals are flat { code, message }", async (t) => {
  const server = await app(t);
  const res = await server.inject({ method: "POST", url: scheduledTaskRoutes.list, payload: { threadId: "chat-1", prompt: "Hi", schedule: { kind: "never" } } });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code: string }).code, "INVALID_REQUEST");
});

test("without a service every route answers 503", async (t) => {
  const server = await app(t, false);
  const res = await server.inject({ method: "GET", url: scheduledTaskRoutes.list });
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as { code: string }).code, "SCHEDULER_UNAVAILABLE");
});

test("an unexpected failure answers 500 INTERNAL, a listed refusal code, without its cause (D-M6)", async (t) => {
  const server = Fastify();
  const broken = {
    update: async () => {
      throw new Error("EACCES: /secret/path");
    }
  } as unknown as ScheduledTasksService;
  registerScheduledTaskRoutes(server, { service: () => broken });
  t.after(() => server.close());
  const errors = t.mock.method(console, "error", () => undefined);
  const res = await server.inject({ method: "PUT", url: scheduledTaskRoutes.item("x"), payload: { enabled: false } });
  assert.equal(res.statusCode, 500);
  const code: ScheduledTaskErrorCode = (res.json() as { code: ScheduledTaskErrorCode }).code;
  assert.deepEqual(res.json(), { code: "INTERNAL", message: "The scheduled-task operation failed." });
  assert.equal(code, "INTERNAL");
  assert.equal(errors.mock.callCount(), 1);
});
