// The Gate block through the engine (spec 2026-11-10 §6, §7.5): opening (record + WaitingOn in one
// save, before the push), the person's decision (first wins, comment rules), both phase deadlines,
// restarts in each phase, escalation, the launcher (queued message, idempotent post, authorization)
// and the reviewer agent (on a scripted agent executor: decide, reminder, failure, interruption,
// resume), cancellation, disabled / pinned / retried / test-run gates.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Workflow, WorkflowGateState, WorkflowNode } from "@orquester/api";
import { agentChatCommandPath, agentChatRoutes, type CallerPrincipal } from "@orquester/api/agent-chat";

import { chatSummary, snapshot } from "../mcp/fixtures.ts";
import { FakeDaemonApi } from "../mcp/testing.ts";
import type { NodeExecutionContext, NodeExecutorRegistry, NodeResult, PersistedRun, WorkflowNotifier } from "./contracts.ts";
import { GateRefusal } from "./gates/state.ts";
import { createGateExecutor } from "./nodes/gate.ts";
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
import { createHarness, scripted, type Harness, type HarnessOptions } from "./testing/harness.ts";

const T = (id = "T") => node(id, "trigger.manual");
const USER: CallerPrincipal = { kind: "user" };
const EXTERNAL: CallerPrincipal = { kind: "external", credentialId: "cred_x" };
const agentPrincipal = (threadId: string): CallerPrincipal => ({ kind: "agent", threadId, projectPath: "" });
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CHAIN = [{ agent: "claude", model: "opus" }];

/** A gate between a trigger and two branches: approve → Yes, reject → No. */
function gateFlow(config: Record<string, unknown> = {}, extra: Partial<Omit<WorkflowNode, "config" | "type" | "id">> = {}, overrides: Record<string, unknown> = {}): Workflow {
  return workflow(
    "w1",
    [T(), node("G", "gate", { question: "Ship {{ trigger.input.v }}?", ...config }, extra), node("Yes", "code"), node("No", "code")],
    [edge("T", "G"), edge("G", "Yes", "choice:approve"), edge("G", "No", "choice:reject")],
    overrides
  );
}

interface Env {
  shared: Required<Pick<HarnessOptions, "clock" | "runStore" | "store" | "secrets" | "projects" | "sandbox" | "mintId">>;
  pushed: WorkflowGateState[];
  boot(opts?: { executors?: NodeExecutorRegistry; chatApi?: FakeDaemonApi }): Harness;
}

/** Engines over the same "disk": stop one, boot the next (a restart). Pushes are collected. */
function env(workflows: Workflow[]): Env {
  const shared = {
    clock: new ManualClock(),
    runStore: new InMemoryRunStore(),
    store: new InMemoryWorkflowStore(workflows),
    secrets: new InMemorySecretStore(),
    projects: new FakeProjects(),
    sandbox: new FakeSandbox(),
    mintId: sequentialIds("id")
  };
  const pushed: WorkflowGateState[] = [];
  const notifier: WorkflowNotifier = { runFinished: () => undefined, gateWaiting: (gate) => pushed.push(structuredClone(gate)) };
  return {
    shared,
    pushed,
    boot(opts = {}) {
      return createHarness({ ...shared, notifier, executors: { code: scripted("code"), ...(opts.executors ?? {}) }, ...(opts.chatApi ? { chatApi: opts.chatApi } : {}) });
    }
  };
}

async function gatesOf(h: Harness, runId: string): Promise<WorkflowGateState[]> {
  const run = await h.engine.getRun(runId);
  return Object.values(run?.gates ?? {});
}

async function onlyGate(h: Harness, runId: string): Promise<WorkflowGateState> {
  const gates = await gatesOf(h, runId);
  assert.equal(gates.length, 1, "one gate");
  return gates[0]!;
}

async function refusal(promise: Promise<unknown>, code: string, match?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GateRefusal, String(error));
    assert.equal(error.code, code, error.message);
    if (match) assert.match(error.message, match);
    return true;
  });
}

