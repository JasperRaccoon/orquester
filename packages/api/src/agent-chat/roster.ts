/**
 * Agent chat — the subagent roster fold (spec §7.6).
 *
 * **Signatures only. Package W2 implements the bodies.**
 * Ported from T3 Code (MIT): `packages/client-runtime/src/state/subagentRuntime.ts`.
 *
 * Rules the implementation owes:
 * - the fold is keyed by `taskId` and carries the linkage bundle the task
 *   events repeat on **every** row, so it survives activity retention even if
 *   the `task.started` row aged out;
 * - metadata is **never downgraded to null** by a later partial event;
 * - a `task.completed {status: "stopped"}` folds to `interrupted`;
 * - when the session is not live, every still-**active** row becomes
 *   `interrupted`, while an `idle` row is left alone (a resumable child stays
 *   resumable);
 * - the roster is capped at {@link ROSTER_LIMIT}, evicting live rows last and
 *   newest-settled first, and updates must **never reshuffle rows that remain
 *   visible**.
 */

import type { AgentPanelModel, RuntimeSubagent, ThreadActivityItem } from "./thread.ts";

/**
 * True when this activity's payload does NOT belong on the roster as an agent.
 * Classification happens exactly once, host-side at ingestion
 * (`classifyTaskAgentKind` → the persisted `agentKind` stamp); this only reads
 * it. Rows without a stamp are background by definition.
 *
 * *T3: `state/subagentRuntime.ts:110-112`.*
 */
export function isBackgroundTaskActivity(payload: Record<string, unknown>): boolean {
  return payload.agentKind !== "agent";
}

/**
 * Fold the thread's `task.*` activities into roster rows.
 *
 * `sessionLive` is the derivation that stops a crashed or restarted host from
 * leaving a panel full of agents reading "working" forever.
 */
export function foldSubagentActivities(
  activities: readonly ThreadActivityItem[],
  options?: { readonly sessionLive?: boolean }
): RuntimeSubagent[] {
  void activities;
  void options;
  throw new Error("agent-chat: foldSubagentActivities not implemented (package W2)");
}

/** Group roster rows into the view model the panel and the spawn row read. */
export function deriveAgentPanelModel(input: {
  readonly agents: readonly RuntimeSubagent[];
}): AgentPanelModel {
  void input;
  throw new Error("agent-chat: deriveAgentPanelModel not implemented (package W2)");
}

/** The empty panel model, returned when a thread has no agents. */
export function emptyAgentPanelModel(): AgentPanelModel {
  throw new Error("agent-chat: emptyAgentPanelModel not implemented (package W2)");
}
