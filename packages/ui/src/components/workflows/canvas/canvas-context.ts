/**
 * What a block, a note or an edge on the canvas can ask of the editor: open
 * the add menu (from an output, into an edge), delete an edge, edit a note in
 * place — and which edge the pointer is over. React Flow renders node and
 * edge components itself, so these ride a context rather than props.
 */

import { createContext, useContext } from "react";

import type { WorkflowNode, WorkflowProblem } from "@orquester/api";

import type { OverlayEdgeState, OverlayNodeState } from "../../../lib/workflows/overlay";

/** Where an add menu opens and what the new block wires to. */
export interface AddMenuRequest {
  /** Viewport coordinates the menu opens at. */
  clientPoint: { x: number; y: number };
  /** Flow coordinates the new block lands at (its top-left). */
  flowPoint?: { x: number; y: number };
  from?: { nodeId: string; handle: string } | null;
  intoEdgeId?: string | null;
}

export interface CanvasActions {
  readOnly: boolean;
  openAddMenu: (request: AddMenuRequest) => void;
  deleteEdge: (edgeId: string) => void;
  updateNote: (nodeId: string, patch: { text?: string; size?: { width: number; height: number }; position?: { x: number; y: number } }) => void;
  hoveredEdgeId: string | null;
  setHoveredEdgeId: (edgeId: string | null) => void;
  /** Clear the hover, unless another edge took it meanwhile. */
  clearHoveredEdge: (edgeId: string) => void;
  /** A touch screen: an output is tapped to start tap-to-connect, never dragged. */
  touch: boolean;
  /** Start tap-to-connect from an output (touch only). */
  startTapConnect: ((from: { nodeId: string; handle: string }) => void) | null;
}

const NOOP_ACTIONS: CanvasActions = {
  readOnly: true,
  openAddMenu: () => undefined,
  deleteEdge: () => undefined,
  updateNote: () => undefined,
  hoveredEdgeId: null,
  setHoveredEdgeId: () => undefined,
  clearHoveredEdge: () => undefined,
  touch: false,
  startTapConnect: null
};

export const CanvasActionsContext = createContext<CanvasActions>(NOOP_ACTIONS);

export function useCanvasActions(): CanvasActions {
  return useContext(CanvasActionsContext);
}

/** A block's data on the canvas (React Flow wants a record). */
export interface BlockNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  summary: string;
  /** The block's own problems, errors first. */
  problems: readonly WorkflowProblem[];
  overlay: OverlayNodeState | null;
  /** A run view: blocks the run never reached are dimmed. */
  runView: boolean;
  /** Output handles that already have an edge. */
  connected: readonly string[];
  /** Pinned output (test runs use it). */
  pinned: boolean;
  /** The pulsing "+" of a brand-new workflow. */
  hint: boolean;
  /** Tap-to-connect in progress: the block it starts from, a block it may feed, one it may not. */
  connectRole?: "source" | "valid" | "invalid" | null;
}

export interface EdgeData extends Record<string, unknown> {
  /** The handle it leaves by (branch edges are labelled). */
  handle: string;
  label: string | null;
  overlay: OverlayEdgeState | null;
  runView: boolean;
}

/** The invisible hit area of a handle is this wide; edges attach at its centre. */
export const HANDLE_HIT = 28;
