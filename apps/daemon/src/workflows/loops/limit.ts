// Automated workflows — a loop edge taken at its limit (spec 2026-11-10 §7.2): the loop-limit gate.
//
// The source block's pass has finished on the loop's handle (its output kept), but its loop edge
// has been taken `limit` times. Instead of failing, the engine asks the person with a gate on the
// source block (`engine.gates.openPersonGate`, source "loop_limit"):
//
//   - `allow` ("Allow one more loop"): the edge's limit for this run (`run.loopLimits`) goes up by
//     one and the loop is taken;
//   - `stop` ("Stop"), or the gate expiring after the 7-day maximum: the source pass fails with error
//     kind `loop_limit` (never retried) — its `error` connection runs, else the run fails.
//
// The gates UI keys on these choice ids (packages/ui/src/lib/workflows/gates.ts `isStopChoice`). The
// wait is `WaitingOn {kind: "gate", loopLimit}` on the source block, persisted with its finish
// (engine.ts, search "Loops: at its limit").

import type { WorkflowBlockError, WorkflowGateChoiceView } from "@orquester/api";

import type { LoopEdge } from "./state.ts";

export const LOOP_LIMIT_ALLOW = "allow";
export const LOOP_LIMIT_STOP = "stop";

/** The loop-limit gate's choices (§7.2). */
export const LOOP_LIMIT_CHOICES: readonly WorkflowGateChoiceView[] = [
  { id: LOOP_LIMIT_ALLOW, label: "Allow one more loop", color: "primary", comment: "none" },
  { id: LOOP_LIMIT_STOP, label: "Stop", color: "danger", comment: "none" }
];

export interface LoopLimitInput {
  edge: LoopEdge;
  sourceName: string;
  targetName: string;
  limit: number;
}

/** The gate's question: "<source> → <target> reached its limit (N)." */
export function loopLimitQuestion(input: Omit<LoopLimitInput, "edge">): string {
  return `${input.sourceName} → ${input.targetName} reached its limit (${input.limit}).`;
}

/** The gate's details: what each choice does. */
export function loopLimitDetails(input: Omit<LoopLimitInput, "edge">, hasErrorEdge: boolean): string {
  const loops = `${input.limit} loop${input.limit === 1 ? "" : "s"}`;
  const fails = hasErrorEdge ? `${input.sourceName} fails and its error connection runs` : `${input.sourceName} fails, and with it the run`;
  return `The loop back to ${input.targetName} already ran ${loops}. **Allow one more loop** runs ${input.targetName} again once more; **Stop** ends the loop: ${fails}.`;
}

/** The source pass's failure when the person stops the loop, or nobody decided in time. */
export function loopLimitError(input: LoopLimitInput, how: "stopped" | "expired"): WorkflowBlockError {
  const { edge, sourceName, targetName, limit } = input;
  const head = `${sourceName} → ${targetName} reached its limit (${limit} loop${limit === 1 ? "" : "s"})`;
  return {
    kind: "loop_limit",
    message: how === "stopped" ? `${head}; stopped.` : `${head}; nobody decided to allow another loop in time.`,
    detail: { edgeId: edge.id, limit }
  };
}
