/**
 * Delegated chats in their parent's view — the timeline's subagent strip, the roster's delegated
 * rows, the composer-side count and the tab's "needs input" mark.
 *
 * A delegated child is a chat tab like any other (`create_session` with `delegate: true`, lineage
 * relation `delegate`), so everything live here is read off the tab list the store already holds
 * and keeps fresh from the `sessions` bus: status from the summary's §6.4 fields, its latest word
 * and model from `delegateView`. Nothing here polls or asks the daemon. The timeline's own record
 * — the tool call's `threadRef` — names each child, so a child whose tab was closed still has its
 * row (shown closed), and so does every child after a reload.
 *
 * Ported in spirit from T3 Code (MIT): `MessagesTimeline.tsx` `V2SubagentGroup` and
 * `packages/client-runtime/src/state/subagentDisplay.ts` (`summarizeSubagentStatuses`,
 * `subagentDetailPreview`) and `threadSubagents.ts` (the pill).
 *
 * Pure: no React, no store.
 */

import type { SessionSummary } from "@orquester/api";
import { compactPreviewText, DELEGATE_PREVIEW_CHARS } from "@orquester/api/agent-chat";

import type { WorkLogEntry } from "./contracts";
import { workEntryDisplayIndicatesToolFailure } from "./presentation.logic";

// ---------------------------------------------------------------------------
// The tool call that delegates
// ---------------------------------------------------------------------------

/** The session tools whose call delegates a task: the unified catalogue's and the legacy one. */
const DELEGATING_TOOLS: ReadonlySet<string> = new Set(["create_session", "delegate_task"]);

/**
 * One delegated child as its parent's timeline names it: the tab the call opened (`threadId`), or
 * `null` while the call is still opening it; and the title the call gave it.
 */
