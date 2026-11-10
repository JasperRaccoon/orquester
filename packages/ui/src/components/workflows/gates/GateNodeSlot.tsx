/**
 * The decision card on the run canvas (spec 2026-11-10 §6.4): a block waiting
 * on a gate — a gate block, or any block whose loop reached its limit — shows
 * the card under its status line, and a decided gate block keeps its record
 * line. React Flow draws the blocks itself, so the run rides a context the
 * run view provides around its canvas; outside one (the editor), nothing.
 *
 * On a phone the card would be too small to tap, so the block shows a
 * "Decide" row (40 px) that opens the whole card in a bottom sheet, as the
 * rail does. A click or tap inside the slot (or the sheet portaled from it)
 * is the decision's, never the block's: it does not select or open the block.
 */

import React, { createContext, useContext } from "react";
import { ChevronRight, RotateCcw, ShieldCheck } from "lucide-react";
import { isGateWaiting, type Workflow, type WorkflowGateState } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { useRunGates } from "../../../lib/workflows/gate-hooks";
import { gatesOfNode, gateTitle } from "../../../lib/workflows/gates";
import { usePhoneLayout } from "../phone/phone-context";
import { BottomSheet } from "../../ui/sheet";
import { GateDecision, GateRecordLine } from "./GateDecision";

export interface GateCanvasValue {
  runId: string;
  definition: Pick<Workflow, "nodes" | "edges"> | null;
  loopLimits?: Readonly<Record<string, number>> | null;
  now: number;
}

export const GateCanvasContext = createContext<GateCanvasValue | null>(null);

/** Events inside the slot stay the slot's: the block under it neither selects nor opens. */
const stop = (event: React.SyntheticEvent): void => event.stopPropagation();

/** A phone's in-block row: the decision opens in a bottom sheet. */
const PhoneDecideRow: React.FC<{ gate: WorkflowGateState; run: GateCanvasValue }> = ({ gate, run }) => {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  const person = gate.phase === "person";
  const title = gateTitle(gate, run.definition, run.loopLimits);
  const Icon = gate.source === "loop_limit" ? RotateCcw : ShieldCheck;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Decide: ${title}`}
        onClick={() => setOpen(true)}
        className={cn(
          "nodrag nopan flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left ring-1 ring-inset transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400",
          person ? "bg-warn/10 text-warn ring-warn/30 active:bg-warn/15" : "bg-info/10 text-info ring-info/30 active:bg-info/15"
        )}
      >
        <Icon size={14} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium leading-4">{person ? "Decide" : `${gate.decider.label} is deciding`}</span>
          <span className="block truncate text-[11px] leading-4 text-neutral-300">{title}</span>
        </span>
        <ChevronRight size={14} aria-hidden className="shrink-0 text-neutral-500" />
      </button>
      <BottomSheet open={open} onClose={close} title={gate.nodeName} label={title}>
        <div className="px-3 pb-3 pt-1">
          <GateDecision gate={gate} definition={run.definition} loopLimits={run.loopLimits} variant="sheet" now={run.now} />
        </div>
      </BottomSheet>
    </>
  );
};

export const GateNodeSlot: React.FC<{ nodeId: string; gateBlock: boolean }> = ({ nodeId, gateBlock }) => {
  const run = useContext(GateCanvasContext);
  const phone = usePhoneLayout();
  const gates = gatesOfNode(useRunGates(run?.runId ?? null), nodeId);
  if (run === null || gates.length === 0) return null;
  const waiting = gates.find(isGateWaiting);
  if (waiting) {
    return (
      <div
        data-gate-slot=""
        className="mt-2 border-t border-neutral-800/80 pt-2"
        // Keys typed in the card (its comment box) are not the canvas's shortcuts; clicks are not the block's.
        onKeyDown={stop}
        onClick={stop}
        onDoubleClick={stop}
      >
        {phone ? (
          <PhoneDecideRow gate={waiting} run={run} />
        ) : (
          <GateDecision gate={waiting} definition={run.definition} loopLimits={run.loopLimits} variant="node" now={run.now} />
        )}
      </div>
    );
  }
  if (!gateBlock) return null;
  return <GateRecordLine gate={gates[0]!} now={run.now} compact className="mt-1.5" />;
};
