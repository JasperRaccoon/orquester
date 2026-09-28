// Regression tests for the engine review fixes: nothing proceeds unrecorded after stop(), the
// pre-spawn marker, sub-workflow redaction, outside cancellation, temp-project durability, git
// refs, run error kinds, reserved registration and prototype-safe block ids.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Workflow } from "@orquester/api";

import type { NodeExecutorRegistry, PersistedRun, ProjectContext } from "./contracts.ts";
import { createHttpExecutor } from "./nodes/http.ts";
import { EngineStoppedError } from "./run-context.ts";
import {
  controlledExecutor,
  edge,
  FakeProjects,
  FakeSandbox,
  flush,
  InMemoryRunStore,
  InMemorySecretStore,
  InMemoryWorkflowStore,
  ManualClock,
  node,
  sequentialIds,
  workflow
} from "./testing/fakes.ts";
import { createHarness, scripted, type Harness } from "./testing/harness.ts";

const T = (id = "T") => node(id, "trigger.manual");

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function restartable(workflows: Workflow[]) {
  const shared = {
    clock: new ManualClock(),
    runStore: new InMemoryRunStore(),
    store: new InMemoryWorkflowStore(workflows),
    secrets: new InMemorySecretStore(),
    projects: new FakeProjects(),
    sandbox: new FakeSandbox(),
    mintId: sequentialIds("run")
  };
  return {
    shared,
    boot(executors: NodeExecutorRegistry = {}): Harness {
      return createHarness({ ...shared, executors });
    }
  };
}

