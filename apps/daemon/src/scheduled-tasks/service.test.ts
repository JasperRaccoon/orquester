import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEDULED_TASK_MISSED_GRACE_MINUTES, type ScheduledTask, type ScheduledTaskDeletedPayload, type SessionSummary } from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { ManualClock } from "../workflows/testing/manual-trigger-clock.ts";
import { advance, silentLogger } from "../workflows/triggers/test-support.ts";
import { MISSED_RUN_GRACE_MINUTES } from "../workflows/triggers/scheduler.ts";
import { ScheduledTaskError, ScheduledTasksService, SCHEDULED_TASK_RETRY_MS } from "./service.ts";
import { ScheduledTasksStore } from "./store.ts";

const MIN = 60_000;
const THREAD = "chat-1";
const PROJECT = "/w/ws/app";

type Busy = "idle" | "running" | "approval";

interface Rig {
  root: string;
  file: string;
  clock: ManualClock;
  api: FakeDaemonApi;
  store: ScheduledTasksStore;
  service: ScheduledTasksService;
  events: { type: string; payload: ScheduledTask | ScheduledTaskDeletedPayload }[];
  /** What the session list says about the thread (`null`: the thread is gone). */
  summary: Busy | null;
  /** What the host's own snapshot says. */
  snapshot: Busy;
  turnStatus: number;
  turns: { commandId: string; input: string; context?: unknown }[];
  run(ms: number): Promise<void>;
  /** A fresh store + service on the same file, as after a daemon restart. */
  restart(): Promise<void>;
}

function summaryOf(state: Busy, id = THREAD): SessionSummary {
  return {
    id,
    kind: "agent-chat",
    refId: "claude",
    title: "Chat",
    projectPath: PROJECT,
    cwd: PROJECT,
    cols: 80,
    rows: 24,
    status: "running",
    order: 0,
    createdAt: "2026-10-14T08:00:00.000Z",
    chatSessionStatus: state === "running" ? "running" : "ready",
    latestTurn: { turnId: "t0", state: state === "running" ? "running" : "completed", startedAt: null, completedAt: null },
    hasPendingApprovals: state === "approval",
    hasPendingUserInput: false
  } as SessionSummary;
}

function snapshotOf(state: Busy) {
  return {
    kind: "snapshot",
    thread: {
      head: { session: { status: state === "running" ? "running" : "ready", activeTurnId: state === "running" ? "t1" : null } },
      items: [],
      turns: [{ turnId: "t0", state: state === "running" ? "running" : "completed" }],
      checkpoints: [],
      pending: { approvals: state === "approval" ? [{ requestId: "r1" }] : [], userInputs: [] },
      roster: [],
      seq: 1
    }
  };
}

async function rig(t: test.TestContext, start = "2026-10-14T10:07:30.000Z", opts: { file?: string; root?: string } = {}): Promise<Rig> {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "orq-scheduled-tasks-")));
  if (!opts.root) t.after(() => rm(root, { recursive: true, force: true }));
  const file = opts.file ?? join(root, "scheduled-tasks.json");
  const clock = new ManualClock(start);
  const api = new FakeDaemonApi();
  const r = {
    root,
    file,
    clock,
    api,
    events: [],
    summary: "idle",
    snapshot: "idle",
    turnStatus: 200,
    turns: []
  } as unknown as Rig;
  api.on("GET", "/api/sessions", () => ({
    status: 200,
    body: r.summary === null ? [] : [summaryOf(r.summary), { ...summaryOf("idle", "term-1"), kind: "shell" }]
  }));
  api.on("GET", agentChatRoutes.thread(THREAD), () => ({ status: 200, body: snapshotOf(r.snapshot) }));
  api.on("POST", agentChatRoutes.turn(THREAD), ({ body }) => {
    const turn = body as Rig["turns"][number];
    if (r.turnStatus < 400) r.turns.push(turn);
    return r.turnStatus < 400
      ? { status: 200, body: { seq: r.turns.length } }
      : { status: r.turnStatus, body: { error: { code: r.turnStatus === 409 ? "COMMAND_REJECTED" : "HOST_UNAVAILABLE", message: "The thread refused it." } } };
  });
  const boot = async () => {
    r.store = new ScheduledTasksStore(file, { warn() {}, error() {} });
    await r.store.load();
    let n = 0;
    r.service = new ScheduledTasksService({
      store: r.store,
      clock,
      logger: silentLogger,
      mintId: () => `task-${(n += 1)}`,
      publish: (type, payload) => r.events.push({ type, payload })
    });
    await r.service.start(api);
    t.after(() => r.service.stop());
  };
  r.run = (ms) => advance(clock, () => r.service.idle(), ms);
  r.restart = async () => {
    r.service.stop();
    await r.store.flush();
    await boot();
  };
  await boot();
  return r;
}

