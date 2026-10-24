/**
 * Idle Claude compaction (beta, T3 Code's "Compact idle threads"): the one rule.
 *
 * A Claude chat's prompt cache lives 5 minutes (API key) or an hour (subscription) after the
 * request that wrote it. A user who comes back to a large chat after that pays a full uncached
 * read of the whole conversation. Compacting it shortly BEFORE the cache expires costs one cached
 * read now instead. Two halves:
 *
 * - the host reads the chat's {@link IdleCompactionCandidate} off its log
 *   ({@link idleCompactionCandidateOf}: the latest settled turn and the prompt-cache expiry the
 *   Claude adapter stamped on the context-window row) and reports it on `GET …/summary`;
 * - the daemon's scheduler (`apps/daemon/src/agent-chat/idle-compaction.ts`) puts it together
 *   with the tab's own state ({@link idleCompactionWindow}) and sends a visible `/compact` in the
 *   window `[expiresAt - 2 min, expiresAt)`.
 *
 * Both halves are derived from the thread's `events.ndjson`, never from timers' own state, so a
 * daemon restart or an agent-host handover rebuilds the same window; one that already closed is
 * left alone (the cache is gone, so compacting would pay the read it was meant to save).
 */

import { isAgentOwnedActivity, isCompactionActivity } from "./compaction.ts";
import type { PendingMergeBack, ThreadLineageRelation } from "./lineage.ts";
import type { ThreadActivityItem, ThreadItem, ThreadMessageSentBy, Turn } from "./thread.ts";
import type { AgentChatSessionSummaryFields } from "./wire.ts";
import { IDENTITY_CHANGED_ACTIVITY_KIND, PROFILE_CHANGED_ACTIVITY_KIND } from "./wire.ts";

/**
 * Context below which a chat is never compacted while idle: Claude Code's own `idleCompaction`
 * default. Below it a cold re-read is cheap, so compacting mostly loses context for little saving.
 * *T3: `COMPACTION_SUGGESTION_MIN_TOKENS`.*
 */
export const IDLE_COMPACTION_MIN_TOKENS = 200_000;

/**
 * How long before the cache expires the compaction starts: enough for the session to resume and
 * send it while the cache is still warm. *T3: `LEAD_MS`.*
 */
export const IDLE_COMPACTION_LEAD_MS = 2 * 60_000;

/** `ThreadMessageItem.sentBy` of the `/compact` the daemon sends: the timeline labels it automatic. */
export const IDLE_COMPACTION_SENT_BY: ThreadMessageSentBy = "idle-compaction";

/** The command id prefix of an idle compaction; the rest names the chat and the turn. */
export const IDLE_COMPACTION_COMMAND_PREFIX = "idle-compact";

/** How many of a thread's newest rows {@link idleCompactionCandidateOf} looks through. */
const CANDIDATE_SCAN_ROWS = 500;

/**
 * What the host knows about a chat's prompt cache, on `GET …/summary`
 * (`AgentHostThreadSummary.idleCompaction`): its latest turn settled `completed`, and the newest
 * context reading of the conversation names when the cache it wrote expires.
 */
export interface IdleCompactionCandidate {
  /** The settled turn the window belongs to: a newer turn replaces it. */
  turnId: string;
  /** The context the cache holds. */
  usedTokens: number;
  /** ISO: the request that wrote the cache, plus its lifetime. */
  promptCacheExpiresAt: string;
  /** The lifetime that request wrote (1h or 5m), when known. */
  promptCacheTtlMs?: number;
}

function isUserCompact(text: string): boolean {
  return text.trim().toLowerCase() === "/compact";
}

function contextReadingOf(activity: ThreadActivityItem): { usedTokens: number; expiresAt?: string; ttlMs?: number } | null {
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const usedTokens = record.usedTokens;
  if (typeof usedTokens !== "number" || !Number.isFinite(usedTokens)) return null;
  return {
    usedTokens,
    ...(typeof record.promptCacheExpiresAt === "string" ? { expiresAt: record.promptCacheExpiresAt } : {}),
    ...(typeof record.promptCacheTtlMs === "number" && Number.isFinite(record.promptCacheTtlMs)
      ? { ttlMs: record.promptCacheTtlMs }
      : {})
  };
}

