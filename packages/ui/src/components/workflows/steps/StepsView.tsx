/**
 * The phone's Steps view (workflows spec §7.4): the workflow as a vertical
 * outline — the shared `buildStepOutline` — one card per step in the order a
 * run meets them. Branches hang indented under their output's label (on
 * failure, true, false, a case); a block several branches lead to shows once,
 * after them, with "→ joins …" where each branch meets it; blocks no trigger
 * reaches come last.
 *
 * Tap a card to open its settings; "+" on any output adds a block there and
 * connects it (splicing into a chain); ⋯ — or a long press — opens the step's
 * menu. A whole workflow can be built from here alone.
 */

import React, { useMemo } from "react";
import { AlertCircle, AlertTriangle, CornerDownRight, MoreHorizontal, Plus, Unplug, Zap } from "lucide-react";

import type { Workflow, WorkflowProblem } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { accentClass, nodeSummary, type NodeSummaryContext } from "../../../lib/workflows/catalog-ui";
import { BlockTile } from "../AddBlockMenu";
import { useLongPress } from "../phone/use-long-press";
import { deriveSteps, type OutputRef, type OutputTone, type StepRow } from "./steps-logic";

export interface StepsViewProps {
  workflow: Workflow;
  problems: readonly WorkflowProblem[];
  summaryContext: NodeSummaryContext;
  selectedNodeId: string | null;
  readOnly: boolean;
  onOpenStep: (nodeId: string) => void;
  onAddAfter: (from: OutputRef) => void;
  /** The empty workflow's "Add a trigger" / "Add the first step". */
  onAddFirst: (kind: "trigger" | "step") => void;
  onStepMenu: (row: StepRow) => void;
  className?: string;
}

const INDENT = 18;

export const TONE_CHIP: Record<OutputTone, string> = {
  ok: "text-ok",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-neutral-300"
};

export const TONE_DOT: Record<OutputTone, string> = {
  ok: "bg-ok",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-neutral-400"
};

/** How an output's "+" chip reads: what it adds, and where the output leads now. */
export function outputChipLabel(
  output: { handle: string; label: string; connected: boolean; targets: readonly string[] },
  only: boolean
): { text: string; leadsTo: string | null } {
  const leadsTo = output.targets.length === 0 ? null : output.targets.length === 1 ? output.targets[0]! : `${output.targets.length} steps`;
  if (output.handle === "success") return { text: output.connected ? "Insert step" : only ? "Add step" : "Next step", leadsTo: null };
  return { text: output.handle === "error" ? "On failure" : output.label, leadsTo };
}

/** A branch's heading: its output, and whose it is when the row is not right under it. */
export function branchChipText(via: { handle: string; label: string; parentName: string | null }): string {
  if (via.handle === "error") return via.parentName ? `If ${via.parentName} fails` : "On failure";
  if (via.handle === "true" || via.handle === "false") return via.parentName ? `${via.parentName} · ${via.label}` : `If ${via.label}`;
  return via.parentName ? `${via.parentName} · ${via.label}` : via.label;
}

export const StepsView: React.FC<StepsViewProps> = ({
  workflow,
  problems,
  summaryContext,
  selectedNodeId,
  readOnly,
  onOpenStep,
  onAddAfter,
  onAddFirst,
  onStepMenu,
  className
}) => {
  const model = useMemo(
    () => deriveSteps(workflow, problems, (node) => nodeSummary(node, summaryContext)),
    [workflow, problems, summaryContext]
  );
  const triggerOnly =
    model.hasTrigger &&
    model.rows.filter((row) => row.kind === "node" && !row.unreachable).length === 1 &&
    workflow.edges.length === 0;

  if (model.blockCount === 0) {
    return (
      <div className={cn("px-4 pb-32 pt-6", className)}>
        <EmptyCard
          icon={<Zap size={22} />}
          title="Add a trigger"
          text="A trigger starts the workflow: a schedule, a git event, or Run now."
          action="Choose a trigger"
          onClick={() => onAddFirst("trigger")}
          disabled={readOnly}
          primary
        />
        <button
          type="button"
          disabled={readOnly}
          onClick={() => onAddFirst("step")}
          className="mx-auto mt-4 flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-neutral-400 hover:text-neutral-100 disabled:opacity-40"
        >
          <Plus size={15} /> Or start with a step (Run now only)
        </button>
      </div>
    );
  }

  return (
    <ol aria-label="Steps" className={cn("space-y-2 px-3 pb-32 pt-3", className)}>
      {model.rows.map((row, index) => (
        <React.Fragment key={row.key}>
          {row.firstUnreachable ? (
            <li className="px-1 pb-1 pt-5">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <Unplug size={13} aria-hidden />
                Not connected to a trigger
              </div>
              <p className="mt-1 text-[12.5px] leading-[18px] text-neutral-500">
                These never run until a step leads to them — use ⋯ › Connect to… on the step before.
              </p>
            </li>
          ) : null}
          {row.kind === "join-ref" ? (
            <JoinRef row={row} onOpen={onOpenStep} />
          ) : (
            <StepCard
              row={row}
              continues={continuesAbove(model.rows, index)}
              selected={row.nodeId === selectedNodeId}
              readOnly={readOnly}
              onOpen={onOpenStep}
              onAddAfter={onAddAfter}
              onMenu={onStepMenu}
            />
          )}
        </React.Fragment>
      ))}
      {triggerOnly ? (
        <li className="pt-1">
          <EmptyCard
            icon={<Plus size={20} />}
            title="Add the first step"
            text="An agent, a script, a request — it runs when the trigger fires."
            action="Choose a step"
            onClick={() => onAddFirst("step")}
            disabled={readOnly}
          />
        </li>
      ) : null}
    </ol>
  );
};

