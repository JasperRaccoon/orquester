/**
 * A connection's settings (spec 2026-11-10 §7.4): for a loop edge its limit
 * ("at most N times per run", 1–20) and what the agent steps it runs again
 * do ("Continue in the same chat" / "Start a new chat"), which blocks it runs
 * again, and making it ordinary when nothing makes it point back any more;
 * for an ordinary edge that points back (an agent or another client drew a
 * cycle) the offer to make it a loop. The validator's words about the edge
 * come first, and Delete last.
 *
 * `EdgeDetails` is the body — the desktop inspector column (`EdgeInspector`)
 * and the phone's sheet (`LoopEdgeSheet`) both draw it; `sheet` sizes its
 * controls for a finger.
 */

import React, { useMemo } from "react";
import { ArrowRight, IterationCcw, Minus, Plus, Trash2, X } from "lucide-react";

import { WORKFLOW_LIMITS, workflowHandleLabel, type Workflow, type WorkflowEdgeLoop, type WorkflowProblem } from "@orquester/api";

import { cn } from "../../../lib/cn";
import {
  clampMaxLoops,
  convertToLoop,
  convertToOrdinary,
  edgeConversion,
  LOOP_SESSION_OPTIONS,
  loopResetSet,
  setLoopSettings
} from "../../../lib/workflows/loops";
import { listWords } from "../steps/StepsView";
import { Callout, FOCUS_RING, IconButton, RadioCards, ReadOnlyFieldset } from "../ui/controls";

type Graph = Pick<Workflow, "nodes" | "edges">;

export interface EdgeDetailsProps {
  workflow: Graph;
  edgeId: string;
  problems: readonly WorkflowProblem[];
  readOnly: boolean;
  /** Sized for a finger (a phone sheet). */
  sheet?: boolean;
  /** An edit, as a recipe over the definition. */
  onChange: (recipe: <W extends Graph>(workflow: W) => W) => void;
  onDelete: () => void;
  /** Show a block (its name is a button when given). */
  onSelectNode?: (nodeId: string) => void;
}

const LOOP_HINT =
  "Each time the run comes back here it starts these steps again as a new pass. When the limit is reached, you are asked: allow one more loop, or stop.";

export const LoopLimitStepper: React.FC<{
  value: number;
  onValue: (value: number) => void;
  sheet?: boolean;
  disabled?: boolean;
  labelId?: string;
}> = ({ value, onValue, sheet = false, disabled = false, labelId }) => {
  const { min, max } = WORKFLOW_LIMITS.loops;
  const button = cn(
    "inline-flex shrink-0 items-center justify-center rounded-md border border-neutral-800 text-neutral-300 transition-colors",
    "hover:border-neutral-700 hover:bg-neutral-800/60 hover:text-neutral-50 disabled:pointer-events-none disabled:opacity-35",
    FOCUS_RING,
    sheet ? "h-11 w-11" : "h-8 w-8"
  );
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" aria-label="One loop fewer" disabled={disabled || value <= min} onClick={() => onValue(clampMaxLoops(value - 1))} className={button}>
        <Minus size={sheet ? 18 : 14} aria-hidden />
      </button>
      <input
        type="text"
        inputMode="numeric"
        aria-labelledby={labelId}
        aria-label={labelId ? undefined : "Most loops per run"}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(parsed)) onValue(clampMaxLoops(parsed));
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onValue(clampMaxLoops(value + (event.key === "ArrowUp" ? 1 : -1)));
        }}
        className={cn(
          "w-14 rounded-md border border-neutral-800 bg-neutral-950/60 text-center tabular-nums text-neutral-100",
          "hover:border-neutral-700 focus:border-neutral-600 focus:outline-none disabled:opacity-50",
          sheet ? "h-11 text-base" : "h-8 text-[13px]"
        )}
      />
      <button type="button" aria-label="One loop more" disabled={disabled || value >= max} onClick={() => onValue(clampMaxLoops(value + 1))} className={button}>
        <Plus size={sheet ? 18 : 14} aria-hidden />
      </button>
      <span className={cn("pl-1 text-neutral-500", sheet ? "text-[13px]" : "text-[12px]")}>
        {value === 1 ? "time per run" : "times per run"} · {min}–{max}
      </span>
    </div>
  );
};

