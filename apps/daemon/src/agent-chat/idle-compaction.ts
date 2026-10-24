/**
 * Idle Claude compaction (beta): send `/compact` to an idle Claude chat two minutes before its
 * prompt cache expires (`@orquester/api` `agent-chat/idle-compaction.ts` holds the rule).
 *
 * The host reports each chat's {@link IdleCompactionCandidate} on its summary — the latest
 * completed turn and when the cache it left expires — and the summary poll hands it here on every
 * read ({@link ChatIdleCompaction.onCandidate}) together with the tab's own state. For a chat
 * whose setting (`claudeIdleCompaction`, its account's override first) is `beforeCacheExpires`,
 * this service:
 *
 * 1. computes the window `[expiresAt - 2 min, expiresAt)` with `idleCompactionWindow`, which
 *    holds every guard (a delegate or workflow chat, a newer or unsettled turn, a pending approval,
 *    question, plan, merge, background work or continuing goal, under 200k tokens, cache gone);
 * 2. arms one timer per chat for the window's start — any change of the inputs re-decides it, so
 *    a new message, a new turn, a pending request, the tab closing or the setting changing cancels
 *    or moves it;
 * 3. when it fires, posts `compact {commandId: "idle-compact:<chat>:<turn>", idle: {turnId}}`
 *    through `DaemonApi`, exactly as the GUI's Compact. The command id is the same for one turn
 *    whoever posts it, so the host's receipts make a repeat — a retry, a daemon restarted in
 *    between — a no-op; the `idle` precondition makes the host refuse it when the chat moved on
 *    after the daemon looked.
 *
 * **Nothing is persisted here, on purpose.** Everything the window needs is derived from the
 * thread's `events.ndjson` (the host's fold): a daemon restart re-reads every open chat's summary
 * on its first poll and re-arms the same timers, an agent-host restart or handover answers the
 * same candidate from its log, and a window that closed while nobody was watching is skipped —
 * its cache is gone, so compacting would pay the read it was meant to save. T3 Code keeps these
 * timers in memory only and loses them on a restart.
 */

import type { EventEmitter } from "node:events";

import { SYSTEM_ACCOUNT_ID, type AgentAdapterId, type SessionSummary } from "@orquester/api";
import {
  agentChatCommandPath,
  IDLE_COMPACTION_COMMAND_PREFIX,
  idleCompactionWindow,
  type IdleCompactionCandidate,
  type IdleCompactionTab
} from "@orquester/api/agent-chat";
import { resolveIdleCompaction, type AgentPrefs } from "@orquester/config";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import type { Clock } from "../workflows/contracts.ts";
import { limitCommandId } from "./limit-recovery.ts";

/** A post the host could not take (restarting, daemon API not bound yet) is tried again after this. */
const DEFAULT_RETRY_MS = 15_000;

/** The tab records the service reads (`ChatSessionManager`). */
export interface IdleCompactionChat {
  get(id: string): SessionSummary | undefined;
  list(): SessionSummary[];
  readonly lifecycle: Pick<EventEmitter, "on" | "off">;
}

export type IdleCompactionPrefs = Pick<AgentPrefs, "claudeIdleCompaction" | "claudeIdleCompactionByAccount">;

export interface IdleCompactionOptions {
  chat: IdleCompactionChat;
  /** The settings as they are now (`app.json`), read at every decision. */
  prefs(): Promise<IdleCompactionPrefs>;
  /** A registry entry's chat adapter, or null. */
  adapterOf(refId: string): AgentAdapterId | null;
  clock: Clock;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  retryMs?: number;
}

/** The command id of a chat's idle compaction after `turnId`: one per turn, whoever sends it. */
export function idleCompactionCommandId(sessionId: string, turnId: string): string {
  return limitCommandId(IDLE_COMPACTION_COMMAND_PREFIX, sessionId, turnId);
}

/** The tab as the rule reads it. */
function ruleTab(tab: SessionSummary): IdleCompactionTab {
  return {
    id: tab.id,
    ...(tab.hasPendingApprovals !== undefined ? { hasPendingApprovals: tab.hasPendingApprovals } : {}),
    ...(tab.hasPendingUserInput !== undefined ? { hasPendingUserInput: tab.hasPendingUserInput } : {}),
    ...(tab.hasActionableProposedPlan !== undefined ? { hasActionableProposedPlan: tab.hasActionableProposedPlan } : {}),
    ...(tab.backgroundLiveness !== undefined ? { backgroundLiveness: tab.backgroundLiveness } : {}),
    ...(tab.latestTurn !== undefined ? { latestTurn: tab.latestTurn } : {}),
    ...(tab.chatSessionStatus !== undefined ? { chatSessionStatus: tab.chatSessionStatus } : {}),
    ...(tab.goal !== undefined ? { goal: tab.goal } : {}),
    ...(tab.lineage ? { lineage: tab.lineage } : {}),
    ...(tab.pendingMerges ? { pendingMerges: tab.pendingMerges } : {}),
    workflowOwned: tab.owner?.kind === "workflow" || tab.lineage?.workflowOwned === true
  };
}

export class ChatIdleCompaction {
  private api: DaemonApi | null = null;
  /** Each chat's candidate as the host last reported it. */
  private readonly candidates = new Map<string, IdleCompactionCandidate | null>();
  /** Each chat's inputs as last decided, so an unchanged poll costs nothing. */
  private readonly decided = new Map<string, string>();
  private readonly timers = new Map<string, { cancel(): void }>();
  /** Idle compactions this process posted and the host took: never posted twice. */
  private readonly sent = new Set<string>();
  /** One lane per chat: every decision about a chat runs in it, one after another. */
  private readonly lanes = new Map<string, Promise<unknown>>();
  private started = false;
  private stopped = false;
  private readonly onClosed = ({ id }: { id: string }): void => this.forget(id);

