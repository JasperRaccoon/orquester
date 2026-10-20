/**
 * Usage-limit recovery for interactive chats (`@orquester/api` `agent-chat/usage-limit.ts`).
 *
 * The host reports each thread's CURRENT usage limit on its summary (`usageLimitNoticeOf`); the
 * summary poll hands every change here ({@link ChatLimitRecovery.onNotice}). For a chat that hit
 * its limit this service:
 *
 * 1. **records** the limit on the tab record (`SessionSummary.usageLimit`, persisted in
 *    `sessions.json`): the reset — the provider's stamp, else the reset of the account's burnt
 *    window in the usage snapshot (`burntWindowResetAt`), else none — the account and the turn;
 *    and cools the account down in the workflows' shared cooldown store (`buildCooldown`), so
 *    workflows and chats agree about which accounts are spent;
 * 2. **arms** the automatic resume when the reset is known and the setting
 *    (`autoResumeLimitedChats`) is on: at the reset plus {@link USAGE_LIMIT_RESUME_MARGIN_MS} it
 *    sends {@link USAGE_LIMIT_CONTINUE_MESSAGE} through the chat's own `/turn` route, under the
 *    idempotent command id `limit-resume:<sessionId>:<turn>:<resetAt>` (the host's receipts make a
 *    re-post after a crash a no-op). A limit with no known reset, or one already past when it is
 *    first seen, is never resumed on its own;
 * 3. with the opt-in `switchAccountOnUsageLimit`, **fails over**: the chat moves to the best
 *    other account of its family that is not cooling down (the workflows' `selectAccount`) through
 *    the ordinary account route, and goes on with the workflows' continue message. With every
 *    account cooling down it falls back to the automatic resume, woken at the earliest reset of
 *    any of them. Never for an agent without managed accounts (OpenCode).
 *
 * A resume is skipped, and the schedule disarmed, when the chat was closed, the user wrote to it
 * (the notice clears), it is busy, or it waits on an approval or a question. A parked turn (the
 * Claude SDK holds a turn on a rejected window instead of failing it) is interrupted first, and
 * the resume waits for it to settle on the bus — never on a sleep.
 *
 * Every side effect goes through `DaemonApi` (the daemon's own routes, in process), so each one is
 * gated, receipted and broadcast exactly as the GUI's. What the service is about to do is persisted
 * on the tab record BEFORE it does it (`ChatUsageLimitState.action`); a daemon restart in between
 * re-runs it under the same command ids. Timers are only the scheduled wake: {@link start} rebuilds
 * them from the persisted state, and a reset that passed while the daemon was down resumes at once.
 * Workflow-owned chats are left to the workflow engine's own failover.
 */

import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";

import { SYSTEM_ACCOUNT_ID, type AccountSelectionDecision, type AgentAdapterId, type SessionSummary } from "@orquester/api";
import {
  agentChatCommandPath,
  TURN_NOT_IDLE,
  USAGE_LIMIT_CONTINUE_MESSAGE,
  USAGE_LIMIT_RESUME_MARGIN_MS,
  type AgentChatErrorCode,
  type ChatLimitFailover,
  type ChatUsageLimitState,
  type ThreadHeadResponse,
  type ThreadUsageLimitNotice,
  type UsageLimitActionResponse
} from "@orquester/api/agent-chat";
import type { AgentChainEntry } from "@orquester/config";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import { readThreadHead, sendCommand } from "../mcp/reads.ts";
import type { AccountsReader, Clock, CooldownStore, UsageReader } from "../workflows/contracts.ts";
import { buildCooldown } from "../workflows/agent/cooldowns.ts";
import { accountFamilyOf, cooldownKey, cooldownSubject } from "../workflows/agent/families.ts";
import { continueMessage } from "../workflows/agent/prompt.ts";
import { burntWindowResetAt, formatDuration, selectAccount } from "../workflows/agent/select.ts";
import { acceptsMessage } from "./lineage.ts";

/** A limit row older than this with no known reset is history (a chat that stopped long ago), not a limit to act on. */
export const STALE_LIMIT_MS = 6 * 60 * 60_000;
/** A provider reset further out than this is not believed (the cooldown store's own bound). */
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;
/** A resume the host could not take (restarting, daemon API not bound yet) is tried again after this. */
const DEFAULT_RETRY_MS = 60_000;
/** How long an interrupted parked turn may take to settle before the resume gives up. */
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;
/**
 * A resume or switch that went out but whose limit the host still reports after this long (its
 * message never showed up) stops holding the banner's actions, so the user can act again.
 */
const RESUMING_STUCK_MS = 2 * 60_000;
/** The longest command id this service mints (the routes refuse past 200). */
const MAX_COMMAND_ID = 160;

/** A refusal the routes map onto the §6.2 envelope. */
export class UsageLimitError extends Error {
  constructor(
    message: string,
    readonly code: AgentChatErrorCode
  ) {
    super(message);
    this.name = "UsageLimitError";
  }
}

