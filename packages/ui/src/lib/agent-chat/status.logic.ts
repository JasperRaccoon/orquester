/**
 * Agent chat — the status line, the §6.4 activity ladder and the context-window
 * meter (spec §6.4, §7.6, §7.7).
 *
 * Ported from T3 Code (MIT): `packages/shared/src/agentAwareness.ts:76-113`
 * (the ladder and both race fallbacks), `apps/web/src/lib/contextWindow.ts`
 * (`deriveLatestContextWindowSnapshot`, `formatContextWindowTokens`) and
 * `apps/web/src/components/Sidebar.logic.ts` (unread, recede).
 *
 * The ladder lives here **once**: §6.4 says this ladder, and no per-surface
 * variant of it. Every ambient surface reads it off `SessionSummary`.
 *
 * No React import.
 */

import type {
  BackgroundLiveness,
  LatestTurnSummary,
  ThreadActivityItem,
  ThreadSessionStatus,
  ThreadTokenUsage,
  TurnState
} from "@orquester/api/agent-chat";

import { hasUnseenCompletion as threadHasUnseenCompletion } from "../thread-visits";

// ---------------------------------------------------------------------------
// The §6.4 activity ladder lives on the HOST
// ---------------------------------------------------------------------------
//
// It used to be mirrored here as `resolveChatActivity` / `resolveChatStatusPill`
// / `statusPillPulses`. Nothing consumed them: every ambient surface buckets on
// the daemon-pushed `SessionActivity` (`components/attention/agent-sessions.ts`),
// which the host derives once in `apps/daemon/src/agent-chat/activity-ladder.ts`
// — which is exactly what §7.1 asks for ("ambient surfaces read a shell, never
// a thread"). A second copy of a ladder whose whole point is that there is one
// of it is a drift hazard, so the fix wave deleted it (R7-12).
// ---------------------------------------------------------------------------
// Unread (§7.7)
// ---------------------------------------------------------------------------

/**
 * **Needs-attention and unread are two different things.** Unread is: the
 * latest turn's `completedAt` is newer than this client's last visit.
 *
 * The rule itself lives **once**, in `lib/thread-visits.ts` (which also owns
 * the persisted per-device map); this is the `LatestTurnSummary`-shaped
 * adapter the chat surfaces already hold.
 *
 * *T3: `Sidebar.logic.ts:635-644` (`hasUnseenCompletion`).*
 */
export function hasUnseenCompletion(input: {
  latestTurn?: LatestTurnSummary | null;
  lastVisitedAt?: string | null;
}): boolean {
  return threadHasUnseenCompletion(
    input.latestTurn?.completedAt,
    input.lastVisitedAt ?? undefined
  );
}

/**
 * A "mark unread" action is **just a last-visit stamp set one millisecond
 * before that completion** (§7.7).
 *
 * *T3: `uiStateStore.ts:272-296` (`markThreadUnread`).*
 */
export function markUnreadVisitStamp(latestTurnCompletedAt: string | null | undefined): string | null {
  if (!latestTurnCompletedAt) {
    return null;
  }
  const completed = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(completed)) {
    return null;
  }
  return new Date(completed - 1).toISOString();
}

// ---------------------------------------------------------------------------
// Recede (§7.7)
// ---------------------------------------------------------------------------

/**
 * The bucket a sidebar row reads as, for the recede rule only.
 *
 * *T3: `Sidebar.logic.ts:812-819` (`SidebarThreadStatus`).* Deliberately NOT
 * the activity ladder: the ladder is the daemon's and this surface re-derives
 * none of it. This says what the row is *doing*, which is the only thing
 * receding needs — whether it needs the user's eyes is the separate unread
 * signal.
 */
export type SidebarThreadStatus = "approval" | "input" | "working" | "monitoring" | "ready";

/**
 * *T3: `Sidebar.logic.ts:836-859` (`resolveSidebarThreadStatus`), minus its
 * `failed` bucket* — T3 recedes `failed` exactly like `ready`, so folding the
 * two changes no behaviour here and keeps this from looking like a second
 * ladder.
 */
export function resolveSidebarThreadStatus(row: {
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  chatSessionStatus?: ThreadSessionStatus | null;
  backgroundLiveness?: BackgroundLiveness | null;
}): SidebarThreadStatus {
  if (row.hasPendingApprovals) return "approval";
  if (row.hasPendingUserInput) return "input";
  if (row.chatSessionStatus === "running" || row.chatSessionStatus === "starting") {
    return "working";
  }
  if (row.backgroundLiveness === "working") return "working";
  if (row.backgroundLiveness === "monitoring") return "monitoring";
  return "ready";
}

/**
 * Whether a sidebar row should **recede** — render dimmed, so the rows that
 * want something stay loud. Inbox-zero, not decoration.
 *
 * *T3: `Sidebar.logic.ts:820-833` (`shouldRecedeSidebarThread`).*
 *
 * - the selected row never recedes;
 * - `input` never recedes: something is blocked on the user;
 * - `working` / `monitoring` always recede — an agent that is busy wants
 *   nothing from you;
 * - `ready` and `approval` recede only when there is nothing unseen about
 *   them. (T3 also un-recedes a row whose snooze just woke; Orquester has no
 *   snooze, so that input is always false here.)
 */
export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isSelected: boolean;
}): boolean {
  if (input.isSelected || input.status === "input") return false;
  if (input.status === "working" || input.status === "monitoring") return true;
  return !input.isUnread;
}

