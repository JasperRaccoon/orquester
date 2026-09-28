// projects.ts, prompt-renderer.ts, notifier.ts, sweepers.ts, scheduler-queue.ts, factory.ts.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { GitStatusResponse, SessionSummary, Workflow, WorkflowRunSummary } from "@orquester/api";

import type { DaemonApi, DaemonMethod } from "../mcp/daemon-api.ts";
import type { PersistedRun } from "./contracts.ts";
import { createWorkflowRuntime } from "./factory.ts";
import { createWorkflowNotifier, type WorkflowPushPayload } from "./notifier.ts";
import { createProjectOps, shortStatusLines } from "./projects.ts";
import { createPromptRenderer } from "./prompt-renderer.ts";
import { createSlotPool, SlotAbortedError } from "./scheduler-queue.ts";
import { createWorkflowSweepers } from "./sweepers.ts";
import {
  edge,
  FakeProjects,
  FakeSandbox,
  flush,
  InMemoryRunStore,
  InMemorySecretStore,
  InMemoryWorkflowStore,
  ManualClock,
  node,
  silentLogger,
  workflow
} from "./testing/fakes.ts";

interface Recorded {
  method: DaemonMethod;
  path: string;
  body?: unknown;
}

function fakeApi(handler: (method: DaemonMethod, path: string, body?: unknown) => { status: number; body: unknown }, dirs = { fsRoot: "/w", workspacesDir: "/w" }) {
  const calls: Recorded[] = [];
  const api: DaemonApi = {
    async request(method, path, opts) {
      calls.push({ method, path, ...(opts?.body !== undefined ? { body: opts.body } : {}) });
      return handler(method, path, opts?.body);
    },
    uploadAttachment: async () => ({ status: 503, value: null }),
    subscribe: () => () => undefined,
    ...dirs
  };
  return { api, calls };
}

const cleanStatus = (files: GitStatusResponse["files"] = []): GitStatusResponse => ({
  isRepo: true,
  branch: "main",
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastFetched: null,
  files
});