/** The tab records the service reads and writes (`ChatSessionManager`). */
export interface LimitRecoveryChat {
  get(id: string): SessionSummary | undefined;
  list(): SessionSummary[];
  usageLimitOf(id: string): ChatUsageLimitState | null;
  setUsageLimit(id: string, state: ChatUsageLimitState | null): unknown;
  limitFailoverOf(id: string): ChatLimitFailover | null;
  setLimitFailover(id: string, failover: ChatLimitFailover | null): unknown;
  readonly lifecycle: Pick<EventEmitter, "on" | "off">;
}

/** The two settings (`AgentPrefs.autoResumeLimitedChats`, `.switchAccountOnUsageLimit`). */
export interface LimitRecoveryPrefs {
  autoResume: boolean;
  switchAccount: boolean;
}

export interface LimitRecoveryOptions {
  chat: LimitRecoveryChat;
  /** The workflows' shared cooldown store (`createCooldownStore` over `workflow-state.json`). */
  cooldowns: CooldownStore;
  /** The usage service's cached reading (no I/O). */
  usage: UsageReader;
  accounts: AccountsReader;
  /** The settings as they are now (`app.json`), read at every decision. */
  prefs(): Promise<LimitRecoveryPrefs>;
  /** A registry entry's chat adapter, or null. */
  adapterOf(refId: string): AgentAdapterId | null;
  clock: Clock;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  retryMs?: number;
  settleTimeoutMs?: number;
}

/** What one attempt to post a turn came to. */
type PostOutcome = { kind: "sent"; seq: number } | { kind: "busy" } | { kind: "unavailable" } | { kind: "refused"; message: string };

/** The limit `state` records is the one `notice` reports: the same turn, else the same row. */
export function sameLimit(state: Pick<ChatUsageLimitState, "turnId" | "noticeId">, notice: Pick<ThreadUsageLimitNotice, "turnId" | "activityId">): boolean {
  if (state.turnId !== null && notice.turnId !== null) return state.turnId === notice.turnId;
  return state.noticeId === notice.activityId;
}

/** A workflow run drives this chat: its engine owns the failover (workflows §5.4). */
function workflowOwned(tab: SessionSummary): boolean {
  return tab.owner?.kind === "workflow" || tab.lineage?.workflowOwned === true;
}

function isBusy(tab: SessionSummary): boolean {
  const turn = tab.latestTurn?.state;
  return turn === "running" || turn === "pending" || tab.chatSessionStatus === "running" || tab.chatSessionStatus === "starting";
}

/** The account key the chat runs on: a managed account's id, else the system login. */
function accountKeyOf(tab: SessionSummary): string {
  return tab.accountId || SYSTEM_ACCOUNT_ID;
}

/** A command id of at most {@link MAX_COMMAND_ID} chars: the identity itself, or its hash when too long. */
export function limitCommandId(prefix: string, sessionId: string, ...parts: string[]): string {
  const plain = [prefix, sessionId, ...parts].join(":");
  if (plain.length <= MAX_COMMAND_ID) return plain;
  const digest = createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 32);
  return `${prefix}:${sessionId}:${digest}`.slice(0, MAX_COMMAND_ID);
}

export class ChatLimitRecovery {
  private api: DaemonApi | null = null;
  private readonly timers = new Map<string, { cancel(): void }>();
  /** One lane per chat: every decision about a chat runs in it, one after another. */
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** Chats whose persisted action must be re-run once the daemon's API is bound. */
  private readonly owed = new Set<string>();
  private started = false;
  private stopped = false;
  private readonly onClosed = ({ id }: { id: string }): void => this.forget(id);

  constructor(private readonly opts: LimitRecoveryOptions) {}

  private get retryMs(): number {
    return this.opts.retryMs ?? DEFAULT_RETRY_MS;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Boot, once the tab records are loaded: re-arm every persisted schedule (a reset that passed
   * while the daemon was down fires at once) and remember every action that was in flight.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.opts.chat.lifecycle.on("closed", this.onClosed);
    for (const tab of this.opts.chat.list()) {
      const state = this.opts.chat.usageLimitOf(tab.id);
      if (!state) continue;
      if (state.autoResume === "armed") this.schedule(tab.id, state);
      else if (state.autoResume === "resuming" && state.action) this.owed.add(tab.id);
    }
    if (this.api) this.payOwed();
  }

  /**
   * Bind the daemon's own API (built after the services, on the unix app): owed actions run now,
   * and every schedule is set again — one that came due before the API existed fires at once.
   */
  attachApi(api: DaemonApi): void {
    this.api = api;
    if (!this.started) return;
    for (const tab of this.opts.chat.list()) {
      const state = this.opts.chat.usageLimitOf(tab.id);
      if (state?.autoResume === "armed") this.schedule(tab.id, state);
    }
    this.payOwed();
  }

