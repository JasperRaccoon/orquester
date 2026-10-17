// Catalog family module `sessions` (Sessions: reads and lifecycle) — owned by plan Task 7 (unified MCP, Wave 3):
// list_sessions, get_session, read_transcript, get_turn_diff, update_session, control_session (unified MCP design
// 2026-10-15 §4 rows 4–6, 8, 11, 12; §4.1; §5; §13 a–c). `create_session` is the conversation family's (`messages.ts`).
//
// The scope claim of a session-addressed call, content rights (§5.2, §13 a), the chat result frame (§4.3) and the
// boundary cards (§7.1) are shared with every session-addressed family (`./session-access.ts`).
import { z } from "zod";
import { SYSTEM_ACCOUNT_ID, type SessionLineageResponse, type SessionSummary } from "@orquester/api";
import {
  agentChatRoutes,
  isSettledConversationCompaction,
  parseThreadGoal,
  RUNTIME_MODES,
  startedTurns,
  UNTRUSTED_NOTICE,
  type ModelSelection,
  type RuntimeMode,
  type StartedTurn,
  type ThreadActivityItem,
  type ThreadItem,
  type ThreadSnapshotPayload,
  type TurnDiffResponse
} from "@orquester/api/agent-chat";
import { canonicalProject, resolveProject } from "../addressing.ts";
import { findAgent, loadAgents, resolveModelSelection, validateAccountId, type ResolvedSelection } from "../agents.ts";
import {
  defineTool,
  DESTRUCTIVE,
  MUTATING_IDEMPOTENT,
  READ_ONLY,
  type AnyOrquesterTool,
  type CallContext,
  type ScopeClaim
} from "../catalog/contract.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError, expectOk } from "../errors.ts";
import { runtimeModesUpTo } from "../gate/turn-policy.ts";
import { readOlderHistory, unavailableHint } from "../history.ts";
import { findSession, listSessions, readThread, readThreadHead, requireChatSession, sendCommand } from "../reads.ts";
import { fitJsonBytes, jsonBytes, MAX_RESULT_BYTES, resultBytes, toSafeToolError } from "../result.ts";
import { transcriptEntries, transcriptRange, type TranscriptResult } from "../transcript.ts";
import { buildViewContext, chatDetail, CONTENT_OMITTED_HINT, detailWithoutContent, fitDetail, rowWithoutContent, sessionDetail, sessionView, type SessionDetail } from "../views.ts";
import { byAttention, canonicalProjects, chatFrame, chatNotice, chatThreadRef, hasContentRights, projectCard, sessionAmongTabs, sessionCard, sessionClaim } from "./session-access.ts";

/** The most running tabs a project may hold before a tool opens another (`create_session`, `fork_session`; spec §5.6). */
export const MAX_RUNNING_SESSIONS_PER_PROJECT = 24;
/** A permission mode, as create_session and update_session take it (also the session tools' thread_create / delegate_task). */
export const runtimeModeSchema = z.enum(RUNTIME_MODES as unknown as [RuntimeMode, ...RuntimeMode[]]);
/** Model options by id, as create_session and update_session take them (also the session tools' thread_create / delegate_task). */
export const optionsSchema = z.record(z.union([z.string(), z.boolean()])).describe("By id, e.g. {\"effort\":\"high\"}; `effort` works for every agent.");
/** The session a call names (§9.5: shared field texts stay short). */
export const sessionIdField = z.string().min(1).describe("The session id (list_sessions).");

// ---------------------------------------------------------------------------
// Turn and goal state (shared by update_session and control_session)
// ---------------------------------------------------------------------------

/**
 * A turn is starting or running. The summary can trail the host by a beat, so the thread head just
 * read counts too — the fields the host's own `identitySwitchRefusal` reads.
 */
/** What these checks read of a thread: its head or its whole snapshot alike. */
type ThreadState = Pick<ThreadSnapshotPayload, "head" | "goal" | "pending">;

function isTurnActive(s: SessionSummary, snap: ThreadState): boolean {
  if (s.chatSessionStatus === "starting" || s.chatSessionStatus === "running" || s.latestTurn?.state === "running" || s.latestTurn?.state === "pending") return true;
  const { status, activeTurnId } = snap.head.session;
  return status === "starting" || status === "running" || activeTurnId !== null;
}

/**
 * The goal continues (goals §4.7): the summary's `continuing` — the host's own predicate, grace included — while the
 * thread just read still holds the goal `active`. The summary trails the host by up to one poll (right after a
 * `/goal pause` it can still say continuing), and the host reports a goal continuing only while it is active — or while
 * an Orquester update holds it ({@link goalHeldForUpdate}).
 */
function goalContinuing(s: SessionSummary, snap: ThreadState): boolean {
  return (s.goal?.continuing === true && parseThreadGoal(snap.goal)?.status === "active") || goalHeldForUpdate(s, snap);
}

/**
 * Goals §5.7: an Orquester update holds the goal — paused between two of its turns, and set going again by the agent
 * host itself once it has restarted. The host reports it `paused` and continuing, and the thread just read holds it
 * `paused`: the GUI's "paused for update" (`isGoalHeldForUpdate`).
 */
function goalHeldForUpdate(s: SessionSummary, snap: ThreadState): boolean {
  return s.goal?.continuing === true && s.goal.status === "paused" && parseThreadGoal(snap.goal)?.status === "paused";
}

/** The GUI's `canSwitchChatAccount` / the host's `identitySwitchRefusal`; the host stays authoritative. */
function switchRefusal(s: SessionSummary, snap: ThreadState): string | null {
  // Goals §5.7: the host refuses the switch while it holds the goal, which it will set going again by itself — and
  // then it continues, and is refused anyway: waiting never opens the switch. Any `/goal` but `status` takes the goal
  // back from the hold and leaves it paused, and a paused goal may switch (the host's `GOAL_HELD_SWITCH_REFUSAL`).
  if (goalHeldForUpdate(s, snap)) return "The goal is held for an Orquester update and resumes by itself once the agent host has restarted, when it continues again. Take it back first — send_message \"/goal pause\" keeps it paused — then switch accounts.";
  // Goals §5.5, ahead of the turn check as on the host: between a continuing goal's turns idle never comes, so "wait for
  // the turn" is advice that never comes true — and a switch let through between two of them would be the host's 409
  // only after the other fields were written. A `/goal pause` only stops the NEXT turn; an interrupt stops both.
  if (goalContinuing(s, snap)) return "Pause the goal before switching accounts: control_session {action: \"interrupt\"} pauses it and stops the running turn (or send_message \"/goal pause\", then let the turn finish).";
  if (isTurnActive(s, snap)) return "Wait for the agent to finish the current turn before switching accounts.";
  if (s.hasPendingApprovals || s.hasPendingUserInput || snap.pending.approvals.length > 0 || snap.pending.userInputs.length > 0) return "Answer the agent's open request before switching accounts.";
  if (s.backgroundLiveness) return "Wait for the background work to finish before switching accounts.";
  return null;
}

