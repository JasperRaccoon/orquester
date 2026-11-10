/**
 * An edge on the canvas: a smooth step with rounded corners from the dot of
 * an output to the dot of an input (handles have a 28 px hit area, so the
 * path is pulled in to their centres). Failure edges are red and dashed;
 * branch edges are named at their handle (and by a chip while in focus); in a run view taken edges are green, the
 * edge into a running block is animated and dead ones are greyed. Hovered, it
 * offers "+" (insert a block here) and "×" (delete).
 *
 * A loop edge (spec 2026-11-10 §7.4) is dashed and routed back above the
 * blocks it runs again (`loop-path`), and always labelled: "↺ changes · max
 * 2" in the editor — a button that opens its settings — and "↺ changes · 1/2"
 * in a run, faded once the loop is used up. An edge the validator flags
 * carries a marker with the problem. While a connection is dragged, the line
 * says what dropping it makes: a loop back, or why it cannot connect.
 */

import React, { memo, useMemo, useRef } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Position,
  useStore,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeProps,
  type Node,
  type ReactFlowState
} from "@xyflow/react";
import { AlertCircle, AlertTriangle, Plus, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import { HANDLE_HIT, useCanvasActions, type EdgeData } from "./canvas-context";
import { loopEdgePath, loopLane, type Box } from "./loop-path";

export type WorkflowFlowEdge = Edge<EdgeData, "wf">;

const INSET = HANDLE_HIT / 2;

function pathClass(data: EdgeData | undefined): string {
  const overlay = data?.overlay ?? null;
  if (overlay === "active") return "wf-edge-active";
  if (overlay === "taken") return "wf-edge-taken";
  if (overlay === "dead") return "wf-edge-dead";
  if (data?.runView) return "wf-edge-dead";
  if (data?.problem) return data.problem.severity === "error" ? "wf-edge-problem" : "wf-edge-warning";
  if (data?.handle === "error") return "wf-edge-error";
  return "";
}

const TOOL_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-300 shadow-md shadow-black/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400";

/** "+" (insert a block on the edge) and "×" (delete it), while it is hovered or selected. */
const EdgeTools: React.FC<{ id: string; loop: boolean }> = ({ id, loop }) => {
  const actions = useCanvasActions();
  return (
    <>
      <button
        type="button"
        aria-label={loop ? "Insert a block before the loop goes back" : "Insert a block on this connection"}
        title="Insert a block"
        onClick={(event) => {
          event.stopPropagation();
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          actions.openAddMenu({ clientPoint: { x: rect.left, y: rect.bottom + 4 }, intoEdgeId: id });
        }}
        className={cn(TOOL_BUTTON, "hover:border-neutral-500 hover:text-neutral-50")}
      >
        <Plus size={13} />
      </button>
      <button
        type="button"
        aria-label={loop ? "Delete this loop" : "Delete this connection"}
        title={loop ? "Delete loop" : "Delete connection"}
        onClick={(event) => {
          event.stopPropagation();
          actions.deleteEdge(id);
        }}
        className={cn(TOOL_BUTTON, "hover:border-danger/60 hover:text-danger")}
      >
        <X size={13} />
      </button>
    </>
  );
};

/** The validator's problem on an edge, as a marker that opens the edge (when it can be edited). */
const ProblemMarker: React.FC<{ id: string; problem: NonNullable<EdgeData["problem"]> }> = ({ id, problem }) => {
  const actions = useCanvasActions();
  const error = problem.severity === "error";
  const Icon = error ? AlertCircle : AlertTriangle;
  const className = cn(
    "flex h-5 w-5 items-center justify-center rounded-full shadow-md shadow-black/30",
    error ? "bg-danger-600 text-white" : "bg-warn-500 text-neutral-950"
  );
  const label = `${error ? "Problem" : "Warning"}: ${problem.message}`;
  if (actions.readOnly || !actions.openEdge) {
    return (
      <span role="img" aria-label={label} title={problem.message} className={className}>
        <Icon size={11} aria-hidden />
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={`${label} — open this connection`}
      title={problem.message}
      onClick={(event) => {
        event.stopPropagation();
        actions.openEdge?.(id);
      }}
      className={cn(className, "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300")}
    >
      <Icon size={11} aria-hidden />
    </button>
  );
};

function WorkflowEdgeView(props: EdgeProps<WorkflowFlowEdge>): React.ReactElement {
  return props.data?.loop ? <LoopEdgeView {...props} /> : <ForwardEdgeView {...props} />;
}

function ForwardEdgeView({
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
  const fromX = sourceX - (sourcePosition === Position.Right ? INSET : 0);
  const toX = targetX + (targetPosition === Position.Left ? INSET : 0);
  // A failure edge to a block further right on another row turns right away,
  // in the gap beside its own block, and runs along the target's row — never
  // through the cards between (the success path it would otherwise cross).
  const turnsEarly = data?.handle === "error" && toX - fromX > 120 && Math.abs(targetY - sourceY) > 30;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: fromX,
    sourceY,
    sourcePosition,
    targetX: toX,
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: 22,
    ...(turnsEarly ? { centerX: fromX + 26 } : {})
  });
  const hovered = actions.hoveredEdgeId === id;
  const showTools = !actions.readOnly && (hovered || selected);
  // The handle names its branch where the edge leaves; the chip repeats it only while the edge is in focus.
  const label = hovered || selected ? (data?.label ?? null) : null;
  const problem = data?.problem ?? null;

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
      {label !== null || showTools || problem ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={hold}
            onMouseLeave={release}
          >
            {problem ? <ProblemMarker id={id} problem={problem} /> : null}
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
            {showTools ? <EdgeTools id={id} loop={false} /> : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

/** The cards a loop's lane must clear: every block but notes, as React Flow measured them. */
function laneSelector(source: { x: number; y: number }, target: { x: number; y: number }, level: number) {
  return (state: ReactFlowState): number => {
    const boxes: Box[] = [];
    for (const node of state.nodeLookup.values()) {
      if (node.type === "note" || node.hidden) continue;
      const at = node.internals.positionAbsolute;
      boxes.push({ x: at.x, y: at.y, width: node.measured?.width ?? node.width ?? 240, height: node.measured?.height ?? node.height ?? 80 });
    }
    return loopLane(source, target, boxes, level);
  };
}

function LoopEdgeView({
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
  const loop = data!.loop!;
  const from = { x: sourceX - (sourcePosition === Position.Right ? INSET : 0), y: sourceY };
  const to = { x: targetX + (targetPosition === Position.Left ? INSET : 0), y: targetY };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selectLane = useMemo(() => laneSelector(from, to, loop.level), [from.x, from.y, to.x, to.y, loop.level]);
  const lane = useStore(selectLane);
  const { path, labelX, labelY } = loopEdgePath(from, to, lane);
  const hovered = actions.hoveredEdgeId === id;
  const showTools = !actions.readOnly && (hovered || selected);
  const counter = loop.counter;
  const overlay = data?.overlay ?? null;
  const problem = data?.problem ?? null;
  const editable = !actions.readOnly && actions.openEdge !== null;
  const tone = problem
    ? problem.severity === "error"
      ? "border-danger/50 text-danger"
      : "border-warn/50 text-warn"
    : overlay === "dead"
      ? "border-neutral-800 text-neutral-500"
      : overlay === "taken" || overlay === "active"
        ? "border-ok/40 text-ok"
        : "border-info/40 text-info";
  const text = (
    <>
      <span className="tabular-nums">{loop.label}</span>
      {loop.newChat && !counter ? <span className="font-normal text-neutral-400"> · new chat</span> : null}
    </>
  );
  const chipClass = cn(
    "select-none whitespace-nowrap rounded-md border bg-neutral-950 px-1.5 py-px text-[10.5px] font-medium leading-4 shadow-sm shadow-black/30",
    "transition-opacity duration-150 motion-reduce:transition-none",
    tone,
    actions.touch && "px-2 py-1 text-[12px]",
    counter?.exhausted && "opacity-55",
    selected && "ring-1 ring-neutral-300"
  );
  const describe = problem ? `${loop.description}. ${problem.message}` : loop.description;

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
      <BaseEdge
        id={id}
        path={path}
        className={cn("wf-edge-path wf-edge-loop", pathClass(data), counter?.exhausted && "wf-edge-loop-exhausted")}
        interactionWidth={24}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onMouseEnter={hold}
          onMouseLeave={release}
        >
          {problem ? <ProblemMarker id={id} problem={problem} /> : null}
          {editable ? (
            <button
              type="button"
              aria-label={`${describe}. Edit the loop`}
              title={describe}
              onClick={(event) => {
                event.stopPropagation();
                actions.openEdge?.(id);
              }}
              className={cn(chipClass, "hover:border-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-300")}
            >
              {text}
            </button>
          ) : (
            <span role="img" aria-label={describe} title={describe} className={chipClass}>
              {text}
            </span>
          )}
          {showTools ? <EdgeTools id={id} loop /> : null}
        </div>
      </EdgeLabelRenderer>
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
  connectionStatus,
  fromNode,
  fromHandle,
  toNode
}: ConnectionLineComponentProps<N>): React.ReactElement {
  const actions = useCanvasActions();
  // Over a block: what dropping here makes (a loop back, or why it cannot connect).
  const verdict =
    toNode && fromNode && toNode.id !== fromNode.id
      ? actions.classifyConnection({ source: fromNode.id, sourceHandle: fromHandle?.id ?? null, target: toNode.id })
      : null;
  const loop = verdict?.kind === "loop";
  const hint = verdict?.kind === "loop" ? `↺ Loop back to ${verdict.targetName}` : verdict?.kind === "refused" ? verdict.reason : null;
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
    <g>
      <path
        d={path}
        fill="none"
        strokeWidth={1.75}
        strokeDasharray={connectionStatus === "invalid" ? "5 5" : loop ? "7 5" : undefined}
        style={{
          stroke:
            connectionStatus === "invalid"
              ? "rgb(var(--sem-danger-400))"
              : loop
                ? "rgb(var(--sem-info-400))"
                : connectionStatus === "valid"
                  ? "rgb(var(--sem-ok-400))"
                  : "rgb(var(--n-400))"
        }}
      />
      {hint ? (
        <foreignObject x={toX + 14} y={toY - 40} width={280} height={36} style={{ overflow: "visible", pointerEvents: "none" }}>
          <div
            role="status"
            className={cn(
              "inline-block max-w-[280px] rounded-md border bg-neutral-950/95 px-2 py-1 text-[11px] font-medium leading-4 shadow-lg shadow-black/40",
              loop ? "border-info/40 text-info" : "border-danger/40 text-danger"
            )}
          >
            {hint}
          </div>
        </foreignObject>
      ) : null}
    </g>
  );
}
