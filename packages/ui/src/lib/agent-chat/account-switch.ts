/**
 * Agent chat — the composer's account chip (spec §3.4, §7.4).
 *
 * The account a thread runs under is changed from the composer and applied on
 * the **next message**: the daemon records the new identity and §3.4's
 * ensure-session step restarts the provider child on the send path, carrying
 * the resume cursor. Everything here is pure, so the gate and the option list
 * are testable without a DOM.
 *
 * No React import.
 */

import { SYSTEM_ACCOUNT_ID, type AgentAccount } from "@orquester/api";
import type {
  AdapterGoalSupport,
  AgentGoal,
  ThreadSessionStatus
} from "@orquester/api/agent-chat";

/**
 * Which managed-account family a launcher draws its accounts from.
 *
 * The proxy launchers route by model name, so `claudex` pins a seeded **Codex**
 * account (its GPT/Kimi escape hatch) and `claudemix` a seeded **Claude** one
 * (the Fable main loop); their own ids never match an `AgentAccount.agent`.
 * Mirrors `proxyAccountFamily` on the daemon (`agent-chat/service.ts`), which
 * enforces the same rule at the wire.
 */
export const PROXY_ACCOUNT_FAMILY: Record<string, "claude" | "codex"> = {
  claudemix: "claude",
  claudex: "codex"
};

/** True for a launcher whose accounts are seeded into the model proxy. */
export function isProxyLauncher(refId: string): boolean {
  return refId in PROXY_ACCOUNT_FAMILY;
}

/**
 * Whether this thread can switch accounts at all.
 *
 * OpenCode runs **one server per project** under the daemon's own identity and
 * refuses a non-system home (§3.2), so there is no per-thread account to move
 * and the daemon answers 400. Decided from the registry id **first** — that is
 * known synchronously, while the provider snapshot may not have landed yet, and
 * a chip that offers a switch for a few hundred milliseconds and then errors is
 * worse than one that never offers it.
 */
export function chatAccountSwitchSupported(input: {
  refId: string;
  adapterId?: string | undefined;
}): boolean {
  return input.refId !== "opencode" && input.adapterId !== "opencode";
}

export interface ChatAccountOption {
  id: string;
  label: string;
  /** The account's credentials went stale; it is offered, but flagged. */
  needsReauth: boolean;
}

/**
 * The accounts a chat thread of this launcher may switch to: "System" first,
 * then every managed account of the launcher's family.
 *
 * A proxy launcher's list is additionally filtered to the accounts **seeded**
 * into the model proxy: an unseeded pin emits an `acc<hex>/` routing prefix no
 * auth file serves and every later turn 502s. Same rule, same reason, as the
 * "+" menu's launch chips.
 */
export function buildChatAccountOptions(input: {
  refId: string;
  accounts: readonly AgentAccount[] | undefined;
  /** Accounts seeded into the model proxy; only read for a proxy launcher. */
  seededAccountIds?: readonly string[] | undefined;
  /** How a label is shortened for a chip (`shortAccountLabel`). */
  shortLabel: (label: string | undefined) => string | undefined;
}): ChatAccountOption[] {
  const family = PROXY_ACCOUNT_FAMILY[input.refId];
  const accountKey = family ?? input.refId;
  const seeded = new Set(input.seededAccountIds ?? []);
  const managed = (input.accounts ?? [])
    .filter((account) => account.agent === accountKey)
    .filter((account) => !family || seeded.has(account.id));
  return [
    { id: SYSTEM_ACCOUNT_ID, label: "System", needsReauth: false },
    ...managed.map((account) => ({
      id: account.id,
      label: input.shortLabel(account.label) ?? account.id,
      needsReauth: account.needsReauth === true
    }))
  ];
}

/** Everything the chip's idle gate reads, straight off the thread slice. */
export interface ChatAccountSwitchState {
  /** A turn is running or starting. */
  isTurnActive: boolean;
  /** An approval or a question is parked. */
  hasPendingRequest: boolean;
  /** Client-side queued messages waiting for a boundary (§7.4). */
  queuedCount: number;
  /** A `/revert` is rewriting the thread (§7.5). */
  reverting: boolean;
  /** The stream's own state; anything but `synchronized` is not idle. */
  connection: string;
  /** A background shell or task is still reporting. */
  backgroundLive: boolean;
  /**
   * The thread's goal is continuing — {@link isGoalContinuing} (goals §5.5).
   * Absent reads as no.
   *
   * *Added with agent goals; additive.*
   */
  goalContinuing?: boolean;
  /**
   * The provider is compacting the conversation (the store's
   * `isCompacting`). The host refuses a switch for it first, ahead of a
   * continuing goal. Absent reads as no.
   *
   * *Added with agent goals (fix round 2); additive.*
   */
  compacting?: boolean;
}

/**
 * Goals §5.5: the goal is **continuing** — the provider will start the
 * thread's next turn by itself, so the gaps between its turns are not idle.
 *
 * The host computes exactly this for the tab summary
 * (`SessionSummary.goal.continuing`), and whenever the view has that verdict
 * it wins: `null` there means the host holds no unfinished goal for the
 * thread. Without one — a host that predates the field, a summary not yet
 * received, a malformed one — a coarser form of the host's predicate, with no
 * running-turn or grace check: an `active` goal, on an adapter that continues
 * across turns (Codex), with a provider session that is live
 * (`starting`/`ready`/`running`) or a head marked for a resume after a restart
 * (`resumeGoalAfterRestart`). A stopped or errored session starts nothing, so
 * it may switch — unless its resume mark is still pending (after a handover it
 * may read `stopped` or `error`), which reads as continuing. A paused, blocked
 * or limited goal may switch too, and so may Claude's and Grok's, which run
 * inside turns the user sends.
 */
