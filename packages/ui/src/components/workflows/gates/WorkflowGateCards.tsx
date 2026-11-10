/**
 * A workflow's decisions in its rail card (spec 2026-11-10 §6.4): each gate of
 * its runs that waits — for the user, or for an agent the user may beat to it
 * — as its decision card, with the way to its run. On a phone the card is a
 * row that opens the decision in a bottom sheet (40 px targets, the full
 * card). A test run's gate is answered in the editor only (§7.5), so it is
 * never here. Where each choice leads comes from the run's own definition,
 * loaded on demand.
 */

import React from "react";
import { ArrowUpRight, ChevronRight, ShieldCheck } from "lucide-react";
import type { WorkflowGateState, WorkflowSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { useWorkflowGatesLoad, useWorkflowWaitingGates } from "../../../lib/workflows/gate-hooks";
import { gateTitle } from "../../../lib/workflows/gates";
import { useWorkflowRun } from "../../../lib/workflows/hooks";
import { BottomSheet } from "../../ui/sheet";
import { GateDecision } from "./GateDecision";

/** How many cards a rail card shows before "+N more". */
const SHOWN = 2;

export interface WorkflowGateCardsProps {
  workflow: Pick<WorkflowSummary, "id" | "name">;
  variant: "docked" | "sheet";
  now: number;
  /** Open the gate's run with the gate selected. */
  onOpenRun: (runId: string, gateId: string) => void;
  /** Why the run cannot be opened here (no project open), else `null`. */
  openRunDisabledReason: string | null;
}

const LINK =
  "inline-flex items-center gap-1 rounded-md px-1.5 text-[11.5px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:pointer-events-none disabled:opacity-50";

const OpenRunButton: React.FC<{ onClick: () => void; disabledReason: string | null; sheet: boolean }> = ({ onClick, disabledReason, sheet }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabledReason !== null}
    title={disabledReason ?? "Open the run, this decision selected"}
    className={cn(LINK, sheet ? "min-h-11 px-3 text-[13px]" : "min-h-7")}
  >
    <ArrowUpRight size={12} aria-hidden />
    Open run
  </button>
);

/** One gate's card, docked: the card itself, then its run. */
const DockedGate: React.FC<{ gate: WorkflowGateState; now: number; onOpenRun: () => void; disabledReason: string | null }> = ({
  gate,
  now,
  onOpenRun,
  disabledReason
}) => {
  const entry = useWorkflowRun(gate.runId);
  const definition = entry?.detail?.definition ?? null;
  return (
    <div className="space-y-1">
      <GateDecision gate={gate} definition={definition} loopLimits={entry?.detail?.loopLimits} variant="docked" now={now} context={gate.nodeName} />
      <div className="flex justify-end">
        <OpenRunButton onClick={onOpenRun} disabledReason={disabledReason} sheet={false} />
      </div>
    </div>
  );
};

/** One gate on a phone: a row; the decision opens in a bottom sheet. */
const SheetGate: React.FC<{
  gate: WorkflowGateState;
  workflowName: string;
  now: number;
  onOpenRun: () => void;
  disabledReason: string | null;
}> = ({ gate, workflowName, now, onOpenRun, disabledReason }) => {
  const [open, setOpen] = React.useState(false);
  const entry = useWorkflowRun(open ? gate.runId : null);
  const definition = entry?.detail?.definition ?? null;
  const title = gateTitle(gate, definition, entry?.detail?.loopLimits);
  const close = React.useCallback(() => setOpen(false), []);
  const person = gate.phase === "person";
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "flex min-h-12 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-1.5 text-left ring-1 ring-inset transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400",
          person ? "bg-warn/10 ring-warn/30 active:bg-warn/15" : "bg-info/10 ring-info/30 active:bg-info/15"
        )}
      >
        <ShieldCheck size={16} aria-hidden className={cn("shrink-0", person ? "text-warn" : "text-info")} />
        <span className="min-w-0 flex-1">
          <span className={cn("block text-[11px] font-medium uppercase tracking-wider", person ? "text-warn" : "text-info")}>
            {person ? "Needs your decision" : `${gate.decider.label} is deciding`}
          </span>
          <span className="block truncate text-[13.5px] text-neutral-100">{title}</span>
        </span>
        <ChevronRight size={16} aria-hidden className="shrink-0 text-neutral-500" />
      </button>
      <BottomSheet open={open} onClose={close} title={workflowName}>
        <div className="space-y-2 px-3 pb-3 pt-1">
          <GateDecision gate={gate} definition={definition} loopLimits={entry?.detail?.loopLimits} variant="sheet" now={now} context={gate.nodeName} />
          <div className="flex justify-end">
            <OpenRunButton
              onClick={() => {
                close();
                onOpenRun();
              }}
              disabledReason={disabledReason}
              sheet
            />
          </div>
        </div>
      </BottomSheet>
    </>
  );
};

export const WorkflowGateCards: React.FC<WorkflowGateCardsProps> = ({ workflow, variant, now, onOpenRun, openRunDisabledReason }) => {
  useWorkflowGatesLoad();
  const gates = useWorkflowWaitingGates(workflow.id);
  if (gates.length === 0) return null;
  const shown = gates.slice(0, SHOWN);
  const more = gates.length - shown.length;
  return (
    <div role="group" aria-label={`Decisions waiting in ${workflow.name}`} className="space-y-2">
      {shown.map((gate) =>
        variant === "sheet" ? (
          <SheetGate
            key={`${gate.runId}/${gate.gateId}`}
            gate={gate}
            workflowName={workflow.name}
            now={now}
            onOpenRun={() => onOpenRun(gate.runId, gate.gateId)}
            disabledReason={openRunDisabledReason}
          />
        ) : (
          <DockedGate
            key={`${gate.runId}/${gate.gateId}`}
            gate={gate}
            now={now}
            onOpenRun={() => onOpenRun(gate.runId, gate.gateId)}
            disabledReason={openRunDisabledReason}
          />
        )
      )}
      {more > 0 ? (
        <button
          type="button"
          disabled={openRunDisabledReason !== null}
          title={openRunDisabledReason ?? "Open the oldest of the others"}
          onClick={() => {
            const next = gates[SHOWN];
            if (next) onOpenRun(next.runId, next.gateId);
          }}
          className={cn(LINK, variant === "sheet" ? "min-h-11 px-3 text-[13px]" : "min-h-7")}
        >
          +{more} more {more === 1 ? "decision" : "decisions"}
        </button>
      ) : null}
    </div>
  );
};