function cron(r: Rig, expr = "*/15 * * * *", timezone = "UTC") {
  return r.service.create({ threadId: THREAD, prompt: "Check the deploy", schedule: { kind: "cron", cron: expr, timezone }, createdByThreadId: THREAD });
}

test("the missed-run grace is the workflow schedule trigger's", () => {
  assert.equal(SCHEDULED_TASK_MISSED_GRACE_MINUTES, MISSED_RUN_GRACE_MINUTES);
});

test("a cron task is computed from now and delivered at its time through /turn, with an idempotent command id", async (t) => {
  const r = await rig(t);
  const task = await cron(r);
  assert.equal(task.nextRunAt, "2026-10-14T10:15:00.000Z");
  assert.equal(task.projectPath, PROJECT);
  assert.equal(task.createdByThreadId, THREAD);
  assert.deepEqual(r.events.map((e) => e.type), ["scheduledTask.upserted"]);

  await r.run(7 * MIN + 29_000);
  assert.equal(r.turns.length, 0, "not before its time");
  await r.run(1_000);
  assert.equal(r.turns.length, 1);
  assert.deepEqual(r.turns[0], {
    commandId: `scheduled-task:${task.id}:${Date.parse("2026-10-14T10:15:00.000Z")}`,
    input: "Check the deploy",
    interactionMode: "default",
    context: [{ kind: "scheduled-task", label: "Scheduled task", ref: task.id }]
  });
  const after = r.service.get(task.id)!;
  assert.equal(after.lastRunStatus, "delivered");
  assert.equal(after.runCount, 1);
  assert.equal(after.queuedAt, null);
  assert.equal(after.nextRunAt, "2026-10-14T10:30:00.000Z");

  await r.run(15 * MIN);
  assert.equal(r.turns.length, 2);
  assert.notEqual(r.turns[1]!.commandId, r.turns[0]!.commandId);
});

test("a cron in a time zone fires at that zone's wall-clock time", async (t) => {
  const r = await rig(t);
  const task = await cron(r, "30 12 * * *", "Europe/Berlin");
  // 12:30 CEST = 10:30 UTC.
  assert.equal(task.nextRunAt, "2026-10-14T10:30:00.000Z");
});

test("a busy thread gets the prompt only once its turn has ended — never as a steer", async (t) => {
  const r = await rig(t);
  const task = await cron(r);
  r.summary = "running";
  r.snapshot = "running";
  await r.run(8 * MIN);
  assert.equal(r.turns.length, 0);
  assert.notEqual(r.service.get(task.id)!.queuedAt, null, "queued");

  // The summary says idle, but the host's own snapshot still holds the turn: wait.
  r.summary = "idle";
  r.api.emit({ id: "e1", channel: "sessions", type: "session.updated", createdAt: "", payload: summaryOf("idle") });
  await r.service.idle();
  assert.equal(r.turns.length, 0);

  // An open approval holds it too.
  r.snapshot = "approval";
  r.api.emit({ id: "e2", channel: "sessions", type: "session.updated", createdAt: "", payload: summaryOf("idle") });
  await r.service.idle();
  assert.equal(r.turns.length, 0);

  r.snapshot = "idle";
  r.api.emit({ id: "e3", channel: "sessions", type: "session.updated", createdAt: "", payload: summaryOf("idle") });
  await r.service.idle();
  assert.equal(r.turns.length, 1);
  assert.equal(r.service.get(task.id)!.lastRunStatus, "delivered");
});

test("a queued delivery is retried by the timer when no event comes", async (t) => {
  const r = await rig(t);
  await cron(r);
  r.summary = "running";
  r.snapshot = "running";
  await r.run(8 * MIN);
  assert.equal(r.turns.length, 0);
  r.summary = "idle";
  r.snapshot = "idle";
  await r.run(SCHEDULED_TASK_RETRY_MS);
  assert.equal(r.turns.length, 1);
});

test("a run that comes due while the previous delivery waits is folded into it", async (t) => {
  const r = await rig(t);
  const task = await cron(r);
  r.summary = "running";
  r.snapshot = "running";
  await r.run(8 * MIN); // 10:15 queued
  await r.run(15 * MIN); // 10:30 due while still queued
  r.summary = "idle";
  r.snapshot = "idle";
  await r.run(SCHEDULED_TASK_RETRY_MS);
  await r.run(SCHEDULED_TASK_RETRY_MS);
  assert.equal(r.turns.length, 1, "one message for both");
  assert.equal(r.service.get(task.id)!.nextRunAt, "2026-10-14T10:45:00.000Z");
});