/** "A, B or C". */
export function listWords(names: readonly string[], conjunction: "and" | "or"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}

const Guides: React.FC<{ depth: number }> = ({ depth }) => (
  <>
    {Array.from({ length: depth }, (_, index) => (
      <span
        key={index}
        aria-hidden
        className="absolute -bottom-2 -top-2 w-px bg-neutral-800"
        style={{ left: index * INDENT + 8 }}
      />
    ))}
  </>
);

const BranchChip: React.FC<{ via: NonNullable<StepRow["via"]> }> = ({ via }) => (
  <div className="flex items-center gap-1.5 pb-1.5 pl-1 pt-1">
    <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[via.tone])} />
    <span className={cn("truncate text-[11px] font-semibold uppercase tracking-wider", TONE_CHIP[via.tone])}>{branchChipText(via)}</span>
  </div>
);

/** The row right above is its parent, on the same level: a chain, joined by a line. */
function continuesAbove(rows: readonly StepRow[], index: number): boolean {
  const row = rows[index]!;
  const above = rows[index - 1];
  return row.kind === "node" && row.via === null && above !== undefined && above.kind === "node" && above.depth === row.depth && row.parentId === above.nodeId;
}

const StepCard: React.FC<{
  row: StepRow;
  continues: boolean;
  selected: boolean;
  readOnly: boolean;
  onOpen: (nodeId: string) => void;
  onAddAfter: (from: OutputRef) => void;
  onMenu: (row: StepRow) => void;
}> = ({ row, continues, selected, readOnly, onOpen, onAddAfter, onMenu }) => {
  const press = useLongPress(() => onMenu(row));
  const onlyOne = row.outputs.length === 1;
  const chip = (output: StepRow["outputs"][number]): React.ReactNode => {
    const { text, leadsTo } = outputChipLabel(output, onlyOne);
    return (
      <>
        {text}
        {leadsTo ? <span className="font-normal text-neutral-500">→ {leadsTo}</span> : null}
      </>
    );
  };
  return (
    <li className="relative" style={{ paddingLeft: row.depth * INDENT }} data-step-id={row.nodeId}>
      <Guides depth={row.depth} />
      {continues ? (
        <span aria-hidden className="absolute -top-2 h-2 w-0.5 rounded-full bg-neutral-700" style={{ left: row.depth * INDENT + 33 }} />
      ) : null}
      {row.via ? <BranchChip via={row.via} /> : null}
      <div
        role="button"
        tabIndex={0}
        aria-label={`${row.name} — open its settings`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(row.nodeId)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(row.nodeId);
          }
        }}
        {...press}
        className={cn(
          "wf-step group relative select-none overflow-hidden rounded-2xl border bg-neutral-900 transition-[border-color,box-shadow,opacity]",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 [-webkit-touch-callout:none]",
          accentClass(row.type),
          selected ? "border-neutral-500 shadow-lg shadow-black/25" : "border-neutral-800 active:border-neutral-700",
          row.disabled && "wf-block-disabled",
          (row.disabled || row.unreachable) && "opacity-70"
        )}
      >
        <span aria-hidden className="absolute bottom-3 left-[5px] top-3 w-[3px] rounded-full bg-[rgb(var(--wf-accent))]" />
        <div className="flex items-start gap-3 py-3 pl-4 pr-1.5">
          <div className="pt-0.5">
            <BlockTile type={row.type} />
          </div>
          <div className="min-w-0 flex-1 pt-px">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn("truncate text-[15px] font-semibold leading-5 text-neutral-50", row.disabled && "line-through decoration-neutral-600")}>
                {row.name}
              </span>
              {row.disabled ? (
                <span className="shrink-0 rounded bg-neutral-800 px-1.5 text-[10.5px] font-medium leading-4 text-neutral-400">Off</span>
              ) : null}
              {row.errors > 0 || row.warnings > 0 ? (
                <span
                  className={cn(
                    "inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-semibold",
                    row.errors > 0 ? "bg-danger-600 text-white" : "bg-warn-500 text-neutral-950"
                  )}
                  aria-label={`${row.errors > 0 ? row.errors : row.warnings} ${row.errors > 0 ? "problems" : "warnings"}`}
                >
                  {row.errors > 0 ? <AlertCircle size={11} aria-hidden /> : <AlertTriangle size={11} aria-hidden />}
                  {row.errors > 0 ? row.errors : row.warnings}
                </span>
              ) : null}
            </div>
            <div className="truncate text-[13px] leading-[18px] text-neutral-400">{row.summary || " "}</div>
            {row.firstProblem ? (
              <div className={cn("mt-0.5 line-clamp-2 text-[12px] leading-4", row.errors > 0 ? "text-danger" : "text-warn")}>
                {row.firstProblem}
              </div>
            ) : null}
            {row.joinOf.length > 1 ? (
              <div className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-neutral-500">
                {row.failureJoin
                  ? `When ${listWords(row.joinOf, "or")} fails`
                  : `${row.type === "merge" ? "Waits for" : "After"} ${listWords(row.joinOf, row.type === "merge" ? "and" : "or")}`}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={`More actions for ${row.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onMenu(row);
            }}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
        {!readOnly && row.outputs.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pb-3">
            {row.outputs.map((output) => (
              <button
                key={output.handle}
                type="button"
                aria-label={`Add a block after ${row.name}${output.handle === "success" ? "" : ` · ${output.label}`}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onAddAfter({ nodeId: row.nodeId, handle: output.handle });
                }}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors",
                  "border-neutral-800 bg-neutral-950/60 hover:border-neutral-700 active:bg-neutral-800",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  output.handle === "success" ? "text-neutral-100" : TONE_CHIP[output.tone]
                )}
              >
                <Plus size={14} aria-hidden className={output.handle === "success" ? "text-neutral-400" : undefined} />
                {chip(output)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
};