function sameSelection(a: ResolvedSelection, b: ModelSelection): boolean {
  const norm = (o: readonly { id: string; value: string | boolean }[] | undefined) => JSON.stringify([...(o ?? [])].sort((x, y) => x.id.localeCompare(y.id)));
  return a.model === b.model && norm(a.options) === norm(b.options);
}

/** An error's detail as fields to merge into ours: an object's own fields; anything else rides as `cause`. */
function detailFields(detail: unknown): Record<string, unknown> {
  if (detail === undefined) return {};
  return detail !== null && typeof detail === "object" && !Array.isArray(detail) ? { ...(detail as Record<string, unknown>) } : { cause: detail };
}

// ---------------------------------------------------------------------------
// list_sessions
// ---------------------------------------------------------------------------

const listSessionsTool = defineTool({
  name: "list_sessions",
  title: "List sessions",
  description: "Open tabs (chats, terminals): status, attention and why, lineage. attention:true: only tabs needing the user.",
  externalNote: "Default: every project.",
  input: {
    project: z.string().optional().describe("\"ws/project\", a path, or \"all\" (every project you may see)."),
    kind: z.enum(["chat", "terminal", "all"]).default("all"),
    attention: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).optional()
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  async scope(args, ctx) {
    const claim: ScopeClaim = { projects: [], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] };
    const { caller } = ctx;
    // "all" is narrowed in run, never carded (a fan-out over unknown projects cannot be judged on one card, §13 b).
    if (caller.kind !== "thread" || args.project === "all") return claim;
    if (args.project === undefined) return { ...claim, projects: caller.projectPath ? [caller.projectPath] : [] };
    return { ...claim, projects: [(await resolveProject(ctx.api, args.project)).path] };
  },
  approval: (args, ctx) => projectCard(ctx, args.project ?? "", "list the chats of"),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, caller }) {
    const all = args.project === "all";
    // `!== undefined`, as wait_for_session tests it: an empty project is refused by resolveProject, never "every project".
    const projectPath = args.project !== undefined && !all ? (await resolveProject(api, args.project)).path : undefined;
    const view = await buildViewContext(api);
    let sessions = await listSessions(api, projectPath);
    const frame: Record<string, unknown> = {};
    let readable: (s: SessionSummary) => boolean = () => true;
    if (caller.kind === "thread") {
      const projects = await canonicalProjects(api, sessions);
      const projectOf = (s: SessionSummary) => projects.get(s.projectPath) ?? null;
      const self = (s: SessionSummary) => s.id === caller.threadId;
      if (all && caller.runtimeMode !== "full-access") {
        // Below Full access another workspace's metadata needs a card (§5.2, ruling S13): "all" is this workspace's —
        // and the chats this chat created, wherever they are: they are its own work (§13 c).
        const ownChild = (s: SessionSummary) => s.lineage?.parentThreadId === caller.threadId && s.lineage.agentCreated === true;
        const inWorkspace = (s: SessionSummary) => self(s) || ownChild(s) || (caller.projectPath !== "" && caller.workspace !== "" && projectOf(s)?.workspace === caller.workspace);
        // Counted: the projects with chat tabs left out (a project with only terminals is no chat the caller misses).
        const excluded = new Set(sessions.filter((s) => s.kind === "agent-chat" && !inWorkspace(s)).flatMap((s) => (projectOf(s) ? [projectOf(s)!.canonical] : [])));
        sessions = sessions.filter(inWorkspace);
        frame.listed = "workspace";
        if (excluded.size > 0) frame.excludedProjects = excluded.size;
      } else if (all) {
        frame.listed = "all";
      } else if (projectPath === undefined) {
        sessions = sessions.filter((s) => self(s) || (caller.projectPath !== "" && projectOf(s)?.canonical === caller.projectPath));
      }
      readable = (s) => hasContentRights(caller, projectOf(s), self(s));
    }
    if (args.kind !== "all") sessions = sessions.filter((s) => (args.kind === "chat") === (s.kind === "agent-chat"));
    if (args.attention) {
      sessions = sessions.filter((s) => s.activity && (s.activity.attention !== null || s.activity.state === "waiting"));
      // The Attention Center's order — wait_for_session's own comparator: "what just called for me" first.
      sessions.sort(byAttention);
    } else {
      sessions.sort((a, b) => a.projectPath.localeCompare(b.projectPath) || a.order - b.order);
    }
    const listed = args.limit !== undefined ? sessions.slice(0, args.limit) : sessions;
    let omitted = false;
    let othersWords = false;
    const rows = listed.map((s) => {
      const row = sessionView(s, view);
      if (caller.kind !== "thread") return row;
      const own = s.id === caller.threadId ? { ...row, self: true } : row;
      if (readable(s)) {
        // A goal's objective is another chat's words (§4.3): the list then opens with the notice.
        if (s.id !== caller.threadId && row.chat?.goal) othersWords = true;
        return own;
      }
      omitted = true;
      return rowWithoutContent(own);
    });
    return {
      ...(othersWords ? { notice: UNTRUSTED_NOTICE } : {}),
      sessions: rows,
      ...(listed.length < sessions.length ? { more: sessions.length - listed.length } : {}),
      ...frame,
      ...(omitted ? { hint: `Rows marked contentOmitted leave out the goal's text: ${CONTENT_OMITTED_HINT}.` } : {})
    };
  }
});

// ---------------------------------------------------------------------------
// get_session
// ---------------------------------------------------------------------------

/** The most children get_session lists; `childrenOmitted` counts the rest. */
const MAX_LINEAGE_CHILDREN = 50;

