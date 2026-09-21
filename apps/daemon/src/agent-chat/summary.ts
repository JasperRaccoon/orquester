/**
 * The daemon's coarse view of every chat thread (spec §6.4).
 *
 * One long-lived subscription to the host's `/signals` stream feeds three
 * things and nothing else:
 *
 * 1. the six derived `SessionSummary` fields, so every surface that already
 *    reads only a `SessionSummary` — tab strip, Attention Center, command
 *    palette, push gate — keeps working with no thread subscription;
 * 2. `session.activity`, resolved by the ONE ladder of `activity-ladder.ts`
 *    (never re-derived per surface), plus the three new bus events
 *    `agentChat.turn`, `agentChat.pending` and `agent.providers.changed`;
 * 3. the "needs your input" / "finished" pushes, now produced from protocol
 *    events instead of bells and hooks, behind the existing 30 s per-session
 *    per-type debounce and §6.4's liveness suppression.
 *
 * Nothing higher-rate than this rides the daemon's bus.
 */

import type { SessionActivity, SessionActivityEvent, SessionSummary } from "@orquester/api";
import type {
  AgentChatPendingEventPayload,
  AgentChatSessionSummaryFields,
  AgentChatTurnEventPayload,
  AgentProvidersChangedPayload
} from "@orquester/api/agent-chat";
import { SETTLED_TURN_STATES } from "@orquester/api/agent-chat";
import { agentHostRoutes } from "../agent-host/host-protocol.ts";
import { pushTypeForFields, resolveChatActivity } from "./activity-ladder.ts";
import type { ChatSessionManager } from "./chat-sessions.ts";
import { AgentHostClient } from "./host-client.ts";
import { parseAgentHostSignalFrame, type AgentHostSignalFrame } from "./host-signals.ts";

/** Reconnect backoff for the signal subscription. */
export const SIGNALS_RECONNECT_MIN_MS = 500;
export const SIGNALS_RECONNECT_MAX_MS = 15_000;

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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
  /**
   * A turn reached a settled state. The supervisor's version drain-restart
   * (§3.1 case 3) waits on "no thread has an active turn", and this is what
   * lets a deploy hand over the moment the host goes quiet instead of on the
   * next 15 s health tick.
   */
  onTurnSettled?: () => void;
}

/** What the service remembers per thread, beyond the summary itself. */
interface ThreadState {
  fields: AgentChatSessionSummaryFields;
  activity: SessionActivity;
  /** Open requests, so a close frame can publish the right `open: false`. */
  pending: Map<string, { kind: "approval" | "question"; title: string }>;
}

export class AgentChatSummaryService {
  private readonly threads = new Map<string, ThreadState>();
  private hostInstanceId: string | null = null;
  private running = false;
  private stream: { abort(): void } | null = null;
  private loop: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Fires whenever the instance id changes (§8: clients must re-read). */
  private readonly instanceListeners = new Set<(id: string) => void>();

