// Catalog family module `lineage` (fork_session, merge_back_session) — plan Task 8 (unified MCP, Wave 3).
//
// `fork_session` (spec §4 row 15) and `merge_back_session` (row 16: a FORK's result to its parent,
// and deliver/discard of a queued delivery by its receiver or sender) for both audiences. A chat's
// fork is marked `agentCreated` (the fork route honours it only from the forked chat's own agent,
// §13 c) and inherits workflow ownership through the service (§5.4). Merge-back is for forks only:
// a delegated or opened chat's final reply goes back by itself (§8.5). `get_session_lineage` and
// `resolve_merge_back` are folded into `get_session` and `merge_back_session` (§11).
//
// The pre-catalog definitions (`lineageTools`) stay exported, unserved, for their tests until plan
// Task 14 deletes the legacy definitions.
import { z } from "zod";
import type { ForkSessionRequest, ForkSessionResponse, MergeBackActionResponse, MergeBackResponse, SessionLineageResponse, SessionSummary } from "@orquester/api";
import { agentChatRoutes, SETTLED_TURN_STATES as SETTLED, startedTurns } from "@orquester/api/agent-chat";
import { findAgent, loadAgents } from "../agents.ts";
import { ToolError, expectOk } from "../errors.ts";
import { listSessions, postIdempotent, readThread, requireChatSession } from "../reads.ts";
import { clipText, MAX_ECHO_CHARS, toSafeToolError } from "../result.ts";
import { defineTool, MUTATING, READ_ONLY, type ToolDef } from "../tool.ts";
import { chatDetail } from "../views.ts";
import { defineTool as defineCatalogTool, MUTATING as CATALOG_MUTATING, type AnyOrquesterTool, type ScopeClaim } from "../catalog/contract.ts";
import { chatThreadRef, sessionCard, sessionClaim, threadCaller } from "./watch.ts";
import { MAX_RUNNING_SESSIONS_PER_PROJECT } from "./sessions.ts";

// Thread lineage (spec 2026-10-14 §6): fork a chat session from a turn, merge a fork's result back into its parent,
// and read a session's parent and children. Every call goes through the daemon's own routes (agentChatRoutes.fork,
// .mergeBack, .lineage), so the GUI's checks and the host's refusals apply unchanged.

const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");

const forkSession = defineTool({
  name: "fork_session",
  title: "Fork a chat session",
  description: "Fork a chat session (the GUI's 'Fork from here'): a new chat tab in the same project with the same agent, model, options, permission mode and account, whose conversation is this one's through turn `throughTurn` (the transcript's turn numbers; default: the latest finished turn). The original is untouched. Claude, Codex and OpenCode fork natively and the new tab shows the inherited history; Grok has no fork of its own, so its fork starts fresh and is handed the conversation so far with its first message (`strategy: \"transcript\"`). Refused while that turn is still running. Returns the new session's detail, `strategy` and `lineage`; merge its result back with merge_back_session.",
  input: {
    sessionId: sessionIdField,
    throughTurn: z.number().int().min(0).optional().describe("Keep turns 1..throughTurn (0 = fork before the first message: a fresh session that only remembers where it came from). Default: through the latest finished turn."),
    title: z.string().min(1).max(200).optional().describe("The fork's tab title; default: the original's title + \" (fork)\".")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const body: ForkSessionRequest = {};
    if (args.title !== undefined) body.title = args.title;
    if (args.throughTurn !== undefined) {
      const started = startedTurns((await readThread(api, args.sessionId)).turns);
      if (started.length === 0) throw new ToolError("INVALID_ARGUMENT", "This conversation has no turn to fork from yet.");
      if (args.throughTurn > started.length) {
        throw new ToolError("INVALID_ARGUMENT", `throughTurn must be between 0 and ${started.length}: this conversation has ${started.length} started turn${started.length === 1 ? "" : "s"}.`);
      }
      // Through turn N is turn N itself; before the first is turn 1's user side.
      body.turnId = args.throughTurn === 0 ? started[0]!.turnId : started[args.throughTurn - 1]!.turnId;
      body.role = args.throughTurn === 0 ? "user" : "assistant";
    }
    // A fresh commandId, re-sent unchanged on a 503: a retry lands on the same fork, never a second one.
    const result = await postIdempotent<ForkSessionResponse>(api, agentChatRoutes.fork(args.sessionId), { ...body });
    try {
      return { strategy: result.strategy, lineage: result.lineage, session: await chatDetail(api, result.session.id) };
    } catch (error) {
      // The fork exists now: a caller told only that the read failed would fork again.
      const failure = toSafeToolError(error).structuredContent;
      throw new ToolError(failure.code, `Session ${result.session.id} was forked but could not be read: ${failure.message}`, { sessionId: result.session.id, created: true });
    }
  }
});

const mergeBackSession = defineTool({
  name: "merge_back_session",
  title: "Merge a fork back",
  description: "Send a forked (or delegated) session's result to the session it came from (the GUI's 'Merge back'): `text`, or by default the fork's final reply, arrives in the parent as a message marked as coming from the fork. Delivered now when the parent is idle (`delivery: \"sent\"`); while it is busy — a turn running, a question or approval open — it is queued and delivered once it is idle (`delivery: \"queued\"`, kept across restarts). Refused for a session with no parent, a closed parent, or a fork with no finished reply. Not idempotent: each call is a new message.",
  input: {
    sessionId: sessionIdField.describe("The FORK's session id (its lineage names the parent)."),
    text: z.string().min(1).max(100_000).optional().describe("What to send instead of the fork's final reply, e.g. a summary of what it found.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    // A fresh commandId (the merge's id), re-sent unchanged on a 503: a retry is the same merge.
    const result = await postIdempotent<MergeBackResponse>(api, agentChatRoutes.mergeBack(args.sessionId), args.text !== undefined ? { text: args.text } : {});
    return { ...result };
  }
});

const getSessionLineage = defineTool({
  name: "get_session_lineage",
  title: "Get a session's parent and children",
  description: "A chat session's lineage: the session it was forked from or delegated by (`parent`, with `exists: false` once that tab is closed), the sessions forked from or delegated by it (`children`, oldest first, with their status), and merges waiting for a busy parent (`pendingMerges`).",
  input: { sessionId: sessionIdField },
  annotations: READ_ONLY,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    return { ...expectOk<SessionLineageResponse>(await api.request("GET", agentChatRoutes.lineage(args.sessionId))) };
  }
});