/**
 * The chat's {@link IdleCompactionCandidate}, read off its newest rows, or null. Null unless:
 *
 * - its latest turn settled `completed` (a failed, interrupted or running turn is not idle);
 * - its newest user message is not itself `/compact` — never compact a compaction, so one idle
 *   spell compacts at most once (a compaction that failed is not retried either);
 * - the newest context reading of the conversation (a `context-window.updated` row of the parent,
 *   never a subagent's) names a prompt-cache expiry. A request served whole from the cache wrote
 *   no entry and reports none: the expiry is unknown, and the chat is skipped;
 * - nothing newer than that reading moved the cache elsewhere: a compaction marker (the reading
 *   describes the context before it), or an account or Agent Profile switch (the next request
 *   runs on another home, whose cache is cold).
 *
 * A reading with no expiry taken OUTSIDE any turn (`turnId: null`) is passed over: it is the
 * context read a (re)started Claude session makes before any request — a `mode` command that
 * restarts a live idle session, a host restart's rehydrate. The cache stays warm across that:
 * Anthropic's prompt cache is server-side, keyed on the request's prefix, and the resumed CLI sends
 * the same transcript, system prompt and tools, so its next request reads the entry the last
 * request wrote until that entry's own expiry. (A restart that changes the prefix — a different
 * account or Agent Profile — leaves its own activity row, which voids the candidate above.) Its
 * context size is still the newest one.
 *
 * *T3: `IdleCompaction.ts` `idleCompactionWindow`, the record half.*
 */
export function idleCompactionCandidateOf(items: readonly ThreadItem[], turns: readonly Turn[]): IdleCompactionCandidate | null {
  const latest = turns.at(-1);
  if (latest === undefined || latest.state !== "completed" || latest.completedAt === null || latest.turnId === null) {
    return null;
  }
  // Never a compaction of a compaction: the newest user message decides, wherever the reading
  // is (a compaction's own turn writes a reading after its `/compact`).
  const floor = Math.max(0, items.length - CANDIDATE_SCAN_ROWS);
  let usedTokens: number | undefined;
  for (let index = items.length - 1; index >= floor; index -= 1) {
    const item = items[index]!;
    if (item.kind === "message") {
      if (item.agentId !== undefined || item.role !== "user") continue;
      if ((item.attachments?.length ?? 0) === 0 && isUserCompact(item.text)) return null;
      break;
    }
    if (usedTokens === undefined && item.activityKind === "context-window.updated" && !isAgentOwnedActivity(item)) {
      usedTokens = contextReadingOf(item)?.usedTokens;
      if (usedTokens === undefined) return null;
    }
  }
  const expiry = promptCacheExpiryOf(items);
  if (usedTokens === undefined || expiry === null) return null;
  return {
    turnId: latest.turnId,
    usedTokens,
    promptCacheExpiresAt: expiry.expiresAt,
    ...(expiry.ttlMs !== undefined ? { promptCacheTtlMs: expiry.ttlMs } : {})
  };
}

/**
 * The prompt-cache expiry in force for the conversation, read off its newest rows: the one the
 * newest context reading of the parent names — past readings taken OUTSIDE any turn
 * (`turnId: null`) with no expiry, which made no request (see {@link idleCompactionCandidateOf}).
 * Null when it is unknown: a reading inside a turn with no expiry (a request that wrote no cache
 * entry), or a compaction marker, an account switch or an Agent Profile switch newer than the
 * stamped reading. The one rule for the daemon's idle compaction and the composer's "When you
 * return" offer (`latestContextWindowActivity`), so the two cannot disagree.
 */