describe("projects", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "orq-wf-projects-"));
    await mkdir(join(root, "ws", "app"), { recursive: true });
    await mkdir(join(root, "ws", "app", "deep"), { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const git = { status: async () => cleanStatus(), currentBranch: async () => "feature/x" };

  test("resolveExisting accepts exactly <workspacesDir>/<ws>/<project>", async () => {
    const ops = createProjectOps({ api: null as never, git, workspacesDir: root, fsRoot: root });
    assert.deepEqual(await ops.resolveExisting(join(root, "ws", "app")), { path: join(root, "ws", "app"), name: "app", workspace: "ws", temp: false });
    assert.deepEqual(await ops.resolveExisting("ws/app"), { path: join(root, "ws", "app"), name: "app", workspace: "ws", temp: false });
    assert.equal(await ops.resolveExisting(join(root, "ws", "app", "deep")), null, "a subdirectory is not a project");
    assert.equal(await ops.resolveExisting(join(root, "ws")), null, "a workspace is not a project");
    assert.equal(await ops.resolveExisting(join(root, "ws", "missing")), null);
    assert.equal(await ops.resolveExisting("/etc"), null);
    assert.equal(await ops.currentBranch(join(root, "ws", "app")), "feature/x");
  });

  test("createTemp and deleteProject go through the daemon's routes", async () => {
    const { api, calls } = fakeApi((method, path) => {
      if (method === "POST") return { status: 200, body: { name: "wf-x-1", workspace: "ws", path: "/w/ws/wf-x-1" } };
      if (path.endsWith("/gone")) return { status: 404, body: null };
      if (path.endsWith("/locked")) return { status: 409, body: { code: "BUSY", message: "in use" } };
      return { status: 204, body: null };
    });
    const ops = createProjectOps({ api: () => api, git, workspacesDir: "/w", fsRoot: "/w" });
    const created = await ops.createTemp({ workspace: "ws", name: "wf-x-1", source: { kind: "clone", url: "git@h:o/r.git", ref: "v1" } });
    assert.deepEqual(created, { path: "/w/ws/wf-x-1", name: "wf-x-1", workspace: "ws", temp: true });
    await ops.createTemp({ workspace: "ws", name: "wf-x-2", source: { kind: "empty" } });
    await ops.deleteProject("/w/ws/wf-x-1");
    await ops.deleteProject("/w/ws/gone");
    await assert.rejects(ops.deleteProject("/w/ws/locked"), /BUSY: in use/);
    await assert.rejects(ops.deleteProject("/elsewhere/p"), /not a project/);
    assert.deepEqual(calls.slice(0, 3), [
      { method: "POST", path: "/api/workspaces/ws/projects", body: { source: "clone", name: "wf-x-1", url: "git@h:o/r.git", ref: "v1" } },
      { method: "POST", path: "/api/workspaces/ws/projects", body: { source: "empty", name: "wf-x-2" } },
      { method: "DELETE", path: "/api/workspaces/ws/projects/wf-x-1" }
    ]);
  });

  test("a refused create names the daemon's code", async () => {
    const { api } = fakeApi(() => ({ status: 400, body: { code: "NO_GIT_ACCOUNT", message: "This workspace has no linked git account." } }));
    const ops = createProjectOps({ api, git, workspacesDir: "/w", fsRoot: "/w" });
    await assert.rejects(ops.createTemp({ workspace: "ws", name: "n", source: { kind: "empty" } }), /NO_GIT_ACCOUNT/);
    const detached = createProjectOps({ api: () => null, git, workspacesDir: "/w", fsRoot: "/w" });
    await assert.rejects(detached.createTemp({ workspace: "ws", name: "n", source: { kind: "empty" } }), /not attached/);
  });

  test("gitStatusShort renders porcelain-style lines within the byte cap", async () => {
    const files: GitStatusResponse["files"] = [
      { path: "a.ts", status: "modified", staged: true, unstaged: false },
      { path: "b.ts", status: "modified", staged: false, unstaged: true },
      { path: "c.ts", status: "untracked", staged: false, unstaged: true },
      { path: "d.ts", status: "renamed", staged: true, unstaged: false, oldPath: "old.ts" }
    ];
    assert.deepEqual(shortStatusLines(cleanStatus(files)), ["M  a.ts", " M b.ts", "?? c.ts", "R  old.ts -> d.ts"]);
    const many = Array.from({ length: 500 }, (_, i) => ({ path: `file-${i}.ts`, status: "modified" as const, staged: false, unstaged: true }));
    const ops = createProjectOps({ api: null as never, git: { status: async () => cleanStatus(many), currentBranch: async () => null }, workspacesDir: "/w", fsRoot: "/w" });
    const text = await ops.gitStatusShort("/w/ws/app", 1024);
    assert.ok(Buffer.byteLength(text) <= 1024);
    assert.match(text, /… \(\d+ more\)$/);
    const clean = createProjectOps({ api: null as never, git: { status: async () => cleanStatus(), currentBranch: async () => null }, workspacesDir: "/w", fsRoot: "/w" });
    assert.equal(await clean.gitStatusShort("/w/ws/app", 1024), "(no changes)");
    assert.equal(await clean.currentBranch("/w/ws/app"), undefined);
  });
});

describe("prompt renderer", () => {
  test("renders {variables} with git reads in the workflow's time zone", async () => {
    const renderer = createPromptRenderer({
      git: {
        status: async () => cleanStatus([{ path: "x.ts", status: "modified", staged: false, unstaged: true }]),
        workingDiff: async () => ({ isRepo: true, diff: "DIFF", truncated: false, untracked: [] }) as never
      },
      savedPrompts: { get: (id) => (id === "p1" ? { body: "Fix {branch}", title: "Fixer" } : undefined) },
      now: () => new Date("2026-09-28T23:30:00.000Z")
    });
    const result = await renderer.render({ body: "{project} on {branch} at {date} {time} by {agent}/{model}", projectPath: "/w/ws/app", timeZone: "Asia/Tokyo", agentLabel: "Claude", modelLabel: "Opus" });
    assert.equal(result.ok, true);
    assert.match((result as { text: string }).text, /^app on main at .*2026.* by Claude\/Opus$/);
    assert.ok((result as { text: string }).text.includes("29") || (result as { text: string }).text.includes("Sep 29"), "the date is Tokyo's (already the 29th)");
    assert.deepEqual(renderer.savedPromptBody("p1"), { body: "Fix {branch}", title: "Fixer" });
    assert.equal(renderer.savedPromptBody("nope"), null);
  });

  test("a failed git read renders nothing and names the variables", async () => {
    const renderer = createPromptRenderer({
      git: { status: async () => Promise.reject(new Error("fatal: not a repo")), workingDiff: async () => Promise.reject(new Error("x")) },
      savedPrompts: { get: () => undefined }
    });
    const result = await renderer.render({ body: "Branch {branch}", projectPath: "/w/ws/app", timeZone: "UTC" });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /fatal: not a repo.*\{branch\}/);
  });
});

