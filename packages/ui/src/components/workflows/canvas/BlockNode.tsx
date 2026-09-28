/**
 * One block on the canvas (workflows spec §7.2): a 240 px card with its
 * category's icon tile and left accent, the name, a one-line summary, a
 * validation badge, a disabled look, and — in a run view — a status ring, the
 * duration and (agents) the account and hops. Its input handle sits on the
 * left; its outputs on the right, one labelled row each when there is more
 * than one. An output with nothing wired to it carries the "+" that adds and
 * connects a block in one step.
 */

import React, { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  Check,
  Clock,
  Hourglass,
  Loader2,
  Pin,
  Plus,
  SkipForward,
  X,
  type LucideIcon
} from "lucide-react";

import { acceptsInput, isTriggerType, outputHandles, workflowHandleLabel } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { accentClass, BLOCK_ICONS } from "../../../lib/workflows/catalog-ui";
import { formatDuration } from "../../../lib/workflows/format";
import type { OverlayNodeState } from "../../../lib/workflows/overlay";
import { HANDLE_HIT, useCanvasActions, type BlockNodeData } from "./canvas-context";

export type BlockFlowNode = Node<BlockNodeData, "block">;

/** The paint of an output handle's dot and label. */
export function handleTone(handle: string): { dot: string; text: string } {
  if (handle === "success" || handle === "true") return { dot: "var(--sem-ok-400)", text: "text-ok" };
  if (handle === "error") return { dot: "var(--sem-danger-400)", text: "text-danger" };
  if (handle === "false") return { dot: "var(--n-400)", text: "text-neutral-400" };
  if (handle.startsWith("case:")) return { dot: "var(--sem-info-400)", text: "text-info" };
  return { dot: "var(--n-400)", text: "text-neutral-400" };
}

const STATUS_VIEW: Record<
  OverlayNodeState["status"],
  { label: string; icon: LucideIcon; tone: string; ring: string }
> = {
  pending: { label: "Pending", icon: Clock, tone: "text-neutral-400", ring: "ring-1 ring-neutral-700" },
  queued: { label: "Queued", icon: Clock, tone: "text-neutral-300", ring: "ring-2 ring-neutral-500 ring-offset-0" },
  running: { label: "Running", icon: Loader2, tone: "text-info", ring: "wf-ring-running" },
  waiting: { label: "Waiting", icon: Hourglass, tone: "text-warn", ring: "ring-2 ring-warn/80" },
  succeeded: { label: "Succeeded", icon: Check, tone: "text-ok", ring: "ring-2 ring-ok/80" },
  failed: { label: "Failed", icon: X, tone: "text-danger", ring: "ring-2 ring-danger/90" },
  skipped: { label: "Skipped", icon: SkipForward, tone: "text-neutral-500", ring: "ring-1 ring-neutral-700" },
  cancelled: { label: "Cancelled", icon: Ban, tone: "text-neutral-400", ring: "ring-2 ring-neutral-600" }
};

/**
 * Where handles sit, from the card's top: the input and the first output on
 * the header's centre line (so a straight chain draws straight lines, whatever
 * each card's height), further outputs one step below each other.
 */
export const HANDLE_TOP = 30;
export const HANDLE_STEP = 24;

