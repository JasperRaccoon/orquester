/**
 * Session tools — threads: opening a chat thread in the caller's project, as `thread_create` and
 * `delegate_task` do. The new thread runs in the caller's working directory and permission mode
 * (or a narrower one named; never a broader one), with the caller's model, options and account
 * when it is the same agent — each of which the call may name instead, validated as the external
 * `/mcp`'s `create_session` validates them (`../../mcp/agents.ts`).
 */

import { z } from "zod";
import type { CreateSessionRequest, SessionSummary } from "@orquester/api";
import { threadMessageContext, type CreateAgentChatSessionFields, type RuntimeMode } from "@orquester/api/agent-chat";

import { findAgent, loadAgents, resolveModelSelection, validateAccountId } from "../../mcp/agents.ts";
import { expectOk, ToolError } from "../../mcp/errors.ts";
import { readThread, sendCommand } from "../../mcp/reads.ts";
import { toSafeToolError } from "../../mcp/result.ts";
import { MAX_RUNNING_SESSIONS_PER_PROJECT, optionsSchema, runtimeModeSchema } from "../../mcp/tools/sessions.ts";
import type { SessionToolContext } from "../contract.ts";
import { interactionModeFor, openedThreadRuntimeMode, turnPolicyCallerFrom, withProvenance } from "../turn-policy.ts";
import type { ProjectThreads } from "./shared.ts";

/**
 * The settings `thread_create` and `delegate_task` both take for the thread they open, beside
 * `prompt` and `title`: the agent, its model, model options, account and permission mode.
 */
export const newThreadSettingsInput = {
  agent: z.string().min(1).max(64).optional().describe("Agent id (agent_catalog lists them). Default: this thread's agent."),
  // min(1): an empty model would read as none, so the default model would launch in its place (`resolveModelSelection`).
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Model slug for that agent; an unknown one is refused with the valid list. Default: this thread's model for the same agent, else the agent's default."),
  options: optionsSchema
    .optional()
    .describe("Model options by id, e.g. {\"effort\":\"high\"} (`effort` works for every agent); an invalid one is refused with the valid choices. Same agent: this thread's options carry over (those the model takes) and these replace them one by one; another agent: its defaults plus these."),
  accountId: z.string().min(1).max(200).optional().describe("A managed account id of that agent (agent_catalog), or \"system\". Default: this thread's account for the same agent, else the agent's default account."),
  runtimeMode: runtimeModeSchema
    .optional()
    .describe("Permission mode: this thread's own or a narrower one (approval-required < auto-accept-edits < auto < full-access); a broader one is refused. Default: this thread's.")
};

export interface NewThread {
  prompt: string;
  agent?: string;
  model?: string;
  /** Explicit model options, merged over the inherited ones (`resolveModelSelection`). */
  options?: Record<string, string | boolean>;
  /** A managed account id of the agent, or "system". */
  accountId?: string;
  /** The caller's own permission mode or a narrower one. */
  runtimeMode?: RuntimeMode;
  title?: string;
  /** Set for a delegated task: the caller is its parent. */
  delegate?: true;
}

export interface CreatedThread {
  session: SessionSummary;
  model: string;
  options: { id: string; value: string | boolean }[];
  runtimeMode: RuntimeMode;
  /** The account named on the new thread; absent: the agent's default. */
  accountId?: string;
  /** The first turn runs in plan mode: the caller was planning. */
  planMode: boolean;
}

/** The settings of a `newThreadSettingsInput` call that were given, for {@link openThread}. */
export function newThreadSettings(args: { agent?: string; model?: string; options?: Record<string, string | boolean>; accountId?: string; runtimeMode?: RuntimeMode }): Omit<NewThread, "prompt"> {
  return {
    ...(args.agent !== undefined ? { agent: args.agent } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.options !== undefined ? { options: args.options } : {}),
    ...(args.accountId !== undefined ? { accountId: args.accountId } : {}),
    ...(args.runtimeMode !== undefined ? { runtimeMode: args.runtimeMode } : {})
  };
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
  const own = await readThread(ctx.api, caller.id);
  const head = own.head;
  const refId = input.agent ?? caller.refId;
  const agent = findAgent(await loadAgents(ctx.api), refId);
  if (!agent.enabled) throw new ToolError("INVALID_ARGUMENT", `${refId} is not available on this host (not installed or disabled).`);
  // The turn policy: the new thread runs in the caller's permission mode or a narrower one (never
  // broader), a planning caller's first turn plans too, and the message says which thread sent it.
  const policy = turnPolicyCallerFrom(caller, own);
  // Turn policy (a): the caller's own mode, or a narrower one named — never a broader one.
  const runtimeMode = openedThreadRuntimeMode(policy, input.runtimeMode);
  const interactionMode = await interactionModeFor(policy, { agent: refId, supportsPlanMode: () => agent.supports.planMode });
  const sameAgent = refId === caller.refId;
  // Same agent: the caller's own model and options unless a model is named (its options carry over
  // where the new model takes them). Another agent: its default model and options. Named options
  // then replace those, one by one, validated against the model's catalogue.
  const selection = resolveModelSelection(agent, {
    model: input.model,
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(sameAgent ? { current: head.modelSelection } : {})
  });
  // A named account: any of the agent's, or "system". Otherwise, same agent: the caller's managed
  // account, when it still has one; else the family default.
  let accountId = validateAccountId(agent, input.accountId);
  if (input.accountId === undefined && sameAgent && caller.accountId) {
    try {
      accountId = validateAccountId(agent, caller.accountId);
    } catch {
      accountId = undefined;
    }
  }
  const chat: CreateAgentChatSessionFields = {
    ...(accountId ? { accountId } : {}),
    modelSelection: { model: selection.model, options: selection.options },
    runtimeMode,
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
    await sendCommand(ctx.api, session.id, "turn", {
      input: withProvenance(policy, input.delegate ? "delegated" : "opened", input.prompt),
      interactionMode,
      // The marker that the message is the calling thread's, not the user's (T6-M3).
      context: [threadMessageContext(ctx.threadId)]
    });
  } catch (error) {
    const failure = toSafeToolError(error).structuredContent;
    throw new ToolError(
      failure.code,
      `Thread "${session.id}" was opened but its first message could not be sent: ${failure.message} Send it with thread_send; do not open another.`,
      { threadId: session.id, created: true }
    );
  }
  return { session, model: selection.model, options: selection.options, runtimeMode, ...(accountId ? { accountId } : {}), planMode: interactionMode === "plan" };
}

/** What thread_create and delegate_task report of the thread they opened: its agent and the settings it runs with. */
export function createdSettings(created: CreatedThread): Record<string, unknown> {
  return {
    agent: created.session.refId,
    model: created.model,
    options: Object.fromEntries(created.options.map((o) => [o.id, o.value])),
    runtimeMode: created.runtimeMode,
    ...(created.accountId ? { accountId: created.accountId } : {})
  };
}

/** A delegated task's default tab title: "Task: " and the prompt's first line, cut short. */
export function delegateTitle(prompt: string): string {
  const line = prompt.trim().split("\n", 1)[0]!.trim();
  const cut = line.length > 60 ? `${line.slice(0, 59)}…` : line;
  return cut ? `Task: ${cut}` : "Task";
}
