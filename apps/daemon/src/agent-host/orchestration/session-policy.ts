/**
 * Agent host — the session restart policy (spec §3.4).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:752-779`
 * (`runtimeModeChanged` / `cwdChanged` / `instanceChanged` /
 * `shouldRestartForModelChange` / `shouldRestartForModelSelectionChange`).
 *
 * This lives in orchestration, not in an adapter: a thread's session restarts,
 * carrying its resume cursor, when any of runtime mode, cwd, account or (Claude
 * only) the whole model-selection object changed. A model change on an adapter
 * declaring `sessionModelSwitch: "in-session"` is applied live, and plan mode
 * is a per-turn field that never restarts anything.
 */

import type {
  AdapterCapabilities,
  AgentAdapterId,
  ModelSelection,
  ProviderSession,
  RuntimeMode,
  ThreadSessionStatus
} from "@orquester/api/agent-chat";

/** What the thread now wants, as the head records it. */
export interface DesiredSessionShape {
  adapter: AgentAdapterId;
  runtimeMode: RuntimeMode;
  cwd: string;
  accountKey: string;
  modelSelection: ModelSelection;
}

/** What the live session was started with. */
export interface BoundSessionShape {
  adapter: AgentAdapterId;
  runtimeMode: RuntimeMode;
  cwd: string;
  accountKey: string;
  modelSelection: ModelSelection;
  session: ProviderSession;
}

export interface RestartDecision {
  restart: boolean;
  /** Every trigger that fired, for the log and for the tests. */
  reasons: string[];
  /**
   * False when the model itself changed on an adapter that cannot switch in
   * session — the cursor is dropped so the provider starts a clean thread.
   * *T3: `ProviderCommandReactor.ts:781-784`.*
   */
  carryResumeCursor: boolean;
}

/** Deep structural equality over a `ModelSelection`, option order included. */
export function modelSelectionEquals(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.model !== right.model) return false;
  if ((left.instanceId ?? null) !== (right.instanceId ?? null)) return false;
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  if (leftOptions.length !== rightOptions.length) return false;
  for (let index = 0; index < leftOptions.length; index += 1) {
    const a = leftOptions[index]!;
    const b = rightOptions[index]!;
    if (a.id !== b.id || a.value !== b.value) return false;
  }
  return true;
}

/**
 * §3.4. A restart is a no-op when nothing changed, so the common case costs one
 * comparison.
 */
export function decideSessionRestart(input: {
  desired: DesiredSessionShape;
  bound: BoundSessionShape;
  capabilities: AdapterCapabilities;
}): RestartDecision {
  const { desired, bound, capabilities } = input;
  const reasons: string[] = [];

  if (desired.adapter !== bound.adapter) reasons.push("adapter");
  if (desired.runtimeMode !== bound.runtimeMode) reasons.push("runtimeMode");
  if (desired.cwd !== bound.cwd) reasons.push("cwd");
  if (desired.accountKey !== bound.accountKey) reasons.push("account");

  const modelChanged = desired.modelSelection.model !== bound.modelSelection.model;
  const modelRestart = modelChanged && capabilities.sessionModelSwitch === "unsupported";
  if (modelRestart) reasons.push("model");

  // Claude only, and compared by deep equality on the WHOLE selection object —
  // thinking level and fast mode are launch configuration there.
  const selectionRestart =
    desired.adapter === "claude" &&
    !modelSelectionEquals(desired.modelSelection, bound.modelSelection);
  if (selectionRestart && !modelRestart) reasons.push("modelSelection");

  return {
    restart: reasons.length > 0,
    reasons,
    carryResumeCursor: !modelRestart
  };
}

// ---------------------------------------------------------------------------
// §3.4 — switching the account of an EXISTING thread
// ---------------------------------------------------------------------------

/**
 * Everything the identity gate reads, as data.
 *
 * The switch is applied on the next message: it rewrites the thread's launch
 * configuration and its head, and `decideSessionRestart` then restarts the
 * provider child on the send path with reason `"account"`. That is only safe
 * while nothing is in flight — a restart under a running turn would kill work
 * the user is watching, and a parked approval belongs to a provider process
 * that is about to be replaced.
 */
export interface IdentitySwitchState {
  /** The head's session status. */
  status: ThreadSessionStatus;
  activeTurnId: string | null;
  /** A turn row that has not reached a settled state. */
  hasUnsettledTurn: boolean;
  /** Open approvals + open questions. */
  pendingRequestCount: number;
  /** `/turn`s parked behind a running compaction. */
  queuedTurnCount: number;
  compacting: boolean;
  /** A background shell or task is still reporting. */
  backgroundLive: boolean;
  /**
   * The thread's goal is CONTINUING, in the summary's sense (goals §4.7,
   * §5.5): `active` on an adapter whose provider starts its next turn by
   * itself (`goals.continuesAcrossTurns`, Codex), with a live session running
   * a turn or inside the continuation grace, or a restart's resume still owed.
   * Between its turns the thread only looks idle — a turn the provider starts
   * under the old account would be killed by the next message's account
   * restart. A stopped or errored session is not continuing, and may switch —
   * unless its resume mark is still pending (after a handover the head may
   * read `stopped` or `error`), which reads as continuing.
   */
  goalContinuing: boolean;
}

/** The refusal for a continuing goal — the composer mirror shows these very words. */
export const GOAL_CONTINUING_SWITCH_REFUSAL = "Pause the goal before switching accounts.";

/**
 * The refusal message for an account switch, or `null` when the thread is idle
 * enough to take one. One expression, so the host's 409 and the composer's
 * disabled chip can never disagree about what "idle" means.
 */
export function identitySwitchRefusal(state: IdentitySwitchState): string | null {
  if (state.compacting) {
    return "Wait for the context compaction to finish before switching accounts.";
  }
  // Ahead of the turn check: between a continuing goal's turns idle never
  // comes, so waiting is the wrong advice — pausing the goal is the one that
  // works. Behind the compaction, which a goal command waits for too.
  if (state.goalContinuing) {
    return GOAL_CONTINUING_SWITCH_REFUSAL;
  }
  if (
    state.activeTurnId !== null ||
    state.hasUnsettledTurn ||
    state.status === "starting" ||
    state.status === "running"
  ) {
    return "Wait for the agent to finish the current turn before switching accounts.";
  }
  if (state.pendingRequestCount > 0) {
    return "Answer the agent's open request before switching accounts.";
  }
  if (state.queuedTurnCount > 0) {
    return "Send or clear the queued messages before switching accounts.";
  }
  if (state.backgroundLive) {
    return "Wait for the background work to finish before switching accounts.";
  }
  return null;
}
