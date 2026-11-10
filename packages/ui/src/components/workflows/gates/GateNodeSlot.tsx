/**
 * The decision card on the run canvas (spec 2026-11-10 §6.4): a block waiting
 * on a gate — a gate block, or any block whose loop reached its limit — shows
 * the card under its status line, and a decided gate block keeps its record
 * line. React Flow draws the blocks itself, so the run rides a context the
 * run view provides around its canvas; outside one (the editor), nothing.
 */

import React, { createContext, useContext } from "react";
import { isGateWaiting, type Workflow } from "@orquester/api";

import { useRunGates } from "../../../lib/workflows/gate-hooks";
import { gatesOfNode } from "../../../lib/workflows/gates";
import { GateDecision, GateRecordLine } from "./GateDecision";

export interface GateCanvasValue {
  runId: string;
  definition: Pick<Workflow, "nodes" | "edges"> | null;
  loopLimits?: Readonly<Record<string, number>> | null;
  now: number;
}

export const GateCanvasContext = createContext<GateCanvasValue | null>(null);

export const GateNodeSlot: React.FC<{ nodeId: string; gateBlock: boolean }> = ({ nodeId, gateBlock }) => {
  const run = useContext(GateCanvasContext);
  const gates = gatesOfNode(useRunGates(run?.runId ?? null), nodeId);
  if (run === null || gates.length === 0) return null;
  const waiting = gates.find(isGateWaiting);
  if (waiting) {
    return (
      <div
        className="mt-2 border-t border-neutral-800/80 pt-2"
        // Keys typed in the card (its comment box) are not the canvas's shortcuts.
        onKeyDown={(event) => event.stopPropagation()}
      >
        <GateDecision gate={waiting} definition={run.definition} loopLimits={run.loopLimits} variant="node" now={run.now} />
      </div>
    );
  }
  if (!gateBlock) return null;
  return <GateRecordLine gate={gates[0]!} now={run.now} compact className="mt-1.5" />;
};
