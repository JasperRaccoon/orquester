// End to end, in-process: typed outcomes (spec 2026-11-10 §5) through the whole chain — the agent's
// `report_step_result` call runs through THE catalog executor (thread caller, agent principal),
// the daemon's own `InjectDaemonApi` and the real route into the real engine, while the real agent
// executor watches the `FakeChatHost` session. The run takes the reported outcome's connection, a
// wrong call is refused with what is allowed, and a report survives a daemon restart.

import assert from "node:assert/strict";
import { after, describe, test, type TestContext } from "node:test";
import { join } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GetWorkflowRunResponse, RunWorkflowResponse, WorkflowRun, WorkflowWriteResponse } from "@orquester/api";
import { workflowRunsDir } from "@orquester/config";

import type { ThreadCaller } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { executeToolCall } from "../mcp/executor.ts";
import { realClock } from "./factory.ts";
import type { AgentBlockOutput } from "./agent/executor.ts";
import { account, staticAccounts, staticUsage } from "./agent/testing/fake-context.ts";
import { FakeChatHost, type ProviderStep } from "./agent/testing/fake-chat-host.ts";
import { FakeClock, flushAsync } from "./agent/testing/fake-clock.ts";
import { boot, runFinished, tempAppdir, waitForFileState, type Booted } from "./testing/daemon-harness.ts";

const FIXED = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;
const CHAIN = [{ agent: "claude", model: "opus", accounts: { ...FIXED, accounts: ["a1"] } }];
const OUTCOMES = [
  { id: "approved", label: "Approved", description: "Ready to ship." },
  { id: "changes_requested", label: "Changes requested" }
];

const dirs: Awaited<ReturnType<typeof tempAppdir>>[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => dir.cleanup()));
});

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

const threadCaller = (threadId: string): ThreadCaller => ({
  kind: "thread", threadId, title: "Review", projectPath: "", workspace: "", cwd: "/", agentId: "claude", callId: `call-${threadId}`,
  runtimeMode: "full-access", planning: false, workflowOwned: true, exchange: null
});

/** The agent's tool call, as a chat makes it: through the catalog executor with its thread caller. */
function reportVia(api: () => DaemonApi, threadId: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return executeToolCall({ approvals: null }, { name: "report_step_result", arguments: args }, { caller: threadCaller(threadId), api: api(), signal: new AbortController().signal });
}

const finishedIn = (h: Booted, runId: string) => () => h.events.some(runFinished(runId));

async function setup(host: FakeChatHost, clock: FakeClock, t: TestContext) {
  const dir = await tempAppdir();
  dirs.push(dir);
  t.mock.method(realClock, "now", () => clock.now());
  t.mock.method(realClock, "setTimeout", (fn: () => void, ms: number) => clock.setTimeout(fn, ms));
  const h = await boot(dir.root, { engineApi: () => host, accounts: staticAccounts(host), usage: staticUsage() });
  return { h, dir, projectPath: join(dir.workspacesDir, "acme", "app") };
}