/** The limit and the chat choice of one loop. */
export const LoopSettingsForm: React.FC<{
  loop: WorkflowEdgeLoop;
  onChange: (patch: Partial<Pick<WorkflowEdgeLoop, "maxLoops" | "session">>) => void;
  sheet?: boolean;
  /** The steps it runs again, for the hint. */
  resetNames: readonly string[];
  /** The agent steps among them (the chat choice applies to those). */
  agentNames: readonly string[];
}> = ({ loop, onChange, sheet = false, resetNames, agentNames }) => {
  const limitId = React.useId();
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div id={limitId} className={cn("font-medium text-neutral-200", sheet ? "text-[14px]" : "text-[12.5px]")}>
          Loop at most
        </div>
        <LoopLimitStepper value={loop.maxLoops} onValue={(maxLoops) => onChange({ maxLoops })} sheet={sheet} labelId={limitId} />
        <p className="text-[11.5px] leading-4 text-neutral-500">
          {resetNames.length > 0 ? <>Runs again: {listWords(resetNames, "and")}. </> : null}
          {LOOP_HINT}
        </p>
      </div>
      <div className="space-y-1.5">
        <div className={cn("font-medium text-neutral-200", sheet ? "text-[14px]" : "text-[12.5px]")}>Each agent step it runs again</div>
        <RadioCards
          ariaLabel="Each agent step the loop runs again"
          value={loop.session}
          onValue={(session) => onChange({ session })}
          options={LOOP_SESSION_OPTIONS.map((option) => ({ value: option.id, label: option.label, description: option.hint }))}
        />
        <p className="text-[11.5px] leading-4 text-neutral-500">
          {agentNames.length > 0
            ? `Applies to ${listWords(agentNames, "and")}. If a chat can't be continued, that step starts a new one and its pass says why.`
            : "No agent step runs again in this loop, so this changes nothing yet."}
        </p>
      </div>
    </div>
  );
};

