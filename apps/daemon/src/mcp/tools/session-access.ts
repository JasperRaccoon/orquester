// The session-addressed families' shared helpers (unified MCP design 2026-10-15 §4.3, §5.1, §5.2, §7.1, §13 a):
// the scope claim of a call naming one session, content rights, the chat result frame (`notice`, `threadRef`), the
// boundary cards of a session- or project-addressed call, and the Attention Center order. A module of its own, below
// every family that uses it (`sessions.ts`, `output.ts`, `requests.ts`, `search.ts`, `messages.ts`, `lineage.ts`,
// `watch.ts`), so none of them imports another for these.
import type { ApprovalPreviewSection, SessionSummary } from "@orquester/api";
import { RUNTIME_MODES, threadToolReference, UNTRUSTED_NOTICE, type RuntimeMode, type ThreadToolReference, type ThreadToolRelation } from "@orquester/api/agent-chat";
import { canonicalProject, resolveProject, type CanonicalProject } from "../addressing.ts";
import type { ApprovalPreview, ScopeClaim, ScopeContext, ThreadCaller, ToolCaller } from "../catalog/contract.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { findSession, listSessions } from "../reads.ts";
import { clipText, MAX_ECHO_CHARS, resultBytes } from "../result.ts";

// ---------------------------------------------------------------------------
// The caller
// ---------------------------------------------------------------------------

/** The calling chat, or null for an external caller. */
export const threadCaller = (caller: ToolCaller): ThreadCaller | null => (caller.kind === "thread" ? caller : null);

const AGENT_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

/** The caller as a card's title names it ("An agent" for an external caller). */
export const agentLabel = (caller: ToolCaller): string => (caller.kind === "thread" ? (AGENT_LABELS[caller.agentId] ?? caller.agentId) : "An agent");

// ---------------------------------------------------------------------------
// Content rights and the scope claim (§5.1, §5.2, §13 a)
// ---------------------------------------------------------------------------

/** A permission mode's breadth; an unknown one is the narrowest (fail closed). */
const breadth = (mode: RuntimeMode): number => RUNTIME_MODES.indexOf(mode);

/**
 * Whether a chat caller may read the CONTENT of a target project without a card (§5.2, §13 a): its own project
 * always; another project of its workspace from `auto`; any other project — and every project when the caller has
 * none — only in `full-access`. A target in no project never is. The caller itself always is.
 */
export function hasContentRights(caller: ThreadCaller, project: CanonicalProject | null, self = false): boolean {
  if (self) return true;
  if (project === null) return false;
  if (caller.projectPath !== "" && project.canonical === caller.projectPath) return true;
  const sameWorkspace = caller.projectPath !== "" && caller.workspace !== "" && project.workspace === caller.workspace;
  return breadth(caller.runtimeMode) >= breadth(sameWorkspace ? "auto" : "full-access");
}

/** Each distinct `projectPath` of `sessions`, canonical (null: no project). */
export async function canonicalProjects(api: DaemonApi, sessions: readonly SessionSummary[]): Promise<Map<string, CanonicalProject | null>> {
  const out = new Map<string, CanonicalProject | null>();
  for (const session of sessions) {
    if (!out.has(session.projectPath)) out.set(session.projectPath, await canonicalProject(api, session.projectPath));
  }
  return out;
}

/** The tabs now, and the one `sessionId` names (`SESSION_NOT_FOUND` otherwise, as `findSession`). */
export async function sessionAmongTabs(api: DaemonApi, sessionId: string): Promise<{ summary: SessionSummary; sessions: SessionSummary[] }> {
  const sessions = await listSessions(api);
  const summary = sessions.find((s) => s.id === sessionId);
  if (!summary) throw new ToolError("SESSION_NOT_FOUND", `No session with id "${clipText(sessionId, MAX_ECHO_CHARS)}". Use list_sessions.`);
  return { summary, sessions };
}

/**
 * The scope claim of a call naming one session (§5.1): the session and — for a chat caller — its canonical project,
 * which the gate classifies (the caller itself is its own project: no project claimed). A session in no project is
 * refused to chat callers (it lies in no project they could be allowed into). External callers claim the session only:
 * they are full trust, and the tool validates the address itself. `causesTurnIn` defaults to none.
 */
export async function sessionClaim(
  ctx: ScopeContext,
  sessionId: string,
  claim: Omit<ScopeClaim, "projects" | "sessions" | "causesTurnIn"> & { causesTurnIn?: string[] }
): Promise<ScopeClaim> {
  const base: ScopeClaim = { projects: [], sessions: [sessionId], ...claim, causesTurnIn: claim.causesTurnIn ?? [] };
  const caller = threadCaller(ctx.caller);
  if (caller === null || sessionId === caller.threadId) return base;
  const summary = await findSession(ctx.api, sessionId);
  const project = await canonicalProject(ctx.api, summary.projectPath);
  if (project === null) throw new ToolError("PERMISSION_DENIED", `Session "${clipText(sessionId, MAX_ECHO_CHARS)}" belongs to no project; chat tools reach only sessions inside a project.`);
  return { ...base, projects: [project.canonical] };
}

