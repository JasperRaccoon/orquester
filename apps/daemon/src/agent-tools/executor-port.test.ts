/**
 * The production wiring of approvals (unified MCP design 2026-10-15 §3.3, §7, §9.3), end to end:
 * the catalog executor reaches the REAL `AgentToolsApprovalPort` and toolsets through
 * `connectExecutor` (what `index.ts` calls), the card opens in the real registry, a person answers
 * it there, and the call runs, is refused, or is covered by the grant the answer made. Event-driven
 * (the registry's `opened` publish), no sleeps.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { z } from "zod";
import { agentChatRoutes, TOOL_APPROVAL_EVENT_TYPE, type AgentChatToolApprovalEventPayload } from "@orquester/api/agent-chat";

import { defineTool, MUTATING, type AnyOrquesterTool, type CallContext, type ScopeClaim, type ThreadCaller } from "../mcp/catalog/contract.ts";
import { executeToolCall, executorPorts } from "../mcp/executor.ts";
import { head, snapshot } from "../mcp/fixtures.ts";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { connectExecutor, createAgentToolsRuntime, lockedToolsetsOnly } from "./approval-port.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "umcp-exec-port-")));
const WS = join(ROOT, "w");
const OWN = join(WS, "acme/api");
mkdirSync(OWN, { recursive: true });
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

const claim = (over: Partial<ScopeClaim> = {}): ScopeClaim => ({ projects: [OWN], sessions: [], reads: "none", writes: true, causesTurnIn: [], ...over });

async function rig(t: TestContext) {
  const appdir = mkdtempSync(join(tmpdir(), "umcp-exec-port-appdir-"));
  // Each opened card's id, in order; a waiter for the next one.
  const opened: string[] = [];
  const waiters: ((id: string) => void)[] = [];
  const order: string[] = [];
  const api = new FakeDaemonApi().on("GET", agentChatRoutes.thread("me"), {
    status: 200,
    body: { kind: "snapshot", thread: snapshot({ head: head({ id: "me", runtimeMode: "full-access" }) }) }
  });
  api.fsRoot = ROOT;
  api.workspacesDir = WS;
  const runtime = createAgentToolsRuntime({
    baseDir: appdir,
    publish: (_channel, type, payload) => {
      const event = payload as AgentChatToolApprovalEventPayload;
      if (type !== TOOL_APPROVAL_EVENT_TYPE || !event.opened) return;
      const waiter = waiters.shift();
      if (waiter) waiter(event.opened.approvalId);
      else opened.push(event.opened.approvalId);
    },
    onApprovalsChanged: () => {},
    tab: (id) => (id === "me" ? { projectPath: OWN } : undefined),
    agentOf: (id) => (id === "me" ? "claude" : null),
    api: () => api,
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });
  await runtime.load();
  // What `index.ts` does: the executor's module ports now point at this runtime.
  const disconnect = connectExecutor(runtime, executorPorts);
  t.after(async () => {
    disconnect();
    await runtime.shutdown();
    rmSync(appdir, { recursive: true, force: true });
  });
  const nextCard = (): Promise<string> => (opened.length > 0 ? Promise.resolve(opened.shift()!) : new Promise((resolve) => waiters.push(resolve)));
  const runs: CallContext[] = [];
  let nextWorkflow = 0;
  const tools: AnyOrquesterTool[] = [
    defineTool({
      name: "control_desktop", title: "Open a desktop", description: "d", input: {},
      audiences: ["chat"], toolset: "core", tier: "admin", adminFamily: "desktops", scope: async () => claim(),
      approval: async () => ({ title: "Claude wants to open a desktop", scopeLabel: "Project acme/api", sections: [{ kind: "text", text: "xterm" }] }),
      annotations: MUTATING, resultKind: "json",
      run: async (_args, ctx) => {
        runs.push(ctx);
        return { opened: true };
      }
    }),
    defineTool({
      name: "create_workflow", title: "Create a workflow", description: "d", input: {},
      audiences: ["chat"], toolset: "core", tier: "admin", adminFamily: "workflows", scope: async () => claim(),
      approval: async () => ({ title: "Create a workflow", scopeLabel: "acme/api", sections: [{ kind: "text", text: "nightly" }] }),
      annotations: MUTATING, resultKind: "json",
      run: async (_args, ctx) => {
        runs.push(ctx);
        return { workflowId: `wf_${(nextWorkflow += 1)}` };
      }
    }),
    defineTool({
      name: "run_workflow", title: "Run a workflow", description: "d", input: { workflowId: z.string() },
      audiences: ["chat"], toolset: "core", tier: "admin", adminFamily: "workflows", scope: async () => claim(),
      approval: async (args) => ({ title: "Run a workflow", scopeLabel: "acme/api", sections: [{ kind: "text", text: String(args.workflowId) }], workflowId: String(args.workflowId) }),
      annotations: MUTATING, resultKind: "json",
      run: async (_args, ctx) => {
        runs.push(ctx);
        return { ran: true };
      }
    }),
    defineTool({
      name: "read_more", title: "Read more", description: "d", input: {},
      audiences: ["chat"], toolset: "reads", tier: "read", scope: async () => claim({ projects: [], writes: false }),
      annotations: MUTATING, resultKind: "json", run: async () => ({ read: true })
    }),
    defineTool({
      name: "add_todo", title: "Add a todo", description: "d", input: {},
      audiences: ["chat"], toolset: "notes", tier: "act", scope: async () => claim({ projects: [] }),
      annotations: MUTATING, resultKind: "json", run: async () => ({ added: true })
    }),
    defineTool({
      name: "request_toolset", title: "Request a toolset", description: "d", input: {},
      audiences: ["chat"], toolset: "core", tier: "act", planSafe: true, scope: async () => claim({ projects: [], writes: false }),
      annotations: MUTATING, resultKind: "json",
      run: async (_args, ctx) => {
        const outcome = await ctx.requestToolsetCard!({ toolset: "notes", title: "Claude asks to enable Notes for this chat", sections: [{ kind: "text", text: "Notes" }], reason: "a todo list" });
        order.push("tool resumed");
        return { outcome: outcome.outcome };
      }
    })
  ];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const caller: ThreadCaller = {
    kind: "thread", threadId: "me", title: "Implement auth", projectPath: OWN, workspace: "acme", cwd: OWN, agentId: "claude", callId: "c",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
  };
  // The deps carry no ports: the executor reads the ones `connectExecutor` set, as in production.
  const call = (name: string, args: unknown = {}) =>
    executeToolCall({ lookup: (n) => byName.get(n) }, { name, arguments: args }, { caller, api, signal: new AbortController().signal });
  return { runtime, disconnect, call, nextCard, runs, order, opened };
}

const errorCode = (result: { structuredContent?: unknown }) => (result.structuredContent as { code?: string } | undefined)?.code;
const errorMessage = (result: { structuredContent?: unknown }) => (result.structuredContent as { message?: string } | undefined)?.message ?? "";

test("an Admin call opens a card through the real port; approved, it runs with the card's approval", async (t) => {
  const r = await rig(t);
  const pending = r.call("control_desktop");
  const id = await r.nextCard();
  const card = r.runtime.approvals.list("me")[0]!;
  assert.deepEqual([card.kind, card.family, card.tool, card.grantOptions], ["admin", "desktops", "control_desktop", ["chat", "project"]]);
  assert.equal(card.scope.projects?.[0]?.path, OWN);
  assert.ok((await r.runtime.approvals.answer("me", id, { decision: "approve" })).ok);
  const result = await pending;
  assert.equal(result.isError, undefined, errorMessage(result));
  assert.deepEqual(result.structuredContent, { opened: true });
  assert.deepEqual(r.runs[0]!.approval, { outcome: "approved", approvalId: id });
  assert.equal(r.runtime.approvals.list("me").length, 0);
});

test("denied, the call is refused with the user's words and never runs", async (t) => {
  const r = await rig(t);
  const pending = r.call("control_desktop");
  const id = await r.nextCard();
  assert.ok((await r.runtime.approvals.answer("me", id, { decision: "deny", reason: "not now" })).ok);
  const result = await pending;
  assert.equal(errorCode(result), "APPROVAL_DENIED");
  assert.match(errorMessage(result), /"not now"/);
  assert.equal(r.runs.length, 0);
});

test("approved with a chat grant: the next call is covered by the grant without a card, until it is revoked", async (t) => {
  const r = await rig(t);
  const first = r.call("control_desktop");
  const id = await r.nextCard();
  const answer = await r.runtime.approvals.answer("me", id, { decision: "approve", grant: "chat" });
  assert.ok(answer.ok);
  const grantId = answer.ok ? answer.response.grantId : undefined;
  assert.ok(grantId);
  assert.equal((await first).isError, undefined);
  assert.deepEqual(r.runs[0]!.approval, { outcome: "approved", approvalId: id, grantId });

  const second = await r.call("control_desktop");
  assert.equal(second.isError, undefined, errorMessage(second));
  assert.deepEqual(r.runs[1]!.approval, { outcome: "granted", grantId });
  assert.equal(r.opened.length, 0, "no card opened for the granted call");
  assert.equal(r.runtime.approvals.list("me").length, 0);

  r.runtime.tools.revokeGrant(grantId);
  const third = r.call("control_desktop");
  const thirdId = await r.nextCard();
  assert.ok((await r.runtime.approvals.answer("me", thirdId, { decision: "deny" })).ok);
  assert.equal(errorCode(await third), "APPROVAL_DENIED");
});

test("workflows: a create approved with a chat grant joins its new id to that grant (only the outcome's grantId); approve-once joins nothing", async (t) => {
  const r = await rig(t);
  const once = r.call("create_workflow");
  assert.ok((await r.runtime.approvals.answer("me", await r.nextCard(), { decision: "approve" })).ok);
  assert.deepEqual((await once).structuredContent, { workflowId: "wf_1" });
  assert.equal(r.runtime.tools.settingsView().grants.length, 0, "approving once creates and widens nothing");

  const granted = r.call("create_workflow");
  const answer = await r.runtime.approvals.answer("me", await r.nextCard(), { decision: "approve", grant: "chat" });
  assert.ok(answer.ok);
  assert.deepEqual((await granted).structuredContent, { workflowId: "wf_2" });
  const grant = r.runtime.tools.settingsView().grants.find((g) => g.family === "workflows");
  assert.deepEqual(grant?.workflowIds, ["wf_2"]);

  // The grant covers runs of wf_2 without a card; wf_1 (approved once) still asks.
  assert.equal((await r.call("run_workflow", { workflowId: "wf_2" })).isError, undefined);
  assert.equal(r.runs.at(-1)!.approval?.outcome, "granted");
  const asks = r.call("run_workflow", { workflowId: "wf_1" });
  assert.ok((await r.runtime.approvals.answer("me", await r.nextCard(), { decision: "deny" })).ok);
  assert.equal(errorCode(await asks), "APPROVAL_DENIED");
});

test("toolsets: off → TOOL_NOT_ENABLED; request_toolset's card through the port turns it on (listener before the call resumes)", async (t) => {
  const r = await rig(t);
  assert.equal(errorCode(await r.call("add_todo")), "TOOL_NOT_ENABLED");
  r.runtime.tools.onToolsetsChanged((threadId) => r.order.push(`toolsets changed: ${threadId}`));
  const asking = r.call("request_toolset");
  const id = await r.nextCard();
  const card = r.runtime.approvals.list("me")[0]!;
  assert.deepEqual([card.kind, card.family, card.grantOptions], ["toolset", "toolset", []]);
  assert.ok((await r.runtime.approvals.answer("me", id, { decision: "approve" })).ok);
  assert.deepEqual((await asking).structuredContent, { outcome: "approved" });
  assert.deepEqual(r.order, ["toolsets changed: me", "tool resumed"], "the listener runs after the card settled, before the call resumed");
  assert.deepEqual((await r.call("add_todo")).structuredContent, { added: true });
});

test("shutdown: disconnected first — no card, no grant, locked toolsets only (never the catalogue defaults); a late card is cancelled", async (t) => {
  const r = await rig(t);
  // A chat grant exists, and `reads` (on by default for Claude) works before the disconnect.
  const first = r.call("control_desktop");
  const answer = await r.runtime.approvals.answer("me", await r.nextCard(), { decision: "approve", grant: "chat" });
  assert.ok(answer.ok);
  assert.equal((await first).isError, undefined);
  assert.equal((await r.call("read_more")).isError, undefined);
  const runsBefore = r.runs.length;

  // What `index.ts` does at stop, in order: disconnect, then stop the runtime.
  r.disconnect();
  assert.equal(executorPorts.approvals, null);
  assert.equal(errorCode(await r.call("control_desktop")), "PERMISSION_DENIED", "the grant is not honoured once disconnected");
  assert.equal(r.opened.length, 0, "no card opened");
  assert.equal(r.runs.length, runsBefore);
  assert.equal(errorCode(await r.call("read_more")), "TOOL_NOT_ENABLED", "locked toolsets only, not the catalogue defaults");
  assert.equal((await r.call("request_toolset")).isError, true, "no toolset card either");

  // A call already past the port lookup when the runtime stops: cancelled, never a card.
  await r.runtime.shutdown();
  const late = await r.runtime.port.request(
    { threadId: "me", callerProjectPath: OWN, tool: "control_desktop", kind: "admin", family: "desktops", title: "Late", scope: { label: "x" }, sections: [], secretFields: [], grantOptions: [] },
    new AbortController().signal
  );
  assert.deepEqual([late.outcome, late.outcome === "cancelled" ? late.reason : undefined], ["cancelled", "restarting"]);
  assert.equal(r.opened.length, 0);
});

test("a disconnect clears only the ports that are still its own", async (t) => {
  const r = await rig(t);
  const other = await rig(t);
  // `other` connected last: `r`'s disconnect leaves its ports alone.
  r.disconnect();
  assert.equal(executorPorts.approvals, other.runtime.port);
  assert.notEqual(executorPorts.enabledToolsets, lockedToolsetsOnly);
  other.disconnect();
  assert.equal(executorPorts.approvals, null);
  assert.equal(executorPorts.enabledToolsets, lockedToolsetsOnly);
});