const JoinRef: React.FC<{ row: StepRow; onOpen: (nodeId: string) => void }> = ({ row, onOpen }) => (
  <li className="relative" style={{ paddingLeft: row.depth * INDENT }}>
    <Guides depth={row.depth} />
    {row.via ? <BranchChip via={row.via} /> : null}
    <button
      type="button"
      onClick={() => onOpen(row.nodeId)}
      className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-dashed border-neutral-800 px-3 text-left text-[13px] text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
    >
      <CornerDownRight size={15} aria-hidden className="shrink-0 text-neutral-500" />
      <span className="truncate">
        joins <span className="font-medium text-neutral-200">{row.name}</span>
      </span>
    </button>
  </li>
);

const EmptyCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  text: string;
  action: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}> = ({ icon, title, text, action, onClick, disabled, primary }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      "flex w-full flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-8 text-center transition-colors disabled:opacity-50",
      primary ? "wf-accent-trigger border-neutral-700 bg-neutral-900/60" : "wf-accent-agent border-neutral-800 bg-neutral-900/30",
      "hover:border-neutral-600 active:bg-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
    )}
  >
    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgb(var(--wf-accent)/0.14)] text-[rgb(var(--wf-accent))] ring-1 ring-inset ring-[rgb(var(--wf-accent)/0.25)]">
      {icon}
    </span>
    <span className="text-[16px] font-semibold text-neutral-50">{title}</span>
    <span className="max-w-[280px] text-[13px] leading-5 text-neutral-400">{text}</span>
    <span className="mt-1 inline-flex h-10 items-center rounded-full bg-neutral-100 px-5 text-sm font-semibold text-neutral-900">{action}</span>
  </button>
);
