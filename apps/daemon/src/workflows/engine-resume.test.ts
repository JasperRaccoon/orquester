import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Workflow } from "@orquester/api";

import type { NodeExecutorRegistry, NodeResult } from "./contracts.ts";
import { createHttpExecutor } from "./nodes/http.ts";
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

/** Two engines over the same disk: the first one "crashes" (stops), the second resumes. */
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

async function blockOf(h: Harness, runId: string, nodeId: string) {
  return (await h.runStore.load(runId))!.blocks[nodeId]!;
}

describe("engine: resume after a restart", () => {
  test("a Wait block's timer resumes at the same wall-clock instant", async () => {
    const env = restartable([workflow("w1", [T(), node("W", "wait", { kind: "duration", minutes: 10 }), node("A", "code")], [edge("T", "W"), edge("W", "A")])]);
    const first = env.boot({ code: scripted("code") });
    const { runId } = await first.engine.run("w1", { input: 7 });
    await flush();
    const waiting = await blockOf(first, runId!, "W");
    assert.equal(waiting.status, "waiting");
    assert.deepEqual(waiting.waitingOn, { kind: "timer", until: "2026-09-28T10:10:00.000Z", purpose: "wait" });
    assert.equal(waiting.waitingUntil, "2026-09-28T10:10:00.000Z");
    await first.engine.stop();
    env.shared.clock.jump(4 * 60_000);

    const code = scripted("code");
    const second = env.boot({ code });
    await second.engine.resume();
    await env.shared.clock.advance(5 * 60_000);
    assert.equal((await second.runStore.load(runId!))!.status, "running", "not before the original instant");
    await env.shared.clock.advance(60_000);
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(code.seen, ["A"]);
    assert.deepEqual((await blockOf(second, runId!, "W")).output, { kind: "manual", input: 7 });
  });

  test("a retry delay resumes, then the next attempt runs", async () => {
    const env = restartable([workflow("w1", [T(), node("A", "code", {}, { retry: { maxTries: 2, delaySeconds: 120 } })], [edge("T", "A")])]);
    const first = env.boot({ code: scripted("code", { A: () => ({ status: "failed", error: { kind: "exception", message: "once" } }) }) });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    assert.equal((await blockOf(first, runId!, "A")).waitingOn?.kind, "timer");
    await first.engine.stop();

    const code = scripted("code", { A: (ctx) => ({ status: "succeeded", output: ctx.attempt }) });
    const second = env.boot({ code });
    await second.engine.resume();
    await env.shared.clock.advance(120_000);
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    const block = await blockOf(second, runId!, "A");
    assert.equal(block.attempt, 2);
    assert.equal(block.output, 2);
  });

  test("a code process that ended while the daemon was down: its exit.json is read", async () => {
    const env = restartable([workflow("w1", [T(), node("A", "code")], [edge("T", "A")])]);
    const first = env.boot();
    const { runId } = await first.engine.run("w1", {});
    await flush();
    await first.engine.stop();
    env.shared.sandbox.vanish(env.shared.sandbox.last().handle.pid, {
      code: 0,
      signal: null,
      timedOut: false,
      stdoutBytes: 3,
      stderrBytes: 0,
      result: { ok: false, error: { message: "thrown", stack: "at x" } }
    });
    const second = env.boot();
    await second.engine.resume();
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    assert.deepEqual((await blockOf(second, runId!, "A")).error, { kind: "exception", message: "thrown", detail: { stack: "at x" } });
  });

  test("a process gone without a record is interrupted — retried when the policy allows", async () => {
    const wf = (retry?: { maxTries: number; delaySeconds: number }) =>
      workflow("w1", [T(), node("A", "code", {}, retry ? { retry } : {})], [edge("T", "A")]);
    for (const retry of [undefined, { maxTries: 2, delaySeconds: 0 }]) {
      const env = restartable([wf(retry)]);
      const first = env.boot();
      const { runId } = await first.engine.run("w1", {});
      await flush();
      await first.engine.stop();
      env.shared.sandbox.vanish(env.shared.sandbox.last().handle.pid, null);
      const second = env.boot();
      await second.engine.resume();
      await flush();
      if (!retry) {
        const result = await second.engine.waitForRun(runId!);
        assert.equal(result.status, "failed");
        assert.equal((await blockOf(second, runId!, "A")).error?.kind, "interrupted");
      } else {
        assert.equal(env.shared.sandbox.processes.length, 2, "a second attempt spawned");
        env.shared.sandbox.finish(env.shared.sandbox.last().handle.pid, {
          code: 0,
          signal: null,
          timedOut: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          result: { ok: true, value: "second" }
        });
        const result = await second.engine.waitForRun(runId!);
        assert.equal(result.status, "succeeded");
        assert.equal((await blockOf(second, runId!, "A")).attempt, 2);
      }
    }
  });

  test("a child run is re-subscribed by its parent", async () => {
    const env = restartable([
      workflow("p", [T(), node("S", "workflow", { workflowId: "c" }), node("After", "code")], [edge("T", "S"), edge("S", "After")]),
      workflow("c", [T(), node("W", "wait", { kind: "duration", minutes: 1 })], [edge("T", "W")])
    ]);
    const first = env.boot({ code: scripted("code") });
    const { runId } = await first.engine.run("p", { input: "hi" });
    await flush();
    const waitingOn = (await blockOf(first, runId!, "S")).waitingOn;
    assert.equal(waitingOn?.kind, "child-run");
    await first.engine.stop();

    const code = scripted("code");
    const second = env.boot({ code });
    await second.engine.resume();
    await env.shared.clock.advance(60_000);
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.deepEqual((await blockOf(second, runId!, "S")).output, {
      kind: "subworkflow",
      input: { kind: "manual", input: "hi" },
      parentRunId: runId,
      parentNodeId: "S"
    });
    assert.deepEqual(code.seen, ["After"]);
  });

  test("an HTTP GET is re-issued; a POST fails interrupted", async (t) => {
    for (const method of ["GET", "POST"] as const) {
      const env = restartable([workflow("w1", [T(), node("H", "http", { method, url: "https://api.test/x" })], [edge("T", "H")])]);
      t.mock.method(globalThis, "fetch", () => new Promise<Response>(() => undefined));
      const hang = createHttpExecutor();
      const first = env.boot({ http: hang });
      const { runId } = await first.engine.run("w1", {});
      await flush();
      assert.equal((await blockOf(first, runId!, "H")).waitingOn?.kind, "http");
      await first.engine.stop();

      const calls: string[] = [];
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } });
      });
      const answer = createHttpExecutor();
      const second = env.boot({ http: answer });
      await second.engine.resume();
      const result = await second.engine.waitForRun(runId!);
      if (method === "GET") {
        assert.equal(result.status, "succeeded");
        assert.deepEqual(calls, ["https://api.test/x"]);
        assert.deepEqual(((await blockOf(second, runId!, "H")).output as { body: unknown }).body, { ok: 1 });
      } else {
        assert.equal(result.status, "failed");
        assert.deepEqual(calls, []);
        assert.equal((await blockOf(second, runId!, "H")).error?.kind, "interrupted");
      }
    }
  });

  test("a block running without a WaitingOn: a pure block re-runs as the same attempt", async () => {
    const env = restartable([
      workflow(
        "w1",
        [T(), node("A", "code"), node("If", "if", { combine: "all", rules: [{ left: "{{ input }}", op: "exists" }] }), node("B", "code")],
        [edge("T", "A"), edge("A", "If"), edge("If", "B", "true")]
      )
    ]);
    const first = env.boot({ code: scripted("code") });
    const { runId } = await first.engine.run("w1", {});
    await first.engine.waitForRun(runId!);
    await first.engine.stop();
    // Rewind the record to "If was running when the daemon died".
    const saved = (await env.shared.runStore.load(runId!))!;
    saved.status = "running";
    delete saved.endedAt;
    for (const id of ["If", "B"]) {
      const block = saved.blocks[id]!;
      block.status = id === "If" ? "running" : "pending";
      delete block.output;
      delete block.handle;
      delete block.endedAt;
    }
    await env.shared.runStore.save(saved);

    const code = scripted("code");
    const second = env.boot({ code });
    await second.engine.resume();
    const result = await second.engine.waitForRun(runId!);
    const run = (await second.runStore.load(runId!))!;
    assert.equal(result.status, "succeeded");
    assert.equal(run.blocks.If!.attempt, 1, "the same attempt");
    assert.equal(run.blocks.If!.handle, "true");
    assert.deepEqual(code.seen, ["B"], "A was not re-run");
  });

  test("a side-effecting block running without a WaitingOn is interrupted (no retry)", async () => {
    const env = restartable([workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B", "error")])]);
    const first = env.boot({ code: controlledExecutor("code") });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    await first.engine.stop();
    const code = scripted("code");
    const second = env.boot({ code });
    await second.engine.resume();
    const result = await second.engine.waitForRun(runId!);
    const run = (await second.runStore.load(runId!))!;
    assert.equal(run.blocks.A!.error?.kind, "interrupted");
    assert.equal(run.blocks.A!.status, "failed");
    assert.deepEqual(code.seen, ["B"], "the failure edge still routes");
    assert.equal(result.status, "succeeded");
  });

  test("queued runs start after a restart; a run whose definition cannot be read is marked interrupted", async () => {
    const env = restartable([
      workflow("a", [T(), node("A", "code")], [edge("T", "A")]),
      workflow("b", [T(), node("A", "code")], [edge("T", "A")])
    ]);
    const blocker = controlledExecutor("code");
    const first = createHarness({ ...env.shared, executors: { code: blocker }, limits: { maxConcurrentRuns: 1 } });
    const a = await first.engine.run("a", {});
    const b = await first.engine.run("b", {});
    await flush();
    assert.equal((await env.shared.runStore.load(b.runId!))!.status, "queued");
    await first.engine.stop();
    // A broken record beside them.
    await env.shared.runStore.create({ ...(await env.shared.runStore.load(b.runId!))!, id: "broken", definition: null as never });

    const code = scripted("code");
    const second = createHarness({ ...env.shared, executors: { code }, limits: { maxConcurrentRuns: 1 } });
    await second.engine.resume();
    await flush();
    const resultA = await second.engine.waitForRun(a.runId!);
    const resultB = await second.engine.waitForRun(b.runId!);
    assert.equal(resultA.status, "failed", "A's code block was cut by the restart (no retry)");
    assert.equal(resultB.status, "succeeded");
    assert.equal((await env.shared.runStore.load("broken"))!.status, "interrupted");
  });

  test("stop() persists the last state and writes nothing after", async () => {
    const code = controlledExecutor("code");
    const h = createHarness({ workflows: [workflow("w1", [T(), node("A", "code")], [edge("T", "A")])], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    code.calls[0]!.ctx.update({ activity: "last words" });
    await h.engine.stop();
    const handover = (await h.runStore.load(runId!))!;
    assert.equal(handover.status, "running");
    assert.equal(handover.blocks.A!.activity, "last words");
    handover.blocks.A!.activity = "successor owns the run";
    await h.runStore.save(handover);
    const eventsAfterStop = h.events.length;
    code.calls[0]!.resolve({ status: "succeeded", output: 1 } as NodeResult);
    await flush();
    assert.equal(h.events.length, eventsAfterStop);
    const saved = (await h.runStore.load(runId!))!;
    assert.equal(saved.status, "running");
    assert.equal(saved.blocks.A!.activity, "successor owns the run");
    await assert.rejects(h.engine.run("w1", {}), /stopping/);
  });
});
