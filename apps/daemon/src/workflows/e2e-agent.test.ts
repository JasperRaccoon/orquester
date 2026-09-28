// End to end, in-process: agent blocks THROUGH THE ENGINE — the runtime as `startDaemon` wires it
// (daemon-wiring.ts: the agent executor, the account preview, the cooldowns in workflow-state.json)
// on real stores in a temp appdir, driven over the real routes, with the `FakeChatHost` standing in
// for the daemon's chat routes (the engine's `DaemonApi`) and a fake clock for everything the agent
// block times.
//
//   - a usage limit on the first account switches to the next one of the SAME family in the SAME
//     session; a limit there hands off to the next chain entry (another family) in a NEW session;
//     both accounts cool down in workflow-state.json, and the account preview agrees with the run;
//   - a restart while the agent works: the new runtime re-enters the watcher from run.json and never
//     sends the turn twice (the command id was persisted before the POST).

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import type { AccountPreviewResponse, EventMessage, GetWorkflowRunResponse, RunWorkflowResponse, WorkflowRun, WorkflowWriteResponse } from "@orquester/api";
import { join } from "node:path";

import type { AgentBlockOutput } from "./agent/executor.ts";
import { account, staticAccounts, staticUsage } from "./agent/testing/fake-context.ts";
import { byAccount, FakeChatHost } from "./agent/testing/fake-chat-host.ts";
import { FakeClock, flushAsync } from "./agent/testing/fake-clock.ts";
import { boot, runFinished, tempAppdir, type Booted } from "./testing/daemon-harness.ts";

const FIXED = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;
const ACCOUNTS = [account("claude", "a1", "alpha"), account("claude", "a2", "beta"), account("codex", "c1", "cx-one")];
const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dirs: Awaited<ReturnType<typeof tempAppdir>>[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => dir.cleanup()));
});

/**
 * Run the fake clock until `done()`: let real I/O (run.json writes, the routes) settle, then jump to
 * the next fake timer — the agent block's waits, the fake provider's steps, the engine's throttles.
 */