const getSession = defineTool({
  name: "get_session",
  title: "Get session",
  description: "One session: status, settings, pending requests (ids, options), plan, subagents, context meter, last reply (a delegate's: result), lineage, pending deliveries.",
  chatNote: "Without content access: metadata only.",
  input: { sessionId: sessionIdField },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  scope: (args, ctx) => sessionClaim(ctx, args.sessionId, { reads: "metadata", writes: false, self: "allow" }),
  approval: (args, ctx) => sessionCard(ctx, args.sessionId, "read the status of"),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, caller }) {
    const { summary, sessions } = await sessionAmongTabs(api, args.sessionId);
    const ref = chatThreadRef(caller, sessions, summary);
    if (summary.kind !== "agent-chat") return { session: sessionView(summary, await buildViewContext(api)), ...ref };
    const self = caller.kind === "thread" && summary.id === caller.threadId;
    const readable = caller.kind !== "thread" || hasContentRights(caller, await canonicalProject(api, summary.projectPath), self);
    const [snap, view, lineage] = await Promise.all([
      readThread(api, args.sessionId),
      buildViewContext(api),
      api.request("GET", agentChatRoutes.lineage(args.sessionId)).then((res) => expectOk<SessionLineageResponse>(res))
    ]);
    const { parentThreadId: _parentId, ...link } = lineage.lineage ?? ({} as Partial<NonNullable<SessionLineageResponse["lineage"]>>);
    const children = lineage.children.slice(0, MAX_LINEAGE_CHILDREN);
    const lineageView = {
      ...link,
      parent: lineage.parent,
      children,
      ...(lineage.children.length > children.length ? { childrenOmitted: lineage.children.length - children.length } : {})
    };
    // A queued delivery's preview is another chat's words: content.
    const pendingDeliveries = readable ? lineage.pendingMerges : lineage.pendingMerges.map(({ preview: _preview, error: _error, ...rest }) => rest);
    // The detail gets what the result leaves beside the lineage (ok()'s cap less a margin for the frame).
    let detail: SessionDetail = fitDetail(sessionDetail(summary, snap, view), MAX_RESULT_BYTES - 1_000 - resultBytes({ lineageView, pendingDeliveries }));
    // §8.5: a delegate's final reply IS its task's result, once the turn that produced it settled.
    let result: Record<string, unknown> | undefined;
    if (summary.lineage?.relation === "delegate" && detail.lastReply && !isTurnActive(summary, snap)) {
      const { lastReply, ...rest } = detail;
      detail = rest;
      result = { text: lastReply.text, turnId: lastReply.turnId, ...(lastReply.truncated ? { truncated: true } : {}) };
    }
    return {
      ...(readable ? chatNotice(caller, summary.id) : {}),
      session: readable ? detail : detailWithoutContent(detail),
      lineage: lineageView,
      pendingDeliveries,
      ...(readable && result ? { result } : {}),
      ...(readable ? {} : { contentOmitted: true, hint: CONTENT_OMITTED_HINT }),
      ...ref
    };
  }
});

// ---------------------------------------------------------------------------
// read_transcript
// ---------------------------------------------------------------------------

/** read_transcript's ceiling: the budget covers the whole result in UTF-8 bytes (transcript.ts), 5 000 under ok()'s 60 000-byte cap (result.ts). */
const MAX_TRANSCRIPT_CHARS = 55_000;
const TRUNCATED_HINT = "Shed to fit maxChars: reasoning, then tool detail, then the oldest rows (coveredTurns says which turns are left). Raise maxChars (max 55000), include less, or use get_turn_diff for one turn's file changes.";
/** get_session sheds subagent rows too when its detail would pass the cap (views.ts), so this promises no full roster. */
const SUBAGENTS_TRIMMED_HINT = "The subagent list was trimmed too; get_session may list more of it.";

/**
 * The hint a read_transcript result carries, or none for a whole one that read every turn of its range: first
 * `unavailable`, the sentence about the turns it could not read whole (history.ts `unavailableHint`), then the shed
 * hint. That one keys on `truncated`, which transcript.ts sets on every result it sheds, a trimmed subagent list alone
 * included; `subagentsTruncated` is present only when the list was trimmed. A shed result stays TRANSCRIPT_HINT_BYTES
 * under `maxChars` for this field, and the `unavailable` sentence's bytes more, so the answer, hint included, keeps
 * within `maxChars`.
 */
function transcriptHint(result: Pick<TranscriptResult, "truncated" | "subagentsTruncated">, unavailable?: string): string | undefined {
  const shed = !result.truncated ? undefined : result.subagentsTruncated ? `${TRUNCATED_HINT} ${SUBAGENTS_TRIMMED_HINT}` : TRUNCATED_HINT;
  return unavailable && shed ? `${unavailable} ${shed}` : unavailable || shed;
}

/** Why a `beforeTurn` past the last turn is refused, naming the range that is not. */
function beforeTurnRefusal(turnCount: number): string {
  if (turnCount === 0) return "This conversation has no started turn yet, so there is no turn to read before: leave beforeTurn out.";
  const valid = turnCount === 1 ? "2" : `between 2 and ${turnCount + 1}`;
  return `beforeTurn must be ${valid}: this conversation has ${turnCount} started turn${turnCount === 1 ? "" : "s"}.`;
}

interface TranscriptArgs { sessionId: string; turns: number; beforeTurn?: number; agentId?: string; include: ("reasoning" | "tools" | "activity")[]; maxChars: number }