async function createReviewWorkflow(h: Booted, projectPath: string, review: Record<string, unknown> = {}): Promise<string> {
  const created = await json<WorkflowWriteResponse>(h, "POST", "/api/workflows", {
    name: "Review flow",
    project: { kind: "existing", projectPath },
    nodes: [
      { id: "start", type: "trigger.manual", name: "Start" },
      { id: "review", type: "agent", name: "Review", config: { prompt: { kind: "text", text: "Review the change." }, chain: CHAIN, outcomes: OUTCOMES, outputs: [{ name: "pr_url", type: "string" }], ...review } },
      { id: "ship", type: "stop", name: "Ship", config: { as: "success", message: "shipped {{ nodes.Review.output.outputs.pr_url }}" } },
      { id: "fix", type: "stop", name: "Fix", config: { as: "failure", message: "fix it" } }
    ],
    edges: [
      { source: "Start", target: "Review" },
      { source: "Review", sourceHandle: "outcome:approved", target: "Ship" },
      { source: "Review", sourceHandle: "outcome:changes_requested", target: "Fix" }
    ]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.workflow.id;
}

describe("e2e: typed outcomes through the tool, the route and the engine", () => {
  test("a refused call names what is allowed; a corrected call replaces the first; the run follows the reported outcome", async (t) => {
    const clock = new FakeClock("2026-11-10T12:00:00.000Z");
    const results: CallToolResult[] = [];
    let h!: Booted;
    const call = (args: Record<string, unknown>): ProviderStep => ({ kind: "call", fn: async (sessionId) => void results.push(await reportVia(() => h.api, sessionId, args)) });
    const host = new FakeChatHost({
      clock,
      accounts: [account("claude", "a1", "alpha")],
      behaviour: () => [
        call({ outcome: "lgtm", summary: "ok" }),
        call({ outcome: "changes_requested", summary: "nits", outputs: { pr_url: "https://x/1" } }),
        call({ outcome: "approved", summary: "Fixed the nits.", outputs: { pr_url: "https://x/2" } }),
        { kind: "say", text: "Reported." }
      ]
    });
    const s = await setup(host, clock, t);
    h = s.h;
    try {
      const workflowId = await createReviewWorkflow(h, s.projectPath);
      const runId = (await json<RunWorkflowResponse>(h, "POST", `/api/workflows/${workflowId}/run`, {})).body.runId!;
      await driveUntil(h, clock, finishedIn(h, runId), "the run");

      // Someone else's chat is not this step.
      const stranger = await reportVia(() => h.api, "some-other-chat", { outcome: "approved", summary: "x" });
      assert.equal((stranger.structuredContent as { message: string }).message, "This chat is not a workflow step that reports a result.");

      assert.equal(results.length, 3);
      assert.equal(results[0]!.isError, true);
      const refusal = results[0]!.structuredContent as { code: string; message: string };
      assert.equal(refusal.code, "INVALID_REPORT");
      assert.match(refusal.message, /outcome "lgtm" is not one of this step's outcomes: use `approved` or `changes_requested`/);
      assert.match(refusal.message, /outputs\.pr_url is required: a string/);
      for (const ok of results.slice(1)) assert.equal((ok.content[0] as { text: string }).text, "Recorded. End your turn now.");

      const run = (await json<GetWorkflowRunResponse>(h, "GET", `/api/workflow-runs/${runId}`)).body.run as WorkflowRun;
      assert.equal(run.status, "stopped", JSON.stringify(run.blocks.review, null, 2));
      const review = run.blocks.review!;
      assert.equal(review.handle, "outcome:approved");
      const output = review.output as AgentBlockOutput;
      assert.equal(output.outcome, "approved");
      assert.equal(output.summary, "Fixed the nits.");
      assert.deepEqual(output.outputs, { pr_url: "https://x/2" });
      assert.equal(review.report?.outcome, "approved", "the later valid call replaced the earlier one");
      assert.equal(run.blocks.ship!.status, "succeeded");
      assert.equal(run.blocks.fix!.status, "skipped");
      assert.equal(run.error, "shipped https://x/2", "expressions read nodes.Review.output.outputs");
      assert.equal(host.turnLog.length, 1, "no reminder");
      assert.match(host.turnLog[0]!.input, /Pick exactly one `outcome`:\n- `approved` \(Approved\): Ready to ship\./);

      // get_workflow_runs shows the report.
      const viewed = await executeToolCall({ approvals: null }, { name: "get_workflow_runs", arguments: { runId } }, { caller: { kind: "external" }, api: h.api, signal: new AbortController().signal });
      const block = ((viewed.structuredContent as { blocks: Record<string, unknown>[] }).blocks).find((b) => b.name === "Review")!;
      assert.deepEqual(block.report, { outcome: "approved", summary: "Fixed the nits.", outputs: { pr_url: "https://x/2" }, reportedAt: review.report!.reportedAt });
    } finally {
      await h.close();
    }
  });

  test("no report: one reminder in the same chat, then no_report takes the error connection", async (t) => {
    const clock = new FakeClock("2026-11-10T12:00:00.000Z");
    const host = new FakeChatHost({ clock, accounts: [account("claude", "a1", "alpha")], behaviour: () => [{ kind: "say", text: "Done, I think." }] });
    const { h, projectPath } = await setup(host, clock, t);
    try {
      const created = await json<WorkflowWriteResponse>(h, "POST", "/api/workflows", {
        name: "Silent",
        project: { kind: "existing", projectPath },
        nodes: [
          { id: "start", type: "trigger.manual", name: "Start" },
          { id: "review", type: "agent", name: "Review", config: { prompt: { kind: "text", text: "Review." }, chain: CHAIN, outcomes: OUTCOMES } },
          { id: "alert", type: "stop", name: "Alert", config: { as: "failure", message: "{{ nodes.Review.error.kind }}" } }
        ],
        edges: [{ source: "Start", target: "Review" }, { source: "Review", sourceHandle: "error", target: "Alert" }]
      });
      const runId = (await json<RunWorkflowResponse>(h, "POST", `/api/workflows/${created.body.workflow.id}/run`, {})).body.runId!;
      await driveUntil(h, clock, finishedIn(h, runId), "the run");
      const run = (await json<GetWorkflowRunResponse>(h, "GET", `/api/workflow-runs/${runId}`)).body.run as WorkflowRun;
      assert.equal(run.blocks.review!.error?.kind, "no_report");
      assert.equal(run.blocks.review!.handle, "error");
      assert.equal(run.blocks.alert!.error?.message, "no_report", "the error connection ran (a failing Stop)");
      assert.equal(host.turnLog.length, 2);
      assert.equal(host.sessions.size, 1, "the reminder went into the same chat");
      assert.match(host.turnLog[1]!.input, /^Your turn ended without a report/);
    } finally {
      await h.close();
    }
  });

  test("a report recorded before a daemon restart finishes the step after it, with no reminder", async (t) => {
    const clock = new FakeClock("2026-11-10T12:00:00.000Z");
    let h!: Booted;
    const host = new FakeChatHost({
      clock,
      accounts: [account("claude", "a1", "alpha")],
      behaviour: () => [
        { kind: "call", fn: async (sessionId) => void (await reportVia(() => h.api, sessionId, { outcome: "changes_requested", summary: "One bug.", outputs: { pr_url: "https://x/3" } })) },
        { kind: "wait", ms: 10 * 60_000 },
        { kind: "say", text: "done" }
      ]
    });
    const s = await setup(host, clock, t);
    h = s.h;
    try {
      const workflowId = await createReviewWorkflow(h, s.projectPath);
      const runId = (await json<RunWorkflowResponse>(h, "POST", `/api/workflows/${workflowId}/run`, {})).body.runId!;
      await driveUntil(h, clock, () => host.turnLog.length === 1, "the turn");
      const persisted = await waitForFileState(join(workflowRunsDir(s.dir.root), runId, "run.json"), () => h.runStore.load(runId), (run) => run?.blocks.review?.report !== undefined);
      assert.equal(persisted!.blocks.review!.report!.outcome, "changes_requested", "on disk before the tool answered");

      await h.close();
      h = await boot(s.dir.root, { engineApi: () => host, accounts: staticAccounts(host), usage: staticUsage() });
      await driveUntil(h, clock, finishedIn(h, runId), "the resumed run");
      const run = (await json<GetWorkflowRunResponse>(h, "GET", `/api/workflow-runs/${runId}`)).body.run as WorkflowRun;
      assert.equal(run.blocks.review!.handle, "outcome:changes_requested");
      assert.equal(run.blocks.fix!.error?.kind, "stopped", "the changes_requested connection ran");
      assert.equal(run.blocks.ship!.status, "skipped");
      assert.equal(host.turnLog.length, 1, "no reminder after the restart");
    } finally {
      await h.close();
    }
  });
});
