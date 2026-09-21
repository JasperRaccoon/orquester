/**
 * What the status line says, as a pure function of connection + turn (§7.6).
 *
 * Two precedence decisions live here rather than in the component:
 *
 *  - **A degraded connection outranks a live turn.** While the stream is
 *    reconnecting the client cannot know whether the turn is still moving, so
 *    it says "Reconnecting…" instead of shimmering a stale activity label. The
 *    elapsed ticker keeps running underneath, because the turn's start time is
 *    a fact the connection cannot invalidate.
 *    *T3: `Sidebar.logic.ts:835-864` — "A failed session outranks lingering
 *    background liveness".*
 *  - **Colour is spent on three meanings only**: act-now, in-motion and
 *    broken. A settled, connected thread is muted and unlabelled-by-colour.
 *    *T3: `Sidebar.logic.ts:805-818`.*
 */

import type { ActivePlanState, AgentChatConnectionState } from "../../../lib/agent-chat/contracts";
import type { ChatTone } from "../primitives/tone";

export interface StatusLineModel {
  tone: ChatTone;
  label: string;
  /** Shimmer the label: something is happening right now. */
  live: boolean;
  /** Breathe the dot. Never set on a settled state. */
  pulse: boolean;
  /** The elapsed ticker keeps counting. */
  ticking: boolean;
}

export interface StatusLineInput {
  connection: AgentChatConnectionState;
  /** Non-null ⇒ a turn is running. */
  turnStartedAt: string | null;
  /** The current activity, from the store; `null` early in a turn. */
  activityLabel: string | null;
}

export function resolveStatusLine(input: StatusLineInput): StatusLineModel {
  const turnActive = input.turnStartedAt !== null;

  switch (input.connection) {
    case "error":
      return { tone: "danger", label: "Disconnected", live: false, pulse: false, ticking: false };
    case "reconnecting":
      return { tone: "info", label: "Reconnecting…", live: true, pulse: true, ticking: turnActive };
    case "connecting":
      return { tone: "info", label: "Connecting…", live: true, pulse: true, ticking: turnActive };
    case "idle":
      return { tone: "muted", label: "Idle", live: false, pulse: false, ticking: false };
    case "synchronized":
      break;
    default: {
      const exhaustive: never = input.connection;
      void exhaustive;
      break;
    }
  }

  if (!turnActive) {
    return { tone: "muted", label: "Ready", live: false, pulse: false, ticking: false };
  }
  return {
    // An empty label is not a missing turn: the row must exist from the moment
    // the turn starts, or a thinking agent is indistinguishable from a hung one.
    label: input.activityLabel?.trim() || "Working",
    tone: "info",
    live: true,
    pulse: true,
    ticking: true
  };
}

/**
 * `2/5` for the plan chip, or `null` when there is no plan. Counted from the
 * steps themselves so it cannot go stale — a persisted count would.
 * *T3: `session-logic.ts:85-94` — the same reason the spawn row stores ids only.*
 */
export function formatPlanProgress(plan: ActivePlanState | null | undefined): string | null {
  if (!plan || plan.steps.length === 0) return null;
  const done = plan.steps.filter((step) => step.status === "completed").length;
  return `${done}/${plan.steps.length}`;
}

/** True while some step is in progress — the plan chip is then in-motion. */
export function planIsRunning(plan: ActivePlanState | null | undefined): boolean {
  return plan?.steps.some((step) => step.status === "inProgress") ?? false;
}