/** The transcript as read_transcript has always answered it (the pre-catalog tool, moved here from `messages.ts`). */
async function readTranscriptRecord(api: DaemonApi, args: TranscriptArgs): Promise<Record<string, unknown>> {
  await requireChatSession(api, args.sessionId);
  const snap = await readThread(api, args.sessionId);
  const turnCount = startedTurns(snap.turns).length;
  if (args.beforeTurn !== undefined && args.beforeTurn > turnCount + 1) throw new ToolError("INVALID_ARGUMENT", beforeTurnRefusal(turnCount));
  // Turns older than the window come from the host's thread index; a page it cannot read is reported, never thrown.
  const range = transcriptRange(turnCount, args.turns, args.beforeTurn);
  const older = await readOlderHistory(api, args.sessionId, snap, range, args.agentId !== undefined ? { agentId: args.agentId } : {});
  const read = older.snapshot;
  // "" names no subagent: refused like any unknown id, never read as "the main view" (the schema refuses it first).
  // A subagent of an older turn is known by the rows a page brought back.
  if (args.agentId !== undefined && !read.roster.some((r) => r.id === args.agentId) && !read.items.some((i) => i.agentId === args.agentId)) {
    throw new ToolError("INVALID_ARGUMENT", `No subagent "${args.agentId}". Known: ${read.roster.map((r) => r.id).join(", ") || "none"}.`);
  }
  const unavailable = older.unavailable ? { turns: older.unavailable.turns, hint: unavailableHint(older.unavailable, range.end) } : undefined;
  const result = transcriptEntries(read, {
    turns: args.turns, ...(args.beforeTurn !== undefined ? { beforeTurn: args.beforeTurn } : {}), ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
    include: new Set(args.include), maxChars: args.maxChars, windowItems: snap.items, ...(unavailable ? { unavailable } : {})
  });
  const hint = transcriptHint(result, unavailable?.hint);
  return hint ? { ...result, hint } : { ...result };
}

const readTranscript = defineTool({
  name: "read_transcript",
  title: "Read the transcript",
  // A list cut to fit ends in one element of its own shape counting the rest (transcript.ts `cutRow`): a changedFiles
  // "…N more files" string, a files row {path: "…N more files", additions, deletions} with the rest's line totals, an
  // attachments row {name: "…N more attachments", type: "omitted"}. The description has to say so: it reads as data.
  description: "A session's turns, newest last: messages, tool calls, approvals, questions, plans, file changes, errors. A list cut to fit ends in a marker counting the rest (\"…12 more files\"), not an entry.",
  input: {
    sessionId: sessionIdField,
    turns: z.number().int().min(1).max(200).default(3).describe("Turns to read: the latest, or those before beforeTurn."),
    beforeTurn: z.number().int().min(2).optional().describe("Page back: the last result's olderTurns + 1."),
    agentId: z.string().min(1).optional().describe("A subagent id (get_session): its own timeline."),
    include: z.array(z.enum(["reasoning", "tools", "activity"])).default(["tools", "activity"]),
    maxChars: z.number().int().min(2_000).max(MAX_TRANSCRIPT_CHARS).default(40_000).describe("Result budget in bytes; over it rows are shed.")
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  scope: (args, ctx) => sessionClaim(ctx, args.sessionId, { reads: "content", writes: false, self: "allow" }),
  approval: (args, ctx) => sessionCard(ctx, args.sessionId, "read the transcript of", [{ label: "Turns", value: args.beforeTurn !== undefined ? `${args.turns} before turn ${args.beforeTurn}` : `the latest ${args.turns}` }]),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, caller }) {
    if (caller.kind !== "thread") return readTranscriptRecord(api, args);
    const { summary, sessions } = await sessionAmongTabs(api, args.sessionId);
    const frame = chatFrame(caller, sessions, summary);
    // The frame comes out of the caller's own budget, so the answer still keeps within maxChars.
    const record = await readTranscriptRecord(api, { ...args, maxChars: Math.max(2_000, args.maxChars - frame.bytes) });
    return { ...frame.before, ...record, ...frame.after };
  }
});

// ---------------------------------------------------------------------------
// get_turn_diff
// ---------------------------------------------------------------------------

/**
 * The room get_turn_diff's file list always has in the result, in JSON bytes, however big the diff: a turn that
 * regenerated thousands of files would otherwise leave the diff nothing, or push the result past the cap. A diff that
 * leaves more unused (a 400-file rename is almost all file list) gives the list that room instead.
 */
const MIN_DIFF_FILES_BYTES = 20_000;

/** A checkpoint's changed files: the head whose JSON fits `budget` bytes, and how many were left out. */
function fitFiles(files: readonly { path: string; additions: number; deletions: number }[], budget: number): { files: { path: string; additions: number; deletions: number }[]; omitted: number } {
  const kept: { path: string; additions: number; deletions: number }[] = [];
  let used = 2; // the brackets
  for (const f of files) {
    const row = { path: f.path, additions: f.additions, deletions: f.deletions };
    const cost = resultBytes(row) + (kept.length ? 1 : 0); // the separating comma
    if (used + cost > budget) break;
    used += cost;
    kept.push(row);
  }
  return { files: kept, omitted: files.length - kept.length };
}

/** A turn's diff within `budget` bytes of result (the pre-catalog get_turn_diff's answer at the full cap). */
async function turnDiff(api: DaemonApi, sessionId: string, turn: number | undefined, budget: number): Promise<Record<string, unknown>> {
  await requireChatSession(api, sessionId);
  const snap = await readThread(api, sessionId);
  // Checkpoints are keyed by turn ORDINAL and sparse (a non-git project captures nothing);
  // default to the latest turn that has one.
  const latestCheckpointed = snap.checkpoints.reduce((max, c) => Math.max(max, c.checkpointTurnCount), 0);
  const turnCount = turn ?? latestCheckpointed;
  if (turnCount < 1) throw new ToolError("INVALID_ARGUMENT", "This session has no checkpointed turn yet.");
  const res = expectOk<TurnDiffResponse>(await api.request("GET", agentChatRoutes.turnDiff(sessionId, turnCount), { query: { ignoreWhitespace: "1" } }));
  const files = snap.checkpoints.find((c) => c.checkpointTurnCount === turnCount)?.files ?? [];
  // The list gets its floor, or all the diff leaves unused of the result beside the frame — the frame counted with the
  // markers a cut list would carry.
  const frame = resultBytes({ turn: res.toTurnCount, fromTurn: res.fromTurnCount, files: [], filesTruncated: true, omittedFiles: files.length, diff: "", truncated: false });
  const listed = fitFiles(files, Math.max(MIN_DIFF_FILES_BYTES, budget - frame - jsonBytes(res.diff)));
  const result = { turn: res.toTurnCount, fromTurn: res.fromTurnCount, files: listed.files, ...(listed.omitted ? { filesTruncated: true, omittedFiles: listed.omitted } : {}), diff: "", truncated: false };
  // The diff gets whatever the rest of the result leaves of the result budget, so the whole
  // result survives `ok()` intact instead of being shed to a bare prefix.
  const diff = fitJsonBytes(res.diff, budget - resultBytes(result));
  return { ...result, diff: diff.text, truncated: diff.truncated };
}