export function isGoalContinuing(input: {
  /** `SessionSummary.goal` for this thread — wire data, read field-wise. */
  summaryGoal?: unknown;
  /** The fold's goal. */
  goal: AgentGoal | null | undefined;
  /** The adapter's `capabilities.goals`. */
  support: AdapterGoalSupport | null | undefined;
  /** The head's session status. */
  sessionStatus: ThreadSessionStatus | null | undefined;
  /** The head carries `resumeGoalAfterRestart` (a deploy handover's mark). */
  resumeGoalAfterRestart?: boolean;
}): boolean {
  const summary = input.summaryGoal;
  if (summary === null) return false;
  if (typeof summary === "object" && summary !== undefined && !Array.isArray(summary)) {
    const continuing = (summary as { continuing?: unknown }).continuing;
    if (typeof continuing === "boolean") return continuing;
  }
  const live =
    input.sessionStatus === "starting" ||
    input.sessionStatus === "ready" ||
    input.sessionStatus === "running";
  return (
    input.goal?.status === "active" &&
    input.support?.continuesAcrossTurns === true &&
    (live || input.resumeGoalAfterRestart === true)
  );
}

/** The host's own words for goals §5.5's refusal (`identitySwitchRefusal`). */
export const GOAL_CONTINUING_SWITCH_REFUSAL = "Pause the goal before switching accounts.";

/** The host's own words for a switch refused during a compaction (`identitySwitchRefusal`). */
export const COMPACTION_SWITCH_REFUSAL =
  "Wait for the context compaction to finish before switching accounts.";

/**
 * The client half of §3.4's identity gate, mirroring
 * `identitySwitchRefusal` on the host — the daemon is authoritative and
 * answers 409, this only decides whether the chip is offered.
 *
 * A continuing goal closes it too (goals §5.5): a turn the provider starts
 * under the old account would be killed by the next message's account
 * restart. Pausing the goal opens it again, and the host re-creates the goal
 * on the new account (`carryGoal`).
 */
export function canSwitchChatAccount(state: ChatAccountSwitchState): boolean {
  return (
    !state.isTurnActive &&
    !state.hasPendingRequest &&
    state.queuedCount === 0 &&
    !state.reverting &&
    state.connection === "synchronized" &&
    !state.backgroundLive &&
    state.goalContinuing !== true &&
    state.compacting !== true
  );
}

/**
 * The reason the chip names, in the host's own order and words
 * (`identitySwitchRefusal`), so the chip and a refused switch never disagree:
 * a running compaction first, then a continuing goal — which only a pause
 * ends (goals §5.5); between its turns idle never comes, so it outranks a
 * running turn. `null` otherwise, where the chip's own "available when the
 * agent is idle" is the truth.
 */
export function chatAccountSwitchRefusal(state: ChatAccountSwitchState): string | null {
  if (state.compacting === true) return COMPACTION_SWITCH_REFUSAL;
  return state.goalContinuing === true ? GOAL_CONTINUING_SWITCH_REFUSAL : null;
}

/**
 * The option id a thread's stored account corresponds to.
 *
 * The head and the tab record spell the system identity as the **empty
 * string** (and the summary as `undefined`), while the menu — like the "+"
 * launch chips — spells it `SYSTEM_ACCOUNT_ID`. Without this the "System" row
 * never shows its checkmark and picking it looks like a no-op.
 */
export function chatAccountSelectionId(accountId: string | undefined): string {
  return accountId ? accountId : SYSTEM_ACCOUNT_ID;
}

/** The chip's own label: the account's short name, or "System". */
export function chatAccountLabel(input: {
  accountId: string | undefined;
  accounts: readonly AgentAccount[] | undefined;
  shortLabel: (label: string | undefined) => string | undefined;
}): string {
  if (!input.accountId || input.accountId === SYSTEM_ACCOUNT_ID) {
    return "System";
  }
  const account = (input.accounts ?? []).find((candidate) => candidate.id === input.accountId);
  return input.shortLabel(account?.label) ?? "System";
}

/**
 * The timeline row for a `session.identity-changed` activity.
 *
 * The label is resolved HERE, not frozen into the event: an account renamed
 * after the switch should read under its current name, and the host has no
 * account list to write one from.
 */
export function identityChangeSummary(input: {
  payload: unknown;
  accounts: readonly AgentAccount[] | undefined;
  shortLabel: (label: string | undefined) => string | undefined;
}): string {
  const payload =
    typeof input.payload === "object" && input.payload !== null
      ? (input.payload as { accountId?: unknown; home?: unknown })
      : null;
  if (payload === null) {
    return "Switched account";
  }
  const accountId = typeof payload.accountId === "string" ? payload.accountId : undefined;
  if (accountId === undefined) {
    return "Switched account";
  }
  return `Switched to ${chatAccountLabel({
    accountId,
    accounts: input.accounts,
    shortLabel: input.shortLabel
  })}`;
}