describe("gate: the person decides", () => {
  test("opening persists the record with the wait, before the push; the decision runs the chosen branch only", async () => {
    const e = env([gateFlow()]);
    const code = scripted("code");
    const h2 = e.boot({ executors: { code } });
    const { runId } = await h2.engine.run("w1", { input: { v: "1.2" } });
    await flush();
    const persisted = (await e.shared.runStore.load(runId!))!;
    const block = persisted.blocks.G!;
    assert.equal(block.status, "waiting");
    assert.equal(block.waitingOn?.kind, "gate");
    const gateId = block.gateId!;
    assert.equal(block.waitingOn?.kind === "gate" && block.waitingOn.gateId, gateId);
    const gate = persisted.gates![gateId]!;
    assert.equal(gate.question, "Ship 1.2?");
    assert.equal(gate.phase, "person");
    assert.deepEqual(gate.decider, { kind: "human", label: "you" });
    assert.equal(gate.phaseDeadlineAt, new Date(Date.parse(gate.openedAt) + 7 * DAY).toISOString(), "the 7-day maximum");
    assert.deepEqual(gate.choices.map((choice) => [choice.id, choice.comment]), [["approve", "none"], ["reject", "optional"]]);
    assert.equal(e.pushed.length, 1, "the person is pushed once");
    assert.equal(e.pushed[0]!.gateId, gateId);
    assert.equal(persisted.gateNotices?.[gateId], gate.phaseStartedAt);
    // Summary counts and the parked state ride the events (published at most every 250 ms).
    await e.shared.clock.advance(1_000);
    const summary = h2.eventsOf("workflowRun.updated").at(-1)!.run as Record<string, unknown>;
    assert.equal(summary.pendingGates, 1);
    assert.equal(summary.pendingPersonGates, 1);
    assert.equal(summary.parked, true);
    assert.ok(h2.eventsOf("workflowRun.updated").some((payload) => Array.isArray(payload.gates) && (payload.gates as WorkflowGateState[]).some((g) => g.gateId === gateId)));

    const decided = await h2.engine.decideGate!(runId!, gateId, { choice: "approve" }, USER);
    assert.equal(decided.alreadyDecided, false);
    assert.equal(decided.decision?.decidedBy.kind, "human");
    const result = await h2.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(code.seen, ["Yes"]);
    const done = (await e.shared.runStore.load(runId!))!;
    assert.equal(done.blocks.G!.handle, "choice:approve");
    assert.deepEqual(done.blocks.G!.output, { choice: "approve", decidedBy: { kind: "human", label: "you" }, decidedAt: decided.decision!.decidedAt, escalated: false });
    assert.equal(done.blocks.No!.status, "skipped");
    assert.equal(done.pendingGates, undefined, "no gate waits any more");
    assert.equal(done.parked, undefined);
    // A later decision changes nothing (the run is over: read from disk).
    const late = await h2.engine.decideGate!(runId!, gateId, { choice: "reject" }, USER);
    assert.equal(late.alreadyDecided, true);
    assert.equal(late.decision?.choice, "approve");
  });

  test("the first decision wins: two at once, the second answers alreadyDecided; an external client decides as the person", async () => {
    const e = env([gateFlow()]);
    const h = e.boot();
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    const gate = await onlyGate(h, runId!);
    const [first, second] = await Promise.all([
      h.engine.decideGate!(runId!, gate.gateId, { choice: "reject", comment: " not now " }, EXTERNAL),
      h.engine.decideGate!(runId!, gate.gateId, { choice: "approve" }, USER)
    ]);
    assert.equal(first.alreadyDecided, false);
    assert.deepEqual(first.decision?.decidedBy, { kind: "external", label: "you (MCP client)" });
    assert.equal(first.decision?.comment, "not now");
    assert.equal(second.alreadyDecided, true);
    assert.equal(second.decision?.choice, "reject");
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    assert.equal((await h.runStore.load(runId!))!.blocks.No!.status, "succeeded");
  });

  test("a choice that needs a comment refuses a decision without one; an unknown choice lists the allowed ids; escalate is not the person's", async () => {
    const e = env([gateFlow({ choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject", comment: "required" }] })]);
    const h = e.boot();
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    const gate = await onlyGate(h, runId!);
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "reject" }, USER), "INVALID_REQUEST", /needs a comment/);
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "maybe" }, USER), "INVALID_REQUEST", /one of: approve, reject/);
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { escalate: true, comment: "x" }, USER), "INVALID_REQUEST", /agent decider/);
    await refusal(h.engine.decideGate!(runId!, "nope", { choice: "approve" }, USER), "GATE_NOT_FOUND");
    // An in-chat agent is never the decider of a person's gate.
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "approve", comment: "ok" }, agentPrincipal("chat-x")), "GATE_NOT_DECIDER", /Only the person/);
    const ok = await h.engine.decideGate!(runId!, gate.gateId, { choice: "reject", comment: "broken" }, USER);
    assert.equal(ok.decision?.comment, "broken");
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
  });

  test("the person phase's timeout takes its choice (decidedBy timeout), counted from the phase start", async () => {
    const e = env([gateFlow({ timeout: { minutes: 30, then: { kind: "choice", choice: "reject" } } })]);
    const h = e.boot();
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    await e.shared.clock.advance(29 * MIN);
    assert.equal((await onlyGate(h, runId!)).decision, undefined);
    await e.shared.clock.advance(MIN);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    const run = (await h.runStore.load(runId!))!;
    assert.equal(run.blocks.G!.handle, "choice:reject");
    assert.equal((run.blocks.G!.output as { decidedBy: { kind: string } }).decidedBy.kind, "timeout");
  });

  test("timeout fail expires the gate (gate_expired) and the block's retry never runs it again", async () => {
    const e = env([gateFlow({ timeout: { minutes: 10, then: { kind: "fail" } } }, { retry: { maxTries: 3, delaySeconds: 1 } })]);
    const h = e.boot();
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    await e.shared.clock.advance(10 * MIN);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    const run = (await h.runStore.load(runId!))!;
    assert.equal(run.blocks.G!.error?.kind, "gate_expired");
    assert.equal(run.blocks.G!.attempt, 1, "never retried");
    const gate = Object.values(run.gates!)[0]!;
    assert.equal(gate.expired, true);
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "approve" }, USER), "RUN_NOT_ACTIVE");
  });

  test("without a timeout the person has 7 days, then gate_expired", async () => {
    const e = env([gateFlow()]);
    const h = e.boot();
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    await e.shared.clock.advance(7 * DAY - MIN);
    assert.equal((await h.runStore.load(runId!))!.status, "running");
    await e.shared.clock.advance(MIN);
    assert.equal((await h.engine.waitForRun(runId!)).status, "failed");
    assert.equal((await h.runStore.load(runId!))!.blocks.G!.error?.kind, "gate_expired");
  });

  test("a restart while the person decides: the gate resumes, the push is not repeated, and the decision continues the run", async () => {
    const e = env([gateFlow()]);
    const first = e.boot();
    const { runId } = await first.engine.run("w1", { input: { v: "1" } });
    await flush();
    const gate = await onlyGate(first, runId!);
    assert.equal(e.pushed.length, 1);
    await first.engine.stop();
    e.shared.clock.jump(3 * 60 * MIN);

    const code = scripted("code");
    const second = e.boot({ executors: { code } });
    await second.engine.resume();
    await flush();
    assert.equal(e.pushed.length, 1, "the same phase is never pushed twice");
    assert.equal((await onlyGate(second, runId!)).phaseDeadlineAt, gate.phaseDeadlineAt, "the deadline is the persisted one");
    await second.engine.decideGate!(runId!, gate.gateId, { choice: "approve" }, USER);
    assert.equal((await second.engine.waitForRun(runId!)).status, "succeeded");
    assert.deepEqual(code.seen, ["Yes"]);
  });

  test("a restart after the person deadline passed while the daemon was down applies the timeout at once", async () => {
    const e = env([gateFlow({ timeout: { minutes: 30, then: { kind: "choice", choice: "approve" } } })]);
    const first = e.boot();
    const { runId } = await first.engine.run("w1", { input: { v: "1" } });
    await flush();
    await first.engine.stop();
    e.shared.clock.jump(45 * MIN);
    const second = e.boot();
    await second.engine.resume();
    await e.shared.clock.advance(0);
    assert.equal((await second.engine.waitForRun(runId!)).status, "succeeded");
    assert.equal((await second.runStore.load(runId!))!.blocks.G!.handle, "choice:approve");
  });

  test("a decision persisted just before a stop is the one the restarted engine continues with", async () => {
    const e = env([gateFlow()]);
    const first = e.boot();
    const { runId } = await first.engine.run("w1", { input: { v: "1" } });
    await flush();
    const gate = await onlyGate(first, runId!);
    const deciding = first.engine.decideGate!(runId!, gate.gateId, { choice: "reject" }, USER);
    await first.engine.stop();
    await deciding;
    const stored = (await e.shared.runStore.load(runId!))!;
    assert.equal(stored.gates![gate.gateId]!.decision?.choice, "reject", "on disk before the run moved on");
    const second = e.boot();
    await second.engine.resume();
    assert.equal((await second.engine.waitForRun(runId!)).status, "succeeded");
    assert.equal((await second.runStore.load(runId!))!.blocks.No!.status, "succeeded");
  });

  test("a decision made while the push is being recorded is never missed", async () => {
    // A store whose writes can be held: the push's save waits while the person decides.
    class HeldRunStore extends InMemoryRunStore {
      held: Promise<void> | null = null;
      release: () => void = () => undefined;
      hold(): void {
        this.held = new Promise((resolve) => {
          this.release = () => {
            this.held = null;
            resolve();
          };
        });
      }
      override async save(run: Parameters<InMemoryRunStore["save"]>[0]): Promise<void> {
        if (this.held) await this.held;
        return super.save(run);
      }
    }
    const runStore = new HeldRunStore();
    const notifier: WorkflowNotifier = { runFinished: () => undefined, gateWaiting: () => runStore.hold() };
    const h = createHarness({ workflows: [gateFlow()], runStore, notifier, executors: { code: scripted("code") }, mintId: sequentialIds("id") });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    assert.ok(runStore.held, "the push's save is held");
    const gate = (await h.engine.getRun(runId!))!.gates!;
    const deciding = h.engine.decideGate!(runId!, Object.keys(gate)[0]!, { choice: "approve" }, USER);
    await flush();
    runStore.release();
    await deciding;
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
  });

  test("cancelling the run cancels the gate", async () => {
    const e = env([gateFlow()]);
    const h = e.boot();
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    const gate = await onlyGate(h, runId!);
    await h.engine.cancel(runId!);
    assert.equal((await h.engine.waitForRun(runId!)).status, "cancelled");
    const run = (await h.runStore.load(runId!))!;
    assert.equal(run.gates![gate.gateId]!.cancelled, true);
    assert.equal(run.pendingGates, undefined);
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "approve" }, USER), "RUN_NOT_ACTIVE");
    assert.ok(h.eventsOf("workflowRun.updated").some((payload) => (payload.gates as WorkflowGateState[] | undefined)?.some((g) => g.cancelled === true)));
  });
});

