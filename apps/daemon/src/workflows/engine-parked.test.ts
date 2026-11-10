// Parked runs (spec 2026-11-10 §6.2): a run whose every active block waits on a gate, a timer or a
// parked child frees the global run cap (and is held when it would come back over it), its parked
// time does not count toward `runTimeoutMinutes` (also across a restart), and it still counts for
// its own workflow's overlap policy — whose skip or queue then says why.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Workflow } from "@orquester/api";

import type { NodeExecutorRegistry } from "./contracts.ts";
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
const MIN = 60_000;
const USER = { kind: "user" } as const;

const gated = (id: string, settings: Record<string, unknown> = {}): Workflow =>
  workflow(id, [T(), node("G", "gate", { question: `Ship ${id}?` }), node("After", "code")], [edge("T", "G"), edge("G", "After", "choice:approve")], { settings });
const working = (id: string): Workflow => workflow(id, [T(), node("Work", "code")], [edge("T", "Work")]);

function boot(workflows: Workflow[], executors: NodeExecutorRegistry = {}) {
  const shared = {
    clock: new ManualClock(),
    runStore: new InMemoryRunStore(),
    store: new InMemoryWorkflowStore(workflows),
    secrets: new InMemorySecretStore(),
    projects: new FakeProjects(),
    sandbox: new FakeSandbox(),
    mintId: sequentialIds("id")
  };
  return { shared, start: (more: NodeExecutorRegistry = executors): Harness => createHarness({ ...shared, executors: more }) };
}

async function gateIdOf(h: Harness, runId: string): Promise<string> {
  const run = await h.engine.getRun(runId);
  return Object.keys(run!.gates!)[0]!;
}

