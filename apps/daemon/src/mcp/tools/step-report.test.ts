import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { workflowRoutes } from "@orquester/api";
import type { ThreadCaller, ToolCaller } from "../catalog/contract.ts";
import { catalogFor } from "../catalog/index.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";
import { STEP_REPORT_RECORDED } from "./step-report.ts";

const caller = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
  kind: "thread", threadId: "step-chat", title: "Nightly · Review", projectPath: "/w/ws/app", workspace: "ws", cwd: "/w/ws/app", agentId: "claude", callId: "call-1",
  runtimeMode: "full-access", planning: false, workflowOwned: true, exchange: null, ...over
});

async function report(api: FakeDaemonApi, who: ToolCaller, args: Record<string, unknown>): Promise<CallToolResult> {
  // `approvals: null`: a call that needed a card would fail here — this tool never asks for one.
  return executeToolCall({ approvals: null }, { name: "report_step_result", arguments: args }, { caller: who, api, signal: new AbortController().signal });
}
const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const errorOf = (r: CallToolResult) => r.structuredContent as { code: string; message: string };

test("report_step_result is chat-only, Act tier, never Admin", () => {
  const tool = catalogFor("chat").find((t) => t.name === "report_step_result");
  assert.ok(tool);
  assert.equal(tool.tier, "act");
  assert.equal(tool.adminFamily, undefined);
  assert.equal(catalogFor("external").some((t) => t.name === "report_step_result"), false);
});

test("a step's chat records its report without a card — workflow-owned included — and is told to end its turn", async () => {
  const api = new FakeDaemonApi().on("POST", workflowRoutes.stepReport, { status: 200, body: { recorded: true } });
  for (const who of [caller(), caller({ workflowOwned: false, runtimeMode: "approval-required" })]) {
    const r = await report(api, who, { outcome: "approved", summary: "Looks good.", outputs: { pr_url: "https://x/1" } });
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.equal(textOf(r), STEP_REPORT_RECORDED);
    assert.equal(STEP_REPORT_RECORDED, "Recorded. End your turn now.");
  }
  // The body names no session: the route takes the step from the caller's principal.
  assert.deepEqual(api.calls.map((c) => c.body), Array(2).fill({ outcome: "approved", summary: "Looks good.", outputs: { pr_url: "https://x/1" } }));
});

test("the daemon's refusals reach the agent in its words: not a step, and every report problem with a hint", async () => {
  const api = new FakeDaemonApi().on("POST", workflowRoutes.stepReport, { status: 403, body: { error: { code: "NOT_A_WORKFLOW_STEP", message: "This chat is not a workflow step that reports a result." } } });
  const refused = await report(api, caller({ workflowOwned: false }), { summary: "x" });
  assert.equal(refused.isError, true);
  assert.deepEqual(errorOf(refused), { ...errorOf(refused), code: "NOT_A_WORKFLOW_STEP", message: "This chat is not a workflow step that reports a result." });

  api.on("POST", workflowRoutes.stepReport, { status: 400, body: { error: { code: "INVALID_REPORT", message: "The report was not recorded:\n- outcome is required: one of `approved` or `changes_requested`." } } });
  const invalid = await report(api, caller(), { summary: "x" });
  assert.equal(errorOf(invalid).code, "INVALID_REPORT");
  assert.match(errorOf(invalid).message, /one of `approved` or `changes_requested`\. Fix what is listed and call report_step_result again\.$/);
});

test("arguments are checked strictly before the daemon is asked", async () => {
  const api = new FakeDaemonApi();
  for (const args of [{}, { summary: "x".repeat(2_001) }, { summary: "x", outputs: [1] }, { summary: "x", sessionId: "other" }]) {
    assert.equal(errorOf(await report(api, caller(), args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 60));
  }
  assert.equal(api.calls.length, 0);
});
