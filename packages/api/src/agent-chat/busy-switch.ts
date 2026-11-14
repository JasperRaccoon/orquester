/**
 * Switching a chat's account while it is busy (spec
 * `docs/superpowers/specs/2026-11-14-per-task-stop-and-live-account-switch-design.md` §3–§4).
 *
 * The composer's account chip stays usable while the chat runs. After the user confirms the
 * warning modal, the client posts the ordinary account route with
 * `AccountCommandBody.whileBusy: true`. The daemon then stops the work, waits for the thread to
 * go idle, switches the account and sends a continue turn (or `/goal resume` for a continuing
 * goal). What it is doing is persisted on the tab record before each step
 * (`SessionSummary.accountSwitch`), so a daemon restart picks up where it left off. While that
 * record stands, the daemon refuses every other turn into the chat with `TURN_NOT_IDLE`.
 */

/** Where a busy switch stands. Each step is persisted before its side effect starts. */
export type ChatBusySwitchStep =
  /** Persisted; the session-scoped interrupt (with `cascade: false`) is about to go out. */
  | "stopping"
  /** Interrupted; waiting on the bus for the thread to be idle with no live background work. */
  | "settling"
  /** Idle; the ordinary account switch is about to be applied. */
  | "switching"
  /** Switched; the continue turn (or `/goal resume`) is about to be sent. */
  | "continuing";

/**
 * The goal a busy switch found on the chat (§4):
 * - `continuing`: a goal the provider continues by itself (`goals.continuesAcrossTurns`). Stop
 *   pauses it, and the switch ends with `/goal resume` instead of the continue message.
 * - `held`: a goal paused between turns for an Orquester update. Nothing is stopped, the hold
 *   marks are kept, nothing is sent, and the goal resumes by itself on the new account after
 *   the update.
 */
export type ChatBusySwitchGoal = "continuing" | "held";

/** `SessionSummary.accountSwitch`: a busy switch in flight on this chat. */
export interface ChatBusySwitchState {
  /** The account route's `commandId`. Derived command ids (interrupt, continue) build on it. */
  commandId: string;
  /** The account the chat ran on when the switch started; "" for the system login. */
  fromAccountId: string;
  /** The account the chat is moving to; "" for the system login. */
  toAccountId: string;
  /** When the daemon accepted the switch (ISO). */
  startedAt: string;
  step: ChatBusySwitchStep;
  /** The goal found when the switch started; null when there was none to handle. */
  goal: ChatBusySwitchGoal | null;
}

/**
 * Sent after a busy switch into a Claude chat. Subagents survive an account switch there
 * (every account home shares the `projects` folder), and Orquester clears their
 * `stoppedByUser` mark, so the agent can resume them with their context.
 */
export const BUSY_SWITCH_CONTINUE_MESSAGE =
  "This chat was moved to another account. Orquester stopped your subagents and background commands to do it; the user did not cancel them. Continue where you left off: resume each subagent whose work you still need with SendMessage (it keeps its context), and rerun the background commands you still need; check before repeating anything that changes state.";

/** Sent after a busy switch into a Codex or Grok chat: no resumable subagents there. */
export const BUSY_SWITCH_CONTINUE_MESSAGE_PLAIN =
  "This chat was moved to another account. Orquester stopped your subagents and background commands to do it; the user did not cancel them. Continue where you left off: relaunch the subagents and rerun the background commands whose results you still need; check before repeating anything that changes state.";

/** Whether a prompt is one of the daemon's busy-switch continue messages. */
export function isBusySwitchContinueMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === BUSY_SWITCH_CONTINUE_MESSAGE || trimmed === BUSY_SWITCH_CONTINUE_MESSAGE_PLAIN;
}
