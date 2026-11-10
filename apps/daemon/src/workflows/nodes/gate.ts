// Automated workflows — the Gate block (spec 2026-11-10 §6). A placeholder until the gate executor
// lands: it is replaced by the gate executor, which opens the gate (`WaitingOn` kind "gate"),
// notifies the decider and finishes on the decided `choice:<id>` handle.

import type { NodeExecutor, NodeResult } from "../contracts.ts";

export function createGateExecutor(): NodeExecutor<"gate"> {
  return {
    type: "gate",
    async execute(): Promise<NodeResult> {
      // Placeholder: replaced by the gate executor.
      return { status: "failed", error: { kind: "validation", message: "Gate blocks are not available yet." } };
    }
  };
}