const OutputHandle: React.FC<{
  nodeId: string;
  handle: string;
  label: string | null;
  top: number;
  connected: boolean;
  hint: boolean;
  /** A block's failure output: its "+" shows on hover (or selection) only. */
  quiet: boolean;
}> = ({ nodeId, handle, label, top, connected, hint, quiet }) => {
  const actions = useCanvasActions();
  const tone = handleTone(handle);
  const showPlus = !actions.readOnly && !connected;
  return (
    // A zero-size anchor on the right edge at the handle's height.
    <div className="absolute right-0 h-0 w-0" style={{ top }}>
      <Handle
        type="source"
        position={Position.Right}
        id={handle}
        className="wf-handle"
        style={{ ["--wf-handle-color" as string]: tone.dot }}
        aria-label={`${label ?? handle} output`}
        onClick={
          actions.touch && actions.startTapConnect
            ? (event) => {
                event.stopPropagation();
                actions.startTapConnect?.({ nodeId, handle });
              }
            : undefined
        }
      />
      {label !== null && connected ? (
        <span
          className={cn("pointer-events-none absolute bottom-[3px] select-none whitespace-nowrap text-[10.5px] font-medium leading-none", tone.text)}
          style={{ left: HANDLE_HIT / 2 + 2 }}
        >
          {label}
        </span>
      ) : null}
      {showPlus ? (
        <div
          className={cn(
            "nodrag nopan absolute top-0 flex -translate-y-1/2 items-center",
            quiet && "opacity-0 transition-opacity focus-within:opacity-100 group-hover/block:opacity-100 group-[.is-selected]/block:opacity-100"
          )}
          style={{ left: HANDLE_HIT / 2 }}
        >
          {label !== null ? (
            <span className={cn("select-none whitespace-nowrap px-1 text-[10.5px] font-medium", tone.text)}>{label}</span>
          ) : null}
          <span aria-hidden className="h-px w-4 bg-neutral-700" />
          <button
            type="button"
            aria-label={`Add a block after ${label ?? "this block"}`}
            title="Add a block here"
            onClick={(event) => {
              event.stopPropagation();
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              actions.openAddMenu({
                clientPoint: { x: rect.right + 6, y: rect.top },
                from: { nodeId, handle }
              });
            }}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-400",
              "transition-colors hover:border-neutral-500 hover:bg-neutral-800 hover:text-neutral-100",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400",
              hint && "wf-add-hint border-neutral-500 text-neutral-100"
            )}
          >
            <Plus size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
};

function OverlayLine({ overlay }: { overlay: OverlayNodeState }): React.ReactElement {
  const view = STATUS_VIEW[overlay.status];
  const Icon = view.icon;
  const bits: string[] = [];
  if (overlay.durationMs !== undefined) bits.push(formatDuration(overlay.durationMs) || "0s");
  if (overlay.attempt > 1) bits.push(`try ${overlay.attempt}`);
  if (overlay.accountLabel) bits.push(overlay.accountLabel);
  if (overlay.hopCount && overlay.hopCount > 1) bits.push(`${overlay.hopCount} hops`);
  const detail = overlay.status === "failed" ? overlay.errorMessage : overlay.activity;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1.5 border-t border-neutral-800/80 pt-2 text-[11px]" title={detail ?? undefined}>
      <Icon size={12} className={cn("shrink-0", view.tone, overlay.status === "running" && "motion-safe:animate-spin")} />
      <span className={cn("shrink-0 font-medium", view.tone)}>{view.label}</span>
      {bits.length > 0 ? <span className="min-w-0 truncate text-neutral-500">{bits.join(" · ")}</span> : null}
      {overlay.pinned ? <Pin size={11} className="ml-auto shrink-0 text-neutral-500" aria-label="Pinned output" /> : null}
    </div>
  );
}