export interface DelegateChildRef {
  /** The call's row in the parent's timeline (stable across re-derivations). */
  entryId: string;
  /** The tool call (its lifecycle rows share it), else the row. */
  callId: string;
  threadId: string | null;
  title: string;
  /** When the call ran: the child's start when its tab is gone. */
  createdAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A call's arguments, whatever the provider's layout: `arguments` (Codex, OpenCode) or `input` (Claude), object or JSON text. */
function callArguments(toolData: unknown): Record<string, unknown> | null {
  const data = asRecord(toolData);
  if (data === null) return null;
  for (const key of ["arguments", "input"] as const) {
    const value = data[key];
    const direct = asRecord(value);
    if (direct !== null) return direct;
    if (typeof value === "string" && value.trimStart().startsWith("{")) {
      try {
        const parsed = asRecord(JSON.parse(value) as unknown);
        if (parsed !== null) return parsed;
      } catch {
        // A partial stream of the arguments: nothing to read yet.
      }
    }
  }
  return null;
}

/** The default title the daemon gives a delegated task: "Task: " and the prompt's first line (`delegateTitle`). */
function taskTitle(prompt: unknown): string {
  const line = typeof prompt === "string" ? (prompt.trim().split("\n", 1)[0] ?? "").trim() : "";
  if (!line) return "Task";
  return `Task: ${line.length > 60 ? `${line.slice(0, 59)}…` : line}`;
}

/**
 * The delegated child a timeline row stands for, or null when the row delegates nothing: a
 * `create_session` that delegated (its result's `threadRef` is a `delegate`, or — while it still
 * runs — its arguments say `delegate: true`) or a legacy `delegate_task`. A call that failed or
 * ended without opening a chat is no child: it stays an ordinary tool row, where its error shows.
 */
export function delegateCallOf(entry: WorkLogEntry): DelegateChildRef | null {
  if (entry.sessionTool === undefined || !DELEGATING_TOOLS.has(entry.sessionTool)) return null;
  const link = entry.threadLink;
  if (link !== undefined) {
    return link.relation === "delegate"
      ? { entryId: entry.id, callId: entry.toolCallId ?? entry.id, threadId: link.threadId, title: link.title || "Task", createdAt: entry.createdAt }
      : null;
  }
  if (entry.tone === "error" || workEntryDisplayIndicatesToolFailure(entry)) return null;
  if (entry.toolLifecycleStatus !== undefined && entry.toolLifecycleStatus !== "inProgress") return null;
  const args = callArguments(entry.toolData);
  if (entry.sessionTool === "create_session" && args?.delegate !== true) return null;
  const title = typeof args?.title === "string" && args.title.trim() ? args.title.trim() : taskTitle(args?.prompt);
  return { entryId: entry.id, callId: entry.toolCallId ?? entry.id, threadId: null, title, createdAt: entry.createdAt };
}

/**
 * Consecutive delegating calls collapse into one group (rows.logic): the children in call order,
 * each call once — a call's lifecycle rows (start, completion) are one child, its completed row
 * winning.
 */
export function mergeDelegateRefs(refs: readonly DelegateChildRef[]): DelegateChildRef[] {
  const out: DelegateChildRef[] = [];
  for (const ref of refs) {
    const same = out.findIndex((other) => other.callId === ref.callId || (ref.threadId !== null && other.threadId === ref.threadId));
    if (same === -1) out.push(ref);
    // The call's later row knows more (the tab it opened): it keeps the first row's place and start.
    else if (ref.threadId !== null || out[same]!.threadId === null) out[same] = { ...out[same]!, threadId: ref.threadId, title: ref.title };
  }
  return out;
}

// ---------------------------------------------------------------------------
// A child's status
// ---------------------------------------------------------------------------

/**
 * What a delegated child is doing, by its tab's summary: `starting` (the call is still opening it,
 * or its thread is being created), `working`, `needs-input` (a question, approval or secret waits
 * for its user), `done`, `failed`, `stopped`, `idle` (opened, no turn yet), `closed` (its tab is
 * gone).
 */
export type DelegateChildStatus = "starting" | "working" | "needs-input" | "done" | "failed" | "stopped" | "idle" | "closed";

export function delegateChildStatus(ref: Pick<DelegateChildRef, "threadId">, session: SessionSummary | undefined): DelegateChildStatus {
  if (ref.threadId === null) return "starting";
  if (!session) return "closed";
  if (session.hasPendingApprovals || session.hasPendingUserInput) return "needs-input";
  if (session.chatPending === true) return "starting";
  const state = session.latestTurn?.state;
  if (session.chatSessionStatus === "running" || session.chatSessionStatus === "starting" || state === "running" || state === "pending") {
    return "working";
  }
  if (session.goal?.continuing === true || session.backgroundLiveness === "working") return "working";
  if (session.chatSessionStatus === "error" || state === "failed") return "failed";
  if (state === "interrupted" || state === "cancelled") return "stopped";
  if (state === "completed") return "done";
  return "idle";
}

/** Still at work: the elapsed timer runs and the summary reads in the accent colour. */
export function isDelegateLive(status: DelegateChildStatus): boolean {
  return status === "starting" || status === "working" || status === "needs-input";
}

/** The status word a row shows. */
export const DELEGATE_STATUS_LABEL: Readonly<Record<DelegateChildStatus, string>> = {
  starting: "Starting",
  working: "Working",
  "needs-input": "Needs input",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  idle: "Idle",
  closed: "Closed"
};

/**
 * The group's status line: "4 working · 1 needs input · 1 done · 1 failed" — what needs the user
 * first, then work in motion, then how the rest ended. A starting child counts as working.
 */
export function summarizeDelegateStatuses(statuses: readonly DelegateChildStatus[]): string {
  const counts: Array<[string, number]> = [
    ["needs input", 0],
    ["working", 0],
    ["done", 0],
    ["failed", 0],
    ["stopped", 0],
    ["idle", 0],
    ["closed", 0]
  ];
  const slot: Record<DelegateChildStatus, number> = {
    "needs-input": 0,
    starting: 1,
    working: 1,
    done: 2,
    failed: 3,
    stopped: 4,
    idle: 5,
    closed: 6
  };
  for (const status of statuses) counts[slot[status]]![1] += 1;
  return counts
    .filter(([, count]) => count > 0)
    .map(([word, count]) => `${count} ${word}`)
    .join(" · ");
}

/** "1 subagent" / "3 subagents". */
export function delegateGroupLabel(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"}`;
}

// ---------------------------------------------------------------------------
// One child's row
// ---------------------------------------------------------------------------

/** One delegated child as a row renders it. */
export interface DelegateChildView {
  ref: DelegateChildRef;
  /** The tab's live title, else the call's. */
  title: string;
  status: DelegateChildStatus;
  /** The registry entry its icon is drawn from; null once its tab is gone. */
  refId: string | null;
  model: string | null;
  accountId: string | null;
  /** Its latest progress (while it works) or result (once it ended), on one line, cut short. */
  preview: string | null;
  /** When it started, and when it ended (null while it works, or when unknown). */
  startedAt: string;
  endedAt: string | null;
}

/** A child's preview text: its latest word, cut to `max` (default {@link DELEGATE_PREVIEW_CHARS}). */
export function delegatePreviewText(session: SessionSummary | undefined, max: number = DELEGATE_PREVIEW_CHARS): string | null {
  const text = session?.delegateView?.preview?.text;
  if (typeof text !== "string") return null;
  const cut = compactPreviewText(text, max);
  return cut.length > 0 ? cut : null;
}

export function delegateChildView(ref: DelegateChildRef, session: SessionSummary | undefined): DelegateChildView {
  const status = delegateChildStatus(ref, session);
  const startedAt = session?.lineage?.createdAt || session?.createdAt || ref.createdAt;
  const latest = session?.latestTurn ?? null;
  const ended = !isDelegateLive(status) && status !== "closed" && status !== "idle" ? (latest?.completedAt ?? null) : null;
  return {
    ref,
    title: session?.title || ref.title,
    status,
    refId: session?.refId ?? null,
    model: session?.delegateView?.model ?? null,
    accountId: session ? session.accountId || null : null,
    preview: delegatePreviewText(session),
    startedAt,
    endedAt: ended
  };
}

/**
 * The group's clock: from its first child's start; live while any child works; once none does,
 * to the latest end any child reports (null when none reports one: no duration is claimed).
 */
export function delegateGroupTiming(children: readonly Pick<DelegateChildView, "status" | "startedAt" | "endedAt">[]): {
  live: boolean;
  startedAt: string | null;
  endedAt: string | null;
} {
  let start: number | null = null;
  let end: number | null = null;
  let live = false;
  for (const child of children) {
    const started = Date.parse(child.startedAt);
    if (Number.isFinite(started)) start = start === null ? started : Math.min(start, started);
    if (isDelegateLive(child.status)) live = true;
    const ended = child.endedAt === null ? Number.NaN : Date.parse(child.endedAt);
    if (Number.isFinite(ended)) end = end === null ? ended : Math.max(end, ended);
  }
  return {
    live,
    startedAt: start === null ? null : new Date(start).toISOString(),
    endedAt: live || end === null ? null : new Date(end).toISOString()
  };
}

// ---------------------------------------------------------------------------
// The parent's open delegated tabs (roster, pill, tab mark)
// ---------------------------------------------------------------------------

/** The open tabs `parentId` delegated a task to, oldest first. */
export function delegatedChildrenOf(sessions: readonly SessionSummary[], parentId: string): SessionSummary[] {
  return sessions
    .filter((session) => session.kind === "agent-chat" && session.lineage?.relation === "delegate" && session.lineage.parentThreadId === parentId)
    .sort((a, b) => (a.lineage?.createdAt || a.createdAt).localeCompare(b.lineage?.createdAt || b.createdAt));
}

/** An open delegated tab as a row — what the roster lists — named by the tab itself. */
export function delegateTabView(session: SessionSummary): DelegateChildView {
  return delegateChildView(
    { entryId: session.id, callId: session.id, threadId: session.id, title: session.title, createdAt: session.createdAt },
    session
  );
}

/**
 * The composer-side count: "2/5 working" while any delegated child works (a child waiting for its
 * user counts — it is unfinished), "5 done" once every one ended, null with none. `live` says
 * which.
 */
export function delegatePillLabel(children: readonly Pick<DelegateChildView, "status">[]): { label: string; live: boolean } | null {
  if (children.length === 0) return null;
  const working = children.filter((child) => isDelegateLive(child.status)).length;
  if (working > 0) return { label: `${working}/${children.length} working`, live: true };
  return { label: `${children.length} done`, live: false };
}

/** The delegated children of `parentId` that wait for their user now — the parent tab's "needs input" mark. */
export function delegatesNeedingInput(sessions: readonly SessionSummary[], parentId: string): SessionSummary[] {
  return delegatedChildrenOf(sessions, parentId).filter((session) => session.hasPendingApprovals || session.hasPendingUserInput);
}
