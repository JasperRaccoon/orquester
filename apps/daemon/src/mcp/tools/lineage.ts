// Catalog family module `lineage` (fork_session, merge_back_session) — plan Task 8 (unified MCP, Wave 3).
//
// `fork_session` (spec §4 row 15) and `merge_back_session` (row 16: a FORK's result to its parent,
// and deliver/discard of a queued delivery by its receiver or sender) for both audiences. A chat's
// fork is marked `agentCreated` (the fork route honours it only from the forked chat's own agent,
// §13 c) and inherits workflow ownership through the service (§5.4). Merge-back is for forks only:
// a delegated or opened chat's final reply goes back by itself (§8.5). `get_session_lineage` and
// `resolve_merge_back` are folded into `get_session` and `merge_back_session` (§11).
import { z } from "zod";
import type { ForkSessionRequest, ForkSessionResponse, MergeBackActionResponse, MergeBackResponse, SessionSummary } from "@orquester/api";
import { agentChatRoutes, SETTLED_TURN_STATES as SETTLED, startedTurns } from "@orquester/api/agent-chat";
import { canonicalProject } from "../addressing.ts";
import { findAgent, findModel, loadAgents, resolveModelSelection, validateAccountId } from "../agents.ts";
import { ToolError, expectOk } from "../errors.ts";
import { listSessions, postIdempotent, readThread, readThreadHead, requireChatSession } from "../reads.ts";
import { clipText, MAX_ECHO_CHARS, toSafeToolError } from "../result.ts";
import { chatDetail } from "../views.ts";
import { defineTool, MUTATING, type AnyOrquesterTool, type ScopeClaim } from "../catalog/contract.ts";
import { chatThreadRef, sessionCard, sessionClaim, threadCaller } from "./session-access.ts";
import { MAX_RUNNING_SESSIONS_PER_PROJECT, optionsSchema } from "./sessions.ts";
import { launchModel } from "./messages.ts";
import { profileNames, profileRef, resolveProfileArg } from "../profiles.ts";

// Every call goes through the daemon's own routes (agentChatRoutes.fork, .mergeBack, .mergeBackItem), so the GUI's
// checks and the host's refusals apply unchanged.

// ---------------------------------------------------------------------------
// The catalog tools (unified MCP design 2026-10-15 §4 rows 15–16)
// ---------------------------------------------------------------------------

const catalogSessionId = z.string().min(1);

/** The fork body's cut by turn number (the transcript's numbers): `finishedOnly` while the caller forks its own running conversation. */
async function forkCut(api: Parameters<typeof readThread>[0], sessionId: string, throughTurn: number, finishedOnly: boolean): Promise<Pick<ForkSessionRequest, "turnId" | "role">> {
  const started = startedTurns((await readThread(api, sessionId)).turns);
  if (started.length === 0) throw new ToolError("INVALID_ARGUMENT", "This conversation has no turn to fork from yet.");
  if (finishedOnly) {
    // Only finished turns fork: yours is still running, so the latest finished one is the most a fork keeps.
    let finished = 0;
    started.forEach((turn, index) => { if (SETTLED.has(turn.state)) finished = index + 1; });
    if (throughTurn > finished) {
      throw new ToolError(
        "INVALID_ARGUMENT",
        throughTurn <= started.length
          ? `Turn ${throughTurn} has not finished; the latest finished turn is ${finished}. Fork through that, or leave throughTurn out.`
          : `throughTurn must be between 0 and ${finished}, the latest finished turn.`
      );
    }
  } else if (throughTurn > started.length) {
    throw new ToolError("INVALID_ARGUMENT", `throughTurn must be between 0 and ${started.length}: this conversation has ${started.length} started turn${started.length === 1 ? "" : "s"}.`);
  }
  // Through turn N is turn N itself; before the first is turn 1's user side.
  return throughTurn === 0 ? { turnId: started[0]!.turnId, role: "user" } : { turnId: started[throughTurn - 1]!.turnId, role: "assistant" };
}

/**
 * Refuse a fork once the target's project holds as many open chats as a tool may add to (§5.6).
 * Projects compare canonically (two spellings of one project are one project).
 */
