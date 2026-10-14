/**
 * Session tools — threads: opening a chat thread in the caller's project, as `thread_create` and
 * `delegate_task` do. The new thread runs in the caller's working directory and permission mode
 * (never a broader one), with the caller's model and account when it is the same agent.
 */

import type { CreateSessionRequest, SessionSummary } from "@orquester/api";
import type { CreateAgentChatSessionFields } from "@orquester/api/agent-chat";

import { findAgent, loadAgents, resolveModelSelection, validateAccountId } from "../../mcp/agents.ts";
import { expectOk, ToolError } from "../../mcp/errors.ts";
import { readThread, sendCommand } from "../../mcp/reads.ts";
import { toSafeToolError } from "../../mcp/result.ts";
import { MAX_RUNNING_SESSIONS_PER_PROJECT } from "../../mcp/tools/sessions.ts";
import type { SessionToolContext } from "../contract.ts";
import type { ProjectThreads } from "./shared.ts";

export interface NewThread {
  prompt: string;
  agent?: string;
  model?: string;
  title?: string;
  /** Set for a delegated task: the caller is its parent. */
  delegate?: true;
}

export interface CreatedThread {
  session: SessionSummary;
  model: string;
}

/** Refuse once the project already runs as many tabs as the external `/mcp` lets it (`create_session`). */
export function assertRoomInProject(project: ProjectThreads): void {
  const running = project.threads.filter((s) => s.status === "running").length;
  if (running >= MAX_RUNNING_SESSIONS_PER_PROJECT) {
    throw new ToolError("SESSION_BUSY", `${running} chats are open in this project (limit ${MAX_RUNNING_SESSIONS_PER_PROJECT}); the user has to close some first.`);
  }
}

/**
 * Open the thread and send it its first message. A thread whose first message could not be sent
 * still exists: the error names it (`detail.threadId`), so the caller sends again instead of
 * opening a second one.
 */
export async function openThread(ctx: SessionToolContext, project: ProjectThreads, input: NewThread): Promise<CreatedThread> {
  assertRoomInProject(project);
  const caller = project.caller;
  const head = (await readThread(ctx.api, caller.id)).head;
  const refId = input.agent ?? caller.refId;
  const agent = findAgent(await loadAgents(ctx.api), refId);
  if (!agent.enabled) throw new ToolError("INVALID_ARGUMENT", `${refId} is not available on this host (not installed or disabled).`);
  const sameAgent = refId === caller.refId;
  // Same agent: the caller's own model and options unless a model is named (its options carry over
  // where the new model takes them). Another agent: its default model.
  const selection = resolveModelSelection(agent, { model: input.model, ...(sameAgent ? { current: head.modelSelection } : {}) });
  // Same agent: the caller's managed account, when it still has one; otherwise the family default.
  let accountId: string | undefined;
  if (sameAgent && caller.accountId) {
    try {
      accountId = validateAccountId(agent, caller.accountId);
    } catch {
      accountId = undefined;
    }
  }
  const chat: CreateAgentChatSessionFields = {
    ...(accountId ? { accountId } : {}),
    modelSelection: { model: selection.model, options: selection.options },
    // Never broader than the caller's: a supervised thread must not open an unsupervised one.
    runtimeMode: head.runtimeMode,
    ...(input.delegate ? { lineage: { parentThreadId: caller.id, relation: "delegate" as const } } : {})
  };
  const title = input.title?.trim() || (input.delegate ? delegateTitle(input.prompt) : agent.name);
  const body: CreateSessionRequest = {
    kind: "agent-chat",
    refId,
    projectPath: caller.projectPath,
    cwd: ctx.cwd || caller.cwd,
    title,
    ...(accountId ? { accountId } : {}),
    chat
  };
  const session = expectOk<SessionSummary>(await ctx.api.request("POST", "/api/sessions", { body }));
  try {
    await sendCommand(ctx.api, session.id, "turn", { input: input.prompt, interactionMode: "default" });
  } catch (error) {
    const failure = toSafeToolError(error).structuredContent;
    throw new ToolError(
      failure.code,
      `Thread "${session.id}" was opened but its first message could not be sent: ${failure.message} Send it with thread_send; do not open another.`,
      { threadId: session.id, created: true }
    );
  }
  return { session, model: selection.model };
}

/** A delegated task's default tab title: "Task: " and the prompt's first line, cut short. */
export function delegateTitle(prompt: string): string {
  const line = prompt.trim().split("\n", 1)[0]!.trim();
  const cut = line.length > 60 ? `${line.slice(0, 59)}…` : line;
  return cut ? `Task: ${cut}` : "Task";
}