test("the queued delivery is on disk before it is sent", async (t) => {
  const r = await rig(t);
  const task = await cron(r);
  let onDisk: unknown = null;
  r.api.on("POST", agentChatRoutes.turn(THREAD), () => {
    onDisk = (JSON.parse(readFileSync(r.file, "utf8")) as { tasks: { pending: unknown }[] }).tasks[0]!.pending;
    return { status: 200, body: { seq: 1 } };
  });
  await r.run(8 * MIN);
  assert.deepEqual(onDisk, {
    fireKey: String(Date.parse("2026-10-14T10:15:00.000Z")),
    scheduledFor: "2026-10-14T10:15:00.000Z",
    queuedAt: "2026-10-14T10:15:00.000Z",
    manual: false
  });
  assert.equal(r.service.get(task.id)!.lastRunStatus, "delivered");
});

test("tasks survive a restart, and a delivery a restart interrupted is retried with the SAME command id", async (t) => {
  const r = await rig(t);
  const task = await cron(r);
  r.turnStatus = 503; // the host is down: the delivery stays queued
  await r.run(8 * MIN);
  assert.equal(r.turns.length, 0);
  assert.notEqual(r.service.get(task.id)!.queuedAt, null);

  r.turnStatus = 200;
  await r.restart();
  assert.equal(r.service.list().length, 1);
  assert.equal(r.service.get(task.id)!.nextRunAt, "2026-10-14T10:30:00.000Z");
  assert.equal(r.turns.length, 1, "boot retries the queued delivery");
  assert.equal(r.turns[0]!.commandId, `scheduled-task:${task.id}:${Date.parse("2026-10-14T10:15:00.000Z")}`);
  assert.equal(r.service.get(task.id)!.lastRunStatus, "delivered");
});

test("missed runs: past the grace nothing is sent; a cron moves on from now, a one-shot pauses", async (t) => {
  const r = await rig(t);
  const recurring = await cron(r, "0 * * * *"); // next 11:00
  const once = await r.service.create({ threadId: THREAD, prompt: "Ping", schedule: { kind: "once", at: "2026-10-14T10:30:00.000Z" } });
  // The daemon is down from 10:08 until 13:20.
  r.service.stop();
  await r.store.flush();
  r.clock.jump("2026-10-14T13:20:00.000Z");
  await r.restart();
  assert.equal(r.turns.length, 0, "nothing stale is delivered");
  const a = r.service.get(recurring.id)!;
  assert.equal(a.lastRunStatus, "missed");
  assert.match(a.lastRunError!, /2026-10-14T11:00:00.000Z/);
  assert.equal(a.nextRunAt, "2026-10-14T14:00:00.000Z");
  assert.equal(a.enabled, true);
  const b = r.service.get(once.id)!;
  assert.equal(b.lastRunStatus, "missed");
  assert.equal(b.enabled, false);
  assert.equal(b.nextRunAt, null);
});

test("a run within the grace is still delivered after a restart", async (t) => {
  const r = await rig(t);
  await cron(r); // 10:15
  r.service.stop();
  await r.store.flush();
  r.clock.jump(Date.parse("2026-10-14T10:15:00.000Z") + (MISSED_RUN_GRACE_MINUTES - 1) * MIN);
  await r.restart();
  assert.equal(r.turns.length, 1);
});

test("a one-shot's time is stored in UTC", async (t) => {
  const r = await rig(t);
  const task = await r.service.create({ threadId: THREAD, prompt: "Ping", schedule: { kind: "once", at: "2026-10-14T14:00:00+02:00" } });
  assert.equal(task.nextRunAt, "2026-10-14T12:00:00.000Z");
  assert.deepEqual(task.schedule, { kind: "once", at: "2026-10-14T12:00:00.000Z" });
});

test("a one-shot in the future is delivered at its time and removed", async (t) => {
  const r = await rig(t);
  const task = await r.service.create({ threadId: THREAD, prompt: "Ping", schedule: { kind: "once", at: "2026-10-14T10:20:00.000Z" } });
  await r.run(13 * MIN);
  assert.equal(r.turns.length, 1);
  assert.equal(r.service.get(task.id), undefined);
  assert.deepEqual(r.events.at(-1), { type: "scheduledTask.deleted", payload: { id: task.id, threadId: THREAD } });
  await r.run(60 * MIN);
  assert.equal(r.turns.length, 1);
});