export const EdgeDetails: React.FC<EdgeDetailsProps> = ({ workflow, edgeId, problems, readOnly, sheet = false, onChange, onDelete, onSelectNode }) => {
  const edge = workflow.edges.find((candidate) => candidate.id === edgeId);
  const conversion = useMemo(() => edgeConversion(workflow, edgeId), [workflow, edgeId]);
  const reset = useMemo(() => (edge?.loop ? loopResetSet(workflow, edge) : []), [workflow, edge]);
  if (!edge) return <p className="px-1 py-6 text-center text-xs text-neutral-500">This connection no longer exists.</p>;
  const source = workflow.nodes.find((node) => node.id === edge.source);
  const target = workflow.nodes.find((node) => node.id === edge.target);
  const handleLabel = source ? workflowHandleLabel(source, edge.sourceHandle) : edge.sourceHandle;
  const own = problems.filter((problem) => problem.edgeId === edgeId && problem.severity !== "info");
  own.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  const name = (id: string, fallback: string): React.ReactNode =>
    onSelectNode ? (
      <button
        type="button"
        onClick={() => onSelectNode(id)}
        className={cn("max-w-full truncate rounded font-medium text-neutral-100 underline-offset-2 hover:underline", FOCUS_RING, sheet && "min-h-10")}
      >
        {fallback}
      </button>
    ) : (
      <span className="truncate font-medium text-neutral-100">{fallback}</span>
    );
  const action = cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md px-3 font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
    FOCUS_RING,
    sheet ? "h-11 text-[14px]" : "h-8 text-xs"
  );

  return (
    <div className={cn("space-y-4", sheet ? "text-[14px]" : "text-[12.5px]")}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-neutral-400">
        {name(edge.source, source?.name ?? edge.source)}
        {handleLabel !== "success" ? <span className="text-neutral-500">· {handleLabel}</span> : null}
        {edge.loop ? (
          <IterationCcw size={14} role="img" aria-label="loops back to" className="shrink-0 text-info" />
        ) : (
          <ArrowRight size={14} role="img" aria-label="to" className="shrink-0" />
        )}
        {name(edge.target, target?.name ?? edge.target)}
      </div>

      {own.map((problem, index) => (
        <Callout key={`${problem.code}:${index}`} tone={problem.severity === "error" ? "danger" : "warn"}>
          {problem.message}
        </Callout>
      ))}

      <ReadOnlyFieldset readOnly={readOnly} className="space-y-4">
        {edge.loop ? (
          <>
            <LoopSettingsForm
              loop={edge.loop}
              sheet={sheet}
              resetNames={reset.map((node) => node.name)}
              agentNames={reset.filter((node) => node.type === "agent").map((node) => node.name)}
              onChange={(patch) => onChange((current) => setLoopSettings(current, edgeId, patch))}
            />
            {conversion.toOrdinary === null ? (
              <Callout tone="info" title="Nothing makes this point back any more">
                {target?.name ?? "Its target"} no longer runs before {source?.name ?? "its source"}, so this can be an ordinary connection.
                <div className="pt-1.5">
                  <button
                    type="button"
                    onClick={() => onChange((current) => convertToOrdinary(current, edgeId))}
                    className={cn(action, "border border-neutral-700 text-neutral-100 hover:bg-neutral-800")}
                  >
                    Make it an ordinary connection
                  </button>
                </div>
              </Callout>
            ) : null}
          </>
        ) : conversion.toLoop !== undefined ? (
          <Callout tone="warn" title={`This goes back to ${target?.name ?? "an earlier step"}`}>
            {target?.name ?? "It"} runs before {source?.name ?? "this step"}, and workflows run in one direction. A loop goes back with a limit.
            <div className="space-y-1 pt-1.5">
              <button
                type="button"
                disabled={conversion.toLoop !== null}
                onClick={() => onChange((current) => convertToLoop(current, edgeId))}
                className={cn(action, "bg-neutral-100 text-neutral-900 hover:bg-neutral-50")}
              >
                <IterationCcw size={sheet ? 16 : 13} aria-hidden />
                Make it a loop (max {WORKFLOW_LIMITS.defaultLoop.maxLoops})
              </button>
              {conversion.toLoop ? <p className="text-[11.5px] leading-4 text-neutral-400">{conversion.toLoop}</p> : null}
            </div>
          </Callout>
        ) : null}

        <div className="border-t border-neutral-800 pt-3">
          <button type="button" onClick={onDelete} className={cn(action, "text-danger hover:bg-danger-soft/30")}>
            <Trash2 size={sheet ? 16 : 13} aria-hidden />
            {edge.loop ? "Delete loop" : "Delete connection"}
          </button>
        </div>
      </ReadOnlyFieldset>
    </div>
  );
};

/** The desktop inspector column for one selected connection. */
export const EdgeInspector: React.FC<
  Omit<EdgeDetailsProps, "sheet"> & {
    onClose: () => void;
  }
> = ({ onClose, ...props }) => {
  const edge = props.workflow.edges.find((candidate) => candidate.id === props.edgeId);
  return (
    <section aria-label={edge?.loop ? "Loop settings" : "Connection settings"} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-800 px-3">
        <span
          aria-hidden
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-lg ring-1 ring-inset",
            edge?.loop ? "bg-info/10 text-info ring-info/25" : "bg-neutral-800/70 text-neutral-400 ring-neutral-700/70"
          )}
        >
          {edge?.loop ? <IterationCcw size={14} /> : <ArrowRight size={14} />}
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-neutral-100">{edge?.loop ? "Loop" : "Connection"}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <EdgeDetails {...props} />
      </div>
    </section>
  );
};