describe("notifier", () => {
  const wf = (notify: { onFailure: boolean; onSuccess: boolean }) => workflow("w1", [node("T", "trigger.manual")], [], { name: "Nightly", settings: { notify } });
  const run = (status: WorkflowRunSummary["status"], extra: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
    id: `r-${Math.random()}`,
    workflowId: "w1",
    workflowName: "Nightly",
    status,
    trigger: { kind: "schedule" },
    test: false,
    queuedAt: "2026-09-28T10:00:00.000Z",
    durationMs: 125_000,
    ...extra
  });

  test("pushes per settings.notify, debounced per workflow and kind", async () => {
    const clock = new ManualClock();
    const pushed: WorkflowPushPayload[] = [];
    const notifier = createWorkflowNotifier({ push: { notifyWorkflowRun: async (payload) => void pushed.push(payload) }, clock, debounceMs: 60_000 });
    notifier.runFinished(run("failed", { error: "A: boom" }), wf({ onFailure: true, onSuccess: false }));
    notifier.runFinished(run("failed", { error: "again" }), wf({ onFailure: true, onSuccess: false }));
    notifier.runFinished(run("succeeded"), wf({ onFailure: true, onSuccess: false }));
    notifier.runFinished(run("succeeded"), wf({ onFailure: true, onSuccess: true }));
    notifier.runFinished(run("cancelled"), wf({ onFailure: true, onSuccess: true }));
    notifier.runFinished(run("failed", { test: true }), wf({ onFailure: true, onSuccess: true }));
    notifier.runFinished(run("failed", { parentRunId: "p" }), wf({ onFailure: true, onSuccess: true }));
    await flush();
    assert.deepEqual(
      pushed.map((payload) => [payload.title, payload.body]),
      [
        ["Workflow failed: Nightly", "A: boom"],
        ["Workflow finished: Nightly", "Finished in 2m 5s."]
      ]
    );
    assert.equal(pushed[0]!.tag, "workflow-w1");
    await clock.advance(60_000);
    notifier.runFinished(run("interrupted", { error: "restart" }), wf({ onFailure: true, onSuccess: false }));
    await flush();
    assert.equal(pushed.length, 3);
    notifier.runFinished(run("failed"), wf({ onFailure: false, onSuccess: true }));
    assert.equal(pushed.length, 3);
  });
});

describe("slot pool", () => {
  test("FIFO past the cap; aborted waiters leave the queue; force skips it", async () => {
    const pool = createSlotPool(1);
    const signal = new AbortController().signal;
    const first = await pool.acquire(signal);
    const order: string[] = [];
    const aborter = new AbortController();
    const second = pool.acquire(signal).then((release) => (order.push("second"), release));
    const third = pool.acquire(aborter.signal).then(
      () => order.push("third"),
      (error: unknown) => order.push(error instanceof SlotAbortedError ? "third aborted" : "?")
    );
    const fourth = pool.acquire(signal).then((release) => (order.push("fourth"), release));
    assert.equal(pool.waiting(), 3);
    aborter.abort();
    await third;
    const forced = await pool.acquire(signal, { force: true });
    assert.equal(pool.inUse(), 2);
    forced();
    first();
    first();
    const releaseSecond = await second;
    releaseSecond();
    (await fourth)();
    assert.deepEqual(order, ["third aborted", "second", "fourth"]);
    assert.equal(pool.inUse(), 0);
    await assert.rejects(pool.acquire(aborter.signal), SlotAbortedError);
  });
});