/** Waiting Gate-block gates no block (nor a loop's interrupted pass) waits on. */
function orphanGates(run: PersistedRun): string[] {
  const referenced = new Set<string>();
  for (const block of Object.values(run.blocks)) {
    if (block.waitingOn?.kind === "gate") referenced.add(block.waitingOn.gateId);
    for (const pass of block.passes ?? []) if (pass.interruptedFrom?.kind === "gate") referenced.add(pass.interruptedFrom.gateId);
  }
  return Object.values(run.gates ?? {})
    .filter((gate) => gate.source === "gate" && gate.decision === undefined && gate.cancelled !== true && gate.expired !== true && !referenced.has(gate.gateId))
    .map((gate) => gate.gateId);
}

describe("gate: the record and its wait reach disk together", () => {
  /** Every snapshot the engine writes. */
  class RecordingRunStore extends InMemoryRunStore {
    readonly saves: PersistedRun[] = [];
    held: Promise<void> | null = null;
    release: () => void = () => undefined;
    hold(): void {
      this.held = new Promise((resolve) => {
        this.release = () => {
          this.held = null;
          resolve();
        };
      });
    }
    override async save(run: PersistedRun): Promise<void> {
      this.saves.push(structuredClone(run));
      if (this.held) await this.held;
      return super.save(run);
    }
  }

  /** `currentBranch` can be held (the await before an executor starts). */
  class HeldBranchProjects extends FakeProjects {
    holding = false;
    private releases: (() => void)[] = [];
    override async currentBranch(): Promise<string | undefined> {
      if (this.holding) await new Promise<void>((resolve) => this.releases.push(resolve));
      return this.branch;
    }
    releaseBranch(): void {
      this.holding = false;
      for (const release of this.releases.splice(0)) release();
    }
  }

  /** T → C → G: C arms the hold, so G's executor starts once every earlier save has landed. */
  function heldFlow(projects: HeldBranchProjects): { flow: Workflow; code: ReturnType<typeof scripted<"code">> } {
    const flow = workflow(
      "w1",
      [T(), node("C", "code"), node("G", "gate", { question: "Ship?" }), node("Yes", "code"), node("No", "code")],
      [edge("T", "C"), edge("C", "G"), edge("G", "Yes", "choice:approve"), edge("G", "No", "choice:reject")]
    );
    const code = scripted("code", {
      C: () => {
        projects.holding = true;
        return { status: "succeeded", output: 1 };
      }
    });
    return { flow, code };
  }

  test("no save holds a waiting gate its block does not wait on", async () => {
    const projects = new HeldBranchProjects();
    const { flow, code } = heldFlow(projects);
    const e = env([flow]);
    const runStore = new RecordingRunStore();
    e.shared.runStore = runStore;
    e.shared.projects = projects;
    const h = e.boot({ executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    assert.equal((await h.engine.getRun(runId!))!.blocks.G!.status, "running", "G waits on currentBranch");
    projects.releaseBranch();
    await flush();
    assert.ok(runStore.saves.some((run) => Object.keys(run.gates ?? {}).length > 0), "the gate was saved");
    for (const run of runStore.saves) assert.deepEqual(orphanGates(run), [], "a gate record never reaches disk before its WaitingOn");
    await h.engine.cancel(runId!);
  });

  test("a stop while a gate block starts leaves no orphan gate: the restarted engine asks once", async () => {
    const projects = new HeldBranchProjects();
    const { flow, code } = heldFlow(projects);
    const e = env([flow]);
    const runStore = new RecordingRunStore();
    e.shared.runStore = runStore;
    e.shared.projects = projects;
    const first = e.boot({ executors: { code } });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    assert.equal((await first.engine.getRun(runId!))!.blocks.G!.status, "running", "G waits on currentBranch");
    // The stop's last save is in flight while G's executor goes on to open its gate.
    runStore.hold();
    const stopping = first.engine.stop();
    await flush();
    projects.releaseBranch();
    await flush();
    runStore.release();
    await stopping;
    assert.deepEqual(orphanGates((await runStore.load(runId!))!), [], "no gate record without its wait on disk");

    const second = e.boot();
    await second.engine.resume();
    await flush();
    const gates = await gatesOf(second, runId!);
    assert.equal(gates.filter((gate) => gate.decision === undefined && gate.cancelled !== true).length, 1, "one gate asks");
    await e.shared.clock.advance(1_000);
    assert.equal((await second.engine.getRun(runId!))!.pendingGates, 1);
    await second.engine.cancel(runId!);
  });

  test("a waiting gate on disk no block waits on (an older daemon's crash) is cancelled on resume", async () => {
    const e = env([gateFlow()]);
    const first = e.boot();
    const { runId } = await first.engine.run("w1", { input: { v: "1" } });
    await flush();
    const real = await onlyGate(first, runId!);
    await first.engine.stop();
    const stored = (await e.shared.runStore.load(runId!))!;
    stored.gates!["orphan"] = { ...structuredClone(real), gateId: "orphan" };
    stored.pendingGates = 2;
    stored.pendingPersonGates = 2;
    await e.shared.runStore.save(stored);

    const code = scripted("code");
    const second = e.boot({ executors: { code } });
    await second.engine.resume();
    await flush();
    const run = (await second.engine.getRun(runId!))!;
    assert.equal(run.gates!["orphan"]!.cancelled, true, "the orphan is cancelled");
    assert.equal(run.pendingGates, 1);
    assert.equal(run.pendingPersonGates, 1);
    await refusal(second.engine.decideGate!(runId!, "orphan", { choice: "reject" }, USER), "RUN_NOT_ACTIVE");
    await second.engine.decideGate!(runId!, real.gateId, { choice: "approve" }, USER);
    assert.equal((await second.engine.waitForRun(runId!)).status, "succeeded");
    assert.deepEqual(code.seen, ["Yes"]);
  });
});

describe("gate: disabled, pinned, retried and test runs (§7.5)", () => {
  test("a disabled gate asks nobody and takes its first choice", async () => {
    const e = env([gateFlow({}, { disabled: true })]);
    const code = scripted("code");
    const h = e.boot({ executors: { code } });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    assert.deepEqual(code.seen, ["Yes"]);
    assert.equal((await h.runStore.load(runId!))!.blocks.G!.handle, "choice:approve");
    assert.equal(e.pushed.length, 0);
    assert.equal(await gatesOf(h, runId!).then((gates) => gates.length), 0);
  });

  test("a pinned gate takes the choice its pin names in a test run", async () => {
    const e = env([gateFlow({}, {}, { pinned: { G: { choice: "reject" } } })]);
    const code = scripted("code");
    const h = e.boot({ executors: { code } });
    const { runId } = await h.engine.run("w1", { input: { v: "1" }, test: true, usePinned: true });
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    assert.deepEqual(code.seen, ["No"]);
    const block = (await h.runStore.load(runId!))!.blocks.G!;
    assert.equal(block.handle, "choice:reject");
    assert.equal(block.pinned, true);
  });

  test("a retry asks the gate again: its decision is never reused", async () => {
    const e = env([gateFlow()]);
    const failing = scripted("code", { Yes: () => ({ status: "failed", error: { kind: "exception", message: "boom" } }) });
    const h = e.boot({ executors: { code: failing } });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    await h.engine.decideGate!(runId!, (await onlyGate(h, runId!)).gateId, { choice: "approve" }, USER);
    assert.equal((await h.engine.waitForRun(runId!)).status, "failed");
    const retry = await h.engine.run("w1", { retryOf: runId! });
    await flush();
    const run = (await h.runStore.load(retry.runId!))!;
    assert.equal(run.blocks.T!.status, "succeeded", "the trigger is reused");
    assert.equal(run.blocks.G!.status, "waiting", "the gate asks again");
    assert.equal(Object.keys(run.gates ?? {}).length, 1);
    await h.engine.cancel(retry.runId!);
  });

  test("a test run's gate is the person's in the editor: no agent, no launcher, no push", async () => {
    const e = env([gateFlow({ decider: { kind: "agent", prompt: { kind: "text", text: "Review" }, chain: CHAIN } })]);
    const agent = controlledExecutor("agent");
    const h = e.boot({ executors: { gate: createGateExecutor({ agent }) } });
    const { runId } = await h.engine.run("w1", { input: { v: "1" }, test: true });
    await flush();
    const gate = await onlyGate(h, runId!);
    assert.equal(gate.test, true);
    assert.equal(gate.phase, "person");
    assert.equal(gate.decider.label, "you");
    assert.equal(agent.calls.length, 0, "no reviewer agent");
    assert.equal(e.pushed.length, 0, "no push");
    await e.shared.clock.advance(1_000);
    const summary = h.eventsOf("workflowRun.updated").at(-1)!.run as Record<string, unknown>;
    assert.equal(summary.pendingGates, 1);
    assert.equal(summary.pendingPersonGates, undefined, "no attention row for a test gate");
    await h.engine.decideGate!(runId!, gate.gateId, { choice: "approve" }, USER);
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
  });
});

// ---------------------------------------------------------------------------
// The launcher
// ---------------------------------------------------------------------------

interface ChatFake {
  api: FakeDaemonApi;
  turns: Record<string, unknown>[];
  /** What the next turn posts answer. */
  answers: ({ status: number; body: unknown })[];
}

function launcherChat(over: { exists?: boolean } = {}): ChatFake {
  const api = new FakeDaemonApi();
  const fake: ChatFake = { api, turns: [], answers: [] };
  api.on("GET", "/api/sessions", { status: 200, body: over.exists === false ? [] : [chatSummary({ id: "chat-1", title: "Lead" })] });
  api.on("GET", agentChatRoutes.thread("chat-1"), { status: 200, body: { kind: "snapshot", thread: snapshot() } });
  api.on("POST", agentChatCommandPath("chat-1", "turn"), ({ body }) => {
    fake.turns.push(structuredClone(body as Record<string, unknown>));
    return fake.answers.shift() ?? { status: 200, body: { seq: 1 } };
  });
  return fake;
}

describe("gate: the launching chat decides", () => {
  test("the run records startedBy; the gate queues one message (ifIdle, persisted command id) and only that chat may decide, with a comment", async () => {
    const e = env([gateFlow({ decider: { kind: "launcher", maxMinutes: 20 } })]);
    const chat = launcherChat();
    const code = scripted("code");
    const h = e.boot({ chatApi: chat.api, executors: { code } });
    const { runId } = await h.engine.run("w1", { input: { v: "2" } }, { startedBy: { kind: "thread", sessionId: "chat-1" } });
    await flush();
    const run = (await h.runStore.load(runId!))!;
    assert.deepEqual(run.startedBy, { kind: "thread", sessionId: "chat-1" });
    const gate = Object.values(run.gates!)[0]!;
    assert.equal(gate.phase, "agent");
    assert.deepEqual(gate.decider, { kind: "launcher", label: "the launching chat “Lead”", sessionId: "chat-1" });
    assert.equal(gate.phaseDeadlineAt, new Date(Date.parse(gate.openedAt) + 20 * MIN).toISOString());
    assert.equal(e.pushed.length, 0, "the person is not pushed while the launcher decides");
    assert.equal(chat.turns.length, 1);
    const turn = chat.turns[0]!;
    assert.equal(turn.ifIdle, true, "a queued turn, never a steer");
    assert.match(String(turn.input), /decide_workflow_gate \{"runId": "/);
    assert.ok(String(turn.input).includes(gate.gateId) && String(turn.input).includes("Ship 2?"));
    const waiting = run.blocks.G!.waitingOn;
    assert.ok(waiting?.kind === "gate" && waiting.launcher?.commandId === turn.commandId, "the command id was persisted");

    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "approve", comment: "ok" }, agentPrincipal("chat-2")), "GATE_NOT_DECIDER", /Only the launching chat “Lead”/);
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "approve" }, agentPrincipal("chat-1")), "INVALID_REQUEST", /explain/);
    const decided = await h.engine.decideGate!(runId!, gate.gateId, { choice: "approve", comment: "tests pass" }, agentPrincipal("chat-1"));
    assert.deepEqual(decided.decision?.decidedBy, { kind: "launcher", label: "the launching chat “Lead”", sessionId: "chat-1" });
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    assert.deepEqual(code.seen, ["Yes"]);
  });

  test("a busy chat gets the message at its next idle point, under the same command id", async () => {
    const e = env([gateFlow({ decider: { kind: "launcher" } })]);
    const chat = launcherChat();
    chat.answers.push({ status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "busy" } } });
    const h = e.boot({ chatApi: chat.api });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } }, { startedBy: { kind: "thread", sessionId: "chat-1" } });
    await flush();
    await e.shared.clock.advance(0);
    assert.equal(chat.turns.length, 2);
    assert.equal(chat.turns[0]!.commandId, chat.turns[1]!.commandId);
    const waiting = (await h.runStore.load(runId!))!.blocks.G!.waitingOn;
    assert.ok(waiting?.kind === "gate" && waiting.launcher?.delivered === true);
    await h.engine.cancel(runId!);
  });

  test("a restart before the message went out re-posts it under the persisted id; after delivery it is never sent again", async () => {
    const e = env([gateFlow({ decider: { kind: "launcher" } })]);
    const down = launcherChat();
    down.answers.push({ status: 503, body: { code: "HOST_UNAVAILABLE", message: "down" } }, { status: 503, body: { code: "HOST_UNAVAILABLE", message: "down" } }, { status: 503, body: { code: "HOST_UNAVAILABLE", message: "down" } }, { status: 503, body: { code: "HOST_UNAVAILABLE", message: "down" } });
    const first = e.boot({ chatApi: down.api });
    const { runId } = await first.engine.run("w1", { input: { v: "1" } }, { startedBy: { kind: "thread", sessionId: "chat-1" } });
    await flush();
    const commandId = down.turns[0]!.commandId;
    await first.engine.stop();

    const up = launcherChat();
    const second = e.boot({ chatApi: up.api });
    await second.engine.resume();
    await flush();
    assert.equal(up.turns.length, 1);
    assert.equal(up.turns[0]!.commandId, commandId, "the same id: the host's receipt dedupes it");
    await second.engine.stop();

    const again = launcherChat();
    const third = e.boot({ chatApi: again.api });
    await third.engine.resume();
    await flush();
    assert.equal(again.turns.length, 0, "delivered: never sent twice");
    const gate = await onlyGate(third, runId!);
    assert.equal(gate.phase, "agent");
    await third.engine.decideGate!(runId!, gate.gateId, { choice: "reject", comment: "no" }, agentPrincipal("chat-1"));
    assert.equal((await third.engine.waitForRun(runId!)).status, "succeeded");
  });

  test("the launcher not deciding within maxMinutes escalates to the person (push, escalated); the launcher may no longer decide", async () => {
    const e = env([gateFlow({ decider: { kind: "launcher", maxMinutes: 10 }, timeout: { minutes: 60, then: { kind: "fail" } } })]);
    const chat = launcherChat();
    const h = e.boot({ chatApi: chat.api });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } }, { startedBy: { kind: "thread", sessionId: "chat-1" } });
    await flush();
    await e.shared.clock.advance(10 * MIN);
    const gate = await onlyGate(h, runId!);
    assert.equal(gate.phase, "person");
    assert.equal(gate.escalated, true);
    assert.match(gate.escalationReason ?? "", /did not decide within 10 min/);
    assert.equal(gate.phaseDeadlineAt, new Date(Date.parse(gate.phaseStartedAt!) + 60 * MIN).toISOString(), "the timeout counts from the person phase's start");
    assert.equal(e.pushed.length, 1);
    assert.equal(e.pushed[0]!.escalated, true);
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "approve", comment: "late" }, agentPrincipal("chat-1")), "GATE_NOT_DECIDER", /handed to the person/);
    // The agent phase never applied `timeout`: it fails only an hour after the escalation.
    await e.shared.clock.advance(59 * MIN);
    assert.equal((await h.runStore.load(runId!))!.status, "running");
    await e.shared.clock.advance(MIN);
    assert.equal((await h.engine.waitForRun(runId!)).status, "failed");
  });

  test("the launcher escalates itself (comment required); a run not started by a chat asks the person at once", async () => {
    const e = env([gateFlow({ decider: { kind: "launcher" } })]);
    const chat = launcherChat();
    const h = e.boot({ chatApi: chat.api });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } }, { startedBy: { kind: "thread", sessionId: "chat-1" } });
    await flush();
    const gate = await onlyGate(h, runId!);
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { escalate: true }, agentPrincipal("chat-1")), "INVALID_REQUEST", /why/);
    const escalated = await h.engine.decideGate!(runId!, gate.gateId, { escalate: true, comment: "needs a human" }, agentPrincipal("chat-1"));
    assert.equal(escalated.alreadyDecided, false);
    assert.equal(escalated.decision, undefined);
    assert.equal(escalated.gate.phase, "person");
    assert.match(escalated.gate.escalationReason ?? "", /needs a human/);
    assert.equal(e.pushed.length, 1);
    await h.engine.cancel(runId!);
    await h.engine.waitForRun(runId!);

    const gui = await h.engine.run("w1", { input: { v: "2" } });
    await flush();
    const direct = await onlyGate(h, gui.runId!);
    assert.equal(direct.phase, "person");
    assert.equal(direct.escalated, false);
    assert.deepEqual((await h.runStore.load(gui.runId!))!.startedBy, { kind: "human" });
    assert.ok(((await h.runStore.load(gui.runId!))!.blocks.G!.warnings ?? []).some((w) => /No chat started this run/.test(w)));
    await h.engine.cancel(gui.runId!);
  });

  test("a launcher chat that is gone asks the person; one closed while asked escalates", async () => {
    const e = env([gateFlow({ decider: { kind: "launcher" } })]);
    const gone = launcherChat({ exists: false });
    const h = e.boot({ chatApi: gone.api });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } }, { startedBy: { kind: "thread", sessionId: "chat-1" } });
    await flush();
    assert.equal((await onlyGate(h, runId!)).phase, "person");
    assert.equal(gone.turns.length, 0);
    await h.engine.cancel(runId!);

    const closing = launcherChat();
    closing.answers.push({ status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "gone" } } });
    const h2 = e.boot({ chatApi: closing.api });
    const second = await h2.engine.run("w1", { input: { v: "1" } }, { startedBy: { kind: "thread", sessionId: "chat-1" } });
    await flush();
    const gate = await onlyGate(h2, second.runId!);
    assert.equal(gate.phase, "person");
    assert.match(gate.escalationReason ?? "", /closed/);
    await h2.engine.cancel(second.runId!);
  });

  test("a sub-workflow's gate asks the top-level run's launcher; the parent counts it and is parked", async () => {
    const child = workflow("child", [T(), node("G", "gate", { question: "Child?", decider: { kind: "launcher" } })], [edge("T", "G")], { name: "Child" });
    const parent = workflow("parent", [T(), node("Sub", "workflow", { workflowId: "child" })], [edge("T", "Sub")], { name: "Parent" });
    const e = env([parent, child]);
    const chat = launcherChat();
    const h = e.boot({ chatApi: chat.api });
    const { runId } = await h.engine.run("parent", {}, { startedBy: { kind: "thread", sessionId: "chat-1" } });
    await flush();
    const parentRun = (await h.runStore.load(runId!))!;
    const childId = parentRun.blocks.Sub!.childRunId!;
    const childRun = (await h.runStore.load(childId))!;
    assert.deepEqual(childRun.startedBy, { kind: "thread", sessionId: "chat-1" }, "inherited");
    const gate = Object.values(childRun.gates!)[0]!;
    assert.equal(gate.rootRunId, runId);
    assert.equal(gate.decider.sessionId, "chat-1");
    assert.match(String(chat.turns[0]!.input), /sub-workflow "Child"/);
    assert.equal(parentRun.pendingGates, 1, "the parent counts its child's gate");
    assert.equal(parentRun.parked, true, "parked through its parked child");
    await h.engine.decideGate!(childId, gate.gateId, { choice: "approve", comment: "fine" }, agentPrincipal("chat-1"));
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    const after = (await h.runStore.load(runId!))!;
    assert.equal(after.pendingGates, undefined);
  });
});