  constructor(private readonly opts: AgentChatSummaryOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  currentHostInstanceId(): string | null {
    return this.hostInstanceId;
  }

  onHostInstanceChanged(listener: (id: string) => void): () => void {
    this.instanceListeners.add(listener);
    return () => this.instanceListeners.delete(listener);
  }

  /** Start (or restart) the subscription. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  stop(): void {
    this.running = false;
    this.stream?.abort();
    this.stream = null;
    this.instanceListeners.clear();
  }

  /** Awaits the read loop's exit. Test/teardown helper. */
  async stopAndWait(): Promise<void> {
    this.stop();
    await this.loop?.catch(() => undefined);
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

  /** Apply one already-parsed frame. Exposed so tests drive the fold directly. */
  applyFrame(frame: AgentHostSignalFrame): void {
    switch (frame.kind) {
      case "hello": {
        const previous = this.hostInstanceId;
        this.hostInstanceId = frame.hostInstanceId;
        // A restarted host is not a reconnect (§8). Its liveness registry is
        // empty by construction, so replace rather than merge: a thread absent
        // from `hello` has no live background work, which is correct.
        const seen = new Set<string>();
        for (const row of frame.threads) {
          seen.add(row.threadId);
          this.applyFields(row.threadId, row.fields);
        }
        for (const threadId of [...this.threads.keys()]) {
          if (!seen.has(threadId)) {
            this.applyFields(threadId, {});
          }
        }
        if (previous && previous !== frame.hostInstanceId) {
          for (const listener of [...this.instanceListeners]) {
            try {
              listener(frame.hostInstanceId);
            } catch {
              /* a listener must never break the read loop */
            }
          }
        }
        return;
      }
      case "thread": {
        if (frame.gone) {
          this.threads.delete(frame.threadId);
          return;
        }
        this.applyFields(frame.threadId, frame.fields);
        return;
      }
      case "turn": {
        const payload: AgentChatTurnEventPayload = {
          id: frame.threadId,
          turnId: frame.turnId,
          state: frame.state
        };
        if (frame.tokenUsage) payload.tokenUsage = frame.tokenUsage;
        this.opts.broadcaster.publish("sessions", "agentChat.turn", payload);
        if (SETTLED_TURN_STATES.has(frame.state)) {
          this.opts.onTurnSettled?.();
        }
        return;
      }
      case "pending": {
        const state = this.threads.get(frame.threadId);
        if (state) {
          if (frame.open) {
            state.pending.set(frame.requestId, { kind: frame.requestKind, title: frame.title });
          } else {
            state.pending.delete(frame.requestId);
          }
        }
        const payload: AgentChatPendingEventPayload = {
          id: frame.threadId,
          requestId: frame.requestId,
          kind: frame.requestKind,
          title: frame.title,
          open: frame.open
        };
        this.opts.broadcaster.publish("sessions", "agentChat.pending", payload);
        return;
      }
      case "providers": {
        const payload: AgentProvidersChangedPayload = {};
        if (frame.adapterId) payload.adapterId = frame.adapterId;
        this.opts.broadcaster.publish("registry", "agent.providers.changed", payload);
        return;
      }
      default: {
        // Exhaustive by construction; an unknown kind never reaches here
        // because the parser drops it.
        const never: never = frame;
        void never;
      }
    }
  }

  // --- internals -----------------------------------------------------------

  /**
   * Merge the six fields onto the tab, resolve the ladder, broadcast the
   * activity when it changed, and push.
   */
  private applyFields(threadId: string, fields: AgentChatSessionSummaryFields): void {
    if (!this.opts.chat.has(threadId)) {
      // A thread the daemon has no tab for (deleted here, still live there).
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
    const state: ThreadState = {
      fields,
      activity,
      pending: previous?.pending ?? new Map()
    };
    this.threads.set(threadId, state);

    // The tab's own copy of the six fields (the tab strip reads it off the
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

    // Push only on a NEW attention, never on every frame that keeps it raised.
    if (!attentionChanged || resolution.attention === null) {
      return;
    }
    const pushType = pushTypeForFields(fields);
    if (!pushType) return;
    const summary = this.opts.chat.get(threadId);
    if (!summary) return;
    void this.opts.push.notifyStructural(summary, pushType);
  }

  private async run(): Promise<void> {
    let backoff = SIGNALS_RECONNECT_MIN_MS;
    while (this.running) {
      try {
        const opened = await this.opts.client.open("GET", agentHostRoutes.signals, {
          headers: { accept: "application/x-ndjson" },
          // The headers must arrive promptly; the BODY is deliberately endless.
          timeoutMs: 10_000
        });
        this.stream = opened;
        if (opened.status !== 200) {
          opened.abort();
          this.stream = null;
          if (opened.status === 404) {
            // A host build that does not serve `/signals` yet: back off to the
            // ceiling rather than hammering it, and say so once.
            this.opts.logger?.warn?.(
              "agent host does not serve /signals; chat tabs will have no derived activity"
            );
            backoff = SIGNALS_RECONNECT_MAX_MS;
          }
          throw new Error(`agent host /signals answered ${opened.status}`);
        }
        backoff = SIGNALS_RECONNECT_MIN_MS;
        await this.consume(opened.body);
      } catch (error) {
        if (!this.running) return;
        this.opts.logger?.warn?.("agent host signal stream ended", error);
      } finally {
        this.stream = null;
      }
      if (!this.running) return;
      await this.sleep(backoff);
      backoff = Math.min(SIGNALS_RECONNECT_MAX_MS, backoff * 2);
    }
  }

  private async consume(body: AsyncIterable<unknown>): Promise<void> {
    let remainder = "";
    for await (const chunk of body) {
      if (!this.running) return;
      remainder += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let newline = remainder.indexOf("\n");
      while (newline >= 0) {
        const line = remainder.slice(0, newline);
        remainder = remainder.slice(newline + 1);
        const frame = parseAgentHostSignalFrame(line);
        if (frame) {
          try {
            this.applyFrame(frame);
          } catch (error) {
            // A bad frame may only lose that frame — never the subscription.
            this.opts.logger?.error?.("agent chat signal frame failed", error);
          }
        }
        newline = remainder.indexOf("\n");
      }
    }
  }
}
