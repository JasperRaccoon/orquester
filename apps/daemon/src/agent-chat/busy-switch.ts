/**
 * Switching a chat's account while it is busy (spec
 * `docs/superpowers/specs/2026-11-14-per-task-stop-and-live-account-switch-design.md` §3–§4,
 * `@orquester/api` `agent-chat/busy-switch.ts`).
 *
 * The account route with `whileBusy: true` lands here ({@link ChatBusySwitch.run}). For a chat
 * that is busy — a turn, live background work, an open approval or question, a continuing goal or
 * one held for an Orquester update — the daemon runs one sequence:
 *
 * 1. `stopping`: the session-scoped interrupt with `cascade: false` (the chats this one delegated
 *    keep running; the interrupt's own settle step cancels open approvals and questions, and a
 *    continuing goal is paused before anything is interrupted);
 * 2. `settling`: wait on the bus until the turn settled, then — when background work outlived
 *    the turn's interrupt (Codex's subagents, Grok's shells) — interrupt again with nothing
 *    running, which ends a session's background work, and wait until nothing is live;
 * 3. `switching`: the ordinary account switch, with the host's goal refusals lifted
 *    (`SetThreadIdentityRequest.busySwitch`) and every other refusal standing;
 * 4. `continuing`: the continue message (`BUSY_SWITCH_CONTINUE_MESSAGE` for Claude, the plain one
 *    for Codex and Grok) — or `/goal resume` for a continuing goal — through the chat's own
 *    `/turn` route.
 *
 * Before anything is stopped, the host's live head read refuses a running compaction (its own
 * words) and names an adapter that continues goals by itself, whose `active` goal the Stop pauses
 * and the switch therefore resumes, whatever the summary's grace says.
 *
 * A goal held for an update skips the stop (a Stop would take the hold back): the switch waits
 * for anything still running, applies, keeps the head's hold marks and sends nothing; the goal
 * resumes by itself on the new account after the update.
 *
 * The step is persisted on the tab record (`SessionSummary.accountSwitch`) BEFORE its side effect,
 * and every side effect goes out under a command id derived from the switch's own and a private
 * nonce kept on the record (never published), so a daemon restart re-runs the sequence from its
 * step, the host's receipts make repeats no-ops ({@link ChatBusySwitch.start}), and no client can
 * post under one of them. While the record stands, the chat's routes refuse every other turn,
 * answer, compaction and revert ({@link busySwitchCommandRefusal}). A failure after the stop lifts
 * the fence, sends nothing more and writes a warning row on the chat's timeline; the failure is
 * that command's final answer (a retry of it never switches anew).
 */

import { randomBytes } from "node:crypto";

import { SYSTEM_ACCOUNT_ID, type AgentAdapterId, type SessionSummary } from "@orquester/api";
import {
  agentChatCommandPath,
  BUSY_SWITCH_CONTINUE_MESSAGE,
  BUSY_SWITCH_CONTINUE_MESSAGE_PLAIN,
  type AgentChatErrorCode,
  type ChatBusySwitchGoal,
  type ChatBusySwitchState,
  type ChatBusySwitchStep,
  type ThreadHeadResponse
} from "@orquester/api/agent-chat";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import { postIdempotent, readThreadHead, sendCommand } from "../mcp/reads.ts";
import type { Clock } from "../workflows/contracts.ts";
import { limitCommandId, waitForChat } from "./limit-recovery.ts";

/** How long the stopped work may take to settle before the switch gives up (limit recovery's bound). */
export const BUSY_SWITCH_SETTLE_TIMEOUT_MS = 60_000;
/**
 * A switch found after a restart past its stop and settle (`switching`, `continuing`) is finished
 * while it is younger than this: the host's receipts make the repeat safe. Older, it is abandoned.
 */
const RESUME_LIMIT_MS = 10 * 60_000;
/** A restarted switch whose host was unavailable is tried again after this. */
const DEFAULT_RETRY_MS = 30_000;
/** Answered switches remembered for a repeat of their `commandId`. */
const MAX_REMEMBERED = 200;
const GOAL_RESUME_COMMAND = "/goal resume";