// ---------------------------------------------------------------------------
// The reviewer agent (a scripted agent executor stands in for the agent block's)
// ---------------------------------------------------------------------------

type AgentCall = { ctx: NodeExecutionContext<"agent">; resolve(result: NodeResult): void };

function reviewerFlow(over: Record<string, unknown> = {}): Workflow {
  return gateFlow({ decider: { kind: "agent", prompt: { kind: "text", text: "Review the diff." }, chain: CHAIN, profileId: "prof-1", maxMinutes: 30, ...over } });
}

async function reviewerSession(call: AgentCall, sessionId: string): Promise<void> {
  call.ctx.update({ sessionId });
  await call.ctx.setWaitingOn({ kind: "agent", sessionId, commandId: "cmd-1", command: "turn", baseline: null, deadlineAt: "2026-09-28T11:00:00.000Z", phase: "watching", state: { v: 1, marker: sessionId } });
}

describe("gate: a reviewer agent decides", () => {
  test("the reviewer runs on the agent block's machinery under the gate's node, and its own decision is not interrupted", async () => {
    const e = env([reviewerFlow()]);
    const agent = controlledExecutor("agent");
    const code = scripted("code");
    const h = e.boot({ executors: { gate: createGateExecutor({ agent }), code } });
    const { runId } = await h.engine.run("w1", { input: { v: "3" } });
    await flush();
    assert.equal(agent.calls.length, 1);
    const call = agent.calls[0]! as AgentCall;
    const config = call.ctx.node.config;
    assert.equal(call.ctx.node.id, "G", "its chat's owner names the gate's node");
    assert.deepEqual(config.chain.map((entry) => entry.agent), ["claude"]);
    assert.equal(config.profileId, "prof-1");
    assert.equal(config.maxMinutes, 30);
    assert.equal(config.session.kind, "new");
    assert.equal(config.whenAllBurnt.kind, "fail");
    const text = config.prompt.kind === "text" ? config.prompt.text : "";
    assert.match(text, /^Review the diff\./);
    assert.match(text, /<([^>]+)>Ship 3\?<\/\1>/, "the rendered (redacted) question, framed as data");
    assert.match(text, /decide_workflow_gate/);
    const gate = await onlyGate(h, runId!);
    assert.equal(gate.phase, "agent");
    assert.equal(gate.decider.label, "Reviewer agent (claude)");

    await reviewerSession(call, "rev-1");
    await flush();
    assert.equal((await onlyGate(h, runId!)).decider.sessionId, "rev-1");
    const stored = (await h.runStore.load(runId!))!.blocks.G!.waitingOn;
    assert.ok(stored?.kind === "gate" && stored.agent?.sessionId === "rev-1", "the agent's resume state rides the gate's WaitingOn");

    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "approve" }, agentPrincipal("rev-1")), "INVALID_REQUEST", /explain/);
    const decided = await h.engine.decideGate!(runId!, gate.gateId, { choice: "approve", comment: "LGTM" }, agentPrincipal("rev-1"));
    assert.deepEqual(decided.decision?.decidedBy, { kind: "agent", label: "Reviewer agent (claude)", sessionId: "rev-1" });
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    assert.equal(call.ctx.signal.aborted, false, "its turn ends on its own");
    // What it still records is dropped.
    await assert.rejects(call.ctx.setWaitingOn(undefined));
    call.resolve({ status: "succeeded", output: {} });
    assert.deepEqual(code.seen, ["Yes"]);
  });

  test("a turn that settles without a decision gets one reminder in the same chat; a second escalates", async () => {
    const e = env([reviewerFlow()]);
    const agent = controlledExecutor("agent");
    const h = e.boot({ executors: { gate: createGateExecutor({ agent }) } });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    const first = agent.calls[0]! as AgentCall;
    await reviewerSession(first, "rev-1");
    await first.ctx.setWaitingOn(undefined);
    first.resolve({ status: "succeeded", output: { text: "thinking" } });
    await flush();
    assert.equal(agent.calls.length, 2, "the reminder");
    const reminder = agent.calls[1]! as AgentCall;
    assert.deepEqual(reminder.ctx.node.config.session, { kind: "continue", fromNode: "G" });
    assert.deepEqual(reminder.ctx.expressionContext().nodes.G?.output, { sessionId: "rev-1" });
    assert.match(reminder.ctx.node.config.prompt.kind === "text" ? reminder.ctx.node.config.prompt.text : "", /only reminder/);
    const waiting = (await h.runStore.load(runId!))!.blocks.G!.waitingOn;
    assert.ok(waiting?.kind === "gate" && waiting.reminders === 1, "persisted before the reminder");
    reminder.resolve({ status: "succeeded", output: {} });
    await flush();
    const gate = await onlyGate(h, runId!);
    assert.equal(gate.phase, "person");
    assert.match(gate.escalationReason ?? "", /twice without deciding/);
    assert.equal(e.pushed.length, 1);
    await h.engine.decideGate!(runId!, gate.gateId, { choice: "reject" }, USER);
    await h.engine.waitForRun(runId!);
    const output = (await h.runStore.load(runId!))!.blocks.G!.output as { escalated: boolean };
    assert.equal(output.escalated, true);
  });

  test("a reviewer that fails escalates to the person", async () => {
    const e = env([reviewerFlow()]);
    const agent = controlledExecutor("agent");
    const h = e.boot({ executors: { gate: createGateExecutor({ agent }) } });
    const failed = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    (agent.calls[0]! as AgentCall).resolve({ status: "failed", error: { kind: "all_burnt", message: "Every account is burnt." } });
    await flush();
    const gate = await onlyGate(h, failed.runId!);
    assert.equal(gate.phase, "person");
    assert.match(gate.escalationReason ?? "", /failed: Every account is burnt/);
    await h.engine.cancel(failed.runId!);
  });

  test("the person decides while the reviewer works: the reviewer is interrupted, the person's decision stands", async () => {
    const e = env([reviewerFlow()]);
    const agent = controlledExecutor("agent");
    const h = e.boot({ executors: { gate: createGateExecutor({ agent }) } });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    const call = agent.calls[0]! as AgentCall;
    await reviewerSession(call, "rev-1");
    const gate = await onlyGate(h, runId!);
    await h.engine.decideGate!(runId!, gate.gateId, { choice: "reject" }, USER);
    await flush();
    assert.equal(call.ctx.signal.aborted, true, "interrupted (the agent executor's cancel)");
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    await refusal(h.engine.decideGate!(runId!, gate.gateId, { choice: "approve", comment: "x" }, agentPrincipal("someone")), "GATE_NOT_DECIDER");
  });

  test("the agent phase's deadline escalates and interrupts the reviewer", async () => {
    const e = env([reviewerFlow({ maxMinutes: 15 })]);
    const agent = controlledExecutor("agent");
    const h = e.boot({ executors: { gate: createGateExecutor({ agent }) } });
    const { runId } = await h.engine.run("w1", { input: { v: "1" } });
    await flush();
    const call = agent.calls[0]! as AgentCall;
    await e.shared.clock.advance(15 * MIN);
    assert.equal(call.ctx.signal.aborted, true);
    const gate = await onlyGate(h, runId!);
    assert.equal(gate.phase, "person");
    assert.match(gate.escalationReason ?? "", /did not decide within 15 min/);
    await h.engine.cancel(runId!);
  });

  test("a restart while the reviewer works resumes it from its persisted state (same chat, same deadline)", async () => {
    const e = env([reviewerFlow()]);
    const firstAgent = controlledExecutor("agent");
    const first = e.boot({ executors: { gate: createGateExecutor({ agent: firstAgent }) } });
    const { runId } = await first.engine.run("w1", { input: { v: "1" } });
    await flush();
    await reviewerSession(firstAgent.calls[0]! as AgentCall, "rev-1");
    await flush();
    const before = await onlyGate(first, runId!);
    await first.engine.stop();

    const agent = controlledExecutor("agent");
    const second = e.boot({ executors: { gate: createGateExecutor({ agent }) } });
    await second.engine.resume();
    await flush();
    assert.equal(agent.calls.length, 1);
    const resumed = agent.calls[0]! as AgentCall;
    assert.equal(resumed.ctx.resumeFrom?.kind, "agent");
    assert.ok(resumed.ctx.resumeFrom?.kind === "agent" && resumed.ctx.resumeFrom.sessionId === "rev-1");
    const gate = await onlyGate(second, runId!);
    assert.equal(gate.phaseDeadlineAt, before.phaseDeadlineAt);
    await second.engine.decideGate!(runId!, gate.gateId, { choice: "approve", comment: "ok" }, agentPrincipal("rev-1"));
    assert.equal((await second.engine.waitForRun(runId!)).status, "succeeded");
  });

  test("a restart after the escalation was persisted does not ask the reviewer again", async () => {
    const e = env([reviewerFlow()]);
    const firstAgent = controlledExecutor("agent");
    const first = e.boot({ executors: { gate: createGateExecutor({ agent: firstAgent }) } });
    const { runId } = await first.engine.run("w1", { input: { v: "1" } });
    await flush();
    await reviewerSession(firstAgent.calls[0]! as AgentCall, "rev-1");
    const gate = await onlyGate(first, runId!);
    await first.engine.decideGate!(runId!, gate.gateId, { escalate: true, comment: "unsure" }, agentPrincipal("rev-1"));
    await first.engine.stop();
    const agent = controlledExecutor("agent");
    const second = e.boot({ executors: { gate: createGateExecutor({ agent }) } });
    await second.engine.resume();
    await flush();
    assert.equal(agent.calls.length, 0);
    assert.equal((await onlyGate(second, runId!)).phase, "person");
    await second.engine.cancel(runId!);
  });
});