  stop(): void {
    this.stopped = true;
    this.opts.chat.lifecycle.off("closed", this.onClosed);
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
    this.owed.clear();
  }

  /** Resolves once every decision queued so far has run (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.lanes.size > 0) await Promise.allSettled([...this.lanes.values()]);
  }

  private forget(id: string): void {
    this.timers.get(id)?.cancel();
    this.timers.delete(id);
    this.owed.delete(id);
  }

  private payOwed(): void {
    for (const id of [...this.owed]) {
      this.owed.delete(id);
      void this.lane(id, async () => {
        const state = this.opts.chat.usageLimitOf(id);
        const tab = this.opts.chat.get(id);
        if (!state?.action || state.autoResume !== "resuming" || !tab) return;
        const action = state.action;
        const automatic = action.automatic === true;
        // Back to the state before the action, which then runs again under its own command ids
        // (the host's receipts answer a post that already landed with its first receipt).
        const before: ChatUsageLimitState = {
          ...state,
          autoResume: state.resetAt === null ? "unscheduled" : automatic ? "armed" : "off",
          resumeAt: state.resetAt !== null && automatic ? resumeTime(state.resetAt) : null
        };
        delete before.action;
        this.opts.chat.setUsageLimit(id, before);
        try {
          if (action.kind === "switch" && action.accountId !== undefined) {
            await this.failover(id, { commandId: action.commandId, accountId: action.accountId, automatic });
          } else {
            await this.resume(id, { commandId: action.commandId, automatic });
          }
        } catch (error) {
          // A user's own action, cut short by a restart: nobody waits for its answer any more.
          this.opts.logger?.warn?.("[limit-recovery] an action resumed after a restart failed", {
            sessionId: id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
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

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  /** The summary poll's report of a chat's current usage limit (`null`: none). Never throws. */
  onNotice(id: string, notice: ThreadUsageLimitNotice | null): void {
    if (this.stopped) return;
    void this.lane(id, () => this.applyNotice(id, notice)).catch((error: unknown) =>
      this.opts.logger?.error?.("[limit-recovery] a usage limit could not be handled", { sessionId: id, error: String(error) })
    );
  }

  private async applyNotice(id: string, notice: ThreadUsageLimitNotice | null): Promise<void> {
    const tab = this.opts.chat.get(id);
    if (!tab || workflowOwned(tab)) return;
    const current = this.opts.chat.usageLimitOf(id);
    if (notice === null) {
      // The chat spoke again (the user, a resume, a failover's continue): it is no longer limited.
      if (current) {
        this.forget(id);
        this.opts.chat.setUsageLimit(id, null);
      }
      return;
    }
    if (current && sameLimit(current, notice)) {
      await this.refresh(id, current, notice);
      return;
    }
    await this.detect(id, tab, notice);
  }

  /** The same limit, seen again: its newest row, its parked state, a reset the provider only now named. */
  private async refresh(id: string, current: ChatUsageLimitState, notice: ThreadUsageLimitNotice): Promise<void> {
    const now = this.opts.clock.now();
    const next: ChatUsageLimitState = { ...current, noticeId: notice.activityId, parked: notice.parked };
    const started = current.action ? Date.parse(current.action.startedAt) : Number.NaN;
    if (current.autoResume === "resuming" && Number.isFinite(started) && now.getTime() - started > RESUMING_STUCK_MS) {
      next.autoResume = current.resetAt === null ? "unscheduled" : "off";
      next.resumeAt = null;
      delete next.action;
    }
    const reset = futureReset(notice.resetsAt, now);
    if (current.resetAt === null && reset !== null) {
      next.resetAt = reset;
      if (current.autoResume === "unscheduled") {
        const prefs = await this.opts.prefs();
        next.autoResume = prefs.autoResume ? "armed" : "off";
        next.resumeAt = prefs.autoResume ? resumeTime(reset) : null;
      }
    }
    this.opts.chat.setUsageLimit(id, next);
    if (next.autoResume === "armed" && current.autoResume !== "armed") this.schedule(id, next);
  }

