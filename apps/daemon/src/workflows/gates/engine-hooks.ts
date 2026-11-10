// Automated workflows — gates (spec 2026-11-10 §6.2, §7.5): the small rules the engine's walk applies
// to gate blocks, kept here so engine.ts carries only one-line hooks. A disabled or pinned gate's
// handle is `passThroughHandle` / `pinnedHandle` in @orquester/api (shared with agent outcomes).

import type { WorkflowGateState } from "@orquester/api";

/** Why the overlap policy skipped or queued a fire, when an active run of the workflow waits on a gate (§6.2). */
export function overlapSkipDetail(gate: Pick<WorkflowGateState, "question"> | undefined): string | undefined {
  return gate !== undefined ? `previous run is waiting on gate “${gate.question}”` : undefined;
}
