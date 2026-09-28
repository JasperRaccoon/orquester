/**
 * A sticky note on the canvas: tinted by its colour, resizable while
 * selected, edited in place on double-click. Notes never run and never
 * connect — no handles at all. Its size rides the node record as `size`
 * (nodes are passthrough on disk), 240 × 160 by default.
 */

import React, { memo, useEffect, useRef, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";

import type { WorkflowNode } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { useCanvasActions, type BlockNodeData } from "./canvas-context";

export type NoteFlowNode = Node<BlockNodeData, "note">;

export const NOTE_DEFAULT_SIZE = { width: 240, height: 160 };

/** A note's size from its record (anything unreadable is the default). */
export function noteSize(node: WorkflowNode): { width: number; height: number } {
  const size = (node as { size?: unknown }).size;
  if (size && typeof size === "object") {
    const { width, height } = size as { width?: unknown; height?: unknown };
    if (typeof width === "number" && typeof height === "number" && width >= 120 && height >= 60) {
      return { width: Math.min(2000, width), height: Math.min(2000, height) };
    }
  }
  return NOTE_DEFAULT_SIZE;
}

function NoteNodeView({ id, data, selected }: NodeProps<NoteFlowNode>): React.ReactElement {
  const actions = useCanvasActions();
  const node = data.node;
  const config = node.type === "note" ? node.config : { text: "", color: "yellow" as const };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(config.text);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const size = noteSize(node);

  useEffect(() => {
    if (!editing) setDraft(config.text);
  }, [config.text, editing]);

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  const commit = (): void => {
    setEditing(false);
    if (draft !== config.text) actions.updateNote(id, { text: draft });
  };

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col rounded-xl border shadow-md shadow-black/15",
        `wf-note-${config.color}`,
        "border-[rgb(var(--wf-note)/0.35)] bg-[rgb(var(--wf-note)/var(--wf-note-alpha))]",
        selected && "border-[rgb(var(--wf-note)/0.75)]"
      )}
      style={{ width: size.width, height: size.height }}
      onDoubleClick={(event) => {
        if (actions.readOnly) return;
        event.stopPropagation();
        setEditing(true);
      }}
    >
      {!actions.readOnly ? (
        <NodeResizer
          isVisible={selected && !editing}
          minWidth={120}
          minHeight={60}
          color="rgb(var(--wf-note))"
          handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-0"
          lineClassName="!border-transparent"
          onResizeEnd={(_event, params) =>
            actions.updateNote(id, {
              size: { width: Math.round(params.width), height: Math.round(params.height) },
              position: { x: params.x, y: params.y }
            })
          }
        />
      ) : null}
      {editing ? (
        <textarea
          ref={areaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(config.text);
              setEditing(false);
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit();
          }}
          aria-label={`Edit ${node.name}`}
          className="nodrag nowheel h-full w-full resize-none rounded-xl bg-transparent p-3 text-[13px] leading-5 text-neutral-100 focus:outline-none"
        />
      ) : (
        <div className="h-full w-full overflow-hidden whitespace-pre-wrap break-words p-3 text-[13px] leading-5 text-neutral-200">
          {config.text || <span className="text-neutral-500">Double-click to write a note</span>}
        </div>
      )}
    </div>
  );
}

export const NoteNode = memo(NoteNodeView);
