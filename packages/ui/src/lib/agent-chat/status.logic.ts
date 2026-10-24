/**
 * Agent chat — status labels, sidebar receding and context-window activity
 * selection (spec §6.4, §7.6, §7.7).
 *
 * Ported from T3 Code (MIT): `packages/shared/src/agentAwareness.ts:76-113`
 * (the ladder and both race fallbacks), `apps/web/src/lib/contextWindow.ts`
 * (`deriveLatestContextWindowSnapshot`) and
 * `apps/web/src/components/Sidebar.logic.ts` (unread, recede).
 *
 * The ladder lives here **once**: §6.4 says this ladder, and no per-surface
 * variant of it. Every ambient surface reads it off `SessionSummary`.
 *
 * No React import.
 */

import {
  SETTLED_TURN_STATES,
  promptCacheExpiryOf,
  type BackgroundLiveness,
  type ThreadActivityItem,
  type ThreadSessionStatus,
  type ThreadTokenUsage,
  type TurnState
} from "@orquester/api/agent-chat";

import { compactionMarkerState, isCompactionActivity } from "./entries.logic";

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

// ---------------------------------------------------------------------------
// The compaction phase (§7.3, §7.6)
// ---------------------------------------------------------------------------

/**
 * Whether the provider is rewriting the conversation **right now**.
 *
 * A compaction is the one kind of work that produces no rows at all while it
 * runs: on a long thread the timeline sat on "Working for 31s" and a "Thinking"
 * placeholder for minutes, which is indistinguishable from a hung agent. The
 * phase is what lets every live surface say what is actually happening.
 *
 * Two halves, and the second is the one that matters:
 *
 *  - the **latest** compaction marker is the in-flight one (`compacting`), and
 *    no later marker — `compacted` or `compaction-failed` — has superseded it;
 *  - **the session is still live.** The host may abandon a compaction after a
 *    deadline, and an adapter that dies mid-compaction emits no terminal
 *    marker at all, so a phase only a marker could end would shimmer
 *    "Compacting context…" forever on a thread that has been idle for hours. A
 *    settled turn, or a session that is `ready`/`stopped`/`error`, ends it.
 *
 * *T3: `ChatView.tsx:3234-3237` — the same two halves, spelled against its own
 * `phase`/`isSendBusy` pair.*
 */
export function isCompactingThread(input: {
  activities: readonly ThreadActivityItem[];
  sessionStatus: ThreadSessionStatus | null;
  turnStatus: TurnState | null;
}): boolean {
  if (input.turnStatus !== null && SETTLED_TURN_STATES.has(input.turnStatus)) {
    return false;
  }
  if (
    input.sessionStatus !== null &&
    input.sessionStatus !== "running" &&
    input.sessionStatus !== "starting"
  ) {
    return false;
  }
  return latestCompactionIsInFlight(input.activities);
}

/** Whether the latest compaction marker of `activities` is the in-flight one; by list, as a list never changes. */
const compactionInFlightByList = new WeakMap<readonly ThreadActivityItem[], boolean>();

function latestCompactionIsInFlight(activities: readonly ThreadActivityItem[]): boolean {
  const cached = compactionInFlightByList.get(activities);
  if (cached !== undefined) {
    return cached;
  }
  let inFlight = false;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (!isCompactionActivity(activity)) {
      continue;
    }
    inFlight = compactionMarkerState(activity) === "compacting";
    break;
  }
  compactionInFlightByList.set(activities, inFlight);
  return inFlight;
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
  connection: "idle" | "connecting" | "synchronized" | "reconnecting" | "error" | "gone";
  sessionStatus: ThreadSessionStatus | null;
  turnStatus: TurnState | null;
  backgroundLiveness: BackgroundLiveness | null;
  liveToolLabel?: string | null;
  pendingApprovals: number;
  pendingQuestions: number;
  /** {@link isCompactingThread}; replaces the generic working label (§7.6). */
  isCompacting?: boolean;
}): string | null {
  if (input.connection === "reconnecting") {
    return "Reconnecting…";
  }
  if (input.connection === "error") {
    return "Disconnected";
  }
  if (input.connection === "gone") {
    return "This chat no longer exists";
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
    // A compaction outranks the live tool label: the last tool the agent ran
    // before the compaction started is not what the thread is doing now.
    return input.isCompacting === true ? "Compacting…" : (input.liveToolLabel ?? "Working");
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

/** The latest `context-window.updated` activity, newest first. *T3: `contextWindow.ts:28-42`.* */
export function latestContextWindowActivity(
  activities: readonly ThreadActivityItem[]
): ContextWindowActivity | null {
  // Read on every projection, of a list a streamed token leaves as it was.
  const cached = contextWindowByList.get(activities);
  if (cached !== undefined) {
    return cached;
  }
  const latest = scanLatestContextWindowActivity(activities);
  contextWindowByList.set(activities, latest);
  return latest;
}

interface ContextWindowActivity {
  usage: ThreadTokenUsage;
  updatedAt: string;
}

/** {@link latestContextWindowActivity} by list — the lists are never mutated once built. */
const contextWindowByList = new WeakMap<readonly ThreadActivityItem[], ContextWindowActivity | null>();

function scanLatestContextWindowActivity(
  activities: readonly ThreadActivityItem[]
): ContextWindowActivity | null {
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
        : {}),
      // Copied field-wise like the rest: an activity written by an older host
      // simply omits it, and "the provider never said" is a different reading
      // from "the provider said no".
      ...(typeof record.compactsAutomatically === "boolean"
        ? { compactsAutomatically: record.compactsAutomatically }
        : {}),
    };
    // Idle compaction's "When you return" offer reads when the prompt cache expires: the daemon's
    // own rule, which carries the last request's expiry past a restarted session's context read.
    const expiry = promptCacheExpiryOf(activities);
    if (expiry !== null) {
      usage.promptCacheExpiresAt = expiry.expiresAt;
      if (expiry.ttlMs !== undefined) usage.promptCacheTtlMs = expiry.ttlMs;
    }
    return { usage, updatedAt: activity.createdAt };
  }
  return null;
}