const getTurnDiff = defineTool({
  name: "get_turn_diff",
  title: "Get a turn's diff",
  description: "Unified diff of the files a turn changed. Too large: cut at the end (truncated:true); a long file list too (filesTruncated, omittedFiles).",
  input: { sessionId: sessionIdField, turn: z.number().int().min(1).optional().describe("1-based; default: the latest checkpointed turn.") },
  audiences: ["external", "chat"],
  toolset: "chat-extras",
  tier: "read",
  scope: (args, ctx) => sessionClaim(ctx, args.sessionId, { reads: "content", writes: false, self: "allow" }),
  approval: (args, ctx) => sessionCard(ctx, args.sessionId, "read a turn's file changes in", [{ label: "Turn", value: args.turn !== undefined ? String(args.turn) : "the latest checkpointed" }]),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, caller }) {
    if (caller.kind !== "thread") return turnDiff(api, args.sessionId, args.turn, MAX_RESULT_BYTES);
    const { summary, sessions } = await sessionAmongTabs(api, args.sessionId);
    const frame = chatFrame(caller, sessions, summary);
    const diff = await turnDiff(api, args.sessionId, args.turn, MAX_RESULT_BYTES - frame.bytes);
    return { ...frame.before, ...diff, ...frame.after };
  }
});

// ---------------------------------------------------------------------------
// update_session
// ---------------------------------------------------------------------------

const OWN_CHILDREN_UPDATE = "update_session changes only this chat's own title, or the chats this chat created (create_session, fork_session).";

const updateSession = defineTool({
  name: "update_session",
  title: "Update session settings",
  description: "Change a chat's model, options, permission mode, account and/or title. Model/mode changes restart a live agent; refused mid-turn unless force. Account switch: idle session only; applies on the next message.",
  chatNote: "Only chats you created (incl. forks); never a broader mode than yours. This chat: title only.",
  input: {
    sessionId: sessionIdField,
    title: z.string().min(1).max(300).optional(),
    // min(1): an empty model would read as the session's current one, a silent no-op.
    model: z.string().min(1).optional().describe("From list_agents."),
    options: optionsSchema.optional(),
    runtimeMode: runtimeModeSchema.optional(),
    accountId: z.string().optional().describe("From list_agents, or \"system\"."),
    force: z.boolean().default(false).describe("Apply mid-turn, cutting the turn.")
  },
  audiences: ["external", "chat"],
  toolset: "chat-extras",
  tier: "act",
  async scope(args, ctx) {
    const { caller } = ctx;
    if (caller.kind === "thread") {
      const settings = args.model !== undefined || args.options !== undefined || args.runtimeMode !== undefined || args.accountId !== undefined;
      if (args.sessionId === caller.threadId && settings) {
        throw new ToolError("PERMISSION_DENIED", "A chat may change only its own title; ask the user to change its model, options, permission mode or account.");
      }
      // Never broader (§4.1): a chat it created may run in the caller's mode or a narrower one. A caller
      // mode the catalogue does not know allows none (fail closed: `runtimeModesUpTo` is empty for it).
      const allowed = runtimeModesUpTo(caller.runtimeMode);
      if (args.runtimeMode !== undefined && !allowed.includes(args.runtimeMode)) {
        throw new ToolError("PERMISSION_DENIED", `runtimeMode ${args.runtimeMode} is broader than this chat's ${caller.runtimeMode}; allowed: ${allowed.join(", ") || "none"}.`);
      }
    }
    return sessionClaim(ctx, args.sessionId, { reads: "none", writes: true, self: "title-only", ownChildrenOnly: OWN_CHILDREN_UPDATE });
  },
  approval: (args, ctx) =>
    sessionCard(ctx, args.sessionId, "change the settings of", [
      ...(args.title !== undefined ? [{ label: "Title", value: args.title }] : []),
      ...(args.model !== undefined ? [{ label: "Model", value: args.model }] : []),
      ...(args.options !== undefined ? [{ label: "Options", value: JSON.stringify(args.options) }] : []),
      ...(args.runtimeMode !== undefined ? [{ label: "Permission mode", value: args.runtimeMode }] : []),
      ...(args.accountId !== undefined ? [{ label: "Account", value: args.accountId }] : []),
      ...(args.force ? [{ label: "Force", value: "yes — cuts a running turn" }] : [])
    ]),
  annotations: MUTATING_IDEMPOTENT,
  resultKind: "json",
  async run(args, { api, caller }) {
    const summary = await requireChatSession(api, args.sessionId);
    const snap = await readThreadHead(api, args.sessionId);
    const current = snap.head.modelSelection;
    const wantsSelection = args.model !== undefined || args.options !== undefined;
    // Decided on the registry id first, then the thread's adapter — the GUI's `chatAccountSwitchSupported`.
    if (args.accountId !== undefined && (summary.refId === "opencode" || snap.head.adapter === "opencode")) {
      throw new ToolError("INVALID_ARGUMENT", "OpenCode runs one server per project under the daemon's own identity; it has no per-session account.");
    }
    // The catalogue only when something is checked against it, so a rename or a permission change never depends on
    // it. Legacy models included: a thread whose model has since gone legacy can still change its options.
    const agent = wantsSelection || args.accountId !== undefined ? findAgent(await loadAgents(api, { includeLegacyModels: true }), summary.refId) : null;
    const selection = agent && wantsSelection ? resolveModelSelection(agent, { model: args.model, options: args.options, current }) : undefined;
    const accountId = agent && args.accountId !== undefined ? validateAccountId(agent, args.accountId) : undefined;
    // What would actually change. One /mode body carries model, options and permission mode (atomic on the host).
    const mode: { runtimeMode?: RuntimeMode; modelSelection?: ModelSelection } = {};
    const modeFields: string[] = [];
    if (selection && !sameSelection(selection, current)) {
      // `instanceId` routes the provider instance, not the model: carried unchanged, as the composer does.
      mode.modelSelection = { ...(current.instanceId !== undefined ? { instanceId: current.instanceId } : {}), model: selection.model, options: selection.options };
      if (selection.model !== current.model) modeFields.push("model");
      if (args.options !== undefined || !modeFields.length) modeFields.push("options");
    }
    if (args.runtimeMode !== undefined && args.runtimeMode !== snap.head.runtimeMode) {
      mode.runtimeMode = args.runtimeMode;
      modeFields.push("runtimeMode");
    }
    // Only a real change restarts the agent, so only a real change is refused mid-turn: a field that already holds its
    // value is skipped below and cuts nothing.
    if (modeFields.length && isTurnActive(summary, snap) && !args.force) {
      // Under a continuing goal the next turn starts as this one ends (goals §4.7): waiting never helps, and a
      // `/goal pause` alone lets this turn run to its end — an interrupt pauses the goal and stops the turn. A goal
      // an Orquester update holds (§5.7) starts no next turn here: waiting does help.
      throw new ToolError("SESSION_BUSY", goalContinuing(summary, snap) && !goalHeldForUpdate(summary, snap)
        ? "A goal turn is running, and the goal starts the next one by itself; changing the model or permission mode restarts the agent and would cut it. control_session {action: \"interrupt\"} pauses the goal and stops the turn — or pass force:true."
        : "A turn is running; changing the model or permission mode restarts the agent and would cut it. Wait, control_session {action: \"interrupt\"}, or pass force:true.");
    }
    // The tab record spells the system identity as an absent id; the wire spells it "system".
    const switchAccount = accountId !== undefined && accountId !== (summary.accountId || SYSTEM_ACCOUNT_ID);
    if (switchAccount) {
      const refusal = switchRefusal(summary, snap);
      if (refusal) throw new ToolError("SESSION_BUSY", refusal);
    }
    // Every check has run. Writes in order; `applied` records only what landed, and rides a mid-way failure's detail.
    const applied: string[] = [];
    try {
      if (args.title !== undefined && args.title !== summary.title) {
        expectOk(await api.request("PUT", `/api/sessions/${encodeURIComponent(args.sessionId)}`, { body: { title: args.title } }));
        applied.push("title");
      }
      if (modeFields.length) {
        await sendCommand(api, args.sessionId, "mode", mode);
        applied.push(...modeFields);
      }
      if (switchAccount) {
        await sendCommand(api, args.sessionId, "account", { accountId });
        applied.push("accountId");
      }
    } catch (error) {
      if (error instanceof ToolError) throw new ToolError(error.code, error.message, { applied, ...(error.detail !== undefined ? { cause: error.detail } : {}) });
      throw error;
    }
    const session = await chatDetail(api, args.sessionId);
    // The detail carries the target's words (its last reply, plan, requests): another chat's are marked as data (§4.3).
    return { ...chatNotice(caller, args.sessionId), applied, session, ...(caller.kind === "thread" ? chatThreadRef(caller, await listSessions(api), { ...summary, title: session.title }) : {}) };
  }
});