// ---------------------------------------------------------------------------
// The engine-internal person gate (what a loop edge at its limit opens, §7.2)
// ---------------------------------------------------------------------------

describe("gate: the engine-internal person gate API", () => {
  // Its code block re-runs after a restart (retries left), so the run outlives the restart.
  const working = () => workflow("w2", [T(), node("Work", "code", {}, { retry: { maxTries: 3, delaySeconds: 0 } })], [edge("T", "Work")], { name: "Looping" });
  const spec = {
    nodeId: "Work",
    pass: 3,
    source: "loop_limit" as const,
    edgeId: "e-loop",
    question: "Work → Fix reached its limit (3).",
    choices: [{ id: "more", label: "Allow one more loop", comment: "none" as const }, { id: "stop", label: "Stop", color: "danger" as const, comment: "none" as const }]
  };

  test("openPersonGate persists and pushes; awaitGate resolves with the person's decision", async () => {
    const e = env([working()]);
    const code = controlledExecutor("code");
    const h = e.boot({ executors: { code } });
    const { runId } = await h.engine.run("w2", {});
    await flush();
    const opened = await h.engine.gates.openPersonGate(runId!, spec);
    assert.equal(opened.source, "loop_limit");
    assert.equal(opened.edgeId, "e-loop");
    assert.equal(opened.pass, 3);
    assert.equal(opened.nodeName, "Work");
    assert.deepEqual(opened.decider, { kind: "human", label: "you" });
    assert.equal((await e.shared.runStore.load(runId!))!.gates![opened.gateId]!.question, spec.question, "on disk");
    assert.equal(e.pushed.length, 1);
    const controller = new AbortController();
    const waiting = h.engine.gates.awaitGate(runId!, opened.gateId, controller.signal);
    await h.engine.decideGate!(runId!, opened.gateId, { choice: "more" }, USER);
    const result = await waiting;
    assert.equal(result.kind, "decided");
    assert.equal(result.kind === "decided" && result.decision.choice, "more");
    code.calls[0]!.resolve({ status: "succeeded", output: 1 });
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
  });

  test("awaitGate re-arms after a restart and expires after the 7-day maximum; a run's end cancels it", async () => {
    const e = env([working()]);
    const first = e.boot({ executors: { code: controlledExecutor("code") } });
    const { runId } = await first.engine.run("w2", {});
    await flush();
    const opened = await first.engine.gates.openPersonGate(runId!, spec);
    await first.engine.stop();
    e.shared.clock.jump(7 * DAY + MIN);
    const second = e.boot({ executors: { code: controlledExecutor("code") } });
    await second.engine.resume();
    await flush();
    assert.equal(e.pushed.length, 1, "pushed once");
    const result = await second.engine.gates.awaitGate(runId!, opened.gateId, new AbortController().signal);
    assert.equal(result.kind, "expired");
    const again = await second.engine.gates.openPersonGate(runId!, { ...spec, pass: 4 });
    const waiting = second.engine.gates.awaitGate(runId!, again.gateId, new AbortController().signal);
    await second.engine.cancel(runId!);
    assert.deepEqual(await waiting, { kind: "cancelled" });
  });
});
