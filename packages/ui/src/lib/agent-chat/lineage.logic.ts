/**
 * Thread lineage in the client (spec 2026-10-14 §6): a chat tab's parent and
 * children, read off the tab list the store already holds — every tab record
 * carries its `lineage`, so nothing here asks the daemon.
 *
 * Pure: no React, no store.
 */

import type { SessionSummary, ThreadItem, ThreadLineage } from "@orquester/api";
import { isMessageStreaming, type MessageStreamingContext } from "@orquester/api/agent-chat";

/**
 * The chip's verb: what the child is to its parent. A chat another chat's agent opened
 * (`opened`, unified MCP §4.1) reads "Opened by" — it is not a fork: it starts empty, with that
 * chat's first message.
 */
export function lineageVerb(lineage: Pick<ThreadLineage, "relation">): string {
  switch (lineage.relation) {
    case "delegate":
      return "Delegated by";
    case "opened":
      return "Opened by";
    default:
      return "Forked from";
  }
}

/** What a child is called in its parent's list and the merge-back wording: fork, task, opened chat. */
export function lineageRelationNoun(relation: ThreadLineage["relation"] | undefined): string {
  switch (relation) {
    case "delegate":
      return "task";
    case "opened":
      return "opened chat";
    default:
      return "fork";
  }
}

/**
 * A parent's children counted by relation: "2 forks · 1 task · 1 opened chat". A relation this
 * build does not know (a newer daemon's) is counted in a neutral "other chat" bucket, never dropped.
 */
export function lineageChildrenLabel(children: readonly Pick<SessionSummary, "lineage">[]): string {
  const known: readonly ThreadLineage["relation"][] = ["fork", "delegate", "opened"];
  const count = (relation: ThreadLineage["relation"]): number =>
    children.filter((child) => (child.lineage?.relation ?? "fork") === relation).length;
  const other = children.filter((child) => !known.includes(child.lineage?.relation ?? "fork")).length;
  const plural = (n: number, noun: string): string | null => (n > 0 ? `${n} ${noun}${n === 1 ? "" : "s"}` : null);
  return [
    plural(count("fork"), "fork"),
    plural(count("delegate"), "task"),
    plural(count("opened"), "opened chat"),
    plural(other, "other chat")
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
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
 * is none yet. Whether a reply is still being written is `isMessageStreaming`'s
 * rule, never the bare flag a dead host or an unclosed turn leaves `true`.
 */
export function defaultMergeBackText(entries: readonly ThreadItem[], streaming: MessageStreamingContext): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index]!;
    if (
      item.kind === "message" &&
      item.role === "assistant" &&
      item.agentId === undefined &&
      !isMessageStreaming(item, streaming) &&
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
 * Whether a kept fork key may name the point a fork child was taken from. A message names its
 * point on its own (the host's fold may record a turn the client did not send); a key without
 * one is a cut by turn, or the whole thread. A child with no recorded point — a whole-thread fork, or a lineage whose
 * point did not read — may be any of its parent's forks, so it matches them all: a kept id that
 * would now conflict is worse than a fresh fork.
 */
function forkPointMatches(key: string, point: ThreadLineage["forkedFrom"]): boolean {
  if (point === undefined) return true;
  const [, messageId, turnId] = JSON.parse(key) as [string, string | null, string | null];
  if (messageId !== null) return point.messageId === messageId;
  // A whole-thread key (no turn either) is not a fork taken at a point.
  return turnId !== null && point.turnId === turnId;
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
   * A tab closed. Closing a parent drops every kept id of forks from it. Closing a fork drops
   * only the kept id of the point it was forked from (its `forkedFrom` message, or every point
   * of its parent when it records none): that fork may be the very one a kept id would converge on —
   * a stray one the user closed, or one the daemon took back — and its key now answers
   * COMMAND_ID_CONFLICT, so the next fork from that point is a new command. Kept ids of the
   * parent's other points stay, so their retries still converge.
   */
  forgetTab(closed: Pick<SessionSummary, "id" | "lineage">): void {
    const lineage = closed.lineage?.relation === "fork" ? closed.lineage : null;
    for (const [key, entry] of this.pending) {
      if (entry.sessionId === closed.id) {
        this.pending.delete(key);
        continue;
      }
      if (lineage === null || entry.sessionId !== lineage.parentThreadId) continue;
      if (forkPointMatches(key, lineage.forkedFrom)) this.pending.delete(key);
    }
  }
}