/** The host's own refusal for a running compaction (`identitySwitchRefusal`), which a busy switch keeps. */
const COMPACTION_REFUSAL = "Wait for the context compaction to finish before switching accounts.";
const GOAL_RESUME_OWED_REFUSAL =
  "The goal is resuming after an Orquester update. Switch accounts once it is running again.";

/** The words the `/turn` fence refuses with. */
export const BUSY_SWITCH_FENCE_MESSAGE = "This chat is moving to another account. Send the message again once the switch is done.";

/**
 * Owed, not answered: the switch is still persisted (a restarted one waiting for its host) or
 * nothing happened yet (the preflight read failed), so a repeat of its command may run it.
 */
const OWED = Symbol("owed");

/** A refusal or a failure the account route maps onto the §6.2 envelope. */
export class BusySwitchError extends Error {
  [OWED]?: true;
  constructor(
    message: string,
    readonly code: AgentChatErrorCode
  ) {
    super(message);
    this.name = "BusySwitchError";
  }
}

/** A failure a repeat of the same command may still run past ({@link OWED}). */
function owed(error: BusySwitchError): BusySwitchError {
  error[OWED] = true;
  return error;
}

/** The tab records the switch reads and writes (`ChatSessionManager`). */
export interface BusySwitchChat {
  get(id: string): SessionSummary | undefined;
  list(): SessionSummary[];
  accountSwitchOf(id: string): ChatBusySwitchState | null;
  /** The switch's private nonce: persisted on the tab record, never published. */
  accountSwitchNonceOf(id: string): string | null;
  setAccountSwitch(id: string, state: SwitchState | null): unknown;
}

export interface BusySwitchOptions {
  chat: BusySwitchChat;
  /**
   * The ordinary account switch (`AgentChatService.switchAccountNow`) under `commandId`;
   * `busySwitch` lifts only the host's two goal refusals.
   */
  switchAccount(id: string, input: { commandId: string; accountId: string; busySwitch?: true }): Promise<{ seq: number }>;
  /** One warning row on the chat's timeline (the host's `notice` route). Never throws. */
  appendNotice(id: string, input: { commandId: string; summary: string; detail: string }): Promise<void>;
  /** A registry entry's chat adapter, or null. */
  adapterOf(refId: string): AgentAdapterId | null;
  clock: Clock;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  settleTimeoutMs?: number;
  retryMs?: number;
}

/** A switch as the daemon holds it: the published state plus its private nonce. */
export type SwitchState = ChatBusySwitchState & { nonce?: string };

type SwitchPart = "interrupt" | "interrupt-background" | "account" | "continue" | `notice-${ChatBusySwitchStep}`;

/**
 * The command id of one of the switch's side effects: stable for the switch (a restart re-posts
 * it), within the id cap, and built on the switch's private nonce — which the summary never
 * publishes — so no client can post under it (and get past the fence, or answer the daemon's own
 * command with its receipt).
 */
export function busySwitchCommandId(sessionId: string, state: Pick<SwitchState, "commandId" | "nonce">, part: SwitchPart): string {
  return limitCommandId("busy-switch", sessionId, state.nonce !== undefined ? `${state.commandId}:${state.nonce}` : state.commandId, part);
}

/** The chat commands the fence holds back: each starts (or rewrites) agent work. */
const FENCED_COMMANDS: Readonly<Record<string, { code: "TURN_NOT_IDLE" | "COMMAND_REJECTED"; message: string }>> = {
  turn: { code: "TURN_NOT_IDLE", message: "This chat is moving to another account. Send the message again once the switch is done." },
  // A message-mode answer starts a turn; a compaction started now would fail the switch.
  answer: { code: "TURN_NOT_IDLE", message: "This chat is moving to another account. Answer again once the switch is done." },
  compact: { code: "TURN_NOT_IDLE", message: "This chat is moving to another account. Compact once the switch is done." },
  revert: { code: "COMMAND_REJECTED", message: "This chat is moving to another account. Revert once the switch is done." }
};

/**
 * The fence: why the chat's command route refuses this command now, or null. While a busy switch
 * stands on the tab record, `turn`, `answer`, `compact` and `revert` are refused — whoever sends
 * them — except the switch's own continue turn, matched by its nonce-bearing command id.
 */
