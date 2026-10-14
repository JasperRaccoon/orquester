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
import { agentChatRoutes, parseThreadMessage } from "@orquester/api/agent-chat";
import { Broadcaster } from "../../broadcaster.ts";
import { InjectDaemonApi } from "../../mcp/daemon-api.ts";
import { registerScheduledTaskRoutes } from "../../scheduled-tasks/routes.ts";
import { ScheduledTasksService } from "../../scheduled-tasks/service.ts";
import { ScheduledTasksStore } from "../../scheduled-tasks/store.ts";
import { ManualClock } from "../../workflows/testing/manual-trigger-clock.ts";
import { advance, silentLogger } from "../../workflows/triggers/test-support.ts";
import type { SessionToolContext } from "../contract.ts";
import { executeSessionToolCall } from "../executor.ts";
import { createSessionToolRegistry } from "../registry.ts";
import { schedulingToolkit } from "./index.ts";

const NOW = "2026-10-14T10:00:00.000Z";
const APP = "/w/ws/app";

const sessions = [
  { id: "me", title: "Main", refId: "claude", kind: "agent-chat", projectPath: APP, chatSessionStatus: "ready", latestTurn: null },
  { id: "sibling", title: "Sibling", refId: "claude", kind: "agent-chat", projectPath: APP, chatSessionStatus: "ready", latestTurn: null },
  { id: "wide", title: "Wide open", refId: "claude", kind: "agent-chat", projectPath: APP, chatSessionStatus: "ready", latestTurn: null },
  { id: "codexy", title: "Codex chat", refId: "codex", kind: "agent-chat", projectPath: APP, chatSessionStatus: "ready", latestTurn: null },
  { id: "elsewhere", title: "Elsewhere", refId: "claude", kind: "agent-chat", projectPath: "/w/ws/other", chatSessionStatus: "ready", latestTurn: null },
  { id: "loose", title: "Loose", refId: "claude", kind: "agent-chat", projectPath: "", chatSessionStatus: "ready", latestTurn: null },
  { id: "loose-2", title: "Loose 2", refId: "claude", kind: "agent-chat", projectPath: "", chatSessionStatus: "ready", latestTurn: null },
  { id: "term", kind: "shell", projectPath: APP }
];