/** A visit stamp only ever moves forward. *T3: `uiStateStore.ts:250-270`.* */
export function nextVisitStamp(previous: string | null | undefined, visitedAt: string): string | null {
  const next = Date.parse(visitedAt);
  if (!Number.isFinite(next)) {
    return previous ?? null;
  }
  const before = previous ? Date.parse(previous) : Number.NaN;
  if (Number.isFinite(before) && before >= next) {
    return previous ?? null;
  }
  return visitedAt;
}

// ---------------------------------------------------------------------------
// The activity label (§7.6)
// ---------------------------------------------------------------------------

/**
 * The status line's current-activity label. Deliberately short and derived
 * from state the store already holds — anything that changes every second is a
 * self-ticking leaf, never a prop pushed down the row tree (§7.6).
 */
export function resolveActivityLabel(input: {
  connection: "idle" | "connecting" | "synchronized" | "reconnecting" | "error";
  sessionStatus: ThreadSessionStatus | null;
  turnStatus: TurnState | null;
  backgroundLiveness: BackgroundLiveness | null;
  liveToolLabel?: string | null;
  pendingApprovals: number;
  pendingQuestions: number;
}): string | null {
  if (input.connection === "reconnecting") {
    return "Reconnecting…";
  }
  if (input.connection === "error") {
    return "Disconnected";
  }
  if (input.pendingApprovals > 0) {
    return input.pendingApprovals === 1 ? "Waiting for approval" : `${input.pendingApprovals} approvals`;
  }
  if (input.pendingQuestions > 0) {
    return "Waiting for your answer";
  }
  if (input.sessionStatus === "error") {
    return "Session error";
  }
  if (input.sessionStatus === "starting") {
    return "Starting…";
  }
  if (input.turnStatus === "pending") {
    return "Sending…";
  }
  if (input.turnStatus === "running" || input.sessionStatus === "running") {
    return input.liveToolLabel ?? "Working";
  }
  if (input.backgroundLiveness === "working") {
    return "Background work";
  }
  if (input.backgroundLiveness === "monitoring") {
    return "Monitoring";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context window (§7.6)
// ---------------------------------------------------------------------------

/**
 * Without `maxTokens` there is **no ring and no percentage, only a bare
 * total** — on an adapter with `reportsContextWindow: false` the meter
 * degrades rather than showing zeros (§7.6).
 *
 * *T3: `contextWindow.ts:28-75`.*
 */
export interface ContextWindowSnapshot {
  usedTokens: number;
  maxTokens: number | null;
  autoCompactAtTokens: number | null;
  totalProcessedTokens: number | null;
  remainingTokens: number | null;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  updatedAt: string | null;
}

export function contextWindowSnapshot(
  usage: ThreadTokenUsage | null,
  updatedAt: string | null = null
): ContextWindowSnapshot | null {
  if (!usage || !Number.isFinite(usage.usedTokens) || usage.usedTokens < 0) {
    return null;
  }
  const maxTokens =
    typeof usage.maxTokens === "number" && Number.isFinite(usage.maxTokens) && usage.maxTokens > 0
      ? usage.maxTokens
      : null;
  const usedPercentage = maxTokens !== null ? Math.min(100, (usage.usedTokens / maxTokens) * 100) : null;
  return {
    usedTokens: usage.usedTokens,
    maxTokens,
    autoCompactAtTokens:
      typeof usage.autoCompactAtTokens === "number" && Number.isFinite(usage.autoCompactAtTokens)
        ? usage.autoCompactAtTokens
        : null,
    totalProcessedTokens:
      typeof usage.totalProcessedTokens === "number" && Number.isFinite(usage.totalProcessedTokens)
        ? usage.totalProcessedTokens
        : null,
    remainingTokens: maxTokens !== null ? Math.max(0, Math.round(maxTokens - usage.usedTokens)) : null,
    usedPercentage,
    remainingPercentage: usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null,
    updatedAt
  };
}

/** The latest `context-window.updated` activity, newest first. *T3: `contextWindow.ts:28-42`.* */
export function latestContextWindowActivity(
  activities: readonly ThreadActivityItem[]
): { usage: ThreadTokenUsage; updatedAt: string } | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.activityKind !== "context-window.updated") {
      continue;
    }
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    const usedTokens = record.usedTokens;
    if (typeof usedTokens !== "number" || !Number.isFinite(usedTokens) || usedTokens < 0) {
      continue;
    }
    const usage: ThreadTokenUsage = {
      usedTokens,
      ...(typeof record.maxTokens === "number" ? { maxTokens: record.maxTokens } : {}),
      ...(typeof record.autoCompactAtTokens === "number"
        ? { autoCompactAtTokens: record.autoCompactAtTokens }
        : {}),
      ...(typeof record.totalProcessedTokens === "number"
        ? { totalProcessedTokens: record.totalProcessedTokens }
        : {})
    };
    return { usage, updatedAt: activity.createdAt };
  }
  return null;
}

/** *T3: `contextWindow.ts:77-90`.* */
export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** The auto-compaction sentence under the meter. *T3: `ContextWindowMeter.logic.ts:100-110`.* */
export function autoCompactionSentence(snapshot: ContextWindowSnapshot | null): string | null {
  if (!snapshot || snapshot.autoCompactAtTokens === null || snapshot.maxTokens === null) {
    return null;
  }
  const at = formatContextWindowTokens(snapshot.autoCompactAtTokens);
  return snapshot.usedTokens >= snapshot.autoCompactAtTokens
    ? `Compacts automatically past ${at} tokens — the next turn may compact.`
    : `Compacts automatically at ${at} tokens.`;
}