  private async detect(id: string, tab: SessionSummary, notice: ThreadUsageLimitNotice): Promise<void> {
    const now = this.opts.clock.now();
    const family = accountFamilyOf(tab.refId);
    const usageResetAt =
      family !== null
        ? burntWindowResetAt({ usage: this.opts.usage.snapshot(), family, accountId: accountKeyOf(tab), now })
        : undefined;
    const futureAt = futureReset(notice.resetsAt, now) ?? futureReset(usageResetAt, now);
    const limitedAt = Date.parse(notice.at);
    const recent = Number.isFinite(limitedAt) && now.getTime() - limitedAt <= STALE_LIMIT_MS;
    // A limit whose reset is already past, or that names none, and is old is history: the chat
    // stopped on it long ago (or before this build). It is not marked, and never resumed.
    if (futureAt === null && !recent) {
      if (this.opts.chat.usageLimitOf(id)) {
        this.forget(id);
        this.opts.chat.setUsageLimit(id, null);
      }
      return;
    }
    await this.coolDown(tab, notice, usageResetAt, now);
    const prefs = await this.opts.prefs();
    this.forget(id);
    // A recent limit whose provider reset is already past keeps that stamp to show, but is never
    // resumed on its own: an expired window reported with a fresh failure must not start a loop.
    const pastAt = futureAt === null ? pastReset(notice.resetsAt, now) : null;
    const resetAt = futureAt ?? pastAt;
    const armed = futureAt !== null && prefs.autoResume;
    const state: ChatUsageLimitState = {
      noticeId: notice.activityId,
      turnId: notice.turnId,
      detectedAt: now.toISOString(),
      limitedAt: notice.at,
      resetAt,
      accountId: tab.accountId ?? "",
      parked: notice.parked,
      autoResume: resetAt === null ? "unscheduled" : armed ? "armed" : "off",
      resumeAt: armed && futureAt !== null ? resumeTime(futureAt) : null,
      ...(notice.message ? { message: notice.message } : {})
    };
    this.opts.chat.setUsageLimit(id, state);

    if (prefs.switchAccount && this.canSwitch(tab)) {
      const switched = await this.failover(id, {
        commandId: limitCommandId("limit-switch", id, state.turnId ?? state.noticeId),
        automatic: true
      }).catch((error: unknown) => {
        this.opts.logger?.warn?.("[limit-recovery] the automatic account switch failed", { sessionId: id, error: String(error) });
        return null;
      });
      if (switched?.switched) return;
      // Every other account is cooling down too: wake at the earliest reset of any of them.
      const earliest = switched?.decision?.earliestResetAt ? futureReset(switched.decision.earliestResetAt, now) : null;
      const after = this.opts.chat.usageLimitOf(id);
      if (after && prefs.autoResume && earliest !== null && (after.resetAt === null || Date.parse(earliest) < Date.parse(after.resetAt))) {
        this.opts.chat.setUsageLimit(id, { ...after, autoResume: "armed", resumeAt: resumeTime(earliest) });
      }
    }
    const scheduled = this.opts.chat.usageLimitOf(id);
    if (scheduled?.autoResume === "armed") this.schedule(id, scheduled);
  }

  /** Cool the account down in the shared store, as a workflow's failover does (`coolDown`). */
  private async coolDown(tab: SessionSummary, notice: ThreadUsageLimitNotice, usageResetAt: string | undefined, now: Date): Promise<void> {
    let model = "";
    if (accountFamilyOf(tab.refId) === null) {
      // An accountless agent's cooldown is keyed by the provider that answered, read off the model.
      const head = this.api ? await readThreadHead(this.api, tab.id).catch(() => null) : null;
      model = head?.head.modelSelection.model ?? "";
      if (!model) return;
    }
    const subject = cooldownSubject(tab.refId, model, accountKeyOf(tab));
    const cooldown = buildCooldown({
      ...(notice.resetsAt ? { resetsAt: notice.resetsAt } : {}),
      ...(usageResetAt ? { usageResetAt } : {}),
      now,
      reason: "usage_limit",
      detail: notice.message.slice(0, 500)
    });
    try {
      await this.opts.cooldowns.set(subject.family, subject.account, cooldown);
    } catch (error) {
      this.opts.logger?.warn?.("[limit-recovery] the account cooldown could not be saved", { sessionId: tab.id, error: String(error) });
    }
  }

  // -------------------------------------------------------------------------
  // The schedule
  // -------------------------------------------------------------------------

  private schedule(id: string, state: ChatUsageLimitState): void {
    this.timers.get(id)?.cancel();
    this.timers.delete(id);
    if (this.stopped || state.autoResume !== "armed" || state.resumeAt === null) return;
    const due = Date.parse(state.resumeAt);
    const delay = Number.isFinite(due) ? Math.max(0, due - this.opts.clock.now().getTime()) : 0;
    const timer = this.opts.clock.setTimeout(() => {
      if (this.timers.get(id) === timer) this.timers.delete(id);
      void this.lane(id, () => this.fire(id)).catch((error: unknown) =>
        this.opts.logger?.error?.("[limit-recovery] the automatic resume failed", { sessionId: id, error: String(error) })
      );
    }, delay);
    this.timers.set(id, timer);
  }

  /** Put the schedule back to `at` (an unavailable host, the daemon API not bound yet). */
  private retryAt(id: string, state: ChatUsageLimitState, at: number): void {
    const next: ChatUsageLimitState = { ...state, autoResume: "armed", resumeAt: new Date(at).toISOString() };
    delete next.action;
    this.opts.chat.setUsageLimit(id, next);
    this.schedule(id, next);
  }

  /** No automatic resume any more: off when the reset is known, else unscheduled. */
  private disarm(id: string): void {
    this.forget(id);
    const state = this.opts.chat.usageLimitOf(id);
    if (!state) return;
    const next: ChatUsageLimitState = { ...state, autoResume: state.resetAt === null ? "unscheduled" : "off", resumeAt: null };
    delete next.action;
    this.opts.chat.setUsageLimit(id, next);
  }