// ---------------------------------------------------------------------------
// A thread the host does not hold (`connection: "gone"`)
// ---------------------------------------------------------------------------

/**
 * What a tab's view remembers between renders to tell a thread that is gone
 * from one still being created: whether its record said `chatPending` since
 * its stream last synchronized, and the record it last saw.
 */
export interface GoneWatch {
  sawPending: boolean;
  record: unknown;
}

export function initialGoneWatch(input: { pending: boolean; record: unknown }): GoneWatch {
  return { sawPending: input.pending, record: input.record };
}

/**
 * The watches of the threads' live slices, kept past a view's unmount: a
 * slice lingers for a short grace after its last view goes, still `gone`,
 * and a view remounted within it must carry on from what the last one saw —
 * a record that stopped being pending, or changed, while no view watched
 * still earns its one look. Keyed by the slice (its `actions`), so a slice
 * the registry disposed takes its watch with it and a new one starts fresh.
 */
export class GoneWatches {
  private readonly watches = new WeakMap<object, GoneWatch>();

  /** The watch a view mounting on `slice` starts from: the last view's, else a fresh one. */
  watchFor(slice: object, input: { pending: boolean; record: unknown }): GoneWatch {
    return this.watches.get(slice) ?? initialGoneWatch(input);
  }

  remember(slice: object, watch: GoneWatch): void {
    this.watches.set(slice, watch);
  }
}

/**
 * How a tab whose stream answered `THREAD_NOT_FOUND` is shown. A tab whose
 * record is — or was, since its stream last synchronized — `chatPending` is
 * being created (a grid cell opens its stream on `session.created`, before
 * the host has the thread): `starting`, never `gone`. So is one whose record
 * changed since the watch last saw it: {@link nextGoneWatch} connects it
 * again on this very render, so it is not said to be gone before that look.
 */
export function goneDisplay(input: {
  gone: boolean;
  pending: boolean;
  record: unknown;
  watch: GoneWatch;
}): "live" | "starting" | "gone" {
  if (!input.gone) return "live";
  return input.pending || input.watch.sawPending || input.record !== input.watch.record ? "starting" : "gone";
}

/**
 * The next {@link GoneWatch}, and whether the stream should connect again: a
 * gone tab whose record stopped being pending (the host created the thread —
 * before or after the stream met the miss) retries once by itself, and so does
 * one whose record changed (a fork the daemon confirmed); a pending one waits
 * for its record to change.
 */
export function nextGoneWatch(
  watch: GoneWatch,
  input: { connection: string; pending: boolean; record: unknown }
): { watch: GoneWatch; retry: boolean } {
  const { connection, pending, record } = input;
  if (connection === "synchronized") return { watch: { sawPending: pending, record }, retry: false };
  if (connection !== "gone") return { watch: { sawPending: watch.sawPending || pending, record }, retry: false };
  if (pending) return { watch: { sawPending: true, record }, retry: false };
  if (watch.sawPending) return { watch: { sawPending: false, record }, retry: true };
  return { watch: { sawPending: false, record }, retry: record !== watch.record };
}