describe("sweepers", () => {
  const DAY = 24 * 60 * 60_000;

  function finishedRun(id: string, extra: Partial<PersistedRun>): PersistedRun {
    return {
      version: 1,
      id,
      workflowId: "w1",
      workflowName: "W",
      status: "failed",
      trigger: { kind: "manual" },
      test: false,
      queuedAt: "2026-09-20T10:00:00.000Z",
      endedAt: "2026-09-20T10:05:00.000Z",
      definition: workflow("w1", [node("T", "trigger.manual")]),
      triggerPayload: null,
      blocks: {},
      takenEdges: [],
      deadEdges: [],
      depth: 0,
      ...extra
    };
  }

  test("deletes temp projects past deleteAfter and closes old workflow tabs nobody wrote in", async () => {
    const clock = new ManualClock("2026-09-28T10:00:00.000Z");
    const runStore = new InMemoryRunStore();
    const store = new InMemoryWorkflowStore([workflow("w1", [node("T", "trigger.manual")])]);
    const projects = new FakeProjects();
    await runStore.create(finishedRun("old", { tempProject: { path: "/w/ws/wf-old", deleted: false, deleteAfter: "2026-09-27T10:00:00.000Z" } }));
    await runStore.create(finishedRun("fresh", { tempProject: { path: "/w/ws/wf-fresh", deleted: false, deleteAfter: "2026-09-30T10:00:00.000Z" } }));
    await runStore.create(finishedRun("recent", { endedAt: "2026-09-27T10:00:00.000Z" }));
    await runStore.create(finishedRun("running", { status: "running", endedAt: undefined as never }));

    const owner = (runId: string) => ({ kind: "workflow" as const, workflowId: "w1", runId, nodeId: "A" });
    const sessions: Partial<SessionSummary>[] = [
      { id: "s-old", kind: "agent-chat", projectPath: "/w/ws/app", owner: owner("old") },
      { id: "s-talked", kind: "agent-chat", projectPath: "/w/ws/app", owner: owner("old") },
      { id: "s-recent", kind: "agent-chat", projectPath: "/w/ws/app", owner: owner("recent") },
      { id: "s-running", kind: "agent-chat", projectPath: "/w/ws/app", owner: owner("running") },
      { id: "s-gone", kind: "agent-chat", projectPath: "/w/ws/app", owner: owner("swept-long-ago") },
      // Run records gone (retention, a deleted workflow): the tab's own clock decides.
      { id: "s-gone-old", kind: "agent-chat", projectPath: "/w/ws/app", createdAt: "2026-09-10T10:00:00.000Z", owner: owner("swept-1") },
      { id: "s-gone-talked", kind: "agent-chat", projectPath: "/w/ws/app", createdAt: "2026-09-10T10:00:00.000Z", owner: owner("swept-2") },
      { id: "s-gone-young", kind: "agent-chat", projectPath: "/w/ws/app", createdAt: "2026-09-25T10:00:00.000Z", owner: owner("swept-3") },
      { id: "s-temp", kind: "agent-chat", projectPath: "/w/ws/wf-old", owner: owner("old") },
      { id: "s-user", kind: "agent-chat", projectPath: "/w/ws/app" }
    ];
    const thread = (userAt: string | null) => ({
      kind: "snapshot",
      thread: {
        items: [
          { kind: "message", id: "m1", role: "user", text: "workflow prompt", turnId: null, streaming: false, createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "x" },
          ...(userAt ? [{ kind: "message", id: "m2", role: "user", text: "thanks", turnId: null, streaming: false, createdAt: userAt, updatedAt: "x" }] : [])
        ]
      }
    });
    const { api, calls } = fakeApi((method, path) => {
      if (method === "GET" && path === "/api/sessions") return { status: 200, body: sessions };
      if (method === "GET" && path.includes("s-talked")) return { status: 200, body: thread("2026-09-21T09:00:00.000Z") };
      if (method === "GET" && path.includes("s-gone-talked")) return { status: 200, body: thread("2026-09-26T09:00:00.000Z") };
      if (method === "GET") return { status: 200, body: thread(null) };
      return { status: 204, body: null };
    });
    const sweepers = createWorkflowSweepers({ clock, runStore, store, projects, api: () => api, activeRunIds: () => [], logger: silentLogger() });
    const report = await sweepers.sweepNow();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.tempProjectsDeleted, ["/w/ws/wf-old"]);
    assert.deepEqual(projects.deleted, ["/w/ws/wf-old"]);
    assert.deepEqual((await runStore.load("old"))!.tempProject, { path: "/w/ws/wf-old", deleted: true });
    assert.equal((await runStore.load("fresh"))!.tempProject?.deleted, false);
    assert.deepEqual(report.tabsClosed, ["s-old", "s-gone-old"]);
    assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/api/sessions/s-old"));
    assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/api/sessions/s-gone-old"));
    assert.equal(runStore.sweeps, 1);
    void DAY;
  });

  test("runs hourly on the injected clock and stops cleanly", async () => {
    const clock = new ManualClock();
    const runStore = new InMemoryRunStore();
    const sweepers = createWorkflowSweepers({
      clock,
      runStore,
      store: new InMemoryWorkflowStore(),
      projects: new FakeProjects(),
      api: () => null,
      activeRunIds: () => []
    });
    sweepers.start();
    await clock.advance(59 * 60_000);
    assert.equal(runStore.sweeps, 0);
    await clock.advance(60_000);
    assert.equal(runStore.sweeps, 1);
    await clock.advance(60 * 60_000);
    assert.equal(runStore.sweeps, 2);
    sweepers.stop();
    await clock.advance(3 * 60 * 60_000);
    assert.equal(runStore.sweeps, 2);
  });
});

