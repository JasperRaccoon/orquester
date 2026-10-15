// Catalog family module `watch` (Waiting: wait_for_session) — plan Task 8 (unified MCP, Wave 3).
//
// `wait_for_session` (spec §4 row 14, §8.1, §13 a, §13 d) for both audiences, plus the helpers the
// conversation family shares (content rights, a session-addressed scope claim, the chat result
// frame): `messages.ts` and `lineage.ts` import them from here, never the other way round
// (`sessions.ts` imports this module for `byAttention`).
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { ApprovalPreviewSection, SessionSummary } from "@orquester/api";
import { RUNTIME_MODES, threadToolReference, UNTRUSTED_NOTICE, type RuntimeMode, type ThreadToolReference, type ThreadToolRelation } from "@orquester/api/agent-chat";
import { canonicalProject, resolveProject, type CanonicalProject } from "../addressing.ts";
import { ToolError } from "../errors.ts";
import { findSession, listSessions } from "../reads.ts";
import { clipText, MAX_ECHO_CHARS } from "../result.ts";
import { buildViewContext, sessionView, type SessionView } from "../views.ts";
import { readWorkReport, waitForAttention, waitWhileWorking, type WatchScope, type WorkReport } from "../wait.ts";
import { registerWait } from "../../agent-chat/waits.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ApprovalPreview, type ScopeClaim, type ScopeContext, type ThreadCaller, type ToolCaller } from "../catalog/contract.ts";

const instant = (stamp: string | null | undefined): number => Date.parse(stamp ?? "");
const createdAt = (s: SessionSummary): number => { const t = instant(s.createdAt); return Number.isNaN(t) ? 0 : t; };
/** When a session called for attention; one with no parseable stamp counts from its tab's creation, as the GUI's `flaggedAt`. */
const flaggedAt = (s: SessionSummary): number => { const t = instant(s.activity?.needsAttentionAt); return Number.isNaN(t) ? createdAt(s) : t; };

/**
 * THE Attention Center order, for every tool that lists flagged sessions (wait_for_session, list_sessions
 * `attention: true`): newest attention first, by the instant — never by the string, which puts an offset stamp out of
 * place — and a tie to the newer tab.
 */
export function byAttention(a: SessionSummary, b: SessionSummary): number {
  return flaggedAt(b) - flaggedAt(a) || createdAt(b) - createdAt(a);
}

// ---------------------------------------------------------------------------
// Shared by the conversation family (messages.ts, lineage.ts, watch.ts)
// ---------------------------------------------------------------------------

/** A permission mode's breadth; an unknown one is the narrowest (fail closed). */
const breadth = (mode: RuntimeMode): number => RUNTIME_MODES.indexOf(mode);

/** The hint beside content left out for want of content rights (§13 a): where the boundary card is raised. */
export const CONTENT_OMITTED_HINT = "read_transcript asks for content access";

/**
 * Whether a chat caller may read the CONTENT of a target project without a card (§5.2, §13 a): its
 * own project always; another project of its workspace from `auto`; any other project — and every
 * project when the caller has none — only in `full-access`. A target in no project never is. The
 * caller itself always is.
 */
export function hasContentRights(caller: ThreadCaller, project: CanonicalProject | null, self = false): boolean {
  if (self) return true;
  if (project === null) return false;
  if (caller.projectPath !== "" && project.canonical === caller.projectPath) return true;
  const sameWorkspace = caller.projectPath !== "" && caller.workspace !== "" && project.workspace === caller.workspace;
  return breadth(caller.runtimeMode) >= breadth(sameWorkspace ? "auto" : "full-access");
}

/** The calling chat, or null for an external caller. */
export const threadCaller = (caller: ToolCaller): ThreadCaller | null => (caller.kind === "thread" ? caller : null);

/**
 * The scope claim of a call naming one session (§5.1): the session and — for a chat caller — its
 * canonical project, which the gate classifies (the caller itself is its own project: no project
 * claimed). A session in no project is refused to chat callers. External callers claim the session
 * only (full trust; the tool validates the address itself).
 */
export async function sessionClaim(ctx: ScopeContext, sessionId: string, claim: Omit<ScopeClaim, "projects" | "sessions">): Promise<ScopeClaim> {
  const base: ScopeClaim = { projects: [], sessions: [sessionId], ...claim };
  const caller = threadCaller(ctx.caller);
  if (caller === null || sessionId === caller.threadId) return base;
  const summary = await findSession(ctx.api, sessionId);
  const project = await canonicalProject(ctx.api, summary.projectPath);
  if (project === null) throw new ToolError("PERMISSION_DENIED", `Session "${clipText(sessionId, MAX_ECHO_CHARS)}" belongs to no project; chat tools reach only sessions inside a project.`);
  return { ...base, projects: [project.canonical] };
}