test("closing the thread removes its tasks; so does a thread gone while the daemon was down", async (t) => {
  const r = await rig(t);
  const a = await cron(r);
  r.api.emit({ id: "e", channel: "sessions", type: "session.closed", createdAt: "", payload: { id: THREAD } });
  await r.service.idle();
  assert.equal(r.service.list().length, 0);
  assert.deepEqual(r.events.at(-1), { type: "scheduledTask.deleted", payload: { id: a.id, threadId: THREAD } });

  await cron(r);
  r.summary = null;
  await r.restart();
  assert.equal(r.service.list().length, 0);
  const onDisk = JSON.parse(await readFile(r.file, "utf8")) as { tasks: unknown[] };
  assert.equal(onDisk.tasks.length, 0);
});

test("a refused delivery is recorded as failed, with the host's reason", async (t) => {
  const r = await rig(t);
  const task = await cron(r);
  r.turnStatus = 409;
  await r.run(8 * MIN);
  const after = r.service.get(task.id)!;
  assert.equal(after.lastRunStatus, "failed");
  assert.equal(after.lastRunError, "The thread refused it.");
  assert.equal(after.queuedAt, null);
});

test("run now delivers at once, even when paused; a second one while queued is refused", async (t) => {
  const r = await rig(t);
  const task = await cron(r);
  await r.service.update(task.id, { enabled: false });
  const result = await r.service.runNow(task.id);
  assert.equal(result.delivered, true);
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0]!.commandId, new RegExp(`^scheduled-task:${task.id}:manual-`));
  assert.equal(result.task!.runCount, 1);
  assert.equal(result.task!.enabled, false);

  r.summary = "running";
  const queued = await r.service.runNow(task.id);
  assert.equal(queued.delivered, false);
  assert.notEqual(queued.task!.queuedAt, null);
  await assert.rejects(r.service.runNow(task.id), (error: unknown) => error instanceof ScheduledTaskError && error.code === "ALREADY_QUEUED");
});

test("pausing drops the next time and any waiting delivery; resuming recomputes from now", async (t) => {
  const r = await rig(t);
  const task = await cron(r);
  r.summary = "running";
  r.snapshot = "running";
  await r.run(8 * MIN);
  const paused = await r.service.update(task.id, { enabled: false });
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.queuedAt, null);
  r.summary = "idle";
  r.snapshot = "idle";
  await r.run(60 * MIN);
  assert.equal(r.turns.length, 0);
  const resumed = await r.service.update(task.id, { enabled: true, prompt: "  New prompt " });
  assert.equal(resumed.nextRunAt, "2026-10-14T11:30:00.000Z");
  assert.equal(resumed.prompt, "New prompt");
});

test("create refuses what it cannot schedule", async (t) => {
  const r = await rig(t);
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof ScheduledTaskError ? `${error.status} ${error.code}` : String(error);
    }
  };
  const at = (value: string) => ({ kind: "once" as const, at: value });
  assert.equal(await code(r.service.create({ threadId: "nope", prompt: "x", schedule: at("2026-10-14T11:00:00Z") })), "404 THREAD_NOT_FOUND");
  assert.equal(await code(r.service.create({ threadId: "term-1", prompt: "x", schedule: at("2026-10-14T11:00:00Z") })), "400 NOT_A_CHAT_SESSION");
  assert.equal(await code(r.service.create({ threadId: THREAD, prompt: "x", schedule: at("2026-10-14T09:00:00Z") })), "400 INVALID_REQUEST");
  assert.equal(await code(r.service.create({ threadId: THREAD, prompt: "  ", schedule: at("2026-10-14T11:00:00Z") })), "400 INVALID_REQUEST");
  assert.equal(await code(r.service.create({ threadId: THREAD, prompt: "x", schedule: { kind: "cron", cron: "* * *", timezone: "UTC" } })), "400 INVALID_REQUEST");
  assert.equal(await code(r.service.update("missing", { enabled: false })), "404 SCHEDULED_TASK_NOT_FOUND");
  assert.equal(r.service.list().length, 0);
});

test("a task this build cannot read stays in the file across rewrites", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-scheduled-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "scheduled-tasks.json");
  const foreign = { id: "x", threadId: THREAD, prompt: "p", schedule: { kind: "webhook" }, createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:00.000Z" };
  await writeFile(file, JSON.stringify({ version: 1, owner: "newer", tasks: [foreign] }));
  const r = await rig(t, undefined, { root, file });
  await cron(r);
  const onDisk = JSON.parse(await readFile(file, "utf8")) as { owner: string; tasks: { id: string }[] };
  assert.equal(onDisk.owner, "newer");
  assert.deepEqual(onDisk.tasks.map((task) => task.id).sort(), ["task-1", "x"]);
  assert.deepEqual(r.service.list().map((task) => task.id), ["task-1"]);
});
