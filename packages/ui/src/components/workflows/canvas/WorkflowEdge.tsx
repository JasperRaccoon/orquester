/**
 * An edge on the canvas: a smooth step with rounded corners from the dot of
 * an output to the dot of an input (handles have a 28 px hit area, so the
 * path is pulled in to their centres). Failure edges are red and dashed;
 * branch edges are named at their handle (and by a chip while in focus); in a run view taken edges are green, the
 * edge into a running block is animated and dead ones are greyed. Hovered, it
 * offers "+" (insert a block here) and "×" (delete).
 */

import React, { memo, useRef } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Position,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeProps,
  type Node
} from "@xyflow/react";
import { Plus, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import { HANDLE_HIT, useCanvasActions, type EdgeData } from "./canvas-context";

export type WorkflowFlowEdge = Edge<EdgeData, "wf">;

const INSET = HANDLE_HIT / 2;

function pathClass(data: EdgeData | undefined): string {
  const overlay = data?.overlay ?? null;
  if (overlay === "active") return "wf-edge-active";
  if (overlay === "taken") return "wf-edge-taken";
  if (overlay === "dead") return "wf-edge-dead";
  if (data?.runView) return "wf-edge-dead";
  if (data?.handle === "error") return "wf-edge-error";
  return "";
}

function WorkflowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected
}: EdgeProps<WorkflowFlowEdge>): React.ReactElement {
  const actions = useCanvasActions();
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: sourceX - (sourcePosition === Position.Right ? INSET : 0),
    sourceY,
    sourcePosition,
    targetX: targetX + (targetPosition === Position.Left ? INSET : 0),
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: 22
  });
  const hovered = actions.hoveredEdgeId === id;
  const showTools = !actions.readOnly && (hovered || selected);
  // The handle names its branch where the edge leaves; the chip repeats it only while the edge is in focus.
  const label = hovered || selected ? (data?.label ?? null) : null;

  const hold = (): void => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    actions.setHoveredEdgeId(id);
  };
  const release = (): void => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => actions.clearHoveredEdge(id), 160);
  };

  return (
    <>
      <BaseEdge id={id} path={path} className={cn("wf-edge-path", pathClass(data))} interactionWidth={24} />
      {label !== null || showTools ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={hold}
            onMouseLeave={release}
          >
            {label !== null ? (
              <span
                className={cn(
                  "select-none rounded-md border px-1.5 py-px text-[10.5px] font-medium leading-4",
                  data?.handle === "error"
                    ? "border-danger/40 bg-neutral-950 text-danger"
                    : "border-neutral-700 bg-neutral-950 text-neutral-300"
                )}
              >
                {label}
              </span>
            ) : null}
            {showTools ? (
              <>
                <button
                  type="button"
                  aria-label="Insert a block on this connection"
                  title="Insert a block"
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    actions.openAddMenu({ clientPoint: { x: rect.left, y: rect.bottom + 4 }, intoEdgeId: id });
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-300 shadow-md shadow-black/30 hover:border-neutral-500 hover:text-neutral-50"
                >
                  <Plus size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Delete this connection"
                  title="Delete connection"
                  onClick={(event) => {
                    event.stopPropagation();
                    actions.deleteEdge(id);
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-300 shadow-md shadow-black/30 hover:border-danger/60 hover:text-danger"
                >
                  <X size={13} />
                </button>
              </>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const WorkflowEdgeComponent = memo(WorkflowEdgeView);

/** The line drawn while a connection is being dragged, from the dot's centre. */
export function WorkflowConnectionLine<N extends Node = Node>({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionStatus
}: ConnectionLineComponentProps<N>): React.ReactElement {
  const [path] = getSmoothStepPath({
    sourceX: fromX - (fromPosition === Position.Right ? INSET : 0),
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
    borderRadius: 14,
    offset: 22
  });
  return (
    <path
      d={path}
      fill="none"
      strokeWidth={1.75}
      strokeDasharray={connectionStatus === "invalid" ? "5 5" : undefined}
      style={{
        stroke:
          connectionStatus === "invalid"
            ? "rgb(var(--sem-danger-400))"
            : connectionStatus === "valid"
              ? "rgb(var(--sem-ok-400))"
              : "rgb(var(--n-400))"
      }}
    />
  );
}
