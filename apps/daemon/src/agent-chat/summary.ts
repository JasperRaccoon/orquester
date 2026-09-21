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
  AgentChatSessionSummaryFields,
  AgentChatTurnEventPayload,
  AgentProvidersChangedPayload,
  BackgroundLiveness,
  LatestTurnSummary,
  ThreadSessionStatus,
  TurnState
} from "@orquester/api/agent-chat";
import { SETTLED_TURN_STATES } from "@orquester/api/agent-chat";
import { agentHostExtraRoutes } from "../agent-host/server/extra-routes.ts";
import { pushTypeForFields, resolveChatActivity } from "./activity-ladder.ts";
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
  notifyStructural(session: SessionSummary, type: "needs-input" | "finished"): Promise<void>;
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
  /** Test seam: replaces the interval so a test never waits on a clock. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

/** What the service remembers per thread, beyond the summary itself. */
interface ThreadState {
  fields: AgentChatSessionSummaryFields;
  activity: SessionActivity;
}

export class AgentChatSummaryService {
  private readonly threads = new Map<string, ThreadState>();
  private timer: unknown = null;
  private polling = false;
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
      return;
    }
    this.polling = true;
    try {
      await Promise.all(ids.map((id) => this.refreshThread(id)));
    } finally {
      this.polling = false;
    }
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
        // The host has no such thread (deleted there, or never created).
        this.threads.delete(threadId);
        return;
      }
      if (response.status !== 200) return;
      raw = response.value;
    } catch {
      return;
    }
    this.applyFields(threadId, sanitizeFields(raw));
  }

  /**
   * Merge the six fields onto the tab, resolve the ladder, broadcast what
   * changed, and push.
   *
   * Exposed so tests drive the fold directly, without a host.
   */
  applyFields(threadId: string, fields: AgentChatSessionSummaryFields): void {
    if (!this.opts.chat.has(threadId)) {
      // A thread the daemon has no tab for (closed here, still live there).
      this.threads.delete(threadId);
      return;
    }
    const previous = this.threads.get(threadId);
    const resolution = resolveChatActivity(fields);
    const nowIso = new Date(this.now()).toISOString();
    const attentionChanged = (previous?.activity.attention ?? null) !== resolution.attention;
    const activity: SessionActivity = {
      state: resolution.state,
      attention: resolution.attention,
      // A chat thread has no PTY output; the field stays null rather than
      // pretending to a timestamp the tab never produced.
      lastOutputAt: previous?.activity.lastOutputAt ?? null,
      needsAttentionAt:
        resolution.attention === null
          ? null
          : attentionChanged
            ? nowIso
            : (previous?.activity.needsAttentionAt ?? nowIso)
    };
    this.threads.set(threadId, { fields, activity });

    // The tab's own copy of the six fields (the tab strip reads them off the
    // summary), published only when one actually moved.
    this.opts.chat.applyFields(threadId, fields);
    this.opts.chat.setActivity(threadId, activity);

    const sameActivity =
      previous !== undefined &&
      previous.activity.state === activity.state &&
      previous.activity.attention === activity.attention;
    if (!sameActivity) {
      this.opts.broadcaster.publish("sessions", "session.activity", {
        id: threadId,
        activity
      } satisfies SessionActivityEvent);
    }

    this.publishTurnTransition(threadId, previous?.fields.latestTurn ?? null, fields.latestTurn ?? null);

    // Push only on a NEW attention, never on every tick that keeps it raised.
    if (!attentionChanged || resolution.attention === null) {
      return;
    }
    const pushType = pushTypeForFields(fields);
    if (!pushType) return;
    const summary = this.opts.chat.get(threadId);
    if (!summary) return;
    void this.opts.push.notifyStructural(summary, pushType);
  }

  /** `agentChat.turn` — one per turn transition. Nothing higher-rate rides the bus. */
  private publishTurnTransition(
    threadId: string,
    before: LatestTurnSummary | null,
    after: LatestTurnSummary | null
  ): void {
    if (!after) return;
    if (before && before.turnId === after.turnId && before.state === after.state) return;
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
 * Keep only the six §6.4 fields, each only when it has the right shape.
 *
 * This is another process's JSON reaching typed code, so it goes through
 * field-wise validation with a fallback exactly as AGENTS.md requires of every
 * persisted/adapter load: a field written by a newer host with an unexpected
 * type is dropped rather than trusted, because the ladder branches on it.
 */
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
    if (typeof turn.state === "string") {
      fields.latestTurn = {
        turnId: typeof turn.turnId === "string" ? turn.turnId : null,
        state: turn.state as TurnState,
        startedAt: typeof turn.startedAt === "string" ? turn.startedAt : null,
        completedAt: typeof turn.completedAt === "string" ? turn.completedAt : null
      };
    }
  }
  if (typeof row.chatSessionStatus === "string") {
    fields.chatSessionStatus = row.chatSessionStatus as ThreadSessionStatus;
  }
  return fields;
}