async function assertRoomInProject(api: Parameters<typeof canonicalProject>[0], sessions: readonly SessionSummary[], projectPath: string): Promise<void> {
  const own = (await canonicalProject(api, projectPath))?.canonical;
  const roots = new Map<string, string | undefined>();
  let running = 0;
  for (const s of sessions) {
    if (s.status !== "running") continue;
    if (!roots.has(s.projectPath)) roots.set(s.projectPath, (await canonicalProject(api, s.projectPath))?.canonical);
    if (s.projectPath === projectPath || (own !== undefined && roots.get(s.projectPath) === own)) running += 1;
  }
  if (running >= MAX_RUNNING_SESSIONS_PER_PROJECT) {
    throw new ToolError("SESSION_BUSY", `${running} sessions are open in this project (limit ${MAX_RUNNING_SESSIONS_PER_PROJECT}); the user has to close some first.`);
  }
}

/** The daemon's refusals of a launch's Agent Profile. */
const PROFILE_REFUSALS: ReadonlySet<string> = new Set(["PROFILE_NOT_FOUND", "PROFILE_NOT_READY", "PROFILE_UNSUPPORTED_AGENT"]);

/** The fork route, its profile refusal naming the profile (`profile`: the one asked for or inherited, id or `{id, name}`). */
async function forkWithProfile(api: Parameters<typeof readThread>[0], target: string, body: ForkSessionRequest, profile: { id: string; name: string } | string | null): Promise<ForkSessionResponse> {
  try {
    // A fresh commandId, re-sent unchanged on a 503: a retry lands on the same fork, never a second one.
    return await postIdempotent<ForkSessionResponse>(api, agentChatRoutes.fork(target), { ...body });
  } catch (error) {
    if (profile !== null && error instanceof ToolError && PROFILE_REFUSALS.has(error.code)) {
      const named = typeof profile === "string" ? (await profileNames(api)).get(profile) ?? profile : profile.name;
      throw new ToolError(error.code, `Agent Profile "${named}" could not be used, so nothing was forked: ${error.message} Fork with another \`profile\`, or \"global\".`, error.detail);
    }
    throw error;
  }
}

/**
 * The fork's agent, model, options and account (`agent`, `model`, `options`, `accountId`), checked
 * as create_session checks them. Another agent needs a model from ITS catalogue (named, else its
 * launch default); the same agent keeps its own unless one is named. Nothing named: `{}`.
 */