describe("factory", () => {
  test("assembles a runtime that refuses to start detached, then resumes and runs", async () => {
    const clock = new ManualClock();
    const store = new InMemoryWorkflowStore([workflow("w1", [node("T", "trigger.manual"), node("W", "wait", { kind: "duration", minutes: 1 })], [edge("T", "W")])]);
    const runStore = new InMemoryRunStore();
    const events: string[] = [];
    const { api } = fakeApi(() => ({ status: 200, body: { name: "x", workspace: "ws", path: "/w/ws/x" } }), { fsRoot: "/w", workspacesDir: "/w" });
    const runtime = createWorkflowRuntime({
      store,
      runStore,
      secrets: new InMemorySecretStore(),
      publish: (type) => events.push(type),
      summarize: (wf: Workflow) => ({ id: wf.id, name: wf.name, enabled: wf.enabled, revision: wf.revision, project: wf.project, triggers: [], nodeCount: 0, errorCount: 0, activeRuns: [], createdAt: wf.createdAt, updatedAt: wf.updatedAt }),
      usage: { snapshot: () => ({}) as never },
      accounts: { list: () => ({}) as never, seededAccountIds: () => new Set() },
      cooldowns: { get: () => null, set: async () => undefined, list: () => ({}) },
      git: { status: async () => cleanStatus(), workingDiff: async () => ({}) as never, currentBranch: async () => "main" },
      savedPrompts: { get: () => undefined },
      workspacesDir: "/w",
      fsRoot: "/w",
      push: null,
      logger: silentLogger(),
      clock,
      sandbox: new FakeSandbox(),
      mintId: () => "run-1"
    });
    await assert.rejects(runtime.start(), /Attach the daemon API/);
    runtime.attachApi(api);
    await runtime.start();
    // The existing project must resolve for real paths; point the workflow at a temp project instead.
    store.put(workflow("w1", [node("T", "trigger.manual"), node("W", "wait", { kind: "duration", minutes: 1 })], [edge("T", "W")], { project: { kind: "temp", workspace: "ws", source: { kind: "empty" } } }));
    const { runId } = await runtime.engine.run("w1", {});
    await clock.advance(60_000);
    const result = await runtime.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.ok(events.includes("workflowRun.finished"));
    await runtime.stop();
  });
});
