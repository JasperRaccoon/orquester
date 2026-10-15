/**
 * Legacy chat-tool aliases (unified MCP design 2026-10-15 §14.1, spec §14.2.5): an old agent host's
 * names reach the catalog tools that replaced them WITH THE OLD SEMANTICS, through the one executor
 * (gate, toolset check, turn policy as the target's), and only once the catalog no longer serves
 * the old name itself.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { defineTool, MUTATING, READ_ONLY, type AnyOrquesterTool, type CallContext, type ThreadCaller } from "../mcp/catalog/contract.ts";
import { executeToolCall } from "../mcp/executor.ts";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { chatToolByName, LEGACY_CHAT_TOOL_ALIASES, LEGACY_CHAT_TOOL_NAMES } from "./legacy-aliases.ts";

const caller: ThreadCaller = {
  kind: "thread", threadId: "me", title: "Old host chat", projectPath: "", workspace: "", cwd: "/tmp", agentId: "claude", callId: "c1",
  runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
};

/** Stand-ins for the replacing catalog tools (their spec §4 input sketches); each records its call. */
function targets() {
  const runs: { tool: string; args: Record<string, unknown>; legacyAlias: string | undefined }[] = [];
  const target = (name: string, input: z.ZodRawShape, tier: "read" | "act" = "act", toolset: "core" | "chat-extras" = "core"): AnyOrquesterTool =>
    defineTool({
      name, title: name, description: name, input, audiences: ["external", "chat"], toolset, tier,
      scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }),
      annotations: tier === "read" ? READ_ONLY : MUTATING, resultKind: "json",
      run: async (args: Record<string, unknown>, ctx: CallContext) => {
        runs.push({ tool: name, args, legacyAlias: ctx.legacyAlias });
        return { ran: name };
      }
    }) as AnyOrquesterTool;
  const reply = z.enum(["wait", "notify", "none"]).optional();
  const settings = { agent: z.string().optional(), model: z.string().optional(), options: z.record(z.union([z.string(), z.boolean()])).optional(), accountId: z.string().optional(), runtimeMode: z.string().optional(), title: z.string().optional() };
  const tools = [
    target("list_sessions", { project: z.string().optional(), limit: z.number().int().optional() }, "read"),
    target("read_transcript", { sessionId: z.string(), turns: z.number().optional(), beforeTurn: z.number().optional(), include: z.array(z.string()).optional(), maxChars: z.number().optional() }, "read"),
    target("create_session", { project: z.string().optional(), prompt: z.string().optional(), reply, delegate: z.boolean().optional(), timeoutSeconds: z.number().optional(), ...settings }),
    target("list_agents", { agent: z.string().optional(), model: z.string().optional(), query: z.string().optional() }, "read"),
    target("send_message", { sessionId: z.string(), text: z.string().optional(), reply, timeoutSeconds: z.number().int().max(600).optional() }),
    target("wait_for_session", { sessionId: z.string().optional(), timeoutSeconds: z.number().optional() }, "read"),
    target("control_session", { sessionId: z.string(), action: z.enum(["interrupt", "stop_task", "close"]) }),
    target("fork_session", { sessionId: z.string().optional(), throughTurn: z.number().optional(), messageId: z.string().optional(), title: z.string().optional() }),
    target("merge_back_session", { sessionId: z.string().optional(), text: z.string().optional() }),
    target("get_session", { sessionId: z.string() }, "read")
  ];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { runs, lookup: (name: string) => byName.get(name), byName };
}

async function call(name: string, args: Record<string, unknown>, rig = targets()) {
  const result = await executeToolCall(
    { lookup: (n) => chatToolByName(n, rig.lookup), approvals: null, enabledToolsets: async () => new Set(["core"]) },
    { name, arguments: args },
    { caller, api: new FakeDaemonApi(), signal: new AbortController().signal }
  );
  return { result, runs: rig.runs };
}

test("every legacy name has an alias onto spec §14.1's tool", () => {
  assert.deepEqual([...LEGACY_CHAT_TOOL_NAMES].sort(), [
    "agent_catalog", "delegate_task", "task_cancel", "task_status", "task_wait", "thread_create", "thread_fork", "thread_interrupt",
    "thread_list", "thread_merge_back", "thread_read", "thread_send", "thread_wait"
  ]);
  assert.equal(LEGACY_CHAT_TOOL_ALIASES.thread_send!.target, "send_message");
  assert.equal(LEGACY_CHAT_TOOL_ALIASES.delegate_task!.target, "create_session");
});

