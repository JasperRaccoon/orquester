/**
 * The daemon's coarse view of every chat thread (spec §6.4).
 *
 * It reads `GET /threads/:id/summary` on the agent-host socket — the host's
 * own projection of the six derived fields — and from that one read produces
 * everything the daemon owes the rest of the app:
 *
 * 1. the six `SessionSummary` fields, so every surface that already reads only
 *    a `SessionSummary` — tab strip, Attention Center, command palette, push
 *    gate — keeps working with no thread subscription;
 * 2. `session.activity`, resolved by the ONE ladder of `activity-ladder.ts`
 *    (never re-derived per surface), plus the coarse bus events;
 * 3. the "needs your input" / "finished" pushes, now produced from protocol
 *    state instead of bells and hooks, behind the existing 30 s per-session
 *    per-type debounce and §6.4's liveness suppression.
 *
 * **Why a poll rather than a subscription.** `backgroundLiveness` lives in an
 * in-memory registry inside the host (§3.1: "deliberately not persisted"), so
 * no fold over `events.ndjson` can produce it and the host's per-thread event
 * stream does not carry it — `…/summary` is its only source. The poll is
 * scoped to threads that have an open tab, runs only while at least one
 * exists, and is skipped entirely while the host is not healthy, so an idle
 * daemon costs nothing. Nothing higher-rate than this ever rides the bus.
 */

import type { SessionActivity, SessionActivityEvent, SessionSummary } from "@orquester/api";
import type {
  AgentChatPendingEventPayload,
  AgentChatSessionSummaryFields,
  AgentChatTurnEventPayload,
  AgentProvidersChangedPayload,
  BackgroundLiveness,
  LatestTurnSummary,
  ThreadSessionStatus,
  TurnState
} from "@orquester/api/agent-chat";
import { SETTLED_TURN_STATES } from "@orquester/api/agent-chat";
import { agentHostExtraRoutes, type AgentHostPendingRequest } from "../agent-host/server/index.ts";
import {
  pushTypeForFields,
  resolveChatActivity,
  type ChatPushType
} from "./activity-ladder.ts";
import type { ChatSessionManager } from "./chat-sessions.ts";
import { AgentHostClient } from "./host-client.ts";

/**
 * How often the open tabs' summaries are re-read. Fast enough that a tab's dot
 * and a "needs your input" push feel immediate, slow enough to be free: each
 * tick is one small JSON read per OPEN chat tab over a local unix socket.
 */
export const SUMMARY_POLL_INTERVAL_MS = 1_500;

/** A read that hangs must never stall the next tick. */
export const SUMMARY_READ_TIMEOUT_MS = 5_000;

export interface SummaryBroadcaster {
  publish(channel: string, type: string, payload: unknown): void;
}

export interface SummaryPush {
  notifyStructural(session: SessionSummary, type: ChatPushType): Promise<void>;
}

export interface AgentChatSummaryOptions {
  client: AgentHostClient;
  chat: ChatSessionManager;
  broadcaster: SummaryBroadcaster;
  push: SummaryPush;
  /** False while the host is restarting or foreign — the poll then idles. */
  isHostHealthy?: () => boolean;
  now?: () => number;
  logger?: { warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
  /**
   * A turn reached a settled state. The supervisor's version drain-restart
   * (§3.1 case 3) waits on "no thread has an active turn", and this is what
   * lets a deploy hand over the moment the host goes quiet instead of on the
   * next 15 s health tick.
   */
  onTurnSettled?: () => void;
  /**
   * A thread's background liveness went from live to none. The same drain
   * window as `onTurnSettled`: the §3.1 restart also waits on subagent fleets
   * and watch loops, which have no turn to settle.
   */
  onBackgroundWorkEnded?: () => void;
  /** Test seam: replaces the interval so a test never waits on a clock. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

/** What the service remembers per thread, beyond the summary itself. */
interface ThreadState {
  fields: AgentChatSessionSummaryFields;
  activity: SessionActivity;
  /**
   * The open requests as of the last poll, keyed by `requestId`. Diffed against
   * the next poll so `agentChat.pending` fires once per open and once per
   * close, never once per tick (§6.4: nothing higher-rate rides the bus).
   */
  pending: Map<string, AgentHostPendingRequest>;
  /**
   * The instant of the last poll folded in (the `now` behind its stamp). A
   * settled turn whose `completedAt` is later settled since we last looked.
   */
  polledAt: number;
}

export class AgentChatSummaryService {
  private readonly threads = new Map<string, ThreadState>();
  private timer: unknown = null;
  private polling = false;
  /** True once one poll round has completed — before that the view is unknown. */
  private polledOnce = false;
  private readonly now: () => number;

  constructor(private readonly opts: AgentChatSummaryOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Start the poll. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    const set = this.opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    const handle = set(() => void this.refreshAll(), SUMMARY_POLL_INTERVAL_MS);
    // Unref'd: a poll must never hold the process open on shutdown.
    handle.unref?.();
    this.timer = handle;
  }

  stop(): void {
    if (this.timer === null) return;
    const clear = this.opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as never));
    clear(this.timer);
    this.timer = null;
  }

