/**
 * Session tools — TEST-ONLY chat tools. Never in the catalog: the transport's own tests (the
 * route, the agent host's service, each provider's `orquester` server) run them as catalog tools
 * of the chat audience to drive every path — context echo, image content, a handler error, a wait
 * that only cancellation ends — and through THE executor (`../mcp/executor.ts`) where a test needs
 * a daemon-side answer ({@link executeTestChatCall}).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentAdapterId } from "@orquester/api/agent-chat";
import { z } from "zod";

import {
  defineTool,
  MUTATING,
  READ_ONLY,
  type AnyOrquesterTool,
  type CallContext,
  type ScopeClaim,
  type ThreadCaller,
  type ToolAnnotations,
  type ToolResultKind
} from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { executeToolCall } from "../mcp/executor.ts";
import type { SessionSecretRequests } from "./contract.ts";
import { imageResult, jsonResult, ToolError } from "./results.ts";

/** A 1×1 transparent PNG. */
export const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** The instruction block the test tools' "manifest" carries. */
export const TEST_INSTRUCTIONS = "## Orquester\n\nTest tools: call `echo` to see your own context.";

/** What a test tool claims: nothing the gate judges. */
const NO_CLAIM: ScopeClaim = Object.freeze({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }) as ScopeClaim;

/** The calling chat of a test tool's context (the executor always runs these for a chat caller). */
function threadOf(ctx: CallContext): ThreadCaller {
  if (ctx.caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", "A test tool is a chat tool.");
  return ctx.caller;
}

/** A chat-only, `core`, Read (or Act, when its annotations say it writes) catalog tool for tests. */
export function testChatTool<Shape extends z.ZodRawShape>(def: {
  name: string;
  title?: string;
  description?: string;
  input: Shape;
  annotations?: ToolAnnotations;
  resultKind?: ToolResultKind;
  secretResultKeys?: readonly string[];
  run(args: z.infer<z.ZodObject<Shape>>, ctx: CallContext): Promise<Record<string, unknown> | CallToolResult>;
}): AnyOrquesterTool {
  const annotations = def.annotations ?? READ_ONLY;
  return defineTool({
    name: def.name,
    title: def.title ?? def.name,
    description: def.description ?? `Test tool ${def.name}.`,
    input: def.input,
    audiences: ["chat"],
    toolset: "core",
    tier: annotations.readOnlyHint === true ? "read" : "act",
    scope: async () => NO_CLAIM,
    annotations,
    resultKind: def.resultKind ?? "json",
    ...(def.secretResultKeys ? { secretResultKeys: def.secretResultKeys } : {}),
    run: def.run
  });
}

export const TEST_CHAT_TOOLS: readonly AnyOrquesterTool[] = [
  testChatTool({
    name: "echo",
    title: "Echo",
    description: "Returns the text and the caller's context as the daemon derived it.",
    input: { text: z.string().max(1000) },
    run: async (args, ctx) => {
      const caller = threadOf(ctx);
      return jsonResult({
        text: args.text,
        threadId: caller.threadId,
        projectPath: caller.projectPath,
        cwd: caller.cwd,
        agentId: caller.agentId,
        callId: caller.callId
      });
    }
  }),
  testChatTool({
    name: "wait_for_cancel",
    title: "Wait for cancel",
    description: "Waits until the call is cancelled, then reports it.",
    input: {},
    run: (_args, ctx) =>
      new Promise((resolve) => {
        const done = () => resolve(jsonResult({ cancelled: true }));
        if (ctx.signal.aborted) done();
        else ctx.signal.addEventListener("abort", done, { once: true });
      })
  }),
  testChatTool({
    name: "pixel",
    title: "Pixel",
    description: "Returns a 1×1 PNG and its size.",
    input: {},
    resultKind: "image",
    run: async () => imageResult({ data: TEST_PNG_BASE64, mimeType: "image/png" }, { width: 1, height: 1 })
  }),
  testChatTool({
    name: "fail",
    title: "Fail",
    description: "Always fails with a coded error.",
    input: {},
    annotations: MUTATING,
    resultKind: "text",
    run: async () => {
      throw new ToolError("CONFLICT", "This tool always fails.");
    }
  })
];

/** The caller a test call runs as: a chat in a neutral mode, its context from the test. */
export interface TestCallContext {
  threadId: string;
  projectPath: string;
  cwd: string;
  agentId: AgentAdapterId;
  callId: string;
  signal: AbortSignal;
  api: DaemonApi;
  secretRequests?: SessionSecretRequests;
  delivered?: Promise<boolean>;
  now(): number;
}

/**
 * One chat call against `tools` through THE executor, as the daemon's route would run it — with
 * no approval port (a card would be refused) and the caller as given: what a
 * provider's test needs of "the daemon's answer".
 */
export function executeTestChatCall(
  tools: readonly AnyOrquesterTool[],
  call: { name: string; arguments: unknown },
  ctx: TestCallContext
): Promise<CallToolResult> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const caller: ThreadCaller = {
    kind: "thread",
    threadId: ctx.threadId,
    title: "",
    projectPath: ctx.projectPath,
    workspace: "",
    cwd: ctx.cwd,
    agentId: ctx.agentId,
    callId: ctx.callId,
    runtimeMode: "approval-required",
    planning: false,
    workflowOwned: false,
    exchange: null,
    ...(ctx.delivered ? { delivered: ctx.delivered } : {})
  };
  return executeToolCall(
    {
      lookup: (name, audience) => (audience === "chat" ? byName.get(name) : undefined),
      approvals: null,
      ...(ctx.secretRequests ? { secretRequests: ctx.secretRequests } : {}),
      now: () => ctx.now()
    },
    call,
    { caller, api: ctx.api, signal: ctx.signal }
  );
}