test("thread_send without wait steers as before (reply none); with wait it waits WITHOUT the notify conversion", async () => {
  const plain = await call("thread_send", { threadId: "t2", text: "hi" });
  assert.equal(plain.result.isError, undefined);
  assert.deepEqual(plain.runs, [{ tool: "send_message", args: { sessionId: "t2", text: "hi", reply: "none" }, legacyAlias: undefined }]);
  const waiting = await call("thread_send", { threadId: "t2", text: "hi", wait: true, timeoutSeconds: 30 });
  assert.deepEqual(waiting.runs, [{ tool: "send_message", args: { sessionId: "t2", text: "hi", reply: "wait", timeoutSeconds: 30 }, legacyAlias: "thread_send" }]);
});

test("thread_create and delegate_task open a chat that delivers nothing (reply none); a delegate is marked", async () => {
  const created = await call("thread_create", { prompt: "do it", agent: "codex", title: "T" });
  assert.deepEqual(created.runs[0]!.args, { prompt: "do it", agent: "codex", title: "T", reply: "none" });
  const delegated = await call("delegate_task", { prompt: "task", runtimeMode: "auto" });
  assert.deepEqual(delegated.runs[0]!.args, { prompt: "task", runtimeMode: "auto", delegate: true, reply: "none" });
});

test("task_* and the thread reads map onto get_session / wait_for_session / control_session / read_transcript", async () => {
  const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
    ["task_status", { taskId: "k" }, "get_session", { sessionId: "k" }],
    ["task_wait", { taskId: "k", timeoutSeconds: 60 }, "wait_for_session", { sessionId: "k", timeoutSeconds: 60 }],
    ["task_cancel", { taskId: "k" }, "control_session", { sessionId: "k", action: "interrupt" }],
    ["thread_interrupt", { threadId: "k" }, "control_session", { sessionId: "k", action: "interrupt" }],
    ["thread_wait", { threadId: "k" }, "wait_for_session", { sessionId: "k" }],
    ["thread_read", { threadId: "k", turns: 2 }, "read_transcript", { sessionId: "k", turns: 2 }],
    ["thread_list", { limit: 5 }, "list_sessions", { limit: 5 }],
    ["thread_fork", { title: "F" }, "fork_session", { title: "F" }],
    ["thread_merge_back", { text: "done" }, "merge_back_session", { text: "done" }],
    ["agent_catalog", { agent: "codex" }, "list_agents", { agent: "codex" }]
  ];
  for (const [legacy, args, target, mapped] of cases) {
    const { result, runs } = await call(legacy, args);
    assert.equal(result.isError, undefined, legacy);
    assert.deepEqual(runs, [{ tool: target, args: mapped, legacyAlias: undefined }], legacy);
  }
});

test("the old argument names are the only ones taken; the target's own schema refuses a bad mapped value, naming the legacy tool", async () => {
  const unknown = await call("task_status", { sessionId: "k" });
  assert.equal(unknown.result.isError, true);
  assert.match(JSON.stringify(unknown.result.structuredContent), /INVALID_ARGUMENT/);
  const tooLong = await call("thread_send", { threadId: "t2", text: "hi", wait: true, timeoutSeconds: 9_999 });
  assert.equal(tooLong.result.isError, true);
  assert.match((tooLong.result.structuredContent as { message: string }).message, /thread_send/);
  assert.equal(tooLong.runs.length, 0);
});

test("a name the catalog still serves is its own tool; an alias without its target is no alias", () => {
  const rig = targets();
  const own = defineTool({
    name: "thread_send", title: "legacy", description: "d", input: {}, audiences: ["chat"], toolset: "core", tier: "act",
    scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }), annotations: MUTATING, resultKind: "json", run: async () => ({})
  }) as AnyOrquesterTool;
  assert.equal(chatToolByName("thread_send", (n) => (n === "thread_send" ? own : rig.lookup(n))), own);
  assert.equal(chatToolByName("thread_send", (n) => (n === "send_message" ? undefined : rig.lookup(n))), undefined);
  assert.equal(chatToolByName("no_such_tool", rig.lookup), undefined);
  // The alias carries the target's toolset and tier: the gate and TOOL_NOT_ENABLED judge it as the target.
  const alias = chatToolByName("task_status", rig.lookup)!;
  assert.deepEqual([alias.name, alias.toolset, alias.tier, alias.audiences], ["task_status", "core", "read", ["chat"]]);
});