  /** Awaits an in-flight tick. Test/teardown helper. */
  async stopAndWait(): Promise<void> {
    this.stop();
    // `refreshAll` is re-entrancy guarded, so once `polling` clears nothing is
    // in flight.
    while (this.polling) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Drop what we know about a thread — the tab was closed, so no further
   * activity or push may be produced for it.
   */
  forget(threadId: string): void {
    this.threads.delete(threadId);
  }

  /** The current activity for a chat tab, for `SessionSummary.activity`. */
  activity(threadId: string): SessionActivity | undefined {
    return this.threads.get(threadId)?.activity;
  }

  /**
   * Threads whose last summary reported live background work (a subagent
   * fleet, a watch loop) — the daemon's own view for the §3.1 drain-restart
   * (`SupervisorAdapters.backgroundWorkThreadIds`), which a host from before
   * `GET /health` carried the field cannot report itself.
   */
  threadsWithBackgroundLiveness(): string[] {
    const out: string[] = [];
    for (const [threadId, state] of this.threads) {
      if (hasBackgroundLiveness(state.fields)) out.push(threadId);
    }
    return out;
  }

  /** The coarse `agent.providers.changed` of §6.4; the client re-reads §6.3. */
  publishProvidersChanged(payload: AgentProvidersChangedPayload = {}): void {
    this.opts.broadcaster.publish("registry", "agent.providers.changed", payload);
  }

  /** One tick: re-read every open chat tab's summary. Never throws. */
  async refreshAll(): Promise<void> {
    if (this.polling) return;
    if (this.opts.isHostHealthy && !this.opts.isHostHealthy()) return;
    const ids = this.opts.chat.list().map((s) => s.id);
    if (ids.length === 0) {
      // Nothing open: drop any stale state and do no I/O at all.
      this.threads.clear();
      this.polledOnce = true;
      return;
    }
    this.polling = true;
    try {
      await Promise.all(ids.map((id) => this.refreshThread(id)));
    } finally {
      this.polling = false;
      this.polledOnce = true;
    }
  }

  /**
   * False until the first poll round has completed. The supervisor's boot
   * adoption runs BEFORE the poll starts, so a stale host it wants to drain
   * must not be judged on an empty view: `threadsWithBackgroundLiveness` is
   * "unknown", not "none", until this flips.
   */
  hasPolled(): boolean {
    return this.polledOnce;
  }

  /**
   * Read one thread's summary and fold it in. A read that fails leaves the last
   * known state alone rather than blanking the tab: a host restarting mid-poll
   * must not make every tab flicker to "unknown".
   */
  async refreshThread(threadId: string): Promise<void> {
    let raw: unknown;
    try {
      const response = await this.opts.client.json<unknown>(
        "GET",
        agentHostExtraRoutes.summary(threadId),
        undefined,
        { timeoutMs: SUMMARY_READ_TIMEOUT_MS }
      );
      if (response.status === 404) {
        // The host has no such thread (deleted there, or never created). The
        // TAB may still exist here, so close out every request we told clients
        // about rather than leaving a card that can never be answered.
        const state = this.threads.get(threadId);
        if (state) {
          for (const request of state.pending.values()) {
            this.publishPending(threadId, request, false);
          }
        }
        this.threads.delete(threadId);
        return;
      }
      if (response.status !== 200) return;
      raw = response.value;
    } catch {
      return;
    }
    this.applyFields(threadId, sanitizeFields(raw), sanitizePendingRequests(raw));
  }

  /**
   * Merge the six fields onto the tab, resolve the ladder, broadcast what
   * changed, and push.
   *
   * Exposed so tests drive the fold directly, without a host.
   */
  applyFields(
    threadId: string,
    fields: AgentChatSessionSummaryFields,
    pendingRequests: readonly AgentHostPendingRequest[] = []
  ): void {
    if (!this.opts.chat.has(threadId)) {
      // A thread the daemon has no tab for (closed here, still live there).
      this.threads.delete(threadId);
      return;
    }
    const previous = this.threads.get(threadId);
    const resolution = resolveChatActivity(fields);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const attentionChanged = (previous?.activity.attention ?? null) !== resolution.attention;
    const previousPending = previous?.pending ?? new Map<string, AgentHostPendingRequest>();
    const pending = this.publishPendingTransitions(threadId, previousPending, pendingRequests);
    const previousTurn = previous?.fields.latestTurn ?? null;
    const latestTurn = fields.latestTurn ?? null;
    // `needsAttentionAt` is the Attention Center's `flaggedAt` and the MCP
    // `wait_for_session` cursor (MCP spec §9.2): it must move whenever something
    // NEW calls for the user, not only when the attention VALUE changes. Two
    // things happen inside one poll with the value unchanged — approval A
    // answered and approval B raised (`needs-input` throughout), and a turn that
    // starts and settles (`finished` throughout) — and a stamp that did not
    // move hid both from a waiter looping on its cursor. A request that stays
    // open, or a turn that stays settled, keeps its stamp; so does a rewind or
    // a history replay, which move `latestTurn` onto turns that settled long ago.
    const restamp =
      attentionChanged ||
      [...pending.keys()].some((requestId) => !previousPending.has(requestId)) ||
      (previous !== undefined && settledSince(latestTurn, previous.polledAt));
    const activity: SessionActivity = {
      state: resolution.state,
      attention: resolution.attention,
      // A chat thread has no PTY output; the field stays null rather than
      // pretending to a timestamp the tab never produced.
      lastOutputAt: previous?.activity.lastOutputAt ?? null,
      needsAttentionAt:
        resolution.attention === null
          ? null
          : restamp
            ? nowIso
            : (previous?.activity.needsAttentionAt ?? nowIso)
    };
    this.threads.set(threadId, { fields, activity, pending, polledAt: nowMs });
    // Background work ending reopens the §3.1 drain window exactly as a turn
    // settling does: a deploy's handover otherwise waits for the next 15 s
    // health tick.
    if (
      previous !== undefined &&
      hasBackgroundLiveness(previous.fields) &&
      !hasBackgroundLiveness(fields)
    ) {
      this.opts.onBackgroundWorkEnded?.();
    }

    // The tab's own copy of the six fields (the tab strip reads them off the
    // summary), published only when one actually moved.
    this.opts.chat.applyFields(threadId, fields);
    this.opts.chat.setActivity(threadId, activity);

    // The stamp is compared too: a restamp with nothing else moving is exactly
    // what a waiter on the bus needs to hear.
    const sameActivity =
      previous !== undefined &&
      previous.activity.state === activity.state &&
      previous.activity.attention === activity.attention &&
      previous.activity.needsAttentionAt === activity.needsAttentionAt;
    if (!sameActivity) {
      this.opts.broadcaster.publish("sessions", "session.activity", {
        id: threadId,
        activity
      } satisfies SessionActivityEvent);
    }

    this.publishTurnTransition(threadId, previousTurn, latestTurn);

    // Push only on a NEW attention, never on every tick that keeps it raised —
    // and never on the FIRST observation of a thread.
    //
    // `previous === undefined` means the daemon is *discovering* this thread's
    // state, not watching it change: after a restart (every deploy) the first
    // poll reads a long-settled turn as a brand-new "finished" attention and
    // would push one notification per open chat tab for work the user saw hours
    // ago. The in-memory 30 s debounce resets with the process, so it is no
    // backstop. Seed the baseline silently; push only on a transition we
    // actually observed. Same guard covers re-adoption after `forget()` or a
    // host handover.
    if (previous === undefined) {
      return;
    }
    // Gated on the attention VALUE, never on the stamp: a restamp alone (the
    // next approval under a still-raised `needs-input`) must not push again.
    if (!attentionChanged || resolution.attention === null) {
      return;
    }
    const pushType = pushTypeForFields(fields);
    if (!pushType) return;
    const summary = this.opts.chat.get(threadId);
    if (!summary) return;
    void this.opts.push.notifyStructural(summary, pushType);
  }

  /**
   * `agentChat.pending` — one event per request appearing and one per it
   * disappearing (§6.4), deduped by `requestId` across polls.
   *
   * The diff is against the previous poll's list rather than against the
   * booleans: a thread can close one approval and open another between two
   * ticks, and `hasPendingApprovals` would stay `true` through both — the
   * client would then never learn the first one was answered.
   *
   * Returns the new open set for the caller to store.
   */
  private publishPendingTransitions(
    threadId: string,
    before: ReadonlyMap<string, AgentHostPendingRequest>,
    after: readonly AgentHostPendingRequest[]
  ): Map<string, AgentHostPendingRequest> {
    const next = new Map<string, AgentHostPendingRequest>();
    for (const request of after) {
      if (!request || typeof request.requestId !== "string" || !request.requestId) continue;
      if (request.kind !== "approval" && request.kind !== "question") continue;
      next.set(request.requestId, {
        requestId: request.requestId,
        kind: request.kind,
        title: typeof request.title === "string" ? request.title : ""
      });
    }
    for (const [requestId, request] of next) {
      if (before.has(requestId)) continue;
      this.publishPending(threadId, request, true);
    }
    for (const [requestId, request] of before) {
      if (next.has(requestId)) continue;
      this.publishPending(threadId, request, false);
    }
    return next;
  }

  private publishPending(
    threadId: string,
    request: AgentHostPendingRequest,
    open: boolean
  ): void {
    const payload: AgentChatPendingEventPayload = {
      id: threadId,
      requestId: request.requestId,
      kind: request.kind,
      title: request.title,
      open
    };
    this.opts.broadcaster.publish("sessions", "agentChat.pending", payload);
  }

  /** `agentChat.turn` — one per turn transition. Nothing higher-rate rides the bus. */
  private publishTurnTransition(
    threadId: string,
    before: LatestTurnSummary | null,
    after: LatestTurnSummary | null
  ): void {
    if (after === null || !turnMoved(before, after)) return;
    const payload: AgentChatTurnEventPayload = {
      id: threadId,
      turnId: after.turnId,
      state: after.state
    };
    this.opts.broadcaster.publish("sessions", "agentChat.turn", payload);
    if (SETTLED_TURN_STATES.has(after.state)) {
      this.opts.onTurnSettled?.();
    }
  }
}

/**
 * The latest turn moved between two polls: a new turn id, or the same turn in
 * a new state. What `agentChat.turn` reports — every move, a rewind's included.
 */
function turnMoved(before: LatestTurnSummary | null, after: LatestTurnSummary): boolean {
  return before === null || before.turnId !== after.turnId || before.state !== after.state;
}

/**
 * The latest turn settled after `since`: a settled state, with a `completedAt`
 * later than that instant. This, not {@link turnMoved}, is what restamps the
 * attention:
 * - A rewind or a history replay moves `latestTurn` onto turns that settled long
 *   ago. A rewind keeps its rows whole, and `stampHistoryTimes` dates every
 *   replayed row before the thread was created.
 * - Two turns that fail before the provider names them settle with the same
 *   null id and state.
 * A settled turn's `completedAt` is written once and never rewritten
 * (`applySessionStatusToTurn`), so it is the one field that says "new". The
 * settled check is load-bearing too: a running turn's `completedAt` may hold a
 * mid-turn placeholder.
 */
function settledSince(turn: LatestTurnSummary | null, since: number): boolean {
  if (turn === null || turn.completedAt === null || !SETTLED_TURN_STATES.has(turn.state)) {
    return false;
  }
  // An unparseable stamp is NaN, and NaN is later than nothing: no restamp.
  return Date.parse(turn.completedAt) > since;
}

/**
 * Keep only the six §6.4 fields, each only when it has the right shape.
 *
 * This is another process's JSON reaching typed code, so it goes through
 * field-wise validation with a fallback exactly as AGENTS.md requires of every
 * persisted/adapter load: a field written by a newer host with an unexpected
 * type is dropped rather than trusted, because the ladder branches on it.
 */
/**
 * The `pendingRequests` half of the same body, validated row-wise. A malformed
 * row is dropped rather than published: `agentChat.pending` carries a
 * `requestId` a client will post an approval against, so a row without a usable
 * one is worse than no row.
 */
export function sanitizePendingRequests(value: unknown): AgentHostPendingRequest[] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as Record<string, unknown>).pendingRequests;
  if (!Array.isArray(rows)) return [];
  const out: AgentHostPendingRequest[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    if (typeof entry.requestId !== "string" || !entry.requestId) continue;
    if (entry.kind !== "approval" && entry.kind !== "question") continue;
    out.push({
      requestId: entry.requestId,
      kind: entry.kind,
      title: typeof entry.title === "string" ? entry.title : ""
    });
  }
  return out;
}