describe("engine fixes: nothing runs unrecorded after stop()", () => {
  test("setWaitingOn rejects once the engine stopped", async () => {
    const http = controlledExecutor("http");
    const h = createHarness({ workflows: [workflow("w1", [T(), node("H", "http", { url: "https://x.test" })], [edge("T", "H")])], executors: { http } });
    await h.engine.run("w1", {});
    await flush();
    const ctx = http.calls[0]!.ctx;
    await h.engine.stop();
    await assert.rejects(ctx.setWaitingOn({ kind: "http", method: "POST", startedAt: new Date().toISOString() }), EngineStoppedError);
  });

  test("an HTTP POST reached after stop() is not sent; the resumed run sends it exactly once", async () => {
    const env = restartable([workflow("w1", [T(), node("H", "http", { method: "POST", url: "https://api.test/x" })], [edge("T", "H")])]);
    const gate = deferred();
    const original = env.shared.projects.currentBranch.bind(env.shared.projects);
    env.shared.projects.currentBranch = async () => {
      await gate.promise;
      return original();
    };
    const calls: string[] = [];
    const answer = () =>
      createHttpExecutor({
        fetch: async (input) => {
          calls.push(String(input));
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
      });
    const first = env.boot({ http: answer() });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    await first.engine.stop();
    gate.resolve();
    await flush();
    assert.deepEqual(calls, [], "the stopped engine's block never sent its POST");

    env.shared.projects.currentBranch = original;
    const second = env.boot({ http: answer() });
    await second.engine.resume();
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.equal(calls.length, 1, "sent once in all");
  });

  test("a runner spawned while the engine stopped is adopted from its handle, never spawned twice", async () => {
    const env = restartable([workflow("w1", [T(), node("A", "code")], [edge("T", "A")])]);
    const sandbox = env.shared.sandbox;
    const gate = deferred();
    const spawn = sandbox.spawn.bind(sandbox);
    sandbox.spawn = async (request) => {
      await gate.promise;
      return spawn(request);
    };
    const first = env.boot();
    const { runId } = await first.engine.run("w1", {});
    await flush();
    const marker = (await env.shared.runStore.load(runId!))!.blocks.A!.waitingOn;
    assert.equal(marker?.kind, "process");
    assert.equal((marker as { spawning?: boolean }).spawning, true, "the pre-spawn marker is on disk before the spawn");
    await first.engine.stop();
    gate.resolve();
    await flush();
    assert.equal(sandbox.processes.length, 1, "the spawn in flight completed");

    const second = env.boot();
    await second.engine.resume();
    await flush();
    assert.equal(sandbox.processes.length, 1, "adopted from handle.json, not spawned again");
    sandbox.finish(sandbox.last().handle.pid, { code: 0, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0, result: { ok: true, value: 7 } });
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.equal((await env.shared.runStore.load(runId!))!.blocks.A!.output, 7);
  });
});

describe("engine fixes: redaction and outcomes", () => {
  test("a parent's secret rendered into a sub-workflow's input is redacted in the child run", async () => {
    const parent = workflow("p", [T(), node("S", "workflow", { workflowId: "c", input: "{{ secrets.PARENT_TOKEN }}" })], [edge("T", "S")]);
    const child = workflow("c", [T(), node("X", "code")], [edge("T", "X")]);
    const code = scripted("code", { X: (ctx) => ({ status: "succeeded", output: { got: (ctx.expressionContext().trigger as { input: unknown }).input } }) });
    const h = createHarness({ workflows: [parent, child], executors: { code } });
    await h.secrets.set("PARENT_TOKEN", "parent-only-secret-value", "p");
    const { runId } = await h.engine.run("p", {});
    await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    const childRun = (await h.runStore.load(run.blocks.S!.childRunId!))!;
    const text = JSON.stringify(childRun) + JSON.stringify(h.events);
    assert.ok(!text.includes("parent-only-secret-value"), "the child keeps and broadcasts no parent secret");
    assert.match(JSON.stringify(childRun.triggerPayload), /«secret:PARENT_TOKEN»/);
  });

  test("a code runner stopped from outside fails the block; the run does not succeed", async () => {
    const h = createHarness({ workflows: [workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")])] });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    h.sandbox.finish(h.sandbox.last().handle.pid, { code: null, signal: "SIGTERM", timedOut: false, stdoutBytes: 0, stderrBytes: 0, cancelled: true } as never);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(run.blocks.A!.status, "failed");
    assert.equal(run.blocks.A!.error?.kind, "interrupted");
  });

  test("a block that answers cancelled while nothing cancelled the run fails it", async () => {
    const code = scripted("code", { A: () => ({ status: "cancelled" }) });
    const h = createHarness({ workflows: [workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")])], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    assert.deepEqual(code.seen, ["A"]);
  });

  test("a missing existing project fails the run with errorKind project_missing", async () => {
    const h = createHarness({ workflows: [workflow("w1", [T(), node("A", "code")], [edge("T", "A")], { project: { kind: "existing", projectPath: "/w/ws/gone" } })] });
    const { runId } = await h.engine.run("w1", {});
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    assert.equal(result.errorKind, "project_missing");
    assert.equal(h.runStore.latestForWorkflow("w1")?.errorKind, "project_missing");
  });
});

describe("engine fixes: temporary projects", () => {
  const tempWorkflow = (source: Record<string, unknown>, nodes = [T(), node("A", "code")], edges = [edge("T", "A")]) =>
    workflow("w1", nodes, edges, { name: "Nightly", project: { kind: "temp", workspace: "ws", source } });
  const code = () => scripted("code");

  test("a restart during the creation: the pending path is on disk, removed, and made again", async () => {
    const env = restartable([tempWorkflow({ kind: "empty" })]);
    const projects = env.shared.projects;
    const gate = deferred();
    const create = projects.createTemp.bind(projects);
    let hold: Promise<void> | null = gate.promise;
    projects.createTemp = async (input) => {
      if (hold) await hold;
      return create(input);
    };
    const first = env.boot({ code: code() });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    const pending = (await env.shared.runStore.load(runId!))!.tempProject;
    assert.deepEqual(pending, { path: "/w/ws/wf-nightly-run0001", deleted: false, pending: true });
    await first.engine.stop();
    gate.resolve();
    await flush();
    hold = null;

    const second = env.boot({ code: code() });
    await second.engine.resume();
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.equal(projects.deleted[0], "/w/ws/wf-nightly-run0001", "the leftover went before the retry");
    assert.equal(projects.created.length, 2);
    assert.deepEqual((await env.shared.runStore.load(runId!))!.tempProject, { path: "/w/ws/wf-nightly-run0001", deleted: true });
  });

  test("a failed creation removes what it left and records nothing pending", async () => {
    const h = createHarness({ workflows: [tempWorkflow({ kind: "empty" })], executors: { code: code() } });
    h.projects.failCreate = new Error("clone failed");
    const { runId } = await h.engine.run("w1", {});
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    assert.deepEqual(h.projects.deleted, ["/w/ws/wf-nightly-run0001"]);
    assert.deepEqual((await h.runStore.load(runId!))!.tempProject, { path: "/w/ws/wf-nightly-run0001", deleted: true });
  });

  test("a run whose saved state cannot be read is due for the sweeper", async () => {
    const env = restartable([tempWorkflow({ kind: "empty" })]);
    await env.shared.runStore.create({
      version: 1,
      id: "broken",
      workflowId: "w1",
      workflowName: "Nightly",
      status: "running",
      trigger: { kind: "manual" },
      test: false,
      queuedAt: "2026-09-28T09:00:00.000Z",
      definition: null as never,
      triggerPayload: null,
      blocks: {},
      takenEdges: [],
      deadEdges: [],
      depth: 0,
      tempProject: { path: "/w/ws/wf-x", deleted: false }
    } as PersistedRun);
    const h = env.boot();
    await h.engine.resume();
    const run = (await env.shared.runStore.load("broken"))!;
    assert.equal(run.status, "interrupted");
    assert.ok(run.tempProject?.deleteAfter, "the sweeper will delete its project");
  });

  test("stopping during the finalize's delete leaves the project due for the sweeper", async () => {
    const h = createHarness({ workflows: [tempWorkflow({ kind: "empty" })], executors: { code: code() } });
    const gate = deferred();
    h.projects.deleteProject = async () => {
      await gate.promise;
    };
    const { runId } = await h.engine.run("w1", {});
    for (let i = 0; i < 5; i += 1) await flush();
    await h.engine.stop();
    gate.resolve();
    const saved = (await h.runStore.load(runId!))!;
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.tempProject?.deleted, false);
    assert.ok(saved.tempProject?.deleteAfter, "deleteAfter was set before the delete was awaited");
  });

  test("a release event clones at its tag; a PR head the clone cannot resolve is retried at the PR branch", async () => {
    const release = node("G", "trigger.git", { repo: { kind: "project" }, event: { kind: "release", includePrereleases: false } });
    const h = createHarness({
      workflows: [tempWorkflow({ kind: "clone", url: "https://git.test/r.git" }, [release, node("A", "code")], [edge("G", "A")])],
      executors: { code: code() }
    });
    const fired = await h.engine.fire({
      workflowId: "w1",
      triggerNodeId: "G",
      kind: "git",
      payload: {
        kind: "git",
        event: "release",
        repo: { url: "https://git.test/r.git", name: "r" },
        ref: "refs/tags/v1.2.0",
        sha: "",
        tag: "v1.2.0",
        release: { id: "1", name: "v1.2.0", tag: "v1.2.0", body: "", url: "https://git.test/r/releases/1", prerelease: false }
      }
    });
    await h.engine.waitForRun(fired.runId!);
    assert.deepEqual(h.projects.created[0]!.source, { kind: "clone", url: "https://git.test/r.git", ref: "v1.2.0" });

    const pr = node("P", "trigger.git", { repo: { kind: "project" }, event: { kind: "pull_request", actions: ["opened"] } });
    const h2 = createHarness({
      workflows: [tempWorkflow({ kind: "clone", url: "https://git.test/r.git" }, [pr, node("A", "code")], [edge("P", "A")])],
      executors: { code: code() }
    });
    const create = h2.projects.createTemp.bind(h2.projects);
    h2.projects.createTemp = async (input): Promise<ProjectContext> => {
      if (input.source.kind === "clone" && input.source.ref === "0123456789ab") throw new Error("fatal: couldn't find remote ref");
      return create(input);
    };
    const firedPr = await h2.engine.fire({
      workflowId: "w1",
      triggerNodeId: "P",
      kind: "git",
      payload: {
        kind: "git",
        event: "pull_request",
        repo: { url: "https://git.test/r.git", name: "r" },
        ref: "refs/heads/feature/x",
        sha: "0123456789ab",
        pr: { number: 3, title: "t", body: "", url: "u", author: "a", head: "feature/x", base: "main", action: "opened", headSha: "0123456789ab" }
      }
    });
    const result = await h2.engine.waitForRun(firedPr.runId!);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(h2.projects.created.map((c) => (c.source as { ref?: string }).ref), ["feature/x"]);
  });
});

describe("engine fixes: registration and block ids", () => {
  test("a run is not active until its record exists; a failed create leaves nothing active", async () => {
    const h = createHarness({ workflows: [workflow("w1", [T(), node("A", "code")], [edge("T", "A")])], executors: { code: scripted("code") } });
    const gate = deferred();
    const create = h.runStore.create.bind(h.runStore);
    let seenDuringCreate: string[] | null = null;
    h.runStore.create = async (run) => {
      seenDuringCreate = h.engine.activeRunIds();
      await gate.promise;
      throw new Error("disk full");
    };
    const started = h.engine.run("w1", {});
    await flush();
    gate.resolve();
    await assert.rejects(started, /Could not record the run/);
    assert.deepEqual(seenDuringCreate, []);
    assert.deepEqual(h.engine.activeRunIds(), []);
    h.runStore.create = create;
  });

  test("a stored run naming a block `__proto__` is interrupted, never walked", async () => {
    const env = restartable([]);
    const definition = { ...workflow("w1", [T(), node("A", "code")], [edge("T", "A")]) };
    definition.nodes = [...definition.nodes, { ...definition.nodes[1]!, id: "__proto__", name: "Evil" }];
    const run = {
      version: 1,
      id: "evil",
      workflowId: "w1",
      workflowName: "w1",
      status: "running",
      trigger: { kind: "manual" },
      test: false,
      queuedAt: "2026-09-28T09:00:00.000Z",
      definition,
      triggerPayload: null,
      blocks: JSON.parse('{"__proto__": {"nodeId": "__proto__", "status": "running", "attempt": 1}}'),
      takenEdges: [],
      deadEdges: [],
      depth: 0
    } as unknown as PersistedRun;
    await env.shared.runStore.create(run);
    const h = env.boot();
    await h.engine.resume();
    assert.equal((await env.shared.runStore.load("evil"))!.status, "interrupted");
    assert.equal(({} as Record<string, unknown>).status, undefined, "Object.prototype untouched");
  });
});

describe("engine fixes: a cut text keeps no secret prefix", () => {
  test("an invalid URL quoting a long secret is redacted before it is cut", async () => {
    const secret = `S${"s".repeat(300)}`;
    const h = createHarness({ workflows: [workflow("w1", [T(), node("H", "http", { url: "https://exa mple/{{ secrets.LONG }}" })], [edge("T", "H")])] });
    await h.secrets.set("LONG", secret);
    const { runId } = await h.engine.run("w1", {});
    await h.engine.waitForRun(runId!);
    const error = (await h.engine.getRun(runId!))!.blocks.H!.error!;
    assert.equal(error.kind, "validation");
    assert.ok(!error.message.includes("ssssssssss"), error.message);
    assert.match(error.message, /«secret:LONG»/);
  });
});