/** The agent catalogue the turn policy reads a target's plan mode from (Claude has it, Codex not). */
const registryBody = {
  shells: [], ides: [], fileExplorers: [], browsers: [],
  agents: [
    { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
    { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } }
  ]
};
const providersBody = {
  hostInstanceId: "h",
  providers: [
    { id: "claude", refIds: ["claude"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: NOW, slashCommands: [], skills: [], capabilities: { showPlanModeToggle: true }, models: [{ slug: "opus", name: "Opus", isDefault: true, capabilities: null }] },
    { id: "codex", refIds: ["codex"], installed: true, version: "1", status: "ready", auth: { status: "authenticated" }, checkedAt: NOW, slashCommands: [], skills: [], capabilities: {}, models: [{ slug: "gpt-5", name: "GPT-5", isDefault: true, capabilities: null }] }
  ]
};

/** Each thread's head as the policy reads it: its permission mode, and whether its running turn plans. */
type Head = { runtimeMode: string; planning: boolean };

async function rig(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orq-scheduling-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(NOW);
  const app = Fastify();
  const turns: { threadId: string; body: unknown }[] = [];
  const heads = new Map<string, Head>(sessions.map((session) => [session.id, { runtimeMode: session.id === "wide" ? "full-access" : "auto", planning: false }]));
  app.get("/api/sessions", async () => sessions);
  app.get("/api/registry", async () => registryBody);
  app.get(agentChatRoutes.providers, async () => providersBody);
  app.get("/api/agent-accounts", async () => ({ accounts: [], defaults: { claude: null, codex: null, grok: null } }));
  for (const session of sessions) {
    app.get(agentChatRoutes.thread(session.id), async () => {
      const head = heads.get(session.id)!;
      return {
        kind: "snapshot",
        thread: {
          head: { runtimeMode: head.runtimeMode, session: { status: head.planning ? "running" : "ready", activeTurnId: head.planning ? "tp" : null } },
          items: [],
          turns: head.planning ? [{ turnId: "tp", state: "running", interactionMode: "plan" }] : [],
          checkpoints: [],
          pending: { approvals: [], userInputs: [] },
          roster: [],
          seq: 0
        }
      };
    });
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
  return { call, turns, service, clock, heads };
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

test("update_scheduled_task: a cron-only change keeps the task's time zone", async (t) => {
  const { call } = await rig(t);
  const task = (await call("me", "schedule_task", { prompt: "Report", cron: "0 9 * * *", timezone: "Asia/Kolkata" })).value.task;
  const updated = await call("me", "update_scheduled_task", { taskId: task.taskId, cron: "30 9 * * *" });
  assert.deepEqual(updated.value.task.schedule, { kind: "cron", cron: "30 9 * * *", timezone: "Asia/Kolkata" });
  assert.equal(updated.value.task.nextRunAt, "2026-10-15T04:00:00.000Z", "09:30 in +05:30");
});

// --- the turn policy (S-I1) ---------------------------------------------------------------------

test("(a) never into a thread with a broader permission mode — at scheduling and again at delivery", async (t) => {
  const { call, turns, heads, clock, service } = await rig(t);
  const refused = await call("me", "schedule_task", { prompt: "rm -rf build", inMinutes: 5, threadId: "wide" });
  assert.equal(refused.value.code, "PERMISSION_DENIED");
  // Allowed now (same mode), but the target widens before delivery: refused then, recorded, never sent.
  const task = (await call("me", "schedule_task", { prompt: "tidy up", inMinutes: 5, threadId: "sibling" })).value.task;
  heads.get("sibling")!.runtimeMode = "full-access";
  await advance(clock, () => service.idle(), 6 * 60_000);
  assert.equal(turns.length, 0);
  const after = service.get(task.taskId)!;
  assert.equal(after.lastRunStatus, "failed");
  assert.match(after.lastRunError ?? "", /broader than the auto mode/);
});

test("(b) a planning caller's task runs in plan mode; an agent with no plan mode is refused; run now from plan cannot run a default task", async (t) => {
  const { call, turns, heads } = await rig(t);
  const plain = (await call("me", "schedule_task", { prompt: "Later", cron: "0 9 * * *", timezone: "UTC" })).value.task;
  heads.get("me")!.planning = true;
  const planned = await call("me", "schedule_task", { prompt: "Plan the release", inMinutes: 5, threadId: "sibling" });
  assert.equal(planned.value.task.planMode, true);
  assert.equal((await call("me", "schedule_task", { prompt: "x", inMinutes: 5, threadId: "codexy" })).value.code, "PERMISSION_DENIED", "Codex has no plan mode");
  assert.equal((await call("me", "run_scheduled_task_now", { taskId: plain.taskId })).value.code, "PERMISSION_DENIED");
  heads.get("me")!.planning = false;
  const ran = await call("me", "run_scheduled_task_now", { taskId: planned.value.task.taskId });
  assert.equal(ran.value.delivered, true);
  const sent = turns.at(-1)!.body as { interactionMode: string };
  assert.equal(sent.interactionMode, "plan");
});

test("(c) the delivered prompt names the thread that scheduled it, marked as Orquester's — never as the user's", async (t) => {
  const { call, turns } = await rig(t);
  const task = (await call("me", "schedule_task", { prompt: "Check CI", inMinutes: 5, threadId: "sibling" })).value.task;
  await call("sibling", "run_scheduled_task_now", { taskId: task.taskId });
  const sent = turns.at(-1)!.body as { input: string; context: Array<{ kind: string }> };
  assert.deepEqual(parseThreadMessage(sent.input), { origin: "scheduled", fromTitle: "Main", body: "Check CI" });
  assert.deepEqual(sent.context.map((chip) => chip.kind), ["scheduled-task", "thread-message"]);
});

test("(d) agents change, run or delete only agent tasks of their own threads — never the user's", async (t) => {
  const { call, service } = await rig(t);
  const users = await service.create({ threadId: "me", prompt: "The user's own", schedule: { kind: "cron", cron: "0 9 * * *", timezone: "UTC" } });
  for (const [name, args] of [
    ["update_scheduled_task", { taskId: users.id, prompt: "rewritten" }],
    ["delete_scheduled_task", { taskId: users.id }],
    ["run_scheduled_task_now", { taskId: users.id }]
  ] as const) {
    assert.equal((await call("me", name, args)).value.code, "PERMISSION_DENIED", name);
  }
  assert.equal(service.get(users.id)!.prompt, "The user's own");
  const listed = (await call("me", "list_scheduled_tasks", {})).value.tasks as Array<{ taskId: string; createdBy: string }>;
  assert.equal(listed.find((task) => task.taskId === users.id)!.createdBy, "user");

  // Another pair of threads' agent task: refused; the scheduling thread and the target thread may.
  const siblings = (await call("sibling", "schedule_task", { prompt: "Sibling's own", cron: "0 9 * * *", timezone: "UTC" })).value.task;
  assert.equal((await call("me", "delete_scheduled_task", { taskId: siblings.taskId })).value.code, "PERMISSION_DENIED");
  const forMe = (await call("sibling", "schedule_task", { prompt: "For main", cron: "0 9 * * *", timezone: "UTC", threadId: "me" })).value.task;
  const changed = await call("me", "update_scheduled_task", { taskId: forMe.taskId, prompt: "Mine now" });
  assert.equal(changed.error, false);
  assert.equal(changed.value.task.createdBy, "me", "the change makes it the changing thread's");
  assert.equal((await call("sibling", "delete_scheduled_task", { taskId: siblings.taskId })).value.deleted, true);
});