async function forkTarget(
  api: Parameters<typeof readThread>[0],
  summary: SessionSummary,
  args: { agent?: string; model?: string; options?: Record<string, string | boolean>; accountId?: string }
): Promise<Pick<ForkSessionRequest, "refId" | "accountId" | "modelSelection"> & { isLegacy?: true }> {
  const sameAgent = args.agent === undefined || args.agent === summary.refId;
  if (sameAgent && args.model === undefined && args.options === undefined && args.accountId === undefined) return {};
  const refId = args.agent ?? summary.refId;
  const agent = findAgent(await loadAgents(api, { includeLegacyModels: true }), refId);
  if (!agent.enabled) throw new ToolError("INVALID_ARGUMENT", `${refId} is not available on this host (not installed or disabled).`);
  if (args.accountId !== undefined && args.accountId !== "system" && agent.adapter === "opencode") {
    throw new ToolError("INVALID_ARGUMENT", "OpenCode chats run under the server's own identity: leave accountId out.");
  }
  const accountId = validateAccountId(agent, args.accountId);
  let modelSelection: ForkSessionRequest["modelSelection"];
  let isLegacy = false;
  if (!sameAgent) {
    const model = launchModel(agent, args.model, undefined);
    isLegacy = model.isLegacy;
    const selection = resolveModelSelection(agent, { model: model.slug, ...(args.options !== undefined ? { options: args.options } : {}) });
    modelSelection = { model: selection.model, options: selection.options };
  } else if (args.model !== undefined || args.options !== undefined) {
    const current = (await readThreadHead(api, summary.id)).head.modelSelection;
    const model = args.model !== undefined ? findModel(agent, args.model) : undefined;
    isLegacy = model?.isLegacy === true;
    const selection = resolveModelSelection(agent, { ...(args.model !== undefined ? { model: args.model } : {}), ...(args.options !== undefined ? { options: args.options } : {}), current });
    modelSelection = { ...(current.instanceId !== undefined ? { instanceId: current.instanceId } : {}), model: selection.model, options: selection.options };
  }
  return {
    ...(!sameAgent ? { refId } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(modelSelection !== undefined ? { modelSelection } : {}),
    ...(isLegacy ? { isLegacy: true as const } : {})
  };
}

export const forkSessionTool = defineTool({
  name: "fork_session",
  title: "Fork a chat session",
  description:
    "Fork a chat into a new idle tab (same project, agent, settings, Agent Profile) holding its conversation through `throughTurn` (transcript numbers; default: the latest finished turn) or up to `messageId`. A bad profile fails it. send_message the fork work; it returns its result with merge_back_session. " +
    "`agent` or `accountId` CONTINUES it in another agent or account: a fresh session handed the newest whole messages (≤64 KB; `handoff` says how many), earlier history readable with read_transcript. `model`/`options` as create_session.",
  chatNote: "Default: this chat (your running turn is not included).",
  input: {
    sessionId: catalogSessionId.optional(),
    throughTurn: z.number().int().min(0).optional().describe("Keep turns 1..N (0: none)."),
    messageId: z.string().min(1).max(200).optional().describe("Fork at this message (a user message: just before it)."),
    title: z.string().trim().min(1).max(200).optional(),
    profile: z.string().trim().min(1).max(200).nullable().optional().describe("Agent Profile id/name; null: Global."),
    agent: z.string().min(1).max(64).optional().describe("Another agent to continue in (list_agents)."),
    model: z.string().min(1).max(200).optional().describe("For the fork's agent (list_agents)."),
    options: optionsSchema.optional(),
    accountId: z.string().min(1).max(200).optional().describe("Another account (list_agents) or \"system\".")
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "act",
  async scope(args, ctx) {
    if (args.throughTurn !== undefined && args.messageId !== undefined) throw new ToolError("INVALID_ARGUMENT", "Give throughTurn or messageId, not both.");
    const caller = threadCaller(ctx.caller);
    const target = args.sessionId ?? caller?.threadId;
    if (target === undefined) throw new ToolError("INVALID_ARGUMENT", "sessionId is required: the session to fork.");
    // The fork carries the original's conversation into a tab the caller can read: a content read.
    return sessionClaim(ctx, target, { reads: "content", writes: false, causesTurnIn: [], self: "allow" });
  },
  approval: async (args, ctx) =>
    sessionCard(ctx, args.sessionId ?? threadCaller(ctx.caller)?.threadId ?? "", "fork", [
      ...(args.throughTurn !== undefined ? [{ label: "Through turn", value: String(args.throughTurn) }] : []),
      ...(args.messageId !== undefined ? [{ label: "At message", value: args.messageId }] : []),
      ...(args.title !== undefined ? [{ label: "Fork title", value: args.title }] : []),
      ...(args.profile !== undefined ? [{ label: "Agent Profile", value: args.profile ?? "Global" }] : []),
      ...(args.agent !== undefined ? [{ label: "Continue in agent", value: args.agent }] : []),
      ...(args.model !== undefined ? [{ label: "Model", value: args.model }] : []),
      ...(args.options !== undefined ? [{ label: "Options", value: JSON.stringify(args.options) }] : []),
      ...(args.accountId !== undefined ? [{ label: "Account", value: args.accountId }] : [])
    ]),
  annotations: MUTATING,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const caller = threadCaller(ctx.caller);
    const target = args.sessionId ?? caller!.threadId;
    const summary = await requireChatSession(api, target);
    const sessions = await listSessions(api);
    await assertRoomInProject(api, sessions, summary.projectPath);
    // The fork's profile (spec 2026-10-18 §5.5): named (null = Global), else the original's. A tool's fork is unattended.
    const profile = args.profile === undefined ? undefined : args.profile === null ? null : await resolveProfileArg(api, args.profile);
    const body: ForkSessionRequest = { unattended: true, ...(profile !== undefined ? { profileId: profile?.id ?? null } : {}) };
    if (args.title !== undefined) body.title = args.title;
    if (args.messageId !== undefined) body.messageId = args.messageId;
    if (args.throughTurn !== undefined) Object.assign(body, await forkCut(api, target, args.throughTurn, caller !== null && target === caller.threadId));
    // Another agent, model or account: checked as create_session checks them, before anything is made.
    const { isLegacy, ...forkAt } = await forkTarget(api, summary, args);
    Object.assign(body, forkAt);
    // A chat's fork is its own child (§13 c): the route keeps the flag only from the forked chat's own agent.
    if (caller !== null) body.agentCreated = true;
    const result = await forkWithProfile(api, target, body, profile === undefined ? (summary.profileId ?? null) : profile);
    // A continuation says where it runs and what its transcript carries.
    const continued = {
      ...(result.lineage.sourceAgent !== undefined ? { agent: result.session.refId, accountId: result.session.accountId || "system" } : {}),
      ...(forkAt.modelSelection !== undefined ? { model: forkAt.modelSelection.model } : {}),
      ...(isLegacy ? { isLegacy: true } : {}),
      ...(result.handoff !== undefined ? { handoff: result.handoff } : {})
    };
    if (caller !== null) {
      return {
        sessionId: result.session.id,
        title: result.session.title,
        strategy: result.strategy,
        ...continued,
        profile: profileRef(result.session.profileId, await profileNames(api)),
        ...(result.lineage.forkedFrom ? { forkedFrom: result.lineage.forkedFrom } : {}),
        ...chatThreadRef(caller, sessions, result.session, target === caller.threadId ? "fork" : "thread")
      };
    }
    try {
      return { strategy: result.strategy, ...continued, lineage: result.lineage, session: await chatDetail(api, result.session.id) };
    } catch (error) {
      // The fork exists now: a caller told only that the read failed would fork again.
      const failure = toSafeToolError(error).structuredContent;
      throw new ToolError(failure.code, `Session ${result.session.id} was forked but could not be read: ${failure.message}`, { sessionId: result.session.id, created: true });
    }
  }
});

/**
 * Why a session that is no fork cannot merge back (§8.5): a delegate's final reply is its result and
 * an opened chat's goes back by itself — `self` words it for the chat itself, else for an outsider.
 */
function notAFork(lineage: SessionSummary["lineage"], self: boolean): string | null {
  if (!lineage) return "This session was not forked from another one: there is nothing to merge back into.";
  if (lineage.relation === "delegate") {
    return self
      ? "This is a delegated task: your final reply is delivered to your parent automatically as its result. End your turn with it instead of merging back."
      : "That session is a delegated task: its final reply is delivered to its parent automatically as its result. Merge-back is for forks.";
  }
  if (lineage.relation === "opened") {
    return self
      ? "This chat was opened by another chat, not forked from it: your final reply goes back to it by itself when it asked for one; otherwise answer it with send_message."
      : "That session was opened by another chat, not forked from it. Merge-back is for forks.";
  }
  return null;
}

export const mergeBackSessionTool = defineTool({
  name: "merge_back_session",
  title: "Merge a fork back",
  description:
    "Send a fork's result to the chat it was forked from, marked as the fork's: `text` (called from outside the fork, default: its final reply); queued (`delivery: \"queued\"`) unless that chat is idle. Forks only: delegated and opened chats report back by themselves. `mergeId` + `action`: deliver now or discard a queued delivery (get_session pendingDeliveries), as receiver or sender.",
  chatNote: "Default: this chat, the fork; put your whole result in `text`.",
  input: {
    sessionId: catalogSessionId.optional(),
    text: z.string().trim().min(1).max(100_000).optional(),
    mergeId: z.string().min(1).max(200).optional(),
    action: z.enum(["deliver", "discard"]).optional()
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "act",
  async scope(args, ctx) {
    const acting = args.mergeId !== undefined || args.action !== undefined;
    if (acting && (args.mergeId === undefined || args.action === undefined)) throw new ToolError("INVALID_ARGUMENT", "mergeId and action go together.");
    if (acting && args.text !== undefined) throw new ToolError("INVALID_ARGUMENT", "text sends a merge; mergeId and action act on a queued one. Not both.");
    const caller = threadCaller(ctx.caller);
    if (caller === null) {
      if (args.sessionId === undefined) throw new ToolError("INVALID_ARGUMENT", "sessionId is required.");
      return { projects: [], sessions: [args.sessionId], reads: "none", writes: acting && args.action === "discard", causesTurnIn: [] };
    }
    if (args.sessionId !== undefined && args.sessionId !== caller.threadId) {
      throw new ToolError("PERMISSION_DENIED", "A chat merges back, delivers or discards only as itself: leave sessionId out.");
    }
    if (acting) return { projects: [], sessions: [caller.threadId], reads: "none", writes: args.action === "discard", causesTurnIn: [] };
    if (args.text === undefined) throw new ToolError("INVALID_ARGUMENT", "text is required: write your whole result into it (your reply in this turn is not finished yet).");
    const sessions = await listSessions(ctx.api);
    const lineage = sessions.find((s) => s.id === caller.threadId)?.lineage;
    const refusal = notAFork(lineage, true);
    if (refusal !== null) throw new ToolError("INVALID_ARGUMENT", refusal);
    // The parent's turn is caused by this merge: the turn policy and the exchange apply to it (§5.3,
    // §8.4). A parent that is closed is left to the route, which refuses it.
    const parent = sessions.find((s) => s.id === lineage!.parentThreadId);
    if (!parent) return { projects: [], sessions: [caller.threadId], reads: "none", writes: false, causesTurnIn: [] };
    const claim = await sessionClaim(ctx, parent.id, { reads: "none", writes: false, causesTurnIn: [parent.id] });
    return { ...claim, sessions: [caller.threadId, parent.id] } satisfies ScopeClaim;
  },
  async approval(args, ctx) {
    // Only a send reaches another chat: its parent (a fork lives in its parent's project, so this card is rare).
    const caller = threadCaller(ctx.caller);
    const parent = caller ? (await listSessions(ctx.api)).find((s) => s.id === caller.threadId)?.lineage?.parentThreadId : undefined;
    return sessionCard(ctx, parent ?? args.sessionId ?? "", "merge a fork's result into", [], { text: args.text });
  },
  annotations: MUTATING,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const caller = threadCaller(ctx.caller);
    const target = args.sessionId ?? caller!.threadId;
    if (args.mergeId !== undefined && args.action !== undefined) {
      const done = expectOk<MergeBackActionResponse>(await api.request("POST", agentChatRoutes.mergeBackItem(target, args.mergeId), { body: { action: args.action } }));
      return { ...done };
    }
    const summary = await requireChatSession(api, target);
    const refusal = notAFork(summary.lineage, caller !== null);
    if (refusal !== null) throw new ToolError("INVALID_ARGUMENT", refusal);
    let interactionMode: "plan" | undefined;
    if (caller !== null && ctx.turn.interactionMode === "plan") {
      // Plan carries on (§5.3): the parent's turn plans too — refused for an agent with no plan mode.
      const parent = (await listSessions(api)).find((s) => s.id === summary.lineage!.parentThreadId);
      if (parent && !findAgent(await loadAgents(api), parent.refId).supports.planMode) {
        throw new ToolError("PERMISSION_DENIED", `You are planning and ${clipText(parent.refId, MAX_ECHO_CHARS)} has no plan mode, so your result cannot be merged into it now. Propose it in your plan instead.`);
      }
      interactionMode = "plan";
    }
    // A fresh commandId (the merge's id), re-sent unchanged on a 503: a retry is the same merge.
    const result = await postIdempotent<MergeBackResponse>(api, agentChatRoutes.mergeBack(target), {
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(interactionMode ? { interactionMode } : {}),
      ...(ctx.turn.causedBy ? { causedBy: ctx.turn.causedBy } : {})
    });
    if (caller === null) return { ...result };
    const sessions = await listSessions(api);
    const parent = sessions.find((s) => s.id === result.parentSessionId);
    return { ...result, ...(parent ? chatThreadRef(caller, sessions, parent, "parent") : {}) };
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const lineageFamily: readonly AnyOrquesterTool[] = [forkSessionTool, mergeBackSessionTool];
