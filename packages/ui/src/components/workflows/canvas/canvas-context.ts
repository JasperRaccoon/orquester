/**
 * What a block, a note or an edge on the canvas can ask of the editor: open
 * the add menu (from an output, into an edge), delete an edge, edit a note in
 * place — and which edge the pointer is over. React Flow renders node and
 * edge components itself, so these ride a context rather than props.
 */

import { createContext, useContext } from "react";

import type { WorkflowNode, WorkflowProblem } from "@orquester/api";

import type { LoopCounter } from "../../../lib/workflows/loops";
import type { OverlayEdgeState, OverlayNodeState } from "../../../lib/workflows/overlay";
import type { ConnectionClass, ConnectionRequest } from "./connection";

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
  /** Open an edge's settings (a loop's label): selected beside the inspector, or a sheet on a phone. */
  openEdge: ((edgeId: string) => void) | null;
  /** While a connection is dragged: what dropping it there makes (an edge, a loop, or why not). */
  classifyConnection: (request: ConnectionRequest) => ConnectionClass | null;
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
  startTapConnect: null,
  openEdge: null,
  classifyConnection: () => null
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
  /** A trigger whose last poll failed (§6.2): the daemon's words. */
  triggerError?: string | null;
  /** Tap-to-connect in progress: the block it starts from, a block it may feed, one it may not. */
  connectRole?: "source" | "valid" | "invalid" | null;
}

export interface EdgeData extends Record<string, unknown> {
  /** The handle it leaves by (branch edges are labelled). */
  handle: string;
  label: string | null;
  overlay: OverlayEdgeState | null;
  runView: boolean;
  /** A loop edge (spec 2026-11-10 §7.4): drawn dashed, back over the blocks it runs again, always labelled. */
  loop?: EdgeLoopData | null;
  /** The validator's worst problem on this edge. */
  problem?: { severity: "error" | "warning"; message: string } | null;
}

export interface EdgeLoopData {
  /** "↺ changes · max 2", or "↺ changes · 1/2" in a run. */
  label: string;
  /** The same in words, for screen readers and the tooltip. */
  description: string;
  /** The run's use of it (a run view). */
  counter: LoopCounter | null;
  /** Its nesting level: outer loops run above inner ones. */
  level: number;
  /** "new chat" when the loop starts new chats (shown beside the label). */
  newChat: boolean;
}

/** The invisible hit area of a handle is this wide; edges attach at its centre. */
export const HANDLE_HIT = 28;