function BlockNodeView({ id, data, selected }: NodeProps<BlockFlowNode>): React.ReactElement {
  const { node, summary, problems, overlay, runView, connected, pinned, hint, connectRole = null, triggerError = null } = data;
  const Icon = BLOCK_ICONS[node.type];
  const trigger = isTriggerType(node.type);
  const handles = outputHandles(node);
  const labelled = handles.length > 1;
  // success/failure blocks: the dots' colours say which is which; only branches are named.
  const branching = handles.some((handle) => handle !== "success" && handle !== "error");
  const minHeight = Math.max(60, HANDLE_TOP + (handles.length - 1) * HANDLE_STEP + 20);
  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");
  const first = errors[0] ?? warnings[0];
  const status = overlay ? STATUS_VIEW[overlay.status] : null;
  const unreached = runView && !overlay;

  return (
    <div
      className={cn(
        "wf-block group/block relative w-[240px] rounded-xl border bg-neutral-900 shadow-lg shadow-black/25 transition-[box-shadow,border-color,opacity]",
        accentClass(node.type),

        selected ? "is-selected border-neutral-400" : "border-neutral-800 hover:border-neutral-700",
        node.disabled && "wf-block-disabled opacity-60",
        status?.ring,
        (unreached || overlay?.status === "skipped") && "opacity-50 saturate-50",
        connectRole === "source" && "ring-2 ring-ok/80",
        connectRole === "valid" && "wf-connect-target ring-2 ring-info/80 ring-offset-2 ring-offset-neutral-950",
        connectRole === "invalid" && "opacity-35"
      )}
      style={trigger ? { minHeight, borderTopLeftRadius: 30, borderBottomLeftRadius: 30 } : { minHeight }}
    >
      {/* The category accent: a bar inside the left edge. */}
      <span
        aria-hidden
        className={cn(
          "absolute w-[3px] rounded-full bg-[rgb(var(--wf-accent))]",
          trigger ? "bottom-4 left-[9px] top-4" : "bottom-3 left-[5px] top-3"
        )}
      />
      {acceptsInput(node) ? (
        <Handle type="target" position={Position.Left} className="wf-handle" style={{ top: HANDLE_TOP }} aria-label="Input" />
      ) : null}

      <div className={cn("flex items-start gap-3 py-3 pr-3", trigger ? "pl-5" : "pl-4", labelled && "pr-4")}>
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            "bg-[rgb(var(--wf-accent)/0.13)] text-[rgb(var(--wf-accent))] ring-1 ring-inset ring-[rgb(var(--wf-accent)/0.22)]"
          )}
        >
          <Icon size={17} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold leading-5 text-neutral-50">{node.name}</span>
            {node.disabled ? (
              <span className="shrink-0 rounded bg-neutral-800 px-1 text-[10px] font-medium leading-4 text-neutral-400">Off</span>
            ) : null}
            {pinned && !overlay ? <Pin size={11} className="shrink-0 text-neutral-500" aria-label="Pinned output" /> : null}
          </div>
          <div className="truncate text-[11.5px] leading-4 text-neutral-400" title={summary}>
            {summary || " "}
          </div>
          {overlay ? <OverlayLine overlay={overlay} /> : null}
          {triggerError && !overlay ? (
            <div
              className="mt-1 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-warn"
              title={`Last check failed: ${triggerError}`}
              aria-label={`Last check failed: ${triggerError}`}
            >
              <AlertTriangle size={11} aria-hidden className="shrink-0" />
              <span className="truncate">Last check failed</span>
            </div>
          ) : null}
        </div>
      </div>

      {first ? (
        <span
          className={cn(
            "absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full px-1 text-[10.5px] font-semibold shadow-md shadow-black/30",
            errors.length > 0 ? "bg-danger-600 text-white" : "bg-warn-500 text-neutral-950"
          )}
          title={first.message}
          aria-label={`${errors.length > 0 ? errors.length : warnings.length} ${errors.length > 0 ? "problems" : "warnings"}: ${first.message}`}
        >
          {errors.length > 0 ? <AlertCircle size={11} /> : <AlertTriangle size={11} />}
          {errors.length > 0 ? errors.length : warnings.length}
        </span>
      ) : null}

      {handles.map((handle, index) => (
        <OutputHandle
          key={handle}
          nodeId={id}
          handle={handle}
          label={branching || (labelled && !connected.includes(handle)) ? workflowHandleLabel(node, handle) : null}
          top={HANDLE_TOP + index * HANDLE_STEP}
          connected={connected.includes(handle)}
          hint={hint && index === 0}
          quiet={!branching && handle === "error"}
        />
      ))}
    </div>
  );
}

export const BlockNode = memo(BlockNodeView);