/** `working` or `monitoring`; an absent field reads as none. */
function hasBackgroundLiveness(fields: AgentChatSessionSummaryFields): boolean {
  return fields.backgroundLiveness === "working" || fields.backgroundLiveness === "monitoring";
}

export function sanitizeFields(value: unknown): AgentChatSessionSummaryFields {
  const fields: AgentChatSessionSummaryFields = {};
  if (!value || typeof value !== "object") {
    return fields;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.hasPendingApprovals === "boolean") fields.hasPendingApprovals = row.hasPendingApprovals;
  if (typeof row.hasPendingUserInput === "boolean") fields.hasPendingUserInput = row.hasPendingUserInput;
  if (typeof row.hasActionableProposedPlan === "boolean") {
    fields.hasActionableProposedPlan = row.hasActionableProposedPlan;
  }
  if (row.backgroundLiveness === "working" || row.backgroundLiveness === "monitoring") {
    fields.backgroundLiveness = row.backgroundLiveness as BackgroundLiveness;
  } else if (row.backgroundLiveness === null) {
    fields.backgroundLiveness = null;
  }
  if (row.latestTurn === null) {
    fields.latestTurn = null;
  } else if (row.latestTurn && typeof row.latestTurn === "object") {
    const turn = row.latestTurn as Record<string, unknown>;
    // MEMBERSHIP, not just type: a bogus `state` string falls through
    // `SETTLED_TURN_STATES.has(...)` as *not settled*, so `onTurnSettled` would
    // never fire and the §3.1 version drain-restart would stall a deploy's
    // handover with no diagnostic at all.
    if (isTurnState(turn.state)) {
      fields.latestTurn = {
        turnId: typeof turn.turnId === "string" ? turn.turnId : null,
        state: turn.state,
        startedAt: typeof turn.startedAt === "string" ? turn.startedAt : null,
        completedAt: typeof turn.completedAt === "string" ? turn.completedAt : null
      };
    }
  }
  if (isThreadSessionStatus(row.chatSessionStatus)) {
    fields.chatSessionStatus = row.chatSessionStatus;
  }
  return fields;
}

/** `TurnState` = `"pending" | "running"` plus the four `RuntimeTurnState`s. */
const TURN_STATES: ReadonlySet<string> = new Set<TurnState>([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled"
]);

const THREAD_SESSION_STATUSES: ReadonlySet<string> = new Set<ThreadSessionStatus>([
  "idle",
  "starting",
  "ready",
  "running",
  "stopped",
  "error"
]);

function isTurnState(value: unknown): value is TurnState {
  return typeof value === "string" && TURN_STATES.has(value);
}

function isThreadSessionStatus(value: unknown): value is ThreadSessionStatus {
  return typeof value === "string" && THREAD_SESSION_STATUSES.has(value);
}
