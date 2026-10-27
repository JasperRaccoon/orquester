/**
 * Usage-limit recovery for interactive chats: the wire and the one reader.
 *
 * A chat whose account ran out of quota stops — a failed turn (Codex, Grok, OpenCode, a Claude
 * result) or a turn the Claude SDK parks on a rejected window. Every adapter stamps
 * `reason: "usage_limit"` (and, when the provider says, `resetsAt`) on the error or warning it
 * raises then (`failure-reason.ts`). The host projects the thread's CURRENT limit, if any, onto
 * its `GET …/summary` ({@link usageLimitNoticeOf}); the daemon turns it into the chat's recovery
 * state ({@link ChatUsageLimitState}, persisted on the tab record), schedules the automatic
 * resume at the reset, optionally switches the chat to another account of the same family, and
 * publishes both on `SessionSummary` (`usageLimit`, `limitFailover`) so every surface marks the
 * chat without a thread stream.
 */

import { isAgentOwnedActivity } from "./compaction.ts";
import { failureReasonOfActivity, overloadOfActivity } from "./failure-reason.ts";
import type { ThreadItem, Turn } from "./thread.ts";

/** What the daemon sends into a chat when its limit has reset (T3 Code's wording). */
export const USAGE_LIMIT_CONTINUE_MESSAGE = "Continue where you left off.";

/**
 * How long after the provider's reset the automatic resume goes out: a reset stamp is the
 * provider's own clock, and a message sent on the second may still meet the old window.
 */
export const USAGE_LIMIT_RESUME_MARGIN_MS = 45_000;

/**
 * How long after a chat stopped on a provider's capacity error ({@link ThreadUsageLimitNotice.kind}
 * `overloaded`) the daemon retries it the first time; each retry that meets the error again waits
 * twice as long, up to {@link OVERLOAD_RETRY_MAX_MS}.
 */
export const OVERLOAD_RETRY_BASE_MS = 30_000;
export const OVERLOAD_RETRY_MAX_MS = 5 * 60_000;

/**
 * What stopped the chat: absent — the account's usage limit; `overloaded` — the provider had no
 * capacity for the model (Codex "Selected model is at capacity"), retried shortly, with no account
 * cooldown and no account switch.
 */
export type UsageLimitKind = "overloaded";

/** How many of a thread's newest rows {@link usageLimitNoticeOf} looks through. */
const NOTICE_SCAN_ROWS = 500;

/**
 * The thread's current usage limit, as the host reports it on `GET …/summary`
 * (`AgentHostThreadSummary.usageLimit`). `null`: the thread is not limited now.
 */
export interface ThreadUsageLimitNotice {
  /** The failure row's id (`ThreadActivityItem.id`). */
  activityId: string;
  /** The turn the limit hit; null when it hit before the provider named the turn, or between turns. */
  turnId: string | null;
  /** ISO time the provider says the limit resets, when it said. */
  resetsAt?: string;
  /** The row's own message. */
  message: string;
  /** When the row was written (ISO). */
  at: string;
  /** The turn is still open: the Claude SDK parks a turn on a rejected window instead of failing it. */
  parked: boolean;
  /** Absent: a usage limit. */
  kind?: UsageLimitKind;
}

function isProgress(item: ThreadItem): boolean {
  if (item.kind === "message") return item.role === "assistant";
  return item.activityKind.startsWith("tool.");
}

/**
 * The thread's current usage limit, read off its newest rows, or null.
 *
 * Newest first, the scan stops at the first user message (the user — or a resume — spoke after
 * any limit). The newest usage-limit failure row found before that is the limit, unless:
 * - the main agent made progress after it (an assistant message or a tool row: a parked turn
 *   that went on by itself once the window reset);
 * - a newer turn started after it (a provider-started turn, a goal continuing).
 *
 * Every subagent row — a message or an activity carrying `agentId`, on the row or its payload
 * (`isAgentOwnedActivity`) — is passed over: it is neither the user speaking, nor the main
 * agent's progress, nor the thread's limit. Background subagents keep finishing the tool calls
 * they started before the limit (their `tool.completed` / `tool.output` and `task.*` rows land
 * after it), and none of that means the conversation went on; nor does a subagent's own new
 * message after the reset — what clears the limit is the user's next message, or the main
 * agent's own next row. An auth failure is not a limit. A provider's capacity failure
 * (`reason: "overloaded"`) is reported the same way, with `kind: "overloaded"`.
 */
