/**
 * Thread lineage in the client (spec 2026-10-14 §6): a chat tab's parent and
 * children, read off the tab list the store already holds — every tab record
 * carries its `lineage`, so nothing here asks the daemon.
 *
 * Pure: no React, no store.
 */

import type { SessionSummary, ThreadItem, ThreadLineage } from "@orquester/api";

/** The chip's verb: what the child is to its parent. */
export function lineageVerb(lineage: Pick<ThreadLineage, "relation">): string {
  return lineage.relation === "delegate" ? "Delegated by" : "Forked from";
}

/** The parent tab, when it is still open. */
export function lineageParent(
  sessions: readonly SessionSummary[],
  lineage: ThreadLineage | undefined
): SessionSummary | null {
  if (!lineage) return null;
  return sessions.find((session) => session.id === lineage.parentThreadId) ?? null;
}

/** The tabs forked from or delegated by `sessionId`, oldest first. */
export function lineageChildren(
  sessions: readonly SessionSummary[],
  sessionId: string
): SessionSummary[] {
  return sessions
    .filter((session) => session.lineage?.parentThreadId === sessionId)
    .sort((a, b) =>
      (a.lineage?.createdAt || a.createdAt).localeCompare(b.lineage?.createdAt || b.createdAt)
    );
}

/** One tab's line in a parent's children list: what it is doing now. */
export function lineageChildStatus(session: SessionSummary): string {
  const state = session.latestTurn?.state;
  if (session.hasPendingApprovals || session.hasPendingUserInput) return "needs input";
  if (session.chatSessionStatus === "running" || state === "running" || state === "pending") return "working";
  if (session.chatSessionStatus === "error" || state === "failed") return "failed";
  if (state === "interrupted" || state === "cancelled") return "stopped";
  if (state === "completed") return "done";
  return "new";
}

/**
 * What "Merge back" offers to send by default: the thread's last finished
 * answer — its newest settled assistant message of the main conversation
 * (never a subagent's words, never a reply still being written). "" when there
 * is none yet.
 */
export function defaultMergeBackText(entries: readonly ThreadItem[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index]!;
    if (
      item.kind === "message" &&
      item.role === "assistant" &&
      item.agentId === undefined &&
      !item.streaming &&
      item.messageKind !== "commentary" &&
      item.text.trim().length > 0
    ) {
      return item.text.trim();
    }
  }
  return "";
}