/** `notice` (§4.3): a chat caller reading another chat's words is told they are data, first thing in the result. */
export function chatNotice(caller: ToolCaller, sessionId: string): { notice?: string } {
  return caller.kind === "thread" && sessionId !== caller.threadId ? { notice: UNTRUSTED_NOTICE } : {};
}

/** How a session relates to the calling chat, for its tool row's link. */
export function relationTo(callerId: string, sessions: readonly SessionSummary[], target: Pick<SessionSummary, "id" | "lineage">): ThreadToolRelation {
  if (target.lineage?.parentThreadId === callerId) return target.lineage.relation;
  if (sessions.find((s) => s.id === callerId)?.lineage?.parentThreadId === target.id) return "parent";
  return "thread";
}

/** `threadRef` (§4.3): the session a chat caller's result names, for its tool row. External results carry none. */
export function chatThreadRef(caller: ToolCaller, sessions: readonly SessionSummary[], target: Pick<SessionSummary, "id" | "title" | "lineage">, relation?: ThreadToolRelation): { threadRef?: ThreadToolReference } {
  if (caller.kind !== "thread") return {};
  return { threadRef: threadToolReference(target.id, target.title, relation ?? relationTo(caller.threadId, sessions, target)) };
}

/** A work report without another chat's words (§13 a): state and turn numbers stay. */
function reportWithoutContent(report: WorkReport): Record<string, unknown> {
  const { reply: _reply, replyTruncated: _cut, emptyReply: _empty, hint: _hint, error: _error, ...rest } = report;
  return { ...rest, contentOmitted: true, hint: CONTENT_OMITTED_HINT };
}

/** An attention row without the words it may carry (a goal's objective, §13 a). */
function viewWithoutContent(view: SessionView): Record<string, unknown> {
  if (!view.chat?.goal) return { ...view, contentOmitted: true };
  const { objective: _objective, ...goal } = view.chat.goal;
  return { ...view, chat: { ...view.chat, goal }, contentOmitted: true };
}

const AGENT_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };
/** The calling chat's agent, as a card's title names it. */
export const agentLabel = (caller: ThreadCaller): string => AGENT_LABELS[caller.agentId] ?? caller.agentId;

/** A boundary card's content for a session-addressed conversation call (§7.1): composed from structured data, never the raw arguments. */
export async function sessionCard(ctx: ScopeContext, sessionId: string, action: string, rows: { label: string; value: string }[], text: string | undefined): Promise<ApprovalPreview> {
  const caller = threadCaller(ctx.caller);
  const sessions = await listSessions(ctx.api);
  const summary = sessions.find((s) => s.id === sessionId);
  const project = summary ? await canonicalProject(ctx.api, summary.projectPath) : null;
  const where = project ? `${project.workspace}/${project.name}` : "another project";
  const title = clipText((summary?.title ?? sessionId).replace(/\s+/g, " ").trim(), 80);
  const sections: ApprovalPreviewSection[] = [
    { kind: "fields", title: "Request", rows: [{ label: "Action", value: action }, { label: "Session", value: `${summary?.title ?? sessionId} · ${sessionId}` }, { label: "Project", value: where }, ...rows] }
  ];
  if (text !== undefined) sections.push({ kind: "text", title: "Message", text });
  return { title: `${caller ? agentLabel(caller) : "An agent"} wants to ${action} the chat "${title}" in ${where}`, scopeLabel: `Project ${where}`, sections };
}

// ---------------------------------------------------------------------------
// wait_for_session (spec §4 row 14, §8.1)
// ---------------------------------------------------------------------------

const MAX_WAIT_SECONDS = 600;
const MAX_WAIT_SESSIONS = 20;

interface WaitArgs {
  sessionId?: string;
  sessionIds?: string[];
  project?: string;
  after?: string;
  timeoutSeconds: number;
}

/** The sessions a wait names: `sessionIds`, or `sessionId` alone. */
const waitTargets = (args: WaitArgs): string[] => [...new Set(args.sessionIds ?? (args.sessionId !== undefined ? [args.sessionId] : []))];