export function usageLimitNoticeOf(items: readonly ThreadItem[], turns: readonly Turn[]): ThreadUsageLimitNotice | null {
  let progressAfter = false;
  const floor = Math.max(0, items.length - NOTICE_SCAN_ROWS);
  for (let index = items.length - 1; index >= floor; index -= 1) {
    const item = items[index]!;
    if (item.kind === "message") {
      if (item.agentId !== undefined) continue;
      if (item.role === "user") return null;
      if (isProgress(item)) progressAfter = true;
      continue;
    }
    if (isAgentOwnedActivity(item)) continue;
    const overload = overloadOfActivity(item);
    const failure = overload !== null ? { reason: "overloaded" as const, message: overload.message, resetsAt: undefined } : failureReasonOfActivity(item);
    if (failure === null) {
      if (isProgress(item)) progressAfter = true;
      continue;
    }
    if (failure.reason !== "usage_limit" && failure.reason !== "overloaded") continue;
    if (progressAfter) return null;
    const at = Date.parse(item.createdAt);
    const latest = turns.at(-1) ?? null;
    if (latest !== null && latest.turnId !== item.turnId) {
      const requested = Date.parse(latest.requestedAt);
      if (Number.isFinite(requested) && Number.isFinite(at) && requested > at) return null;
    }
    let own: Turn | null = item.turnId === null ? latest : null;
    for (let t = turns.length - 1; own === null && item.turnId !== null && t >= 0; t -= 1) {
      if (turns[t]!.turnId === item.turnId) own = turns[t]!;
    }
    const parked = own !== null && (own.state === "running" || own.state === "pending");
    return {
      activityId: item.id,
      turnId: item.turnId,
      ...(failure.resetsAt !== undefined ? { resetsAt: failure.resetsAt } : {}),
      message: failure.message.slice(0, 500),
      at: item.createdAt,
      parked,
      ...(failure.reason === "overloaded" ? { kind: "overloaded" as const } : {})
    };
  }
  return null;
}

/**
 * Where the automatic resume of a limited chat stands:
 * - `armed`: the daemon sends {@link USAGE_LIMIT_CONTINUE_MESSAGE} at `resumeAt`;
 * - `resuming`: it is sending it (or switching the account) now;
 * - `off`: the reset is known but nothing is scheduled (cancelled, or the setting is off);
 * - `unscheduled`: no reset time is known, so nothing can be scheduled.
 */
export type ChatAutoResumeStatus = "armed" | "resuming" | "off" | "unscheduled";

export const CHAT_AUTO_RESUME_STATUSES = ["armed", "resuming", "off", "unscheduled"] as const satisfies readonly ChatAutoResumeStatus[];

/** The resume or account switch the daemon is carrying out, persisted before its side effects. */
export interface ChatUsageLimitAction {
  kind: "resume" | "switch";
  /** The command id the turn goes out under (the switch's account command adds `:account`). */
  commandId: string;
  /** `switch`: the account the chat moves to. */
  accountId?: string;
  startedAt: string;
  /** Started by the daemon (a scheduled resume, an automatic failover), not by the user. */
  automatic?: boolean;
}

/**
 * A limited chat's recovery state (`SessionSummary.usageLimit`). Persisted on the tab record
 * (`sessions.json`), so a daemon restart rebuilds the schedule; null when the chat is not limited.
 */
export interface ChatUsageLimitState {
  /** The failure row the limit was read from ({@link ThreadUsageLimitNotice.activityId}). */
  noticeId: string;
  turnId: string | null;
  /** When the daemon noticed the limit. */
  detectedAt: string;
  /** When the provider reported it (the row's time). */
  limitedAt: string;
  /** When the account's limit resets: the provider's stamp, else the usage reading's; null when unknown. */
  resetAt: string | null;
  /** The account the chat ran on when the limit hit; "" for the system login. */
  accountId: string;
  /** The turn is parked rather than failed (it is interrupted before the resume). */
  parked: boolean;
  autoResume: ChatAutoResumeStatus;
  /** When the automatic resume goes out (`armed` only). */
  resumeAt: string | null;
  /** The user cancelled the automatic resume; the setting turning on again does not re-arm it. */
  userCancelled?: true;
  /** The provider's message, for a tooltip. */
  message?: string;
  action?: ChatUsageLimitAction;
  /** Absent: a usage limit. `overloaded`: `resetAt` is when the retry is due, not an account reset. */
  kind?: UsageLimitKind;
}

/** The chat moved to another account after a usage limit (`SessionSummary.limitFailover`). */
export interface ChatLimitFailover {
  fromAccountId: string;
  toAccountId: string;
  at: string;
  /** The daemon switched on its own (the opt-in setting), not the user from the banner. */
  automatic: boolean;
}

/** The actions of {@link agentChatRoutes.usageLimit}. */
export const USAGE_LIMIT_ACTIONS = ["auto-resume", "resume", "switch", "dismiss-failover"] as const;
export type UsageLimitAction = (typeof USAGE_LIMIT_ACTIONS)[number];

/** `POST …/usage-limit/auto-resume`: arm or cancel the automatic resume. */
export interface UsageLimitAutoResumeRequest {
  armed: boolean;
}

/** `POST …/usage-limit/resume`: send the continue message now. */
export interface UsageLimitResumeRequest {
  /** Client-minted; a retry with the same id never sends twice. */
  commandId: string;
}

/**
 * `POST …/usage-limit/switch`: move the chat to another account of its family and continue.
 * Without `accountId` the daemon picks the best account (the workflows' least-used selection).
 */
export interface UsageLimitSwitchRequest {
  commandId: string;
  accountId?: string;
}

/** Every usage-limit action answers the chat's state after it. */
export interface UsageLimitActionResponse {
  usageLimit: ChatUsageLimitState | null;
  limitFailover: ChatLimitFailover | null;
}
