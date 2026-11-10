// Automated workflows — what happens when a loop edge is taken at its limit (spec 2026-11-10 §7.2).
//
// ONE decision, in ONE function: `onLoopLimitReached`. Today the source block's pass fails with
// error kind `loop_limit` (never retried — `NOT_RETRIED` in engine.ts), so its `error` connection
// runs, else the run fails. The spec's loop-limit gate ("Allow one more loop" raises the edge's
// limit for the run via `loopLimits` and takes it; "Stop" fails the pass with `loop_limit`)
// replaces the body of this function when gates land; the engine's hook calls only this.

import type { WorkflowBlockError } from "@orquester/api";

import type { LoopEdge } from "./state.ts";

export type LoopLimitDecision =
  /** Fail the source pass with this error (its output kept); `error` handle or run failure follows. */
  { kind: "fail"; error: WorkflowBlockError };

export function onLoopLimitReached(input: { edge: LoopEdge; sourceName: string; targetName: string; limit: number }): LoopLimitDecision {
  const { edge, sourceName, targetName, limit } = input;
  return {
    kind: "fail",
    error: {
      kind: "loop_limit",
      message: `${sourceName} → ${targetName} reached its limit (${limit} loop${limit === 1 ? "" : "s"}).`,
      detail: { edgeId: edge.id, limit }
    }
  };
}
