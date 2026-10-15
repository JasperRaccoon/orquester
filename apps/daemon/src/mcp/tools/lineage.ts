// Catalog family module `lineage` (Lineage: fork_session, merge_back_session) — owned by plan Task 8 (unified MCP, Wave 3).
// Task 2 stub: `lineageFamily` exports this family's tools as catalog tools (`../catalog/legacy.ts`
// adapters over the pre-catalog definitions below); the owning task replaces it and Task 2 never
// edits this file again.
import { z } from "zod";
import type { ForkSessionRequest, ForkSessionResponse, MergeBackActionResponse, MergeBackResponse, SessionLineageResponse } from "@orquester/api";
import { agentChatRoutes, startedTurns } from "@orquester/api/agent-chat";
import { ToolError, expectOk } from "../errors.ts";
import { postIdempotent, readThread, requireChatSession } from "../reads.ts";
import { toSafeToolError } from "../result.ts";
import { defineTool, MUTATING, READ_ONLY, type ToolDef } from "../tool.ts";
import { chatDetail } from "../views.ts";
import { legacyChatTools, legacyExternalTools } from "../catalog/legacy.ts";
import { threadTools as legacyThreadTools } from "../../session-tools/threads/threads.ts";
import { delegationTools as legacyDelegationTools } from "../../session-tools/threads/delegation.ts";

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

export const lineageTools: ToolDef[] = [forkSession, mergeBackSession, resolveMergeBack, getSessionLineage];

/** The legacy in-chat thread tools this family's owner replaces: `thread_send`, `thread_create`, `delegate_task`, `thread_wait`, `task_wait`, `thread_fork`, `thread_merge_back`. */
const LEGACY_CHAT_NAMES: ReadonlySet<string> = new Set(["thread_send", "thread_create", "delegate_task", "thread_wait", "task_wait", "thread_fork", "thread_merge_back"]);
/** This family in the catalog (`../catalog/index.ts`). */
export const lineageFamily = [
  ...legacyExternalTools(lineageTools),
  ...legacyChatTools([...legacyThreadTools, ...legacyDelegationTools].filter((tool) => LEGACY_CHAT_NAMES.has(tool.name)))
];