export function busySwitchCommandRefusal(
  sessionId: string,
  state: SwitchState | null,
  name: string,
  body: unknown
): { code: "TURN_NOT_IDLE" | "COMMAND_REJECTED"; message: string } | null {
  if (state === null) return null;
  const refusal = FENCED_COMMANDS[name];
  if (refusal === undefined) return null;
  const commandId = (body as { commandId?: unknown } | null)?.commandId;
  if (name === "turn" && commandId === busySwitchCommandId(sessionId, state, "continue")) return null;
  return refusal;
}

/** The goal the summary says is going on (a held goal, or one just set going again, reads `paused` and continuing). */
function summaryGoalBusy(tab: SessionSummary): boolean {
  return tab.goal?.continuing === true;
}

/**
 * The goal the switch handles (§4), decided from the host's live head before anything happens:
 * - `held` only when the head carries an update's hold (`goalHeldForHandover`) on a goal that may
 *   still go on — a goal the host has just set going again reads `paused` and continuing too, but
 *   it is going, not held;
 * - `continuing` for any goal going on by itself: `active` on an adapter that continues goals
 *   across turns (the Stop pauses it, whatever the summary's grace says), or one the summary reads
 *   continuing (just resumed). The switch ends with `/goal resume`.
 * An older host names neither the hold-less adapter capability nor the compaction: the summary's
 * verdict then decides as before.
 */
function goalToHandle(tab: SessionSummary, head: ThreadHeadResponse): ChatBusySwitchGoal | null {
  const status = head.goal?.status ?? tab.goal?.status;
  if (head.head.goalHeldForHandover === true && (status === "paused" || status === "active")) return "held";
  if (head.goal?.status === "active" && head.goalContinuesAcrossTurns === true) return "continuing";
  if (summaryGoalBusy(tab)) return "continuing";
  return null;
}

/** No turn running or starting, nothing waiting on an answer. */
function turnSettled(tab: SessionSummary): boolean {
  const turn = tab.latestTurn?.state;
  return (
    turn !== "running" &&
    turn !== "pending" &&
    tab.chatSessionStatus !== "running" &&
    tab.chatSessionStatus !== "starting" &&
    tab.hasPendingApprovals !== true &&
    tab.hasPendingUserInput !== true
  );
}

/** Idle enough for the host's identity gate: settled, no live background work, no goal going on. */
function idleForSwitch(tab: SessionSummary, goal: ChatBusySwitchGoal | null): boolean {
  if (!turnSettled(tab) || (tab.backgroundLiveness ?? null) !== null) return false;
  // A held goal reads continuing until the next host resumes it; the switch keeps it so.
  if (goal === "held") return true;
  // A goal the stop pauses: wait for its pause to land (the host refuses an active one).
  if (goal === "continuing") return tab.goal?.status !== "active";
  return !(tab.goal?.continuing === true && tab.goal.status === "active");
}

/** The account route's id for a stored account ("" is the system login). */
function routeAccountId(accountId: string): string {
  return accountId === "" ? SYSTEM_ACCOUNT_ID : accountId;
}

/** A failure inside the sequence: what to tell the caller, and whether the host was only away. */
class StepFailure extends Error {
  constructor(
    readonly reason: string,
    readonly code: AgentChatErrorCode
  ) {
    super(reason);
  }
}

function describe(error: unknown): { message: string; code: AgentChatErrorCode } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return { message, code: code === "HOST_UNAVAILABLE" ? "HOST_UNAVAILABLE" : "COMMAND_REJECTED" };
}