const resolveMergeBack = defineTool({
  name: "resolve_merge_back",
  title: "Deliver or discard a pending merge",
  description: "Act on a merge that merge_back_session queued and the parent has not taken (get_session_lineage's pendingMerges, from the fork or the parent): `deliver` sends it now whatever the parent is doing — an ordinary message, so a running turn is steered (the way past a parent a continuing goal keeps busy) — and retries a `failed` one; `discard` drops it. Answers {mergeId, outcome: \"sent\" | \"discarded\", seq?}.",
  input: {
    sessionId: sessionIdField.describe("The fork's or the parent's session id."),
    mergeId: z.string().min(1).max(200).describe("pendingMerges[].mergeId from get_session_lineage."),
    action: z.enum(["deliver", "discard"])
  },
  annotations: MUTATING,
  async run(args, { api }) {
    return { ...expectOk<MergeBackActionResponse>(await api.request("POST", agentChatRoutes.mergeBackItem(args.sessionId, args.mergeId), { body: { action: args.action } })) };
  }
});

/** The pre-catalog definitions (unserved; their tests run them until plan Task 14 deletes them). */
export const lineageTools: ToolDef[] = [forkSession, mergeBackSession, resolveMergeBack, getSessionLineage];

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

/** Refuse a fork once the target's project holds as many open chats as a tool may add to (§5.6). */
function assertRoomInProject(sessions: readonly SessionSummary[], projectPath: string): void {
  const running = sessions.filter((s) => s.projectPath === projectPath && s.status === "running").length;
  if (running >= MAX_RUNNING_SESSIONS_PER_PROJECT) {
    throw new ToolError("SESSION_BUSY", `${running} sessions are open in this project (limit ${MAX_RUNNING_SESSIONS_PER_PROJECT}); the user has to close some first.`);
  }
}

export const forkSessionTool = defineCatalogTool({
  name: "fork_session",
  title: "Fork a chat session",
  description:
    "Fork a chat (the GUI's 'Fork from here'): a new tab, same project, agent and settings, whose conversation is the original's through turn `throughTurn` (transcript numbers; default: the latest finished turn) or up to `messageId`. Grok's fork is handed the transcript (`strategy`). The fork starts idle: send_message it work; it returns its result with merge_back_session.",
  chatNote: "Default: this chat (your running turn is not included).",
  input: {
    sessionId: catalogSessionId.optional(),
    throughTurn: z.number().int().min(0).optional().describe("Keep turns 1..N (0: none)."),
    messageId: z.string().min(1).max(200).optional().describe("Fork at this message (a user message: just before it)."),
    title: z.string().trim().min(1).max(200).optional()
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
      ...(args.title !== undefined ? [{ label: "Fork title", value: args.title }] : [])
    ], undefined),
  annotations: CATALOG_MUTATING,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const caller = threadCaller(ctx.caller);
    const target = args.sessionId ?? caller!.threadId;
    const summary = await requireChatSession(api, target);
    const sessions = await listSessions(api);
    assertRoomInProject(sessions, summary.projectPath);
    const body: ForkSessionRequest = {};
    if (args.title !== undefined) body.title = args.title;
    if (args.messageId !== undefined) body.messageId = args.messageId;
    if (args.throughTurn !== undefined) Object.assign(body, await forkCut(api, target, args.throughTurn, caller !== null && target === caller.threadId));
    // A chat's fork is its own child (§13 c): the route keeps the flag only from the forked chat's own agent.
    if (caller !== null) body.agentCreated = true;
    // A fresh commandId, re-sent unchanged on a 503: a retry lands on the same fork, never a second one.
    const result = await postIdempotent<ForkSessionResponse>(api, agentChatRoutes.fork(target), { ...body });
    if (caller !== null) {
      return {
        sessionId: result.session.id,
        title: result.session.title,
        strategy: result.strategy,
        ...(result.lineage.forkedFrom ? { forkedFrom: result.lineage.forkedFrom } : {}),
        ...chatThreadRef(caller, sessions, result.session, target === caller.threadId ? "fork" : "thread")
      };
    }
    try {
      return { strategy: result.strategy, lineage: result.lineage, session: await chatDetail(api, result.session.id) };
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

export const mergeBackSessionTool = defineCatalogTool({
  name: "merge_back_session",
  title: "Merge a fork back",
  description:
    "A fork's result to the chat it was forked from, marked as the fork's: `text` (from outside the fork, default: its final reply), sent at once to an idle chat, else queued (`delivery: \"queued\"`). Forks only: delegated and opened chats' final replies go back by themselves. `mergeId` + `action` deliver now or discard a queued delivery (get_session's pendingDeliveries), as its receiver or sender.",
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
    return sessionCard(ctx, parent ?? args.sessionId ?? "", "merge a fork's result into", [], args.text);
  },
  annotations: CATALOG_MUTATING,
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
