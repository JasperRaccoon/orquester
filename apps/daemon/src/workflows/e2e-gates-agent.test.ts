// End to end: a gate's reviewer agent on the REAL agent executor, through the engine and the real
// routes (spec 2026-11-10 §6.3), with the `FakeChatHost` for the chat routes and a fake clock:
//
//   - the reviewer's chat is owned by the gate's node and gets the gate section; a turn that ends
//     without a decision gets ONE reminder in the same chat (session: continue), a second escalates;
//   - a restart while the reviewer works resumes it (the turn is never sent twice), and it then
//     decides with its own chat's principal.

import assert from "node:assert/strict";
import { after, describe, test, type TestContext } from "node:test";

import type { GetWorkflowRunResponse, RunWorkflowResponse, WorkflowRun, WorkflowWriteResponse } from "@orquester/api";
import { workflowRoutes } from "@orquester/api";
import { join } from "node:path";
import { workflowRunsDir } from "@orquester/config";

import { realClock } from "./factory.ts";
import { account, staticAccounts, staticUsage } from "./agent/testing/fake-context.ts";
import { FakeChatHost, type FakeBehaviour } from "./agent/testing/fake-chat-host.ts";
import { FakeClock, flushAsync } from "./agent/testing/fake-clock.ts";
import { boot, runFinished, tempAppdir, waitForFileState, type Booted } from "./testing/daemon-harness.ts";

const FIXED = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;
const ACCOUNTS = [account("claude", "a1", "alpha")];

const dirs: Awaited<ReturnType<typeof tempAppdir>>[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => dir.cleanup()));
});

async function driveUntil(h: Booted, clock: FakeClock, done: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let step = 0; step < 20_000; step += 1) {
    await flushAsync(8);
    await Promise.all([h.runStore.flush(), h.state.flush()]);
    if (await done()) return;
    const timer = (clock as unknown as { nextTimer(): { at: number } | undefined }).nextTimer();
    await clock.advance(timer ? Math.min(1_000, Math.max(0, timer.at - clock.now().getTime())) : 0);
  }
  throw new Error(`driveUntil gave up: ${label}`);
}

async function json<T>(h: Booted, method: "GET" | "POST", url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await h.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) as T };
}

async function setup(behaviour: FakeBehaviour, t: TestContext) {
  const clock = new FakeClock("2026-11-10T12:00:00.000Z");
  const host = new FakeChatHost({ clock, accounts: ACCOUNTS, behaviour });
  const dir = await tempAppdir();
  dirs.push(dir);
  t.mock.method(realClock, "now", () => clock.now());
  t.mock.method(realClock, "setTimeout", (fn: () => void, ms: number) => clock.setTimeout(fn, ms));
  const start = () => boot(dir.root, { engineApi: () => host, accounts: staticAccounts(host), usage: staticUsage() });
  const h = await start();
  const created = await json<WorkflowWriteResponse>(h, "POST", "/api/workflows", {
    name: "Reviewed",
    project: { kind: "existing", projectPath: join(dir.workspacesDir, "acme", "app") },
    nodes: [
      { id: "start", type: "trigger.manual", name: "Start" },
      {
        id: "g",
        type: "gate",
        name: "Review",
        config: {
          question: "Merge {{ workflow.name }}?",
          decider: { kind: "agent", prompt: { kind: "text", text: "You review merges." }, chain: [{ agent: "claude", model: "opus", accounts: { ...FIXED, accounts: ["a1"] } }], maxMinutes: 60 }
        }
      }
    ],
    edges: [{ source: "Start", target: "Review" }]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const runId = (await json<RunWorkflowResponse>(h, "POST", `/api/workflows/${created.body.workflow.id}/run`, {})).body.runId!;
  return { clock, host, dir, h, start, runId };
}

const runOf = async (h: Booted, runId: string): Promise<WorkflowRun> => (await json<GetWorkflowRunResponse>(h, "GET", `/api/workflow-runs/${runId}`)).body.run;

describe("e2e: a gate's reviewer agent on the agent executor", () => {
  test("a reviewer that ends its turns without deciding is reminded once in the same chat, then the person is asked", async (t) => {
    const { clock, host, h, runId } = await setup(() => [{ kind: "say", text: "I need to think." }], t);
    try {
      await driveUntil(h, clock, async () => (Object.values((await runOf(h, runId)).gates ?? {})[0]?.phase ?? "agent") === "person", "the escalation");
      const sessions = host.sessionsOwnedBy("g");
      assert.equal(sessions.length, 1, "one reviewer chat, owned by the gate's node");
      assert.equal(host.turnLog.length, 2, "the turn and one reminder");
      assert.ok(host.turnLog.every((turn) => turn.sessionId === sessions[0]!.id), "the reminder continues the same chat");
      assert.match(host.turnLog[0]!.input, /^You review merges\./);
      assert.match(host.turnLog[0]!.input, /Merge Reviewed\?/);
      assert.match(host.turnLog[0]!.input, /decide_workflow_gate \{"runId": /);
      assert.match(host.turnLog[1]!.input, /only reminder/);
      const gate = Object.values((await runOf(h, runId)).gates!)[0]!;
      assert.equal(gate.escalated, true);
      assert.match(gate.escalationReason ?? "", /twice without deciding/);
      await json(h, "POST", workflowRoutes.gateDecide(runId, gate.gateId), { choice: "approve" });
      await driveUntil(h, clock, () => h.events.some(runFinished(runId)), "the run's end");
      assert.equal((await runOf(h, runId)).status, "succeeded");
    } finally {
      await h.close();
    }
  });

  test("a restart while the reviewer works resumes it without resending, and it decides with its own chat", async (t) => {
    const { clock, host, dir, h: first, start, runId } = await setup(() => [{ kind: "say", text: "Reading the diff" }, { kind: "wait", ms: 10 * 60_000 }, { kind: "say", text: "Looks good." }], t);
    let h = first;
    try {
      await driveUntil(h, clock, () => host.turnLog.length === 1 && host.session(host.sessionsOwnedBy("g")[0]!.id).activeTurnId !== null, "the reviewer's turn");
      await waitForFileState(join(workflowRunsDir(dir.root), runId, "run.json"), () => h.runStore.load(runId), (run) => {
        const waitingOn = run?.blocks.g?.waitingOn;
        return waitingOn?.kind === "gate" && waitingOn.agent?.phase === "watching";
      });
      await h.close();
      h = await start();
      const sessionId = host.sessionsOwnedBy("g")[0]!.id;
      await driveUntil(h, clock, () => host.turnLog.length === 2, "the reminder after the resumed turn settled");
      assert.equal(host.commandCount("turn"), 2, "the first turn was sent once, then the reminder");
      assert.equal(host.turnLog[1]!.sessionId, sessionId);
      const gate = Object.values((await runOf(h, runId)).gates!)[0]!;
      assert.equal(gate.decider.sessionId, sessionId);
      const res = await h.api.request("POST", workflowRoutes.gateDecide(runId, gate.gateId), { body: { choice: "approve", comment: "The diff is fine." }, principal: { kind: "agent", threadId: sessionId, projectPath: "" } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await driveUntil(h, clock, () => h.events.some(runFinished(runId)), "the run's end");
      const run = await runOf(h, runId);
      assert.equal(run.status, "succeeded");
      assert.deepEqual((run.blocks.g!.output as { decidedBy: unknown }).decidedBy, { kind: "agent", label: "Reviewer agent (claude)", sessionId });
    } finally {
      await h.close();
    }
  });
});