// ---------------------------------------------------------------------------
// control_session
// ---------------------------------------------------------------------------

/** How long a rewind waits for the host to finish the rewind it accepted. */
const REWIND_WAIT_MS = 10_000;
/**
 * How long that wait goes without reading the thread again when no bus event about the session wakes it first: a
 * rewind's failure row moves nothing on the session's summary, so no event may ever announce it.
 */
const REWIND_RECHECK_MS = 1_000;
/** What §5.5 step 6 appends, as an `error` activity, for any rewind that failed (orchestrator.ts `revertEffect`). */
const REVERT_FAILED_ACTIVITY_KIND = "checkpoint.revert.failed";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function isRevertFailure(item: ThreadItem): item is ThreadActivityItem {
  return item.kind === "activity" && item.activityKind === REVERT_FAILED_ACTIVITY_KIND;
}

/** Where a turn begins among the thread's rows: its user message, else its first row; -1 when none is left. */
function turnOpening(items: readonly ThreadItem[], turn: StartedTurn): number {
  const byMessage = turn.userMessageId === undefined ? -1 : items.findIndex((item) => item.id === turn.userMessageId);
  return byMessage !== -1 ? byMessage : items.findIndex((item) => item.turnId === turn.turnId);
}

/**
 * The fewest turns a rewind may keep. The provider holds nothing from before the thread's LAST settled compaction, so
 * the GUI withholds "rewind to here" on every message before it (rows.logic.ts `buildRevertTurnCountByUserMessageId`,
 * and a history page's `rewindable`), and the adapter would refuse the rollback. Which row is that marker is the rule
 * in @orquester/api `compaction.ts`, which this tool and the thread index call as `isSettledConversationCompaction` and
 * the GUI's window gate composes from the same parts over its parent timeline: a `context-compaction` row or the legacy
 * `thread.state.changed {state: "compacted"}`, settled (an unreadable state is), and not a subagent's own (a non-blank
 * `agentId` on the row or on its payload). Turns are in start order, so the first one that begins after the marker
 * is the earliest a rewind may cut at. 0 when nothing was compacted; the started-turn count when no turn began after
 * it.
 *
 * "Before" and "after" are positions in `snap.items`, the fold's append order, where the GUI sorts its timeline by
 * `createdAt` (entries.logic.ts). For a real log the two agree: the fold appends each row when its event lands in the
 * host's append-only log, and the host stamps the row then; a row updated later keeps both its place and its stamp.
 * A turn with no row left in the window is placed by its own start instead: retention evicts rows but never a turn
 * record and never the marker, so on a long thread an early marker outlives the rows of every turn between it and the
 * window — turns the host rewinds to, and the GUI offers from its history pages.
 */
function fewestKeptTurns(snap: ThreadSnapshotPayload): number {
  let marker = -1;
  for (let i = snap.items.length - 1; i >= 0 && marker === -1; i -= 1) if (isSettledConversationCompaction(snap.items[i]!)) marker = i;
  if (marker === -1) return 0;
  const markedAt = snap.items[marker]!.createdAt;
  const started = startedTurns(snap.turns);
  const first = started.findIndex((turn) => {
    const opening = turnOpening(snap.items, turn);
    return opening !== -1 ? opening > marker : (turn.startedAt ?? turn.requestedAt) > markedAt;
  });
  return first === -1 ? started.length : first;
}