describe("parked runs", () => {
  test("runs waiting on gates (and timers) do not count toward the run cap", async () => {
    const waiting = workflow("wt", [T(), node("W", "wait", { kind: "duration", minutes: 60 }), node("After", "code")], [edge("T", "W"), edge("W", "After")]);
    const env = boot([gated("g1"), gated("g2"), gated("g3"), waiting, working("c1")]);
    const code = controlledExecutor("code");
    const h = env.start({ code });
    const runs = [];
    for (const id of ["g1", "g2", "g3", "wt"]) runs.push((await h.engine.run(id, {})).runId!);
    await flush();
    for (const runId of runs) assert.equal((await h.engine.getRun(runId))!.parked, true, runId);
    const fifth = await h.engine.run("c1", {});
    await flush();
    assert.equal((await h.engine.getRun(fifth.runId!))!.status, "running", "four parked runs leave the cap free");
    assert.equal(code.calls.length, 1);
    for (const runId of [...runs, fifth.runId!]) await h.engine.cancel(runId);
  });

  test("a parked run that would come back over the cap is held — still parked — until a run ends", async () => {
    const env = boot([gated("g1"), working("c1"), working("c2"), working("c3"), working("c4")]);
    const code = controlledExecutor("code");
    const h = env.start({ code });
    const parkedRun = (await h.engine.run("g1", {})).runId!;
    await flush();
    const busy = [];
    for (const id of ["c1", "c2", "c3", "c4"]) busy.push((await h.engine.run(id, {})).runId!);
    await flush();
    assert.equal(code.calls.length, 4, "the cap is full of working runs");
    await h.engine.decideGate!(parkedRun, await gateIdOf(h, parkedRun), { choice: "approve" }, USER);
    await flush();
    const held = (await h.engine.getRun(parkedRun))!;
    assert.equal(held.blocks.G!.status, "succeeded");
    assert.equal(held.blocks.After!.status, "pending", "held: its next block waits for the cap");
    assert.equal(held.parked, true);
    assert.equal(code.calls.length, 4);
    // One working run ends: the held run goes first.
    code.calls[0]!.resolve({ status: "succeeded", output: 1 });
    await flush();
    assert.equal(code.calls.length, 5);
    assert.equal(code.calls[4]!.ctx.runId, parkedRun);
    assert.equal((await h.engine.getRun(parkedRun))!.parked, undefined);
    for (const call of code.calls.slice(1)) call.resolve({ status: "succeeded", output: 1 });
    assert.equal((await h.engine.waitForRun(parkedRun)).status, "succeeded");
    for (const runId of busy) await h.engine.waitForRun(runId);
  });

  test("parked time is excluded from the run timeout", async () => {
    const env = boot([gated("g1", { runTimeoutMinutes: 10 })]);
    const code = controlledExecutor("code");
    const h = env.start({ code });
    const { runId } = await h.engine.run("g1", {});
    await flush();
    await env.shared.clock.advance(30 * MIN);
    assert.equal((await h.engine.getRun(runId!))!.status, "running", "30 minutes waiting on the gate do not count");
    await h.engine.decideGate!(runId!, await gateIdOf(h, runId!), { choice: "approve" }, USER);
    await flush();
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(run.parkedMs, 30 * MIN);
    assert.equal(run.parkedSince, undefined);
    await env.shared.clock.advance(9 * MIN);
    assert.equal((await h.engine.getRun(runId!))!.status, "running");
    await env.shared.clock.advance(2 * MIN);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timed out after 10 minutes/);
  });

  test("a restart while parked carries the parked stretch on (the run timeout re-armed with it)", async () => {
    const env = boot([gated("g1", { runTimeoutMinutes: 10 })]);
    const first = env.start({ code: controlledExecutor("code") });
    const { runId } = await first.engine.run("g1", {});
    await flush();
    const parkedSince = (await env.shared.runStore.load(runId!))!.parkedSince;
    assert.ok(parkedSince, "persisted");
    await env.shared.clock.advance(5 * MIN);
    await first.engine.stop();
    env.shared.clock.jump(60 * MIN);

    const code = controlledExecutor("code");
    const second = env.start({ code });
    await second.engine.resume();
    await flush();
    assert.equal((await second.engine.getRun(runId!))!.parked, true);
    await second.engine.decideGate!(runId!, await gateIdOf(second, runId!), { choice: "approve" }, USER);
    await flush();
    assert.equal((await second.engine.getRun(runId!))!.parkedMs, 65 * MIN);
    await env.shared.clock.advance(9 * MIN);
    assert.equal((await second.engine.getRun(runId!))!.status, "running");
    await env.shared.clock.advance(2 * MIN);
    assert.equal((await second.engine.waitForRun(runId!)).status, "failed");
  });

  test("a parked run still counts for its workflow's overlap: the skip says it waits on a gate", async () => {
    const env = boot([gated("g1")]);
    const h = env.start({ code: scripted("code") });
    const { runId } = await h.engine.run("g1", {});
    await flush();
    const skipped = await h.engine.run("g1", {});
    assert.deepEqual(skipped, { runId: null, skipped: "overlap", skipDetail: "previous run is waiting on gate “Ship g1?”" });
    const stub = (await h.engine.listRuns("g1", { limit: 5 })).runs.find((run) => run.status === "skipped")!;
    assert.equal(stub.skipDetail, "previous run is waiting on gate “Ship g1?”");
    await h.engine.cancel(runId!);
  });

  test("a run queued behind a parked one carries the reason until it starts", async () => {
    const env = boot([gated("g1", { overlap: "queue" })]);
    const h = env.start({ code: scripted("code") });
    const { runId } = await h.engine.run("g1", {});
    await flush();
    const queued = await h.engine.run("g1", {});
    assert.equal(queued.skipDetail, "previous run is waiting on gate “Ship g1?”");
    assert.equal((await h.engine.getRun(queued.runId!))!.status, "queued");
    assert.equal((await h.engine.getRun(queued.runId!))!.skipDetail, "previous run is waiting on gate “Ship g1?”");
    await h.engine.decideGate!(runId!, await gateIdOf(h, runId!), { choice: "approve" }, USER);
    await h.engine.waitForRun(runId!);
    await flush();
    const started = (await h.engine.getRun(queued.runId!))!;
    assert.equal(started.status, "running");
    assert.equal(started.skipDetail, undefined);
    await h.engine.cancel(queued.runId!);
  });

  test("parallel runs: a parked run counts toward maxConcurrent", async () => {
    const env = boot([gated("g1", { overlap: "parallel", maxConcurrent: 1 })]);
    const h = env.start({ code: scripted("code") });
    const { runId } = await h.engine.run("g1", {});
    await flush();
    const second = await h.engine.run("g1", {});
    assert.equal(second.skipped, "overlap");
    assert.match(second.skipDetail ?? "", /waiting on gate/);
    await h.engine.cancel(runId!);
  });
});