// ---------------------------------------------------------------------------
// The chat result frame (§4.3)
// ---------------------------------------------------------------------------

/** `notice`: a chat caller reading another chat's words is told they are data, first thing in the result. */
export function chatNotice(caller: ToolCaller, sessionId: string): { notice?: string } {
  return caller.kind === "thread" && sessionId !== caller.threadId ? { notice: UNTRUSTED_NOTICE } : {};
}

/** How a session relates to the calling chat, for its tool row's link. */
export function relationTo(callerId: string, sessions: readonly SessionSummary[], target: Pick<SessionSummary, "id" | "lineage">): ThreadToolRelation {
  if (target.lineage?.parentThreadId === callerId) return target.lineage.relation;
  if (sessions.find((s) => s.id === callerId)?.lineage?.parentThreadId === target.id) return "parent";
  return "thread";
}

/** `threadRef`: the session a chat caller's result names, for its tool row. External results carry none. */
export function chatThreadRef(caller: ToolCaller, sessions: readonly SessionSummary[], target: Pick<SessionSummary, "id" | "title" | "lineage">, relation?: ThreadToolRelation): { threadRef?: ThreadToolReference } {
  if (caller.kind !== "thread") return {};
  return { threadRef: threadToolReference(target.id, target.title, relation ?? relationTo(caller.threadId, sessions, target)) };
}

/**
 * A chat caller's result frame around a session's data: `notice` first, `threadRef` last, and what the two take of the
 * result in bytes — measured, so a long title (a 200-character CJK one is 600 bytes in `threadRef`) is budgeted for.
 */
export function chatFrame(caller: ToolCaller, sessions: readonly SessionSummary[], target: Pick<SessionSummary, "id" | "title" | "lineage">): { before: { notice?: string }; after: { threadRef?: ThreadToolReference }; bytes: number } {
  const before = chatNotice(caller, target.id);
  const after = chatThreadRef(caller, sessions, target);
  // The keys and a comma each beside the data they join: the measured object's braces cover the commas.
  return { before, after, bytes: Object.keys(before).length + Object.keys(after).length > 0 ? resultBytes({ ...before, ...after }) : 0 };
}

// ---------------------------------------------------------------------------
// Boundary cards (§7.1): composed from structured arguments, never the raw arguments
// ---------------------------------------------------------------------------

/** `workspace/project`, or a phrase when the path is no project. */
async function projectLabel(api: DaemonApi, projectPath: string): Promise<string> {
  const project = await canonicalProject(api, projectPath);
  return project ? `${project.workspace}/${project.name}` : "no project";
}

/**
 * The boundary card of a session-addressed call: action, target session and project, `rows` of settings, the message
 * `text` in full and any further `sections` — never inline attachment bytes. A session no longer listed is named by
 * its id ("another project").
 */
export async function sessionCard(
  ctx: ScopeContext,
  sessionId: string,
  action: string,
  rows: { label: string; value: string }[] = [],
  more: { text?: string; sections?: ApprovalPreviewSection[] } = {}
): Promise<ApprovalPreview> {
  const summary = (await listSessions(ctx.api)).find((s) => s.id === sessionId);
  const where = summary ? await projectLabel(ctx.api, summary.projectPath) : "another project";
  const title = clipText((summary?.title ?? sessionId).replace(/\s+/g, " ").trim(), 80);
  const sections: ApprovalPreviewSection[] = [
    { kind: "fields", title: "Request", rows: [{ label: "Action", value: action }, { label: "Session", value: `${summary?.title ?? sessionId} · ${sessionId}` }, { label: "Project", value: where }, ...rows] }
  ];
  if (more.text !== undefined) sections.push({ kind: "text", title: "Message", text: more.text });
  sections.push(...(more.sections ?? []));
  return { title: `${agentLabel(ctx.caller)} wants to ${action} the chat "${title}" in ${where}`, scopeLabel: `Project ${where}`, sections };
}

/** The boundary card of a call naming a project (list or search in another project). */
export async function projectCard(ctx: ScopeContext, project: string, action: string, rows: { label: string; value: string }[] = []): Promise<ApprovalPreview> {
  const ref = await resolveProject(ctx.api, project);
  const where = await projectLabel(ctx.api, ref.path);
  return {
    title: `${agentLabel(ctx.caller)} wants to ${action} ${where}`,
    scopeLabel: `Project ${where}`,
    sections: [{ kind: "fields", title: "Request", rows: [{ label: "Action", value: action }, { label: "Project", value: where }, ...rows] }]
  };
}

// ---------------------------------------------------------------------------
// The Attention Center order
// ---------------------------------------------------------------------------

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
