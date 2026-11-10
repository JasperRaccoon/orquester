/**
 * The decision card wired to the workflows store (spec 2026-11-10 §6.4): a
 * waiting gate is its card; deciding goes through `decideWorkflowGate`, and
 * the toast says how it went ("Approve: sent", "Already decided: Reject by
 * Ana"); a settled gate is its one record line ("approved by you, 10:42:
 * looks good"). `GateRunSection` lists a block's gates in its run details.
 */

import React from "react";
import { Ban, CircleCheck } from "lucide-react";
import type { Workflow, WorkflowGateState } from "@orquester/api";
import { isGateWaiting } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { cn } from "../../../lib/cn";
import { useRunGates } from "../../../lib/workflows/gate-hooks";
import {
  decisionToastText,
  gateChoiceDestinations,
  gateRecordLine,
  gatesOfNode,
  gateTitle
} from "../../../lib/workflows/gates";
import { formatClock } from "../../../lib/workflows/run-view";
import { decideWorkflowGate, type WorkflowsApi } from "../../../lib/workflows/store";
import { useAppStore } from "../../../store/app";
import { GateDecisionCard, type GateCardVariant, type GateDecideResult } from "./GateDecisionCard";

type DefinitionLike = Pick<Workflow, "nodes" | "edges">;

/** Decide `gate` and say how it went in a toast; the store applies the answer. */
export function useDecideGate(gate: Pick<WorkflowGateState, "runId" | "gateId">): (choice: string, comment: string | undefined) => Promise<GateDecideResult> {
  const api = useApi() as unknown as WorkflowsApi;
  return React.useCallback(
    async (choice, comment) => {
      const result = await decideWorkflowGate(api, gate.runId, gate.gateId, {
        choice,
        ...(comment !== undefined ? { comment } : {})
      });
      if (!result.ok) {
        const message =
          result.code === "GATE_NOT_FOUND"
            ? "This gate is no longer open."
            : result.code === "GATE_NOT_DECIDER"
              ? "You can't decide this gate from here."
              : result.error;
        return { ok: false, error: message };
      }
      useAppStore.getState().setNotice({ message: decisionToastText(result.value, choice) });
      return { ok: true };
    },
    [api, gate.runId, gate.gateId]
  );
}

/** A settled gate's record, one line (announced when it replaces the card). */
export const GateRecordLine: React.FC<{ gate: WorkflowGateState; now: number; compact?: boolean; className?: string }> = ({
  gate,
  now,
  compact,
  className
}) => {
  const line = gateRecordLine(gate, (iso) => formatClock(iso, now));
  if (line === null) return null;
  const Icon = gate.decision ? CircleCheck : Ban;
  return (
    <p
      role="status"
      className={cn(
        "flex min-w-0 items-start gap-1.5 leading-4",
        compact ? "text-[11px]" : "text-[12px]",
        gate.decision ? "text-neutral-300" : "text-neutral-500",
        className
      )}
    >
      <Icon size={compact ? 11 : 13} aria-hidden className={cn("mt-px shrink-0", gate.decision ? "text-ok" : "text-neutral-500")} />
      <span className={cn("min-w-0 break-words", compact && "line-clamp-2")}>{line}</span>
    </p>
  );
};

export interface GateDecisionProps {
  gate: WorkflowGateState;
  /** The run's frozen definition (where each choice leads); `null` while it loads. */
  definition: DefinitionLike | null;
  loopLimits?: Readonly<Record<string, number>> | null;
  variant: GateCardVariant;
  now: number;
  /** The workflow's name, where the run is not on screen. */
  context?: string;
  className?: string;
}

/** A gate: its card while it waits, its record once settled. */
export const GateDecision: React.FC<GateDecisionProps> = ({ gate, definition, loopLimits, variant, now, context, className }) => {
  const decide = useDecideGate(gate);
  const destinations = React.useMemo(() => gateChoiceDestinations(definition, gate), [definition, gate]);
  const title = gateTitle(gate, definition, loopLimits);
  if (!isGateWaiting(gate)) return <GateRecordLine gate={gate} now={now} compact={variant === "node"} className={className} />;
  return (
    <GateDecisionCard
      gate={gate}
      title={title}
      destinations={destinations}
      variant={variant}
      now={now}
      onDecide={decide}
      className={className}
      {...(context ? { context } : {})}
    />
  );
};

/**
 * A block's gates in its run details: the one waiting as its card, earlier
 * ones (a loop asked again, a loop limit) as their records. Nothing for a
 * block that never waited on one.
 */
export const GateRunSection: React.FC<{
  runId: string;
  nodeId: string;
  definition: DefinitionLike | null;
  loopLimits?: Readonly<Record<string, number>> | null;
  now: number;
  variant: "docked" | "sheet";
}> = ({ runId, nodeId, definition, loopLimits, now, variant }) => {
  const gates = gatesOfNode(useRunGates(runId), nodeId);
  if (gates.length === 0) return null;
  const waiting = gates.filter(isGateWaiting);
  const settled = gates.filter((gate) => !isGateWaiting(gate));
  return (
    <section aria-label="Decision" className="space-y-2">
      {waiting.map((gate) => (
        <GateDecision key={gate.gateId} gate={gate} definition={definition} loopLimits={loopLimits} variant={variant} now={now} />
      ))}
      {settled.length > 0 ? (
        <div className="space-y-1 rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2">
          {settled.map((gate) => (
            <div key={gate.gateId} className="min-w-0 space-y-0.5">
              <p className="truncate text-[11px] text-neutral-500">
                {gateTitle(gate, definition, loopLimits)}
                {gate.pass && gate.pass > 1 ? ` · pass ${gate.pass}` : ""}
              </p>
              <GateRecordLine gate={gate} now={now} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
};
