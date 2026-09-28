/**
 * What floats over the canvas's top-left corner: the workflow's problems (a
 * count that opens the list — each one selects its block) and the keyboard
 * shortcuts. Both are popovers, so the canvas keeps all its width.
 */

import React, { useRef, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Keyboard } from "lucide-react";

import type { WorkflowProblem } from "@orquester/api";

import { cn } from "../../lib/cn";
import { ProblemList } from "./inspector/Inspector";
import { FOCUS_RING } from "./ui/controls";
import { Popover } from "./ui/Popover";

const SHORTCUTS: [string, string][] = [
  ["Tab", "add a block at the pointer"],
  ["Double-click", "add a block there"],
  ["⌘/Ctrl C · V · D", "copy · paste · duplicate"],
  ["⌘/Ctrl Z · ⇧Z", "undo · redo"],
  ["⌘/Ctrl A", "select every block"],
  ["Arrows", "nudge (⇧ ×10)"],
  ["Delete", "remove the selection"],
  ["Shift-drag", "select an area"],
  ["Scroll · pinch", "pan · zoom"],
  ["⇧ 1", "fit to view"]
];

const PILL = cn(
  "pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium shadow-lg shadow-black/20 backdrop-blur transition-colors",
  FOCUS_RING
);

export const CanvasHud: React.FC<{
  problems: readonly WorkflowProblem[];
  nodeName: (nodeId: string) => string | undefined;
  onSelectNode: (nodeId: string) => void;
}> = ({ problems, nodeName, onSelectNode }) => {
  const [open, setOpen] = useState<"problems" | "keys" | null>(null);
  const problemsRef = useRef<HTMLButtonElement | null>(null);
  const keysRef = useRef<HTMLButtonElement | null>(null);
  const shown = problems.filter((problem) => problem.severity !== "info" || !problem.nodeId);
  const errors = shown.filter((problem) => problem.severity === "error").length;
  const warnings = shown.filter((problem) => problem.severity === "warning").length;
  const labelled = shown.map((problem) => {
    const name = problem.nodeId ? nodeName(problem.nodeId) : undefined;
    return name && !problem.message.startsWith(`${name}:`) ? { ...problem, message: `${name}: ${problem.message}` } : problem;
  });

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2">
      <button
        ref={problemsRef}
        type="button"
        aria-expanded={open === "problems"}
        onClick={() => setOpen(open === "problems" ? null : "problems")}
        title={errors > 0 ? "Problems block enabling the workflow" : undefined}
        className={cn(
          PILL,
          errors > 0
            ? "border-danger/40 bg-neutral-900/90 text-danger hover:bg-danger-soft/40"
            : warnings > 0
              ? "border-warn/40 bg-neutral-900/90 text-warn hover:bg-warn-soft/30"
              : "border-neutral-800 bg-neutral-900/80 text-neutral-400 hover:text-neutral-100"
        )}
      >
        {errors > 0 ? <AlertCircle size={13} /> : warnings > 0 ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} className="text-ok" />}
        {errors > 0
          ? `${errors} ${errors === 1 ? "problem" : "problems"}`
          : warnings > 0
            ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}`
            : "No problems"}
      </button>
      <button
        ref={keysRef}
        type="button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        aria-expanded={open === "keys"}
        onClick={() => setOpen(open === "keys" ? null : "keys")}
        className={cn(PILL, "w-8 justify-center border-neutral-800 bg-neutral-900/80 px-0 text-neutral-400 hover:text-neutral-100")}
      >
        <Keyboard size={14} />
      </button>

      <Popover
        open={open === "problems"}
        anchor={{ element: problemsRef.current }}
        onClose={() => setOpen(null)}
        ignoreOutside={(target) => problemsRef.current?.contains(target) ?? false}
        ariaLabel="Problems"
        className="w-[360px]"
      >
        <div className="border-b border-neutral-800 px-3 py-2.5">
          <div className="text-[13px] font-medium text-neutral-100">Problems</div>
          <p className="text-[11px] leading-4 text-neutral-500">Errors block enabling (not saving); warnings never block.</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {labelled.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-neutral-500">Nothing to fix.</p>
          ) : (
            <ProblemList
              problems={labelled}
              strip={false}
              onPick={(problem) => {
                if (problem.nodeId) onSelectNode(problem.nodeId);
                setOpen(null);
              }}
            />
          )}
        </div>
      </Popover>
      <Popover
        open={open === "keys"}
        anchor={{ element: keysRef.current }}
        onClose={() => setOpen(null)}
        ignoreOutside={(target) => keysRef.current?.contains(target) ?? false}
        ariaLabel="Keyboard shortcuts"
        className="w-[300px]"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 p-3 text-[11.5px] text-neutral-500">
          {SHORTCUTS.map(([keys, text]) => (
            <React.Fragment key={keys}>
              <dt className="font-medium text-neutral-300">{keys}</dt>
              <dd>{text}</dd>
            </React.Fragment>
          ))}
        </dl>
      </Popover>
    </div>
  );
};
