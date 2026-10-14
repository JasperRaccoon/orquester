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

/**
 * Whether a fork request's failure leaves its outcome unknown — the daemon
 * answered `HOST_UNAVAILABLE` (the agent host may hold the child) or nothing
 * came back at all — rather than a refusal. Read structurally off an
 * `ApiError` (`status`, `body`), so this stays free of the client.
 */
export function isForkOutcomeUnknown(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  // No HTTP answer at all (the connection went): the daemon may have forked.
  if (typeof status !== "number") return true;
  if (status >= 500) return true;
  const body = (error as { body?: unknown }).body as { code?: unknown; error?: { code?: unknown } } | null | undefined;
  return (body?.error?.code ?? body?.code) === "HOST_UNAVAILABLE";
}

/**
 * The fork commands whose outcome is unknown, by tab and fork point, so the
 * next "Fork from here" on the same message re-sends the SAME `commandId`:
 * the daemon then answers the fork it may already have opened (its tab and the
 * host's child converge on one), instead of opening a second beside a stray
 * one. A fork that answered — opened or refused — frees its point.
 */
export class ForkRetryKeys {
  private readonly pending = new Map<string, { sessionId: string; commandId: string }>();

  static keyFor(
    sessionId: string,
    request: { messageId?: string | null; turnId?: string | null; role?: string | null }
  ): string {
    return JSON.stringify([sessionId, request.messageId ?? null, request.turnId ?? null, request.role ?? null]);
  }

  /** The id to send: the one an unknown outcome left for this point, else a fresh one. */
  commandIdFor(key: string, mint: () => string): string {
    return this.pending.get(key)?.commandId ?? mint();
  }

  /** Record how the fork sent under `commandId` ended: kept only while its outcome is unknown. */
  settle(key: string, commandId: string, error: unknown | null): void {
    const sessionId = (JSON.parse(key) as unknown[])[0] as string;
    if (error !== null && isForkOutcomeUnknown(error)) this.pending.set(key, { sessionId, commandId });
    else this.pending.delete(key);
  }

  /**
   * A tab closed: the kept ids of forks from it, or from the parent of a fork tab that closed,
   * are dropped. The tab that went may be the very fork a kept id would converge on — a stray
   * one the user closed, or one the daemon took back — and its key now answers
   * COMMAND_ID_CONFLICT, so the next fork from that point is a new command.
   */
  forgetTab(closed: Pick<SessionSummary, "id" | "lineage">): void {
    const parentId = closed.lineage?.relation === "fork" ? closed.lineage.parentThreadId : null;
    for (const [key, entry] of this.pending) {
      if (entry.sessionId === closed.id || entry.sessionId === parentId) this.pending.delete(key);
    }
  }
}