/** send_message's refusal (messages.ts `readyToSend`), worded for a rewind: the agent is waiting on the caller. */
function pendingRefusal(snap: ThreadSnapshotPayload): ToolError | null {
  const { approvals, userInputs } = snap.pending;
  if (!approvals.length && !userInputs.length) return null;
  const open = [
    ...approvals.map((a) => `approval ${a.requestId} (respond_to_request with decision)`),
    ...userInputs.map((q) => `question ${q.requestId} (respond_to_request with answers${q.dismissible ? " or dismiss" : ""})`)
  ];
  return new ToolError("PENDING_REQUEST", `Resolve the agent's open request before rewinding: it is waiting on ${open.join(" and ")}. get_session shows the details.`, { approvals: approvals.map((a) => a.requestId), questions: userInputs.map((q) => q.requestId) });
}

/** A rewind's failure row as the tool's answer: its summary and the host's reason (`payload.detail`), as the GUI shows them. */
function rewindFailed(row: ThreadActivityItem, seq: number): ToolError {
  const reason = isRecord(row.payload) && typeof row.payload.detail === "string" ? row.payload.detail.trim() : "";
  const summary = row.summary.trim() || "Rewind failed";
  return new ToolError("COMMAND_REJECTED", reason ? `${summary}: ${reason}` : `${summary}.`, { seq, activityId: row.id, ...(reason ? { reason } : {}) });
}

/**
 * The host answers `/revert` with `{seq}` long before the rollback runs: that is an effect (orchestrator.ts
 * `revertEffect`), and an adapter's refusal leaves only a `checkpoint.revert.failed` row. So, as the GUI does
 * (`waitForRewind`), the outcome is read off the thread: the rewind landed once at most `keepTurns` turns are started,
 * or the first dropped one is gone (a turn sent right after the rewind cannot hide it); it failed on a failure row that
 * was not there before the POST. The thread is read again on every bus event about the session, else every
 * REWIND_RECHECK_MS — never a fixed sleep — until REWIND_WAIT_MS; a closed request ends the wait at once. The bus
 * listener, the timer and the abort listener are always removed.
 */
async function awaitRewind(ctx: Pick<CallContext, "api" | "signal" | "now">, sessionId: string, target: { keepTurns: number; firstDroppedTurnId: string; seq: number }, knownFailures: ReadonlySet<string>): Promise<void> {
  // Elapsed time as wait.ts counts it: the larger of the caller's clock and the monotonic one.
  const startedAt = ctx.now();
  const startedMono = performance.now();
  const remaining = () => REWIND_WAIT_MS - Math.max(ctx.now() - startedAt, performance.now() - startedMono);
  // A retry would take a late failure row of THIS rewind for its own (the row names no command), and get_session shows
  // no failure: so the text says how to tell the outcome instead.
  const inProgress = () => new ToolError("SESSION_BUSY", `The rewind is still in progress — do not rewind again. It has landed once get_session's chat.turnCount comes down to keepTurns (${target.keepTurns}); if it failed, read_transcript shows a "Rewind failed" error.`, { seq: target.seq });
  let events = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const off = ctx.api.subscribe((event) => {
    if (event.channel !== "sessions" || (event.payload as { id?: unknown } | null)?.id !== sessionId) return;
    events += 1;
    if (event.type === "session.closed") closed = true;
    const w = wake;
    wake = null;
    w?.();
  });
  try {
    for (;;) {
      if (closed) throw new ToolError("SESSION_NOT_FOUND", `Session "${sessionId}" was closed while rewinding.`, { seq: target.seq });
      if (ctx.signal.aborted) throw inProgress();
      const seen = events;
      const snap = await readThread(ctx.api, sessionId);
      const started = startedTurns(snap.turns);
      if (started.length <= target.keepTurns || !started.some((turn) => turn.turnId === target.firstDroppedTurnId)) return;
      const failure = snap.items.find((item): item is ThreadActivityItem => isRevertFailure(item) && !knownFailures.has(item.id));
      if (failure) throw rewindFailed(failure, target.seq);
      const left = remaining();
      if (left <= 0 || ctx.signal.aborted) throw inProgress();
      // Nothing about the session moved during that read: wait until something does, or look again shortly.
      if (events === seen) {
        await new Promise<void>((resolve) => {
          const resume = () => { clearTimeout(timer); ctx.signal.removeEventListener("abort", resume); wake = null; resolve(); };
          const timer = setTimeout(resume, Math.min(left, REWIND_RECHECK_MS));
          ctx.signal.addEventListener("abort", resume, { once: true });
          wake = resume;
        });
      }
    }
  } finally {
    off();
  }
}

/** The GUI's "Rewind to here" (the pre-catalog revert_session). */
async function rewind(ctx: CallContext, sessionId: string, keepTurns: number): Promise<Record<string, unknown>> {
  const { api } = ctx;
  const summary = await requireChatSession(api, sessionId);
  const snap = await readThread(api, sessionId);
  const agent = findAgent(await loadAgents(api), summary.refId);
  if (!agent.supports.rollback) throw new ToolError("INVALID_ARGUMENT", `${summary.refId} does not support conversation rollback.`);
  const started = startedTurns(snap.turns); // turns are counted by START ORDER (turns.ts), never by checkpoints
  if (started.length === 0) throw new ToolError("INVALID_ARGUMENT", "This conversation has no turns to rewind.");
  if (keepTurns >= started.length) throw new ToolError("INVALID_ARGUMENT", `keepTurns must be between 0 and ${started.length - 1}: this conversation has ${started.length} started turn${started.length === 1 ? "" : "s"}.`);
  const fewest = fewestKeptTurns(snap);
  if (keepTurns < fewest) {
    const why = "Cannot rewind past the last context compaction — the agent no longer holds what came before it";
    throw new ToolError("INVALID_ARGUMENT", fewest < started.length ? `${why}. keepTurns must be between ${fewest} and ${started.length - 1}.` : `${why}, and it happened in the latest turn: there is no turn to rewind to.`);
  }
  if (isTurnActive(summary, snap)) throw new ToolError("SESSION_BUSY", "Stop the current turn before rewinding.");
  const pending = pendingRefusal(snap);
  if (pending) throw pending;
  // Only a failure row that appears after the POST answers this rewind.
  const knownFailures = new Set(snap.items.filter(isRevertFailure).map((item) => item.id));
  const { seq } = await sendCommand(api, sessionId, "revert", { targetTurnCount: keepTurns });
  try {
    await awaitRewind(ctx, sessionId, { keepTurns, firstDroppedTurnId: started[keepTurns]!.turnId, seq }, knownFailures);
    return { seq, session: await chatDetail(api, sessionId) };
  } catch (error) {
    // The host accepted the command: whatever fails after it — a thread read in the wait, the detail read after it —
    // keeps its code and safe message (a thrown one is logged, never echoed) and gains the command's seq.
    const failure = toSafeToolError(error).structuredContent;
    throw new ToolError(failure.code, failure.message, { ...detailFields(failure.detail), seq });
  }
}