/** The sentence a reason ends with. */
function sentence(reason: string): string {
  const trimmed = reason.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export class ChatBusySwitch {
  private api: DaemonApi | null = null;
  /** The sequence running on a chat, by session id. */
  private readonly running = new Map<string, { commandId: string; answer: Promise<{ seq: number }> }>();
  /** Answered switches by `sessionId\0commandId`, so a repeat answers the same (bounded). */
  private readonly answered = new Map<string, { seq: number } | BusySwitchError>();
  /** Chats whose persisted switch must be re-run once the daemon's API is bound. */
  private readonly owed = new Set<string>();
  private readonly retries = new Map<string, { cancel(): void }>();
  private started = false;
  private stopped = false;

  constructor(private readonly opts: BusySwitchOptions) {}

  private get settleTimeoutMs(): number {
    return this.opts.settleTimeoutMs ?? BUSY_SWITCH_SETTLE_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Boot, once the tab records are loaded: every persisted switch is owed its finish. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const tab of this.opts.chat.list()) {
      if (this.opts.chat.accountSwitchOf(tab.id)) this.owed.add(tab.id);
    }
    if (this.api) this.payOwed();
  }

  /** Bind the daemon's own API (built after the services): owed switches run now. */
  attachApi(api: DaemonApi): void {
    this.api = api;
    if (this.started) this.payOwed();
  }

  stop(): void {
    this.stopped = true;
    this.owed.clear();
    for (const retry of this.retries.values()) retry.cancel();
    this.retries.clear();
  }

  /** Resolves once every sequence started so far has ended (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()].map((entry) => entry.answer));
  }

  private payOwed(): void {
    for (const id of [...this.owed]) {
      this.owed.delete(id);
      this.resumeOwed(id);
    }
  }

  /** Finish (or abandon) the switch a restart found on the chat. */
  private resumeOwed(id: string): void {
    if (this.stopped || this.running.has(id)) return;
    const state = this.stateOf(id);
    if (!state || !this.opts.chat.get(id)) return;
    const age = this.opts.clock.now().getTime() - Date.parse(state.startedAt);
    const past = state.step === "switching" || state.step === "continuing";
    const answer = !(age <= (past ? RESUME_LIMIT_MS : this.settleTimeoutMs))
      ? this.abandon(id, state)
      : this.sequence(id, state, { restarted: true });
    this.track(id, state.commandId, answer);
    answer.catch((error: unknown) => {
      this.opts.logger?.warn?.("[busy-switch] a switch resumed after a restart failed", { sessionId: id, error: describe(error).message });
    });
  }

  private track(id: string, commandId: string, answer: Promise<{ seq: number }>): Promise<{ seq: number }> {
    const entry = { commandId, answer };
    this.running.set(id, entry);
    const forget = (): void => {
      if (this.running.get(id) === entry) this.running.delete(id);
    };
    answer.then(
      (value) => {
        this.remember(id, commandId, value);
        forget();
      },
      (error: unknown) => {
        const failure = error instanceof BusySwitchError ? error : new BusySwitchError(describe(error).message, describe(error).code);
        // Every answer is final for its command — a repeat gets the same — except one still owed.
        if (failure[OWED] !== true) this.remember(id, commandId, failure);
        forget();
      }
    );
    return answer;
  }

  private remember(id: string, commandId: string, outcome: { seq: number } | BusySwitchError): void {
    this.answered.set(`${id}\0${commandId}`, outcome);
    while (this.answered.size > MAX_REMEMBERED) {
      const oldest = this.answered.keys().next().value;
      if (oldest === undefined) break;
      this.answered.delete(oldest);
    }
  }

  // -------------------------------------------------------------------------
  // The route
  // -------------------------------------------------------------------------

  /**
   * The account route with `whileBusy: true`, its body already validated (`accountId` an account
   * of the chat's family, or `SYSTEM_ACCOUNT_ID`). Answers once the sequence ended: the switch's
   * receipt, or a {@link BusySwitchError}. An idle chat, or the account it already runs on,
   * switches exactly as without `whileBusy`.
   */
  run(id: string, input: { commandId: string; accountId: string }): Promise<{ seq: number }> {
    const flying = this.running.get(id);
    if (flying) {
      if (flying.commandId === input.commandId) return flying.answer;
      return Promise.reject(new BusySwitchError("An account switch is already in progress in this chat.", "COMMAND_REJECTED"));
    }
    const answered = this.answered.get(`${id}\0${input.commandId}`);
    if (answered) return answered instanceof BusySwitchError ? Promise.reject(answered) : Promise.resolve(answered);
    const persisted = this.opts.chat.accountSwitchOf(id);
    if (persisted) {
      // Owed after a restart: a repeat of its command joins its finish.
      if (persisted.commandId === input.commandId && this.api) {
        this.resumeOwed(id);
        const resumed = this.running.get(id);
        if (resumed) return resumed.answer;
      }
      return Promise.reject(
        persisted.commandId === input.commandId
          ? new BusySwitchError("The daemon is still starting. Retry the same commandId in a moment.", "HOST_UNAVAILABLE")
          : new BusySwitchError("An account switch is already in progress in this chat.", "COMMAND_REJECTED")
      );
    }
    const tab = this.opts.chat.get(id);
    if (!tab) return Promise.reject(new BusySwitchError("No chat session with that id.", "THREAD_NOT_FOUND"));
    const from = tab.accountId ?? "";
    const to = input.accountId === SYSTEM_ACCOUNT_ID ? "" : input.accountId;
    // The account it runs on (a receipt, nothing else), or an idle chat: today's switch.
    if (to === from || (!summaryGoalBusy(tab) && idleForSwitch(tab, null))) {
      return this.opts.switchAccount(id, { commandId: input.commandId, accountId: input.accountId });
    }
    const api = this.api;
    if (!api) return Promise.reject(new BusySwitchError("The daemon is still starting. Try again in a moment.", "HOST_UNAVAILABLE"));
    return this.track(id, input.commandId, this.begin(api, id, { commandId: input.commandId, accountId: input.accountId, from, to }));
  }

  private stateOf(id: string): SwitchState | null {
    const state = this.opts.chat.accountSwitchOf(id);
    if (state === null) return null;
    const nonce = this.opts.chat.accountSwitchNonceOf(id);
    return nonce !== null ? { ...state, nonce } : state;
  }

  /**
   * Ask the host what the summary cannot tell, before anything is stopped: a running compaction
   * refuses the switch (the host's own words), and on an adapter that continues goals by itself
   * an `active` goal is one the Stop pauses — so the switch resumes it, whatever the summary's
   * grace says. An older host answers neither: nothing is refused, the summary's goal stands.
   */
  private async begin(
    api: DaemonApi,
    id: string,
    input: { commandId: string; accountId: string; from: string; to: string }
  ): Promise<{ seq: number }> {
    let head: ThreadHeadResponse;
    try {
      head = await readThreadHead(api, id);
    } catch (error) {
      const { message, code } = describe(error);
      // Nothing happened yet: a repeat of the command may try again.
      throw owed(new BusySwitchError(`The chat could not be read, so nothing was stopped: ${message}`, code));
    }
    if (head.compacting === true) throw new BusySwitchError(COMPACTION_REFUSAL, "COMMAND_REJECTED");
    const tab = this.opts.chat.get(id);
    if (!tab) throw new BusySwitchError("No chat session with that id.", "THREAD_NOT_FOUND");
    const goal = goalToHandle(tab, head);
    // A goal an Orquester restart still owes its resume (`resumeGoalAfterRestart`) has no session to
    // stop and pause, and the host refuses its switch until the resume ran: say so now rather than
    // stopping what else runs and timing out.
    if (head.head.resumeGoalAfterRestart === true && goal !== "held") {
      throw new BusySwitchError(GOAL_RESUME_OWED_REFUSAL, "COMMAND_REJECTED");
    }
    // It went idle while the head was read: today's switch, nothing stopped, nothing sent.
    if (goal === null && idleForSwitch(tab, null)) {
      return this.opts.switchAccount(id, { commandId: input.commandId, accountId: input.accountId });
    }
    if (tab.chatSessionStatus === "starting" && goal !== "held") {
      throw new BusySwitchError("Wait for the agent to start before switching accounts.", "COMMAND_REJECTED");
    }
    if (this.opts.chat.accountSwitchOf(id) !== null) {
      throw new BusySwitchError("An account switch is already in progress in this chat.", "COMMAND_REJECTED");
    }
    const state: SwitchState = {
      commandId: input.commandId,
      fromAccountId: input.from,
      toAccountId: input.to,
      startedAt: this.opts.clock.now().toISOString(),
      // A held goal is not stopped: a Stop would take the update's hold back.
      step: goal === "held" ? "settling" : "stopping",
      goal,
      nonce: randomBytes(16).toString("hex")
    };
    this.opts.chat.setAccountSwitch(id, state);
    return this.sequence(id, state, { restarted: false });
  }

  // -------------------------------------------------------------------------
  // The sequence
  // -------------------------------------------------------------------------

  private advance(id: string, state: SwitchState, step: ChatBusySwitchStep): SwitchState {
    const next = { ...state, step };
    this.opts.chat.setAccountSwitch(id, next);
    return next;
  }

  private async sequence(id: string, first: SwitchState, opts: { restarted: boolean }): Promise<{ seq: number }> {
    let state = first;
    let seq = 0;
    try {
      if (state.step === "stopping") {
        await this.interrupt(id, state, "interrupt");
        state = this.advance(id, state, "settling");
      }
      if (state.step === "settling") {
        await this.settle(id, state);
        state = this.advance(id, state, "switching");
      }
      if (state.step === "switching") {
        try {
          seq = (
            await this.opts.switchAccount(id, {
              commandId: busySwitchCommandId(id, state, "account"),
              accountId: routeAccountId(state.toAccountId),
              busySwitch: true
            })
          ).seq;
        } catch (error) {
          const { message, code } = describe(error);
          throw new StepFailure(`The agent host refused the switch: ${message}`, code);
        }
        state = this.advance(id, state, "continuing");
      }
    } catch (error) {
      const failure = error instanceof StepFailure ? error : new StepFailure(describe(error).message, describe(error).code);
      if (opts.restarted && failure.code === "HOST_UNAVAILABLE" && this.retryLater(id)) {
        throw owed(new BusySwitchError(failure.reason, failure.code));
      }
      await this.sequenceFailed(id, state, failure.reason);
      // The switch is over (fence lifted, row written): a final answer, never one to retry — a
      // repeat of the command gets it again rather than switching anew.
      throw new BusySwitchError(this.failureAnswer(state, failure.reason), failure.code === "HOST_UNAVAILABLE" ? "COMMAND_REJECTED" : failure.code);
    }
    // Switched: whatever comes of the continue turn, the switch itself succeeded.
    try {
      await this.continueTurn(id, state);
    } catch (error) {
      const { message, code } = describe(error);
      if (opts.restarted && code === "HOST_UNAVAILABLE" && this.retryLater(id)) throw owed(new BusySwitchError(message, code));
      await this.continueFailed(id, state, message);
      return { seq };
    }
    this.opts.chat.setAccountSwitch(id, null);
    return { seq };
  }

  /** The session-scoped interrupt, `cascade: false`, under the switch's derived command id. */
  private async interrupt(id: string, state: SwitchState, part: "interrupt" | "interrupt-background"): Promise<void> {
    const api = this.requireApi();
    try {
      await sendCommand(api, id, "interrupt", { cascade: false }, { commandId: busySwitchCommandId(id, state, part), retryDelayMs: () => 0 });
    } catch (error) {
      const { message, code } = describe(error);
      throw new StepFailure(`The running work could not be stopped: ${message}`, code);
    }
  }

  /**
   * Wait until the thread can take the switch: the turn settled and nothing waits on an answer,
   * then no background work. Work that outlived the turn's interrupt is ended by a second one
   * with nothing running (it ends the session's background work); a held goal is never
   * interrupted, so its switch only waits. Bounded as a whole by the settle timeout.
   */
  private async settle(id: string, state: SwitchState): Promise<void> {
    const api = this.requireApi();
    const deadline = this.opts.clock.now().getTime() + this.settleTimeoutMs;
    const remaining = (): number => Math.max(0, deadline - this.opts.clock.now().getTime());
    const wait = (ready: (tab: SessionSummary) => boolean): Promise<boolean> =>
      waitForChat(api, { chat: this.opts.chat, clock: this.opts.clock, timeoutMs: remaining() }, id, ready);
    const gaveUp = (): StepFailure =>
      this.opts.chat.get(id)
        ? new StepFailure(`The stopped work did not settle within ${Math.round(this.settleTimeoutMs / 1000)} seconds.`, "COMMAND_REJECTED")
        : new StepFailure("The chat was closed.", "THREAD_NOT_FOUND");
    if (state.goal !== "held") {
      if (!(await wait(turnSettled))) throw gaveUp();
      const tab = this.opts.chat.get(id);
      if (tab && !idleForSwitch(tab, state.goal)) await this.interrupt(id, state, "interrupt-background");
    }
    if (!(await wait((tab) => idleForSwitch(tab, state.goal)))) throw gaveUp();
  }

  /** The continue turn, or `/goal resume`, through the chat's own `/turn`; nothing for a held goal. */
  private async continueTurn(id: string, state: SwitchState): Promise<void> {
    if (state.goal === "held") return;
    const api = this.requireApi();
    const tab = this.opts.chat.get(id);
    if (!tab) throw new BusySwitchError("The chat was closed.", "THREAD_NOT_FOUND");
    const head = await readThreadHead(api, id);
    const input =
      state.goal === "continuing"
        ? GOAL_RESUME_COMMAND
        : this.opts.adapterOf(tab.refId) === "claude"
          ? BUSY_SWITCH_CONTINUE_MESSAGE
          : BUSY_SWITCH_CONTINUE_MESSAGE_PLAIN;
    await postIdempotent(
      api,
      agentChatCommandPath(id, "turn"),
      { input, interactionMode: head.interactionMode, ifIdle: true },
      { commandId: busySwitchCommandId(id, state, "continue"), retryDelayMs: () => 0 }
    );
  }

  /** A restarted switch whose host was away goes on later, while it is young enough. */
  private retryLater(id: string): boolean {
    if (this.stopped) return false;
    this.retries.get(id)?.cancel();
    const timer = this.opts.clock.setTimeout(() => {
      if (this.retries.get(id) === timer) this.retries.delete(id);
      this.resumeOwed(id);
    }, this.opts.retryMs ?? DEFAULT_RETRY_MS);
    this.retries.set(id, timer);
    return true;
  }

  /** A switch a restart found too old to finish: given up, as a failure at its step. */
  private async abandon(id: string, state: SwitchState): Promise<{ seq: number }> {
    const reason = "Orquester restarted while it was switching the account, and the switch was given up.";
    const moved =
      state.step === "continuing" || (state.step === "switching" && (this.opts.chat.get(id)?.accountId ?? "") === state.toAccountId);
    if (moved) {
      await this.continueFailed(id, state, reason);
      return { seq: 0 };
    }
    await this.sequenceFailed(id, state, reason);
    throw new BusySwitchError(this.failureAnswer(state, reason), "COMMAND_REJECTED");
  }

  /** Switched, but the continue turn did not go out: the fence lifts and the timeline says so. */
  private async continueFailed(id: string, state: SwitchState, reason: string): Promise<void> {
    this.opts.chat.setAccountSwitch(id, null);
    if (state.goal === "held") return;
    await this.notice(id, state, {
      summary: "Moved to the other account, but could not continue",
      detail: `${sentence(reason)} The chat runs on the new account now. ${
        state.goal === "continuing" ? "The goal stays paused; send /goal resume to set it going again." : "Tell the agent to continue."
      }`
    });
  }

  /** The switch failed before it applied: the fence lifts, nothing is sent, the timeline says so. */
  private async sequenceFailed(id: string, state: SwitchState, reason: string): Promise<void> {
    this.opts.chat.setAccountSwitch(id, null);
    const stopped = state.goal !== "held" && state.step !== "stopping";
    const summary = state.goal === "held" ? "Account switch failed" : stopped ? "Account switch failed after stopping the work" : "Account switch failed while stopping the work";
    const advice =
      state.goal === "held"
        ? "Nothing was stopped: the chat stays on its current account, and its goal still resumes by itself after the Orquester update."
        : `The chat stays on its current account and was not asked to continue. Switch accounts again, or tell the agent to continue.${
            state.goal === "continuing" ? " The goal stays paused; send /goal resume to set it going again." : ""
          }`;
    await this.notice(id, state, { summary, detail: `${sentence(reason)} ${advice}` });
  }

  /** What the route answers for a failed switch. */
  private failureAnswer(state: SwitchState, reason: string): string {
    if (state.goal === "held") return `The account was not switched: ${reason}`;
    return `The account was not switched after stopping the work: ${reason}`;
  }

  private async notice(id: string, state: SwitchState, row: { summary: string; detail: string }): Promise<void> {
    // One row per switch and step it ended at: a later switch (its own command and nonce) gets its own.
    await this.opts.appendNotice(id, { commandId: busySwitchCommandId(id, state, `notice-${state.step}`), ...row }).catch((error: unknown) => {
      this.opts.logger?.warn?.("[busy-switch] the warning row could not be written", { sessionId: id, error: describe(error).message });
    });
  }

  private requireApi(): DaemonApi {
    if (!this.api) throw new StepFailure("The daemon is still starting.", "HOST_UNAVAILABLE");
    return this.api;
  }
}