/** One of `sessionId`, `sessionIds`, `project`; `after` an instant — checked before any lookup. */
function checkWaitArgs(args: WaitArgs): void {
  const given = [args.sessionId, args.sessionIds, args.project].filter((value) => value !== undefined).length;
  if (given > 1) throw new ToolError("INVALID_ARGUMENT", "Pass one of sessionId, sessionIds or project.");
  if (args.after !== undefined && Number.isNaN(Date.parse(args.after))) throw new ToolError("INVALID_ARGUMENT", "`after` must be an ISO-8601 timestamp.");
}

/**
 * A chat waiting on chats it names, with no `after`: until one of them is not working — at once
 * if one already is — registered in the wait registry (`WAIT_CYCLE` across projects, §8.6); each
 * row carries its state and final reply, the reply only with content rights (§13 a, §13 d).
 */
async function settleWait(caller: ThreadCaller, ctx: ScopeContext, targets: string[], timeoutMs: number, single: boolean): Promise<Record<string, unknown>> {
  const releases: (() => void)[] = [];
  try {
    for (const target of targets) releases.push(registerWait(caller.threadId, target));
    const waited = await waitWhileWorking(ctx.api, targets, { timeoutMs, signal: ctx.signal, now: ctx.now });
    if (waited.cancelled) throw new ToolError("CANCELLED", "The wait was cancelled.");
    const sessions = await listSessions(ctx.api);
    let words = false;
    const rows: Record<string, unknown>[] = [];
    for (const id of targets) {
      const report = waited.reports.get(id) ?? null;
      const summary = sessions.find((s) => s.id === id);
      if (report === null || summary === undefined) {
        rows.push({ sessionId: id, state: "closed" });
        continue;
      }
      const readable = hasContentRights(caller, await canonicalProject(ctx.api, summary.projectPath));
      if (readable && (report.reply !== undefined || report.error !== undefined)) words = true;
      rows.push({ ...(readable ? report : reportWithoutContent(report)), ...chatThreadRef(caller, sessions, summary) });
    }
    const notice = words ? { notice: UNTRUSTED_NOTICE } : {};
    return single ? { ...notice, ...rows[0], timedOut: waited.timedOut } : { ...notice, sessions: rows, timedOut: waited.timedOut };
  } finally {
    for (const release of releases) release();
  }
}

/**
 * The attention wait (both audiences; the external one's semantics): until a session the scope
 * selects calls for attention after `after`. Chat rows lacking content rights lose their words; a
 * single session's result adds its state and latest reply.
 */
async function attentionWait(args: WaitArgs, ctx: ScopeContext, after: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const { api } = ctx;
  const caller = threadCaller(ctx.caller);
  const targets = waitTargets(args);
  let scope: WatchScope = { select: () => true };
  if (args.sessionId !== undefined) {
    scope = { sessionId: (await findSession(api, args.sessionId)).id };
  } else if (targets.length > 0) {
    const listed = new Set((await listSessions(api)).map((s) => s.id));
    const missing = targets.find((id) => !listed.has(id));
    if (missing !== undefined) throw new ToolError("SESSION_NOT_FOUND", `No session with id "${clipText(missing, MAX_ECHO_CHARS)}". Use list_sessions.`);
    const wanted = new Set(targets);
    scope = { select: (s) => wanted.has(s.id) };
  } else if (args.project !== undefined) {
    const path = (await resolveProject(api, args.project)).path;
    scope = { select: (s) => s.projectPath === path };
  } else if (caller !== null) {
    // A chat's default: its own project.
    if (caller.projectPath === "") throw new ToolError("INVALID_ARGUMENT", "This chat belongs to no project: name sessionId, sessionIds or project.");
    const own = caller.projectPath;
    scope = { select: (s) => s.projectPath === own || resolvePath(s.projectPath) === own };
  }
  const r = await waitForAttention(api, { ...scope, after, timeoutMs, signal: ctx.signal, now: ctx.now });
  const view = await buildViewContext(api);
  // Newest attention first, as the Attention Center lists its flagged rows.
  const flagged = [...r.sessions].sort(byAttention);
  const rights = new Map<string, boolean>();
  const readable = async (s: SessionSummary): Promise<boolean> => {
    if (caller === null) return true;
    if (!rights.has(s.projectPath)) rights.set(s.projectPath, hasContentRights(caller, await canonicalProject(api, s.projectPath)));
    return s.id === caller.threadId || rights.get(s.projectPath) === true;
  };
  const rows: Record<string, unknown>[] = [];
  let words = false;
  for (const s of flagged) {
    const row = sessionView(s, view);
    const ok = await readable(s);
    if (ok && caller !== null && s.id !== caller.threadId && row.chat?.goal) words = true;
    rows.push(ok ? { ...row } : viewWithoutContent(row));
  }
  const result: Record<string, unknown> = { sessions: rows, cursor: r.cursor, timedOut: r.timedOut };
  if (args.sessionId !== undefined) {
    // The one session's state and latest reply (content, §13 a).
    const report = await readWorkReport(api, args.sessionId);
    if (report !== null) {
      const summary = (await listSessions(api)).find((s) => s.id === args.sessionId);
      const ok = summary === undefined ? false : await readable(summary);
      if (ok && caller !== null && report.reply !== undefined) words = true;
      Object.assign(result, { state: report.state, ...(ok ? pickWords(report) : { contentOmitted: true, hint: CONTENT_OMITTED_HINT }) });
    }
  }
  return words ? { notice: UNTRUSTED_NOTICE, ...result } : result;
}