const CONTROL_ACTIONS = ["interrupt", "stop_task", "stop_process", "compact", "rewind", "close"] as const;
type ControlAction = (typeof CONTROL_ACTIONS)[number];
/** Spec §4.1: these act only on the caller's own children (lineage parent + `agentCreated`, §13 c). */
const OWN_CHILD_ACTIONS: ReadonlySet<ControlAction> = new Set(["stop_process", "compact", "rewind", "close"]);
/** These change the conversation or the tab (refused while planning); interrupt and stops only stop work. */
const DATA_ACTIONS: ReadonlySet<ControlAction> = new Set(["compact", "rewind", "close"]);
const ACTION_VERBS: Readonly<Record<ControlAction, string>> = {
  interrupt: "interrupt",
  stop_task: "stop a background task of",
  stop_process: "stop the agent process of",
  compact: "compact the context of",
  rewind: "rewind",
  close: "close"
};

/** `taskId` belongs to stop_task, `keepTurns` to rewind, and each needs its own. */
function controlArgsProblem(args: { action: ControlAction; taskId?: string; keepTurns?: number }): string | null {
  if (args.action === "stop_task" && args.taskId === undefined) return "stop_task needs taskId (a subagents[].id from get_session).";
  if (args.action === "rewind" && args.keepTurns === undefined) return "rewind needs keepTurns.";
  if (args.taskId !== undefined && args.action !== "stop_task") return "taskId is for action stop_task only.";
  if (args.keepTurns !== undefined && args.action !== "rewind") return "keepTurns is for action rewind only.";
  return null;
}

const controlSession = defineTool({
  name: "control_session",
  title: "Control a session",
  description:
    "interrupt: stop the turn (none running: background work; pauses a goal). stop_task: one background task (taskId: get_session subagents[].id). " +
    "stop_process: stop the agent, keep the tab. compact: the context. rewind: keep the first keepTurns turns (conversation only). close: the tab.",
  chatNote: "Not this chat. Beyond interrupt/stop_task: only chats you created.",
  input: {
    sessionId: sessionIdField,
    action: z.enum(CONTROL_ACTIONS),
    taskId: z.string().min(1).optional(),
    keepTurns: z.number().int().min(0).optional()
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "act",
  async scope(args, ctx) {
    const problem = controlArgsProblem(args);
    if (problem) throw new ToolError("INVALID_ARGUMENT", problem);
    return sessionClaim(ctx, args.sessionId, {
      reads: "none",
      writes: DATA_ACTIONS.has(args.action),
      self: "refuse",
      ...(OWN_CHILD_ACTIONS.has(args.action) ? { ownChildrenOnly: `control_session ${args.action} acts only on chats this chat created (create_session, fork_session).` } : {})
    });
  },
  approval: (args, ctx) =>
    sessionCard(ctx, args.sessionId, ACTION_VERBS[args.action], [
      ...(args.taskId !== undefined ? [{ label: "Task", value: args.taskId }] : []),
      ...(args.keepTurns !== undefined ? [{ label: "Turns kept", value: String(args.keepTurns) }] : [])
    ]),
  // close and rewind discard, and an interrupt retried goes on to stop background work: the most dangerous action names the hints.
  annotations: { ...DESTRUCTIVE, idempotentHint: false },
  resultKind: "json",
  async run(args, ctx) {
    const { api, caller } = ctx;
    const problem = controlArgsProblem(args);
    if (problem) throw new ToolError("INVALID_ARGUMENT", problem);
    // The link is read before acting: a closed tab is gone after.
    const target = caller.kind === "thread" ? await sessionAmongTabs(api, args.sessionId) : null;
    const result = await control(ctx, args);
    if (!target) return result;
    // A detail carries the target's words (its last reply, plan, requests): marked as another chat's data (§4.3).
    return { ...("session" in result ? chatNotice(caller, args.sessionId) : {}), ...result, ...chatThreadRef(caller, target.sessions, target.summary) };
  }
});

async function control(ctx: CallContext, args: { sessionId: string; action: ControlAction; taskId?: string; keepTurns?: number }): Promise<Record<string, unknown>> {
  const { api } = ctx;
  switch (args.action) {
    case "interrupt": {
      await requireChatSession(api, args.sessionId);
      const { head } = await readThreadHead(api, args.sessionId);
      // Name the turn only while the session runs one — read from the same head as the turn id.
      const { status, activeTurnId } = head.session;
      const turnId = status === "running" ? activeTurnId : null;
      const { seq } = await sendCommand(api, args.sessionId, "interrupt", turnId ? { turnId } : {});
      return { seq, session: await chatDetail(api, args.sessionId) };
    }
    case "stop_task": {
      await requireChatSession(api, args.sessionId);
      const { seq } = await sendCommand(api, args.sessionId, "task/stop", { taskId: args.taskId! });
      return { seq, session: await chatDetail(api, args.sessionId) };
    }
    case "stop_process": {
      await requireChatSession(api, args.sessionId);
      const { seq } = await sendCommand(api, args.sessionId, "session/stop", {});
      return { seq, session: await chatDetail(api, args.sessionId) };
    }
    case "compact": {
      await requireChatSession(api, args.sessionId);
      const { seq } = await sendCommand(api, args.sessionId, "compact", {});
      return { seq, session: await chatDetail(api, args.sessionId) };
    }
    case "rewind":
      return rewind(ctx, args.sessionId, args.keepTurns!);
    case "close": {
      await findSession(api, args.sessionId);
      expectOk(await api.request("DELETE", `/api/sessions/${encodeURIComponent(args.sessionId)}`));
      return { closed: true, sessionId: args.sessionId };
    }
  }
}

/** This family in the catalog (`../catalog/index.ts`), in catalog order. */
export const sessionsFamily: readonly AnyOrquesterTool[] = [
  listSessionsTool,
  getSession,
  readTranscript,
  getTurnDiff,
  updateSession,
  controlSession
];
