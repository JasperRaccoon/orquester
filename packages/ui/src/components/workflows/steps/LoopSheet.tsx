/**
 * A loop edge's settings on a phone (spec 2026-11-10 §7.4): the sheet a
 * "↺ back to …" row of the step list — or a loop's label on the phone's
 * canvas — opens. The same body as the desktop inspector's, sized for a
 * finger.
 */

import React from "react";
import { IterationCcw } from "lucide-react";

import type { Workflow, WorkflowProblem } from "@orquester/api";

import { EdgeDetails, type EdgeDetailsProps } from "../inspector/EdgeSettings";
import { WorkflowSheet } from "../phone/WorkflowSheet";

export const LoopEdgeSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  workflow: Pick<Workflow, "nodes" | "edges">;
  edgeId: string | null;
  problems: readonly WorkflowProblem[];
  readOnly: boolean;
  onChange: EdgeDetailsProps["onChange"];
  onDelete: () => void;
}> = ({ open, onClose, workflow, edgeId, problems, readOnly, onChange, onDelete }) => {
  const edge = edgeId ? workflow.edges.find((candidate) => candidate.id === edgeId) : undefined;
  if (!edgeId || !edge) return null;
  const source = workflow.nodes.find((node) => node.id === edge.source)?.name ?? edge.source;
  const target = workflow.nodes.find((node) => node.id === edge.target)?.name ?? edge.target;
  return (
    <WorkflowSheet
      open={open}
      onClose={onClose}
      label={edge.loop ? `Loop from ${source} back to ${target}` : `Connection from ${source} to ${target}`}
      title={edge.loop ? "Loop" : "Connection"}
      subtitle={edge.loop ? `${source} goes back to ${target}` : `${source} leads to ${target}`}
      leading={
        <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-xl bg-info/10 text-info ring-1 ring-inset ring-info/25">
          <IterationCcw size={18} />
        </span>
      }
      level={1}
    >
      <div className="px-4 pb-6">
        <EdgeDetails workflow={workflow} edgeId={edgeId} problems={problems} readOnly={readOnly} sheet onChange={onChange} onDelete={onDelete} />
      </div>
    </WorkflowSheet>
  );
};