/** A report's turn and words, for a single-session attention result. */
function pickWords(report: WorkReport): Record<string, unknown> {
  const { lastTurn, reply, replyTruncated, emptyReply, hint, error } = report;
  return { ...(lastTurn ? { lastTurn } : {}), ...(reply !== undefined ? { reply } : {}), ...(replyTruncated ? { replyTruncated } : {}), ...(emptyReply ? { emptyReply, hint } : {}), ...(error !== undefined ? { error } : {}) };
}

const sessionIdField = z.string().min(1);

export const waitForSessionTool = defineTool({
  name: "wait_for_session",
  title: "Wait for a session",
  description:
    "Block until a session (sessionId, any of sessionIds, a project's, or any) needs attention — a question, approval, plan, finished turn or error — after `after` (default now); pass the result's `cursor` back as `after`. Never poll. One session's result adds its `state` and latest `reply`.",
  chatNote: "Without `after`, sessionId(s) return once one is not working (at once if one already is) with its final reply. Default: this chat's project.",
  input: {
    sessionId: sessionIdField.optional(),
    sessionIds: z.array(sessionIdField).min(1).max(MAX_WAIT_SESSIONS).optional(),
    project: z.string().optional().describe("Path or \"workspace/project\"."),
    after: z.string().optional().describe("ISO time: the last result's cursor."),
    timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(120)
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  async scope(args, ctx) {
    checkWaitArgs(args);
    const targets = waitTargets(args);
    const base: ScopeClaim = { projects: [], sessions: targets, reads: "metadata", writes: false, causesTurnIn: [] };
    const caller = threadCaller(ctx.caller);
    if (caller === null) return base;
    const projects: string[] = [];
    for (const target of targets) {
      if (target === caller.threadId) continue;
      for (const project of (await sessionClaim(ctx, target, { reads: "metadata", writes: false, causesTurnIn: [] })).projects) {
        if (!projects.includes(project)) projects.push(project);
      }
    }
    if (args.project !== undefined) {
      const ref = await resolveProject(ctx.api, args.project);
      const project = await canonicalProject(ctx.api, ref.path);
      if (project === null) throw new ToolError("PROJECT_NOT_FOUND", `No project at "${clipText(args.project, MAX_ECHO_CHARS)}". Use list_projects.`);
      projects.push(project.canonical);
    }
    return { ...base, projects, self: "refuse" };
  },
  async approval(args, ctx) {
    const targets = waitTargets(args);
    const rows = [{ label: "Timeout", value: `${args.timeoutSeconds} s` }];
    if (targets.length === 1) return sessionCard(ctx, targets[0]!, "wait on", rows, undefined);
    const caller = threadCaller(ctx.caller);
    const where = args.project ?? targets.join(", ");
    const sections: ApprovalPreviewSection[] = [{ kind: "fields", title: "Request", rows: [{ label: "Action", value: "wait on the status of" }, { label: args.project !== undefined ? "Project" : "Sessions", value: where }, ...rows] }];
    return { title: `${caller ? agentLabel(caller) : "An agent"} wants to wait on chats in another project`, scopeLabel: "Another project", sections };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, ctx) {
    checkWaitArgs(args);
    const after = args.after ?? new Date(ctx.now()).toISOString();
    const timeoutMs = args.timeoutSeconds * 1000;
    const caller = threadCaller(ctx.caller);
    const targets = waitTargets(args);
    if (caller !== null && targets.length > 0 && args.after === undefined) return settleWait(caller, ctx, targets, timeoutMs, args.sessionIds === undefined);
    return attentionWait(args, ctx, after, timeoutMs);
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const watchFamily: readonly AnyOrquesterTool[] = [waitForSessionTool];
