/**
 * The Attention Center's "Needs you" source (spec 2026-11-10 §6.4): one row
 * per gate waiting for the person — the workflow, the question, the project
 * and how long it has waited. Opening a row opens the run with that gate's
 * block selected, where its decision card is. A row leaves on its own once
 * the gate is decided (here, elsewhere, by its timeout) or its run ends;
 * there is nothing to dismiss. Test runs' gates are answered in the editor
 * and never show here (§7.5).
 */

import React from "react";
import { ShieldCheck } from "lucide-react";

import { cn } from "../../../lib/cn";
import { formatAgo } from "../../../lib/workflows/format";
import type { GateAttentionRow } from "../../../lib/workflows/gates";
import { useGateAttention } from "../../../lib/workflows/gate-hooks";
import { openWorkflowRunInEditor } from "../runs/open-run";
import { useNow } from "../runs/shared";

export interface GateAttentionRowsProps {
  rows: readonly GateAttentionRow[];
  now: number;
  onOpen: (row: GateAttentionRow) => void;
  /** Bigger targets (the mobile drawer). */
  touch?: boolean;
}

/** The group as a picture of its props. */
export const GateAttentionRows: React.FC<GateAttentionRowsProps> = ({ rows, now, onOpen, touch }) => {
  if (rows.length === 0) return null;
  return (
    <div className="pb-1">
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-600">Needs you</div>
      <ul>
        {rows.map((row) => {
          const age = formatAgo(row.openedAt, now);
          return (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => onOpen(row)}
                title={`${row.workflowName} — ${row.question}`}
                aria-label={`${row.workflowName} needs your decision: ${row.question}${row.projectName ? `, in ${row.projectName}` : ""}${age ? `, asked ${age}` : ""}`}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded px-2 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  touch ? "min-h-11 py-1" : "py-1.5"
                )}
              >
                <span aria-hidden className="relative flex h-4 w-4 shrink-0 items-center justify-center text-warn">
                  <ShieldCheck size={14} />
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-warn ring-2 ring-neutral-900" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{row.workflowName}</span>
                  <span className="block truncate text-[11px] leading-4 text-warn/90">{row.question}</span>
                  {row.projectName ? <span className="block truncate text-[10.5px] leading-4 text-neutral-500">{row.projectName}</span> : null}
                </span>
                {age ? <span className="shrink-0 self-start pt-0.5 text-[10px] text-neutral-500">{age}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** Open a row's run with its gate selected. */
export function openGateRow(row: Pick<GateAttentionRow, "runId" | "gateId" | "workflowId" | "workflowName" | "projectPath">): boolean {
  return openWorkflowRunInEditor({
    runId: row.runId,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    gateId: row.gateId,
    ...(row.projectPath ? { projectPath: row.projectPath } : {})
  });
}

/** The live group, as the sidebar mounts it. */
export const GateAttention: React.FC<{ touch?: boolean }> = ({ touch }) => {
  const rows = useGateAttention();
  const now = useNow(false);
  return <GateAttentionRows rows={rows} now={now} touch={touch} onOpen={(row) => void openGateRow(row)} />;
};
