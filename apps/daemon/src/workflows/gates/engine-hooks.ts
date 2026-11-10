// Automated workflows — gates (spec 2026-11-10 §6.2, §7.5): the small rules the engine's walk applies
// to gate blocks, kept here so engine.ts carries only one-line hooks.

import { choiceHandle, gateChoiceIds, type WorkflowGateState, type WorkflowNode } from "@orquester/api";

/** A disabled gate asks nobody and takes its first choice (its input passes through, as for any disabled block). */
export function disabledGateHandle(node: WorkflowNode): string | undefined {
  if (node.type !== "gate") return undefined;
  const first = gateChoiceIds(node)[0];
  return first !== undefined ? choiceHandle(first) : undefined;
}

/**
 * The handle a pinned gate output takes: its `choice` (one of the gate's), else null — a pin without
 * one is not used (the validator refuses it). Undefined for any other block (its own rule applies).
 */
export function gatePinHandle(node: WorkflowNode, value: unknown): string | null | undefined {
  if (node.type !== "gate") return undefined;
  const choice = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { choice?: unknown }).choice : undefined;
  return typeof choice === "string" && gateChoiceIds(node).includes(choice) ? choiceHandle(choice) : null;
}

/** Why the overlap policy skipped or queued a fire, when an active run of the workflow waits on a gate (§6.2). */
export function overlapSkipDetail(gate: Pick<WorkflowGateState, "question"> | undefined): string | undefined {
  return gate !== undefined ? `previous run is waiting on gate “${gate.question}”` : undefined;
}
