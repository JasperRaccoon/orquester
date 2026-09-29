// End to end, in-process: agent blocks THROUGH THE ENGINE — the runtime as `startDaemon` wires it
// (daemon-wiring.ts: the agent executor, the account preview, the cooldowns in workflow-state.json)
// on real stores in a temp appdir, driven over the real routes, with the `FakeChatHost` standing in
// for the daemon's chat routes (the engine's `DaemonApi`) and a fake clock for everything the agent
// block times.
//
//   - a restart while the agent works: the new runtime re-enters the watcher from run.json and never
//     sends the turn twice (the command id was persisted before the POST).

import assert from "node:assert/strict";
import { after, describe, test, type TestContext } from "node:test";

import type { GetWorkflowRunResponse, RunWorkflowResponse, WorkflowRun, WorkflowWriteResponse } from "@orquester/api";
import { join } from "node:path";
import { workflowRunsDir } from "@orquester/config";

import { realClock } from "./factory.ts";
import type { AgentBlockOutput } from "./agent/executor.ts";
import { account, staticAccounts, staticUsage } from "./agent/testing/fake-context.ts";
import { FakeChatHost } from "./agent/testing/fake-chat-host.ts";
import { FakeClock, flushAsync } from "./agent/testing/fake-clock.ts";
import { boot, runFinished, tempAppdir, waitForFileState, type Booted } from "./testing/daemon-harness.ts";

const FIXED = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;
const ACCOUNTS = [account("claude", "a1", "alpha")];

const dirs: Awaited<ReturnType<typeof tempAppdir>>[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => dir.cleanup()));
});

/**
 * Run the fake clock until `done()`: let real I/O (run.json writes, the routes) settle, then jump to
 * the next fake timer — the agent block's waits, the fake provider's steps, the engine's throttles.
 */
async function driveUntil(h: Booted, clock: FakeClock, done: () => boolean, label: string): Promise<void> {
  for (let step = 0; step < 20_000; step += 1) {
    await flushAsync(8);
    await Promise.all([h.runStore.flush(), h.state.flush()]);
    if (done()) return;
    const timer = (clock as unknown as { nextTimer(): { at: number } | undefined }).nextTimer();
    await clock.advance(timer ? Math.min(1_000, Math.max(0, timer.at - clock.now().getTime())) : 0);
  }
  throw new Error(`driveUntil gave up: ${label}`);
}

async function json<T>(h: Booted, method: "GET" | "POST", url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await h.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) as T };
}

function agentConfig(chain: unknown[], text: string): Record<string, unknown> {
  return { prompt: { kind: "text", text }, chain, autonomyNote: true };
}

async function setup(host: FakeChatHost, clock: FakeClock, t: TestContext): Promise<{ h: Booted; projectPath: string; dir: Awaited<ReturnType<typeof tempAppdir>> }> {
  const dir = await tempAppdir();
  dirs.push(dir);
  t.mock.method(realClock, "now", () => clock.now());
  t.mock.method(realClock, "setTimeout", (fn: () => void, ms: number) => clock.setTimeout(fn, ms));
  const h = await boot(dir.root, { engineApi: () => host, accounts: staticAccounts(host), usage: staticUsage() });
  return { h, projectPath: join(dir.workspacesDir, "acme", "app"), dir };
}

const finishedIn = (h: Booted, runId: string) => () => h.events.some(runFinished(runId));

describe("e2e: agent blocks through the engine", () => {
  test("a restart while the agent works resumes the watcher and never sends the turn twice", async (t) => {
    const clock = new FakeClock("2026-09-28T12:00:00.000Z");
    const host = new FakeChatHost({
      clock,
      accounts: ACCOUNTS,
      behaviour: () => [{ kind: "say", text: "working on it" }, { kind: "wait", ms: 10 * 60_000 }, { kind: "say", text: "all done" }]
    });
    const setupResult = await setup(host, clock, t);
    let h = setupResult.h;
    try {
      const created = await json<WorkflowWriteResponse>(h, "POST", "/api/workflows", {
        name: "Long agent",
        project: { kind: "existing", projectPath: setupResult.projectPath },
        nodes: [
          { id: "start", type: "trigger.manual", name: "Start" },
          { id: "work", type: "agent", name: "Work", config: agentConfig([{ agent: "claude", model: "opus", accounts: { ...FIXED, accounts: ["a1"] } }], "Do the long thing.") }
        ],
        edges: [{ source: "Start", target: "Work" }]
      });
      const workflowId = created.body.workflow.id;
      const runId = (await json<RunWorkflowResponse>(h, "POST", `/api/workflows/${workflowId}/run`, {})).body.runId!;

      // Until the turn is running at the provider and the block's WaitingOn says so on disk.
      await driveUntil(h, clock, () => host.turnLog.length === 1 && host.session(host.sessionsOwnedBy("work")[0]!.id).activeTurnId !== null, "the turn to start");
      const persisted = await waitForFileState(join(workflowRunsDir(setupResult.dir.root), runId, "run.json"), () => h.runStore.load(runId), (run) => (run?.blocks.work?.waitingOn as { phase?: string } | undefined)?.phase === "watching");
      const waitingOn = persisted!.blocks.work!.waitingOn as { kind: string; commandId: string; phase: string };
      assert.equal(waitingOn.kind, "agent");
      assert.equal(waitingOn.phase, "watching", JSON.stringify(waitingOn));

      await h.close();
      h = await boot(setupResult.dir.root, { engineApi: () => host, accounts: staticAccounts(host), usage: staticUsage() });
      await driveUntil(h, clock, finishedIn(h, runId), "the resumed run");
      const run = (await json<GetWorkflowRunResponse>(h, "GET", `/api/workflow-runs/${runId}`)).body.run as WorkflowRun;
      assert.equal(run.status, "succeeded", JSON.stringify(run.blocks.work, null, 2));
      assert.equal((run.blocks.work!.output as AgentBlockOutput).text, "working on it\n\nall done", "the turn's whole answer");
      assert.equal(run.blocks.work!.attempt, 1, "resumed, not retried");
      assert.equal(host.commandCount("turn"), 1, "the turn was sent once");
      assert.equal(host.sessionsOwnedBy("work").length, 1, "one session");
    } finally {
      await h.close();
    }
  });
});