  constructor(private readonly opts: IdleCompactionOptions) {}

  private get retryMs(): number {
    return this.opts.retryMs ?? DEFAULT_RETRY_MS;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.opts.chat.lifecycle.on("closed", this.onClosed);
  }

  /** Bind the daemon's own API (built after the services): every chat is decided again. */
  attachApi(api: DaemonApi): void {
    this.api = api;
    this.redecideAll();
  }

  stop(): void {
    this.stopped = true;
    this.opts.chat.lifecycle.off("closed", this.onClosed);
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
  }

  /** Resolves once every decision queued so far has run (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.lanes.size > 0) await Promise.allSettled([...this.lanes.values()]);
  }

  /** The tab closed: nothing more is sent to it. */
  private forget(id: string): void {
    this.timers.get(id)?.cancel();
    this.timers.delete(id);
    this.candidates.delete(id);
    this.decided.delete(id);
  }

  /**
   * The summary poll's read of a chat: the host's candidate (`null`: none), after the tab's own
   * fields were updated from the same read. Decided again only when something it reads moved.
   * Never throws.
   */
  onCandidate(id: string, candidate: IdleCompactionCandidate | null): void {
    if (this.stopped) return;
    this.candidates.set(id, candidate);
    const tab = this.opts.chat.get(id);
    const key = tab === undefined ? "" : JSON.stringify([candidate, ruleTab(tab)]);
    if (this.decided.get(id) === key) return;
    this.decided.set(id, key);
    this.decide(id);
  }

  /** The setting moved: every chat is decided again (off cancels, on arms). */
  prefsChanged(): void {
    this.redecideAll();
  }

  private redecideAll(): void {
    if (this.stopped) return;
    for (const id of this.candidates.keys()) this.decide(id);
  }

  private decide(id: string): void {
    void this.lane(id, () => this.evaluate(id)).catch((error: unknown) =>
      this.opts.logger?.error?.("[idle-compaction] a chat could not be scheduled", { sessionId: id, error: String(error) })
    );
  }

  private lane<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.lanes.set(id, tail);
    void tail.then(() => {
      if (this.lanes.get(id) === tail) this.lanes.delete(id);
    });
    return run;
  }

  private cancel(id: string): void {
    this.timers.get(id)?.cancel();
    this.timers.delete(id);
  }

  private wakeAt(id: string, at: number): void {
    this.cancel(id);
    if (this.stopped) return;
    const timer = this.opts.clock.setTimeout(
      () => {
        if (this.timers.get(id) === timer) this.timers.delete(id);
        this.decide(id);
      },
      Math.max(0, at - this.opts.clock.now().getTime())
    );
    this.timers.set(id, timer);
  }

  /** The window this chat compacts in now, or null; reads everything fresh. */
  private async windowOf(id: string): Promise<ReturnType<typeof idleCompactionWindow>> {
    const tab = this.opts.chat.get(id);
    const candidate = this.candidates.get(id) ?? null;
    if (!tab || candidate === null || this.opts.adapterOf(tab.refId) !== "claude") return null;
    const prefs = await this.opts.prefs();
    if (resolveIdleCompaction(prefs, tab.accountId || SYSTEM_ACCOUNT_ID) !== "beforeCacheExpires") return null;
    return idleCompactionWindow(ruleTab(tab), candidate, this.opts.clock.now().getTime());
  }

  private async evaluate(id: string): Promise<void> {
    this.cancel(id);
    if (this.stopped) return;
    const window = await this.windowOf(id);
    if (window === null) return;
    const commandId = idleCompactionCommandId(id, window.turnId);
    if (this.sent.has(commandId)) return;
    const now = this.opts.clock.now().getTime();
    if (now < window.startMs) {
      this.wakeAt(id, window.startMs);
      return;
    }
    if (!this.api) {
      // Bound later: `attachApi` decides again; this wake covers a window that would close first.
      this.wakeAt(id, Math.min(now + this.retryMs, window.endMs));
      return;
    }
    const outcome = await this.post(this.api, id, commandId, window.turnId);
    if (outcome === "sent") {
      this.sent.add(commandId);
      this.opts.logger?.info?.("[idle-compaction] compacting an idle chat before its prompt cache expires", {
        sessionId: id,
        turnId: window.turnId
      });
      return;
    }
    if (outcome === "unavailable" && now + this.retryMs < window.endMs) {
      this.wakeAt(id, now + this.retryMs);
    }
    // Refused: the chat moved on or is busy. The poll's next change decides again.
  }

  private async post(api: DaemonApi, id: string, commandId: string, turnId: string): Promise<"sent" | "unavailable" | "refused"> {
    try {
      const res = await api.request("POST", agentChatCommandPath(id, "compact"), { body: { commandId, idle: { turnId } } });
      if (res.status < 400) return "sent";
      const error = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
      if (res.status === 503 || error?.code === "HOST_UNAVAILABLE") return "unavailable";
      this.opts.logger?.warn?.("[idle-compaction] the chat refused the idle compaction", {
        sessionId: id,
        status: res.status,
        code: error?.code,
        message: error?.message
      });
      return "refused";
    } catch {
      return "unavailable";
    }
  }
}
