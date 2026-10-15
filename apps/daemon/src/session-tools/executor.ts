/**
 * Session tools — one call against a {@link SessionToolRegistry} (design 2026-10-14 §1.1), for
 * callers that hold a registry rather than the catalog (the toolkits' own tests, a provider
 * adapter's test). It runs through THE executor (`../mcp/executor.ts`, unified MCP design
 * 2026-10-15 §3.3) — the only caller of a tool's `run` — with the registry's tools adapted as
 * legacy chat tools (`../mcp/catalog/legacy.ts`). Daemon-only: the agent host never imports it.
 *
 * The caller is the context's thread with a neutral mode: a legacy session tool claims no scope
 * the gate judges and reads the caller's mode and plan itself, so nothing here depends on it.
 * The production route (`./route.ts`) builds the full caller from the thread's snapshot.
 */

import type { ThreadCaller } from "../mcp/catalog/contract.ts";
import { legacyChatTools } from "../mcp/catalog/legacy.ts";
import type { AnyOrquesterTool } from "../mcp/catalog/contract.ts";
import { executeToolCall } from "../mcp/executor.ts";
import type { SessionToolContext, SessionToolResult } from "./contract.ts";
import type { SessionToolRegistry } from "./registry.ts";

const adapted = new WeakMap<SessionToolRegistry, ReadonlyMap<string, AnyOrquesterTool>>();

function toolsOf(registry: SessionToolRegistry): ReadonlyMap<string, AnyOrquesterTool> {
  let tools = adapted.get(registry);
  if (!tools) {
    tools = new Map(legacyChatTools(registry.tools).map((tool) => [tool.name, tool]));
    adapted.set(registry, tools);
  }
  return tools;
}

export async function executeSessionToolCall(
  registry: SessionToolRegistry,
  call: { name: string; arguments: unknown },
  ctx: SessionToolContext
): Promise<SessionToolResult> {
  const tools = toolsOf(registry);
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
      lookup: (name, audience) => (audience === "chat" ? tools.get(name) : undefined),
      approvals: null,
      // Every legacy session tool is in the locked `core` toolset.
      enabledToolsets: async () => new Set(["core"]),
      ...(ctx.secretRequests ? { secretRequests: ctx.secretRequests } : {}),
      now: () => ctx.now()
    },
    call,
    { caller, api: ctx.api, signal: ctx.signal }
  );
}