async function driveUntil(clock: FakeClock, done: () => boolean, label: string): Promise<void> {
  const next = (): { at: number } | undefined => (clock as unknown as { nextTimer(): { at: number } | undefined }).nextTimer();
  const settle = async (ms: number): Promise<void> => {
    await flushAsync(4);
    await realDelay(ms);
    await flushAsync(4);
  };
  for (let step = 0; step < 20_000; step += 1) {
    await settle(1);
    if (done()) return;
    let timer = next();
    if (!timer) {
      await realDelay(5);
      continue;
    }
    // A far timer (the hourly sweep, a block's deadline) is jumped to only once real I/O had time to
    // land — otherwise time would run away while a run.json write is in flight.
    if (timer.at - clock.now().getTime() > 30_000) {
      await settle(30);
      if (done()) return;
      timer = next();
      if (!timer) continue;
    }
    await clock.advance(Math.max(0, timer.at - clock.now().getTime()));
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

async function setup(host: FakeChatHost, clock: FakeClock): Promise<{ h: Booted; projectPath: string; dir: Awaited<ReturnType<typeof tempAppdir>> }> {
  const dir = await tempAppdir();
  dirs.push(dir);
  const h = await boot(dir.root, { clock, engineApi: () => host, accounts: staticAccounts(host), usage: staticUsage() });
  return { h, projectPath: join(dir.workspacesDir, "acme", "app"), dir };
}

const finishedIn = (h: Booted, runId: string) => () => h.events.some(runFinished(runId));

describe("e2e: agent blocks through the engine", () => {
  test("a usage limit switches accounts in the same session, then hands off across families", async () => {
    const clock = new FakeClock("2026-09-28T12:00:00.000Z");
    const host = new FakeChatHost({
      clock,
      accounts: ACCOUNTS,
      behaviour: byAccount({
        a1: [{ kind: "limit" }],
        a2: [{ kind: "say", text: "I changed src/app.ts" }, { kind: "limit" }],
        c1: [{ kind: "say", text: "codex finished" }]
      })
    });
    const { h, projectPath } = await setup(host, clock);
    try {
      const chain = [
        { agent: "claude", model: "opus", accounts: { ...FIXED, accounts: ["a1", "a2"] } },
        { agent: "codex", model: "gpt-5", accounts: { ...FIXED } }
      ];
      const created = await json<WorkflowWriteResponse>(h, "POST", "/api/workflows", {
        name: "Fixer",
        project: { kind: "existing", projectPath },
        nodes: [
          { id: "start", type: "trigger.manual", name: "Start" },
          { id: "fix", type: "agent", name: "Fix", config: agentConfig(chain, "Fix issue #7.") },
          // Downstream reads the agent's output (no process: the fake clock drives this test).
          { id: "who", type: "if", name: "Who", config: { rules: [{ left: "{{ nodes.Fix.output.agent }}:{{ input.accountId }}", op: "equals", right: "codex:c1" }] } },
          { id: "done", type: "stop", name: "Done", config: { as: "success", value: "{{ nodes.Fix.output.text }}" } }
        ],
        edges: [
          { source: "Start", target: "Fix" },
          { source: "Fix", target: "Who" },
          { source: "Who", sourceHandle: "true", target: "Done" }
        ]
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const workflowId = created.body.workflow.id;

      // Who would run now: the first account of the first entry.
      const before = await json<AccountPreviewResponse>(h, "POST", "/api/workflows/account-preview", { chain });
      assert.equal(before.body.decision.chosen?.accountId, "a1");

      const started = await json<RunWorkflowResponse>(h, "POST", `/api/workflows/${workflowId}/run`, {});
      const runId = started.body.runId!;
      await driveUntil(clock, finishedIn(h, runId), "the agent run");
      const run = (await json<GetWorkflowRunResponse>(h, "GET", `/api/workflow-runs/${runId}`)).body.run as WorkflowRun;
      // A Stop block (as success) ends the run `stopped`, its value the run's final output.
      assert.equal(run.status, "stopped", JSON.stringify({ error: run.error, fix: run.blocks.fix }, null, 2));

      const out = run.blocks.fix!.output as AgentBlockOutput;
      assert.equal(out.text, "codex finished");
      assert.equal(out.agent, "codex");
      assert.equal(out.accountId, "c1");
      assert.deepEqual(
        out.hops.map((hop) => [hop.agent, hop.accountId, hop.via]),
        [
          ["claude", "a1", "initial"],
          ["claude", "a2", "switched"],
          ["codex", "c1", "handoff"]
        ]
      );
      assert.deepEqual(run.blocks.fix!.hops!.map((hop) => hop.accountId), ["a1", "a2", "c1"], "the run view carries the hops");
      assert.equal(run.blocks.who!.handle, "true");
      assert.equal(run.blocks.done!.status, "succeeded");
      assert.equal(run.finalOutput, "codex finished");

      // Two sessions, both owned by the block: the switch kept the first, the handoff made the second.
      const owned = host.sessionsOwnedBy("fix");
      assert.equal(owned.length, 2);
      for (const session of owned) assert.deepEqual(session.owner, { kind: "workflow", workflowId, runId, nodeId: "fix" });
      assert.deepEqual(owned[0]!.commands.filter((c) => c.name === "account" && !c.deduped).map((c) => c.body.accountId), ["a2"]);
      const handoff = host.turnLog.find((turn) => turn.refId === "codex")!.input;
      assert.ok(handoff.startsWith("Fix issue #7."), "the handoff carries the original prompt");
      assert.ok(handoff.includes("I changed src/app.ts"), "and what the previous agent said");

      // Both Claude accounts cooled down, in workflow-state.json, and the preview now agrees.
      const cooldowns = h.state.get().cooldowns;
      assert.equal(cooldowns["claude:a1"]?.reason, "usage_limit");
      assert.equal(cooldowns["claude:a2"]?.reason, "usage_limit");
      const afterRun = await json<AccountPreviewResponse>(h, "POST", "/api/workflows/account-preview", { chain });
      assert.ok(clock.now().getTime() - Date.parse("2026-09-28T12:00:00.000Z") < 60 * 60_000, `fake time stayed within the cooldown (${clock.now().toISOString()})`);
      assert.equal(afterRun.body.decision.chosen?.agent, "codex");
      assert.equal(afterRun.body.decision.chosen?.accountId, "c1");

      const events = h.events.filter((e: EventMessage) => (e.payload as { run?: { id?: string } })?.run?.id === runId);
      assert.ok(events.some((e) => e.type === "workflowRun.updated" && (e.payload as { blocks: { nodeId: string; hops?: unknown[] }[] }).blocks.some((b) => b.nodeId === "fix" && (b.hops?.length ?? 0) >= 2)), "the hops reached the bus live");
    } finally {
      await h.close();
    }
  });

  test("the host catalogue: unknown agents and models are validation problems, and the preview passes over them", async () => {
    const clock = new FakeClock("2026-09-28T12:00:00.000Z");
    const host = new FakeChatHost({ clock, accounts: ACCOUNTS, behaviour: byAccount({}) });
    const { h, projectPath } = await setup(host, clock);
    try {
      const chain = [
        { agent: "nope", model: "x", accounts: { ...FIXED } },
        { agent: "claude", model: "gpt-404", accounts: { ...FIXED, accounts: ["a1"] } },
        { agent: "claude", model: "opus", accounts: { ...FIXED, accounts: ["a2"] } }
      ];
      const workflow = {
        name: "Catalogued",
        enabled: false,
        project: { kind: "existing", projectPath },
        nodes: [
          { id: "start", type: "trigger.manual", name: "Start" },
          { id: "fix", type: "agent", name: "Fix", config: agentConfig(chain, "Fix it.") }
        ],
        edges: [{ source: "Start", target: "Fix" }]
      };
      const created = await json<WorkflowWriteResponse>(h, "POST", "/api/workflows", workflow);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const problems = created.body.problems.filter((p) => p.code === "unknown_agent" || p.code === "unknown_model");
      assert.deepEqual(
        problems.map((p) => [p.code, p.severity, p.field]),
        [
          ["unknown_agent", "error", "config.chain.0.agent"],
          ["unknown_model", "error", "config.chain.1.model"]
        ]
      );
      // Enabling it is refused while the chain names what this host cannot run.
      const enable = await h.inject({
        method: "PUT",
        url: `/api/workflows/${created.body.workflow.id}`,
        payload: { revision: created.body.workflow.revision, workflow: { ...created.body.workflow, enabled: true } }
      });
      assert.equal(enable.statusCode, 400);
      assert.equal(JSON.parse(enable.body).error.code, "INVALID_WORKFLOW");

      // The preview makes the run's own catalogue check: both bad entries are passed over.
      const preview = await json<AccountPreviewResponse>(h, "POST", "/api/workflows/account-preview", { chain });
      assert.equal(preview.body.decision.chosen?.chainIndex, 2, JSON.stringify(preview.body.decision));
      assert.equal(preview.body.decision.chosen?.accountId, "a2");
      const catalogSkips = preview.body.decision.skipped.filter((skip) => skip.why === "catalog");
      assert.deepEqual(catalogSkips.map((skip) => skip.agent), ["nope", "claude"]);
      const onlyBad = await json<AccountPreviewResponse>(h, "POST", "/api/workflows/account-preview", { chain: chain.slice(0, 2) });
      assert.equal(onlyBad.body.decision.chosen, null, "no entry the host can run: nobody would run");
    } finally {
      await h.close();
    }
  });

  test("a restart while the agent works resumes the watcher and never sends the turn twice", async () => {
    const clock = new FakeClock("2026-09-28T12:00:00.000Z");
    const host = new FakeChatHost({
      clock,
      accounts: ACCOUNTS,
      behaviour: () => [{ kind: "say", text: "working on it" }, { kind: "wait", ms: 10 * 60_000 }, { kind: "say", text: "all done" }]
    });
    const setupResult = await setup(host, clock);
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
      await driveUntil(clock, () => host.turnLog.length === 1 && host.session(host.sessionsOwnedBy("work")[0]!.id).activeTurnId !== null, "the turn to start");
      let persisted = await h.runStore.load(runId);
      for (let i = 0; i < 200 && (persisted?.blocks.work?.waitingOn as { phase?: string } | undefined)?.phase !== "watching"; i += 1) {
        await realDelay(5);
        persisted = await h.runStore.load(runId);
      }
      const waitingOn = persisted!.blocks.work!.waitingOn as { kind: string; commandId: string; phase: string };
      assert.equal(waitingOn.kind, "agent");
      assert.equal(waitingOn.phase, "watching", JSON.stringify(waitingOn));

      await h.close();
      h = await boot(setupResult.dir.root, { clock, engineApi: () => host, accounts: staticAccounts(host), usage: staticUsage() });
      await driveUntil(clock, finishedIn(h, runId), "the resumed run");
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