export function promptCacheExpiryOf(rows: readonly ThreadItem[]): { expiresAt: string; ttlMs?: number } | null {
  const floor = Math.max(0, rows.length - CANDIDATE_SCAN_ROWS);
  for (let index = rows.length - 1; index >= floor; index -= 1) {
    const item = rows[index]!;
    if (item.kind !== "activity" || isAgentOwnedActivity(item)) continue;
    if (
      isCompactionActivity(item) ||
      item.activityKind === IDENTITY_CHANGED_ACTIVITY_KIND ||
      item.activityKind === PROFILE_CHANGED_ACTIVITY_KIND
    ) {
      return null;
    }
    if (item.activityKind !== "context-window.updated") continue;
    const reading = contextReadingOf(item);
    if (reading === null) return null;
    if (reading.expiresAt !== undefined) {
      return Number.isFinite(Date.parse(reading.expiresAt))
        ? { expiresAt: reading.expiresAt, ...(reading.ttlMs !== undefined ? { ttlMs: reading.ttlMs } : {}) }
        : null;
    }
    // Outside any turn — a (re)started session's own context read — no request was made, so the
    // expiry the last request named stands. Inside a turn, no expiry means unknown.
    if (item.turnId !== null) return null;
  }
  return null;
}

/** What the daemon's tab record says about the chat (`SessionSummary`), as the rule reads it. */
export interface IdleCompactionTab extends AgentChatSessionSummaryFields {
  id: string;
  lineage?: { relation: ThreadLineageRelation } | null;
  pendingMerges?: readonly Pick<PendingMergeBack, "parentSessionId" | "state">[];
  /** Set when a workflow run drives the chat: its engine sends the next message, not the user. */
  workflowOwned?: boolean;
}

/** The window an idle compaction goes out in, for the turn it belongs to. */
export interface IdleCompactionWindow {
  turnId: string;
  startMs: number;
  endMs: number;
}

/**
 * When an idle Claude chat should compact, or null when it should not. The window ends when the
 * prompt cache of Claude's last request expires; compacting after that pays a full uncached read.
 * Null when:
 *
 * - the host reported no candidate ({@link idleCompactionCandidateOf});
 * - the chat is a delegated child (T3's subagent threads) or a workflow's;
 * - its latest turn is no longer the candidate's, or not settled `completed`, or its session is
 *   starting or running;
 * - anything is pending: an approval, a question (the daemon's own secret and approval cards
 *   included), a plan waiting to be implemented, a merge or reply queued for it, live background
 *   work (it reports into the next turn; compaction would swallow it), or a goal the provider
 *   continues by itself;
 * - the context is under {@link IDLE_COMPACTION_MIN_TOKENS};
 * - the cache has expired already (`nowMs >= endMs`).
 *
 * *T3: `IdleCompaction.ts` `idleCompactionWindow`.*
 */
// Adapted from T3 Code (MIT): apps/server/src/orchestration-v2/IdleCompaction.ts
export function idleCompactionWindow(
  tab: IdleCompactionTab,
  candidate: IdleCompactionCandidate | null,
  nowMs: number
): IdleCompactionWindow | null {
  if (candidate === null) return null;
  if (tab.lineage?.relation === "delegate" || tab.workflowOwned === true) return null;
  const latest = tab.latestTurn ?? null;
  if (latest === null || latest.turnId !== candidate.turnId || latest.state !== "completed") return null;
  if (tab.chatSessionStatus === "starting" || tab.chatSessionStatus === "running") return null;
  if (
    tab.hasPendingApprovals === true ||
    tab.hasPendingUserInput === true ||
    tab.hasActionableProposedPlan === true ||
    // A queued merge-back, reply or message belongs to the chat's next turn.
    (tab.pendingMerges ?? []).some((merge) => merge.parentSessionId === tab.id && merge.state === "queued") ||
    (tab.backgroundLiveness ?? null) !== null ||
    tab.goal?.continuing === true
  ) {
    return null;
  }
  if (candidate.usedTokens < IDLE_COMPACTION_MIN_TOKENS) return null;
  const endMs = Date.parse(candidate.promptCacheExpiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  return { turnId: candidate.turnId, startMs: endMs - IDLE_COMPACTION_LEAD_MS, endMs };
}