  /** The scheduled wake. */
  private async fire(id: string): Promise<void> {
    const state = this.opts.chat.usageLimitOf(id);
    const tab = this.opts.chat.get(id);
    if (!state || !tab || state.autoResume !== "armed" || state.resumeAt === null) return;
    const now = this.opts.clock.now().getTime();
    const due = Date.parse(state.resumeAt);
    // A timer clamped to the platform's limit (or fired a little early) waits on.
    if (Number.isFinite(due) && due - now > 1_000) {
      this.schedule(id, state);
      return;
    }
    // The setting turning off disarms every schedule at once (`prefsChanged`): one still armed is
    // either the setting's or the user's own "Resume at reset", and goes out.
    const prefs = await this.opts.prefs();
    if (!this.api) {
      this.retryAt(id, state, now + this.retryMs);
      return;
    }
    if (tab.hasPendingApprovals || tab.hasPendingUserInput) {
      this.disarm(id);
      return;
    }
    const ownReset = state.resetAt === null ? Number.NaN : Date.parse(state.resetAt);
    const ownFree = Number.isFinite(ownReset) && ownReset <= now;
    if (!ownFree && prefs.switchAccount && this.canSwitch(tab)) {
      // Woken by another account's reset (every account was cooling down): move to it.
      const outcome = await this.failover(id, {
        commandId: limitCommandId("limit-switch", id, state.turnId ?? state.noticeId, String(due)),
        automatic: true
      }).catch(() => null);
      if (outcome?.switched) return;
      const after = this.opts.chat.usageLimitOf(id);
      if (!after) return;
      const earliest = outcome?.decision?.earliestResetAt ? Date.parse(outcome.decision.earliestResetAt) : Number.NaN;
      const next = [ownReset, earliest].filter((t) => Number.isFinite(t) && t > now);
      if (next.length > 0) this.retryAt(id, after, Math.min(...next) + USAGE_LIMIT_RESUME_MARGIN_MS);
      else this.disarm(id);
      return;
    }
    const resetMs = Number.isFinite(ownReset) ? ownReset : due;
    await this.resume(id, {
      commandId: limitCommandId("limit-resume", id, state.turnId ?? state.noticeId, String(resetMs)),
      automatic: true
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private requireApi(): DaemonApi {
    if (!this.api) throw new UsageLimitError("The daemon is still starting. Try again in a moment.", "HOST_UNAVAILABLE");
    return this.api;
  }

  private requireLimited(id: string): ChatUsageLimitState {
    if (!this.opts.chat.get(id)) throw new UsageLimitError("No chat session with that id.", "THREAD_NOT_FOUND");
    const state = this.opts.chat.usageLimitOf(id);
    if (!state) throw new UsageLimitError("This chat is not stopped on a usage limit.", "COMMAND_REJECTED");
    return state;
  }

  /** Accounts of the same family can be swapped in: not OpenCode (one server identity), nor an agent without accounts. */
  private canSwitch(tab: SessionSummary): boolean {
    return this.opts.adapterOf(tab.refId) !== "opencode" && accountFamilyOf(tab.refId) !== null;
  }

  /** The best other account for the chat: the workflows' least-used selection over its family. */
  private pick(tab: SessionSummary, model: string): AccountSelectionDecision {
    const family = accountFamilyOf(tab.refId)!;
    const chain: AgentChainEntry[] = [
      {
        agent: tab.refId,
        model: model || tab.refId,
        accounts: {
          strategy: "least-used",
          includeSystem: false,
          soonestResetWindow: "weekly",
          leastUsedMetric: "max",
          unknownUsage: "last"
        }
      }
    ];
    return selectAccount({
      chain,
      usage: this.opts.usage.snapshot(),
      accounts: this.opts.accounts.list(),
      cooldowns: this.opts.cooldowns.list(),
      now: this.opts.clock.now(),
      exclude: new Set([cooldownKey(family, accountKeyOf(tab))])
    });
  }

  /** Arm (`armed: true`) or cancel the automatic resume — the banner's toggle. */
  setAutoResume(id: string, armed: boolean): Promise<UsageLimitActionResponse> {
    return this.lane(id, async () => {
      const state = this.requireLimited(id);
      if (state.autoResume === "resuming") {
        throw new UsageLimitError("The chat is already resuming.", "COMMAND_REJECTED");
      }
      if (armed) {
        if (state.resetAt === null) {
          throw new UsageLimitError("The reset time is unknown, so the resume cannot be scheduled. Resume it yourself instead.", "COMMAND_REJECTED");
        }
        const at = Math.max(Date.parse(state.resetAt) + USAGE_LIMIT_RESUME_MARGIN_MS, this.opts.clock.now().getTime());
        const next: ChatUsageLimitState = { ...state, autoResume: "armed", resumeAt: new Date(at).toISOString() };
        delete next.userCancelled;
        this.opts.chat.setUsageLimit(id, next);
        this.schedule(id, next);
      } else {
        this.forget(id);
        this.opts.chat.setUsageLimit(id, {
          ...state,
          autoResume: state.resetAt === null ? "unscheduled" : "off",
          resumeAt: null,
          userCancelled: true
        });
      }
      return this.view(id);
    });
  }

  /** "Resume now": send the continue message at once, whatever the reset. */
  resumeNow(id: string, commandId: string): Promise<UsageLimitActionResponse> {
    const command = validCommandId(commandId);
    return this.lane(id, async () => {
      this.requireLimited(id);
      this.requireApi();
      await this.resume(id, { commandId: command, automatic: false });
      return this.view(id);
    });
  }

  /** "Switch account & continue": the given account, else the best other one of the family. */
  switchAndContinue(id: string, input: { commandId: string; accountId?: string }): Promise<UsageLimitActionResponse> {
    const command = validCommandId(input.commandId);
    return this.lane(id, async () => {
      const state = this.requireLimited(id);
      this.requireApi();
      const tab = this.opts.chat.get(id)!;
      if (!this.canSwitch(tab)) {
        throw new UsageLimitError("This agent always runs under one identity; its account cannot be switched.", "COMMAND_REJECTED");
      }
      const accountId = typeof input.accountId === "string" && input.accountId.trim() ? input.accountId.trim() : undefined;
      if (accountId !== undefined && accountId === (state.accountId || SYSTEM_ACCOUNT_ID)) {
        throw new UsageLimitError("The chat already runs on that account.", "INVALID_COMMAND");
      }
      const outcome = await this.failover(id, { commandId: command, automatic: false, ...(accountId !== undefined ? { accountId } : {}) });
      if (!outcome.switched) {
        throw new UsageLimitError(
          outcome.reason ?? "No other account of this agent is available right now: every one is cooling down or needs signing in.",
          "COMMAND_REJECTED"
        );
      }
      return this.view(id);
    });
  }

  /** Clear the "switched account" notice. */
  dismissFailover(id: string): Promise<UsageLimitActionResponse> {
    return this.lane(id, async () => {
      if (!this.opts.chat.get(id)) throw new UsageLimitError("No chat session with that id.", "THREAD_NOT_FOUND");
      this.opts.chat.setLimitFailover(id, null);
      return this.view(id);
    });
  }

  /**
   * The settings changed (`PUT /api/config/app`): turning the automatic resume off disarms every
   * armed chat; turning it on arms every chat whose reset is still ahead and whose resume the user
   * did not cancel.
   */
  prefsChanged(prefs: LimitRecoveryPrefs): void {
    const now = this.opts.clock.now().getTime();
    for (const tab of this.opts.chat.list()) {
      void this.lane(tab.id, async () => {
        const state = this.opts.chat.usageLimitOf(tab.id);
        if (!state) return;
        if (!prefs.autoResume && state.autoResume === "armed") {
          this.forget(tab.id);
          this.opts.chat.setUsageLimit(tab.id, { ...state, autoResume: "off", resumeAt: null });
        } else if (prefs.autoResume && state.autoResume === "off" && state.userCancelled !== true && state.resetAt !== null) {
          const at = Date.parse(state.resetAt) + USAGE_LIMIT_RESUME_MARGIN_MS;
          if (!(at > now)) return;
          const next: ChatUsageLimitState = { ...state, autoResume: "armed", resumeAt: new Date(at).toISOString() };
          this.opts.chat.setUsageLimit(tab.id, next);
          this.schedule(tab.id, next);
        }
      });
    }
  }

  private view(id: string): UsageLimitActionResponse {
    return { usageLimit: this.opts.chat.usageLimitOf(id), limitFailover: this.opts.chat.limitFailoverOf(id) };
  }

  /**
   * Send the continue message. The intent is persisted first; a parked turn is interrupted and
   * awaited; the chat must be able to take a message (idle, nothing pending). An automatic resume
   * that cannot go out disarms (busy, refused) or retries later (host restarting); a user's throws.
   */
  private async resume(id: string, input: { commandId: string; automatic: boolean }): Promise<void> {
    const before = this.opts.chat.usageLimitOf(id);
    if (!before) return;
    const api = this.api;
    if (!api) {
      if (input.automatic) this.retryAt(id, before, this.opts.clock.now().getTime() + this.retryMs);
      else throw new UsageLimitError("The daemon is still starting. Try again in a moment.", "HOST_UNAVAILABLE");
      return;
    }
    this.forget(id);
    const state: ChatUsageLimitState = {
      ...before,
      autoResume: "resuming",
      resumeAt: null,
      action: { kind: "resume", commandId: input.commandId, startedAt: this.opts.clock.now().toISOString(), automatic: input.automatic }
    };
    this.opts.chat.setUsageLimit(id, state);
    const outcome = await this.postContinue(api, id, state, input.commandId, USAGE_LIMIT_CONTINUE_MESSAGE);
    this.settle(id, before, outcome, input.automatic ? "auto-resume" : "user");
  }

  /**
   * Move the chat to another account of its family and continue there. `accountId` absent: the
   * best other account (`pick`). Answers whether it switched, and the selection when it did not.
   */
  private async failover(
    id: string,
    input: { commandId: string; automatic: boolean; accountId?: string }
  ): Promise<{ switched: boolean; decision?: AccountSelectionDecision; reason?: string }> {
    const before = this.opts.chat.usageLimitOf(id);
    const tab = this.opts.chat.get(id);
    const api = this.api;
    if (!before || !tab || !api || !this.canSwitch(tab)) return { switched: false };
    let target = input.accountId;
    let decision: AccountSelectionDecision | undefined;
    if (target === undefined) {
      const head = await readThreadHead(api, id).catch(() => null);
      decision = this.pick(tab, head?.head.modelSelection.model ?? "");
      target = decision.chosen?.accountId;
      if (target === undefined) return { switched: false, decision, reason: noCandidateReason(decision, this.opts.clock.now()) };
    }
    const fromAccountId = tab.accountId ?? "";
    this.forget(id);
    const state: ChatUsageLimitState = {
      ...before,
      autoResume: "resuming",
      resumeAt: null,
      action: { kind: "switch", commandId: input.commandId, accountId: target, startedAt: this.opts.clock.now().toISOString(), automatic: input.automatic }
    };
    this.opts.chat.setUsageLimit(id, state);
    const settled = await this.stopParkedTurn(api, id, state, input.commandId);
    const mode = input.automatic ? "auto-failover" : "user";
    if (!settled) {
      this.settle(id, before, { kind: "busy" }, mode);
      return { switched: false, ...(decision ? { decision } : {}) };
    }
    const current = this.opts.chat.get(id);
    const alreadyMoved = (current?.accountId || SYSTEM_ACCOUNT_ID) === target;
    if (!alreadyMoved) {
      try {
        await sendCommand(api, id, "account", { accountId: target }, { commandId: `${input.commandId}:account`, retryDelayMs: () => 0 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown }).code;
        this.settle(id, before, code === "HOST_UNAVAILABLE" ? { kind: "unavailable" } : { kind: "refused", message }, mode);
        return { switched: false, ...(decision ? { decision } : {}), reason: message };
      }
    }
    this.opts.chat.setLimitFailover(id, {
      fromAccountId,
      toAccountId: target === SYSTEM_ACCOUNT_ID ? "" : target,
      at: this.opts.clock.now().toISOString(),
      automatic: input.automatic
    });
    // The account moved: the turn goes out with the workflows' continue message (it names the move).
    const outcome = await this.postContinue(api, id, state, `${input.commandId}:turn`, continueMessage(false, "usage_limit"), { parkedHandled: true });
    this.settle(id, before, outcome, mode);
    return { switched: outcome.kind === "sent", ...(decision ? { decision } : {}) };
  }

  /**
   * After an attempt: a sent turn is left to the notice clearing. Otherwise the state goes back to
   * what it was before the attempt, and then:
   * - a user's action throws its refusal (its schedule, if any, stands);
   * - an automatic failover keeps the schedule (the resume at the reset is the fallback);
   * - an automatic resume retries later when the host was restarting, else disarms.
   */
  private settle(id: string, before: ChatUsageLimitState, outcome: PostOutcome, mode: "user" | "auto-failover" | "auto-resume"): void {
    if (outcome.kind === "sent") return;
    const current = this.opts.chat.usageLimitOf(id);
    if (current) {
      const restored: ChatUsageLimitState = {
        ...current,
        autoResume: before.autoResume === "resuming" ? (before.resetAt === null ? "unscheduled" : "off") : before.autoResume,
        resumeAt: before.autoResume === "armed" ? before.resumeAt : null
      };
      delete restored.action;
      this.opts.chat.setUsageLimit(id, restored);
    }
    const state = this.opts.chat.usageLimitOf(id);
    if (mode === "auto-resume") {
      if (outcome.kind === "refused") {
        this.opts.logger?.warn?.("[limit-recovery] the chat refused the automatic resume", { sessionId: id, message: outcome.message });
      }
      if (outcome.kind === "unavailable" && state) this.retryAt(id, state, this.opts.clock.now().getTime() + this.retryMs);
      else this.disarm(id);
      return;
    }
    if (state?.autoResume === "armed") this.schedule(id, state);
    if (mode === "auto-failover") {
      if (outcome.kind === "refused") {
        this.opts.logger?.warn?.("[limit-recovery] the automatic account switch was refused", { sessionId: id, message: outcome.message });
      }
      return;
    }
    if (outcome.kind === "busy") throw new UsageLimitError("The chat is busy or waiting for an answer; nothing was sent.", "COMMAND_REJECTED");
    if (outcome.kind === "unavailable") throw new UsageLimitError("The agent host is restarting. Try again in a moment.", "HOST_UNAVAILABLE");
    throw new UsageLimitError(outcome.message, "COMMAND_REJECTED");
  }

  /** A parked turn is interrupted (idempotently) and awaited until it settled. True when the chat is not busy. */
  private async stopParkedTurn(api: DaemonApi, id: string, state: ChatUsageLimitState, commandId: string): Promise<boolean> {
    const tab = this.opts.chat.get(id);
    if (!tab) return false;
    if (!state.parked && !isBusy(tab)) return true;
    if (state.parked) {
      try {
        // `cascade: false`: clearing the parked turn is not a stop, so the chats this one
        // delegated keep running (`delegates.ts`).
        await sendCommand(api, id, "interrupt", { ...(state.turnId ? { turnId: state.turnId } : {}), cascade: false }, {
          commandId: `${commandId}:interrupt`,
          retryDelayMs: () => 0
        });
      } catch (error) {
        this.opts.logger?.warn?.("[limit-recovery] the parked turn could not be interrupted", { sessionId: id, error: String(error) });
        return false;
      }
    }
    return this.waitSettled(api, id);
  }

  /** Resolve once the chat is not busy, on the bus (never a sleep), or false at the deadline. */
  private waitSettled(api: DaemonApi, id: string): Promise<boolean> {
    const idle = (): boolean => {
      const tab = this.opts.chat.get(id);
      return tab !== undefined && !isBusy(tab);
    };
    if (idle()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        off();
        timer.cancel();
        resolve(value);
      };
      const off = api.subscribe((event) => {
        if (event.channel !== "sessions") return;
        const payload = event.payload as { id?: unknown } | null;
        if (payload?.id !== id) return;
        if (!this.opts.chat.get(id)) finish(false);
        else if (idle()) finish(true);
      });
      const timer = this.opts.clock.setTimeout(() => finish(idle()), this.opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
    });
  }

  /** Post the continue turn under `commandId`, only into a chat that can take it (`ifIdle`). */
  private async postContinue(
    api: DaemonApi,
    id: string,
    state: ChatUsageLimitState,
    commandId: string,
    input: string,
    opts: { parkedHandled?: boolean } = {}
  ): Promise<PostOutcome> {
    if (!opts.parkedHandled && !(await this.stopParkedTurn(api, id, state, commandId))) return { kind: "busy" };
    let head: ThreadHeadResponse;
    try {
      head = await readThreadHead(api, id);
    } catch {
      return { kind: "unavailable" };
    }
    const tab = this.opts.chat.get(id);
    if (!tab) return { kind: "refused", message: "The chat was closed." };
    if (!acceptsMessage(tab, head)) return { kind: "busy" };
    try {
      const res = await api.request("POST", agentChatCommandPath(id, "turn"), {
        body: { commandId, input, interactionMode: head.interactionMode, ifIdle: true }
      });
      if (res.status < 400) return { kind: "sent", seq: (res.body as { seq?: number } | null)?.seq ?? 0 };
      const error = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
      if (res.status === 503 || error?.code === "HOST_UNAVAILABLE") return { kind: "unavailable" };
      if (res.status === 409 && error?.code === TURN_NOT_IDLE) return { kind: "busy" };
      return { kind: "refused", message: error?.message ?? `The chat refused the message (${res.status}).` };
    } catch {
      return { kind: "unavailable" };
    }
  }
}

/** A reset stamp in the future and believable, as ISO; null otherwise. */
function futureReset(stamp: string | undefined, now: Date): string | null {
  const t = stamp ? Date.parse(stamp) : Number.NaN;
  const ahead = t - now.getTime();
  return Number.isFinite(t) && ahead > 0 && ahead <= MAX_RESET_AHEAD_MS ? new Date(t).toISOString() : null;
}

/** A readable reset stamp at or before now, as ISO; null otherwise. */
function pastReset(stamp: string | undefined, now: Date): string | null {
  const t = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(t) && t <= now.getTime() ? new Date(t).toISOString() : null;
}

/** When the automatic resume goes out for a reset. */
function resumeTime(resetAt: string): string {
  return new Date(Date.parse(resetAt) + USAGE_LIMIT_RESUME_MARGIN_MS).toISOString();
}

function validCommandId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (id.length === 0 || id.length > 200) throw new UsageLimitError("commandId is required.", "INVALID_COMMAND");
  return id;
}

/** Why no other account was chosen, in the user's words. */
function noCandidateReason(decision: AccountSelectionDecision, now: Date): string {
  const earliest = decision.earliestResetAt ? Date.parse(decision.earliestResetAt) : Number.NaN;
  return Number.isFinite(earliest)
    ? `No other account of this agent is available right now; the next one frees up in ${formatDuration(earliest - now.getTime())}.`
    : "No other account of this agent is available right now: every one is cooling down or needs signing in.";
}
