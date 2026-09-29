/**
 * The workflow canvas (workflows spec §7.2, §7.3): React Flow over a
 * definition, fully controlled — the definition, the selection and the run
 * overlay come in as props, every edit goes out as a pure recipe through
 * `onChange` (the editor store turns each into one undo step).
 *
 * Only transient state lives here: node sizes React Flow measured, the
 * positions of a drag in progress (committed once, on drop), the hovered edge,
 * and the frames of a Tidy up animation. The same component draws the run
 * view: pass a frozen definition, an `overlay` and `readOnly`.
 *
 * `WorkflowCanvas` needs a `ReactFlowProvider` above it (the editor tab has one
 * so its toolbar can zoom); `StandaloneWorkflowCanvas` brings its own.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  ControlButton,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type OnConnectEnd
} from "@xyflow/react";
import { Map as MapIcon } from "lucide-react";

import { outputHandles, workflowHandleLabel, type Workflow, type WorkflowNodeType, type WorkflowProblem } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { canvasFitOptions, phoneOpeningViewport } from "../../../lib/workflows/canvas-fit";
import { blockAccent, nodeSummary, type NodeSummaryContext } from "../../../lib/workflows/catalog-ui";
import type { ChangeOptions, EditorSelection } from "../../../lib/workflows/editor-store";
import type { RunOverlay } from "../../../lib/workflows/overlay";
import { BlockNode, type BlockFlowNode } from "./BlockNode";
import {
  CanvasActionsContext,
  type AddMenuRequest,
  type BlockNodeData,
  type CanvasActions,
  type EdgeData
} from "./canvas-context";
import { connectBlocks, connectionRefusal } from "./connection";
import { NoteNode, noteSize, type NoteFlowNode } from "./NoteNode";
import { GRID, moveNodes, removeElements, updateNode } from "./ops";
import { useLongPress } from "../phone/use-long-press";
import type { TapConnectEvent, TapConnectState } from "./tap-connect";
import { WorkflowConnectionLine, WorkflowEdgeComponent, type WorkflowFlowEdge } from "./WorkflowEdge";

/** The drag type the palette puts on a block it drags onto the canvas. */
export const BLOCK_DRAG_TYPE = "application/x-orquester-block";

const NODE_TYPES = { block: BlockNode, note: NoteNode };
const EDGE_TYPES = { wf: WorkflowEdgeComponent };
const EMPTY_PROBLEMS: readonly WorkflowProblem[] = [];

export interface WorkflowCanvasHandle {
  /** Glide the blocks to `positions`, then commit them as one change (Tidy up). */
  animateTo(positions: Readonly<Record<string, { x: number; y: number }>>): void;
}

export interface WorkflowCanvasProps {
  workflow: Pick<Workflow, "nodes" | "edges"> & { pinned?: Workflow["pinned"] };
  problems?: readonly WorkflowProblem[];
  /** A run view's overlay. */
  overlay?: RunOverlay | null;
  readOnly?: boolean;
  selection: EditorSelection;
  onSelectionChange?: (selection: EditorSelection) => void;
  /** Edits as pure recipes; ignored while `readOnly`. */
  onChange?: (recipe: (workflow: Workflow) => Workflow, options?: ChangeOptions) => void;
  mintId?: () => string;
  summaryContext?: NodeSummaryContext;
  onOpenAddMenu?: (request: AddMenuRequest) => void;
  /** A block dropped from the palette at a flow position. */
  onDropBlock?: (type: WorkflowNodeType, flowPoint: { x: number; y: number }) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  minimap?: boolean;
  onToggleMinimap?: () => void;
  /** The pulsing "+" on a lone trigger. */
  hint?: boolean;
  /** The last pointer position over the canvas (Tab opens the add menu there). */
  onPointerMove?: (client: { x: number; y: number }) => void;
  /** Laid out for a phone: it opens on the first blocks at a readable zoom. */
  phone?: boolean;
  /** A plain tap / click on a block (a phone opens its settings). */
  onNodeTap?: (nodeId: string) => void;
  /** A long press (or right click) on a block: its menu. */
  onLongPressNode?: (nodeId: string, client: { x: number; y: number }) => void;
  /** A long press (or right click) on empty canvas: the add menu there. */
  onLongPressPane?: (request: AddMenuRequest) => void;
  /** Tap-to-connect's state, and where its taps go (the parent reduces them). */
  tapConnect?: TapConnectState;
  onTapConnect?: (event: TapConnectEvent) => void;
  /** Triggers whose last poll failed, by node id (`triggerErrorsOf`). */
  triggerErrors?: ReadonlyMap<string, string>;
  className?: string;
}

interface CachedNode {
  inputs: unknown[];
  node: BlockFlowNode | NoteFlowNode;
}

const sameInputs = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

function problemsByNode(problems: readonly WorkflowProblem[]): Map<string, WorkflowProblem[]> {
  const map = new Map<string, WorkflowProblem[]>();
  for (const problem of problems) {
    if (!problem.nodeId || problem.severity === "info") continue;
    const list = map.get(problem.nodeId) ?? [];
    list.push(problem);
    map.set(problem.nodeId, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return map;
}

const isCoarsePointer = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const WorkflowCanvas = forwardRef<WorkflowCanvasHandle, WorkflowCanvasProps>(function WorkflowCanvas(
  {
    workflow,
    problems = EMPTY_PROBLEMS,
    overlay = null,
    readOnly = false,
    selection,
    onSelectionChange,
    onChange,
    mintId,
    summaryContext,
    onOpenAddMenu,
    onDropBlock,
    onNodeDoubleClick,
    minimap = true,
    onToggleMinimap,
    hint = false,
    onPointerMove,
    phone = false,
    onNodeTap,
    onLongPressNode,
    onLongPressPane,
    tapConnect,
    onTapConnect,
    triggerErrors,
    className
  },
  ref
) {
  const flow = useReactFlow();
  const editable = !readOnly && onChange !== undefined;
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }> | null>(null);
  const dragRef = useRef<Record<string, { x: number; y: number }> | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  /** A note being resized: its live size and position until the resize ends. */
  const [resizing, setResizing] = useState<Record<string, { width?: number; height?: number; x?: number; y?: number }>>({});
  const cache = useRef(new Map<string, CachedNode>());
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;
  const animation = useRef<number | null>(null);
  const [coarse] = useState(isCoarsePointer);

  const change = useCallback(
    (recipe: (draft: Workflow) => Workflow, options?: ChangeOptions) => {
      if (editable) onChange!(recipe, options);
    },
    [editable, onChange]
  );

  // -------------------------------------------------------------------------
  // Nodes and edges for React Flow
  // -------------------------------------------------------------------------

  const byNode = useMemo(() => problemsByNode(problems), [problems]);
  const connected = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of workflow.edges) {
      const list = map.get(edge.source) ?? [];
      list.push(edge.sourceHandle);
      map.set(edge.source, list);
    }
    return map;
  }, [workflow.edges]);
  const selectedNodes = useMemo(() => new Set(selection.nodeIds), [selection.nodeIds]);
  const selectedEdges = useMemo(() => new Set(selection.edgeIds), [selection.edgeIds]);
  const runView = overlay !== null;
  const lonelyTrigger = hint && !readOnly && workflow.nodes.filter((node) => node.type !== "note").length === 1;
  const picking = tapConnect?.mode === "picking" ? tapConnect.from : null;
  const connectRoles = useMemo(() => {
    if (!picking) return null;
    const roles = new Map<string, "source" | "valid" | "invalid">();
    for (const node of workflow.nodes) {
      if (node.id === picking.nodeId) roles.set(node.id, "source");
      else roles.set(node.id, connectionRefusal(workflow, { source: picking.nodeId, sourceHandle: picking.handle, target: node.id }) === null ? "valid" : "invalid");
    }
    return roles;
  }, [picking?.nodeId, picking?.handle, workflow]); // eslint-disable-line react-hooks/exhaustive-deps

  const nodes = useMemo(() => {
    const next: (BlockFlowNode | NoteFlowNode)[] = [];
    const seen = new Set<string>();
    for (const node of workflow.nodes) {
      seen.add(node.id);
      const nodeProblems = byNode.get(node.id) ?? (EMPTY_PROBLEMS as WorkflowProblem[]);
      const nodeOverlay = overlay?.nodes[node.id] ?? null;
      const live = resizing[node.id];
      const position =
        dragPositions?.[node.id] ??
        (live?.x !== undefined && live.y !== undefined ? { x: live.x, y: live.y } : node.position);
      const size = measured[node.id];
      const handlesConnected = connected.get(node.id) ?? [];
      const connectedKey = handlesConnected.join("|");
      const selected = selectedNodes.has(node.id);
      const pinned = workflow.pinned !== undefined && node.id in workflow.pinned;
      const connectRole = connectRoles?.get(node.id) ?? null;
      const triggerError = triggerErrors?.get(node.id) ?? null;
      const inputs = [
        triggerError,
        connectRole,
        node,
        nodeProblems,
        nodeOverlay,
        position,
        size,
        connectedKey,
        selected,
        pinned,
        runView,
        lonelyTrigger,
        summaryContext,
        editable,
        live
      ];
      const cached = cache.current.get(node.id);
      if (cached && sameInputs(cached.inputs, inputs)) {
        next.push(cached.node);
        continue;
      }
      const data: BlockNodeData = {
        node,
        summary: node.type === "note" ? "" : nodeSummary(node, summaryContext),
        problems: nodeProblems,
        overlay: nodeOverlay,
        runView,
        connected: handlesConnected,
        pinned,
        hint: lonelyTrigger,
        connectRole,
        triggerError
      };
      const common = {
        id: node.id,
        position,
        data,
        selected,
        draggable: editable,
        connectable: editable,
        deletable: false,
        ...(size ? { measured: size } : {})
      };
      const flowNode =
        node.type === "note"
          ? ({
              ...common,
              type: "note",
              zIndex: -1,
              width: live?.width ?? noteSize(node).width,
              height: live?.height ?? noteSize(node).height
            } as NoteFlowNode)
          : ({ ...common, type: "block" } as BlockFlowNode);
      cache.current.set(node.id, { inputs, node: flowNode });
      next.push(flowNode);
    }
    for (const id of cache.current.keys()) if (!seen.has(id)) cache.current.delete(id);
    return next;
  }, [workflow.nodes, workflow.pinned, byNode, overlay, dragPositions, resizing, measured, connected, selectedNodes, runView, lonelyTrigger, summaryContext, editable, connectRoles, triggerErrors]);

  const edges = useMemo(() => {
    const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
    return workflow.edges.map((edge): WorkflowFlowEdge => {
      const source = byId.get(edge.source);
      // Branch edges carry their label (a failure edge is red and dashed instead).
      const branch =
        source !== undefined && outputHandles(source).length > 1 && edge.sourceHandle !== "success" && edge.sourceHandle !== "error";
      const data: EdgeData = {
        handle: edge.sourceHandle,
        label: branch && source ? workflowHandleLabel(source, edge.sourceHandle) : null,
        overlay: overlay?.edges[edge.id] ?? null,
        runView
      };
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        type: "wf",
        data,
        selected: selectedEdges.has(edge.id),
        deletable: false,
        focusable: true,
        zIndex: overlay?.edges[edge.id] === "active" ? 1 : 0
      };
    });
  }, [workflow.nodes, workflow.edges, overlay, runView, selectedEdges]);

  // -------------------------------------------------------------------------
  // Changes from React Flow
  // -------------------------------------------------------------------------

  const onNodesChange = useCallback(
    (changes: NodeChange<BlockFlowNode | NoteFlowNode>[]) => {
      let sizes: Record<string, { width: number; height: number }> | null = null;
      let selectionChanged = false;
      const nodeIds = new Set(selectionRef.current.nodeIds);
      let dragging: Record<string, { x: number; y: number }> | null = null;
      let dropped: Record<string, { x: number; y: number }> | null = null;
      let live: Record<string, { width?: number; height?: number; x?: number; y?: number }> | null = null;
      for (const c of changes) {
        if (c.type === "dimensions" && c.dimensions && c.resizing !== undefined) {
          // A note's resizer: shown live, committed by its onResizeEnd.
          live ??= {};
          live[c.id] = { ...live[c.id], width: c.dimensions.width, height: c.dimensions.height };
        } else if (c.type === "dimensions" && c.dimensions) {
          sizes ??= {};
          sizes[c.id] = { width: c.dimensions.width, height: c.dimensions.height };
        } else if (c.type === "position" && c.position && c.dragging === undefined && editable) {
          live ??= {};
          live[c.id] = { ...live[c.id], x: c.position.x, y: c.position.y };
        } else if (c.type === "select") {
          selectionChanged = true;
          if (c.selected) nodeIds.add(c.id);
          else nodeIds.delete(c.id);
        } else if (c.type === "position" && c.position && editable) {
          if (c.dragging) {
            dragging ??= { ...(dragRef.current ?? {}) };
            dragging[c.id] = c.position;
          } else {
            dropped ??= { ...(dragRef.current ?? {}) };
            dropped[c.id] = c.position;
          }
        }
      }
      if (sizes) {
        const add = sizes;
        setMeasured((current) => {
          let differs = false;
          for (const [id, size] of Object.entries(add)) {
            const old = current[id];
            if (!old || old.width !== size.width || old.height !== size.height) differs = true;
          }
          return differs ? { ...current, ...add } : current;
        });
      }
      if (live) {
        const add = live;
        setResizing((current) => {
          const next = { ...current };
          for (const [id, patch] of Object.entries(add)) next[id] = { ...current[id], ...patch };
          return next;
        });
      }
      if (dragging) {
        dragRef.current = dragging;
        setDragPositions(dragging);
      }
      if (dropped) {
        const positions = dropped;
        dragRef.current = null;
        setDragPositions(null);
        change((draft) => moveNodes(draft, positions));
      }
      if (selectionChanged && onSelectionChange) {
        onSelectionChange({ nodeIds: [...nodeIds], edgeIds: selectionRef.current.edgeIds as string[] });
      }
    },
    [change, editable, onSelectionChange]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<WorkflowFlowEdge>[]) => {
      const edgeIds = new Set(selectionRef.current.edgeIds);
      let changed = false;
      for (const c of changes) {
        if (c.type !== "select") continue;
        changed = true;
        if (c.selected) edgeIds.add(c.id);
        else edgeIds.delete(c.id);
      }
      if (changed && onSelectionChange) {
        onSelectionChange({ nodeIds: selectionRef.current.nodeIds as string[], edgeIds: [...edgeIds] });
      }
    },
    [onSelectionChange]
  );

  const isValidConnection = useCallback(
    (connection: Connection | WorkflowFlowEdge) =>
      editable &&
      connectionRefusal(workflowRef.current, {
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target
      }) === null,
    [editable]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!mintId) return;
      change((draft) => connectBlocks(draft, connection, mintId));
    },
    [change, mintId]
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (!editable || state.isValid || !state.fromNode || !state.fromHandle || state.fromHandle.type !== "source") return;
      const target = event.target as Element | null;
      if (!target?.classList?.contains("react-flow__pane")) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : (event as MouseEvent);
      if (!point) return;
      const clientPoint = { x: point.clientX, y: point.clientY };
      onOpenAddMenu?.({
        clientPoint,
        flowPoint: flow.screenToFlowPosition(clientPoint),
        from: { nodeId: state.fromNode.id, handle: state.fromHandle.id ?? "success" }
      });
    },
    [editable, flow, onOpenAddMenu]
  );

  // -------------------------------------------------------------------------
  // Tidy up: glide, then commit once
  // -------------------------------------------------------------------------

  useImperativeHandle(
    ref,
    () => ({
      animateTo(positions) {
        if (animation.current !== null) cancelAnimationFrame(animation.current);
        const from: Record<string, { x: number; y: number }> = {};
        for (const node of workflowRef.current.nodes) if (positions[node.id]) from[node.id] = node.position;
        const commit = (): void => {
          animation.current = null;
          dragRef.current = null;
          setDragPositions(null);
          change((draft) => moveNodes(draft, positions));
        };
        if (prefersReducedMotion()) {
          commit();
          return;
        }
        const start = performance.now();
        const duration = 320;
        const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
        const step = (now: number): void => {
          const t = Math.min(1, (now - start) / duration);
          const k = ease(t);
          const frame: Record<string, { x: number; y: number }> = {};
          for (const [id, target] of Object.entries(positions)) {
            const origin = from[id] ?? target;
            frame[id] = { x: origin.x + (target.x - origin.x) * k, y: origin.y + (target.y - origin.y) * k };
          }
          setDragPositions(frame);
          if (t < 1) animation.current = requestAnimationFrame(step);
          else commit();
        };
        animation.current = requestAnimationFrame(step);
      }
    }),
    [change]
  );

  useEffect(
    () => () => {
      if (animation.current !== null) cancelAnimationFrame(animation.current);
    },
    []
  );

  // -------------------------------------------------------------------------
  // What nodes and edges may ask for
  // -------------------------------------------------------------------------

  const actions = useMemo<CanvasActions>(
    () => ({
      readOnly: !editable,
      openAddMenu: (request) => onOpenAddMenu?.(request),
      deleteEdge: (edgeId) => change((draft) => removeElements(draft, [], [edgeId])),
      updateNote: (nodeId, patch) => {
        setResizing((current) => {
          if (!(nodeId in current)) return current;
          const next = { ...current };
          delete next[nodeId];
          return next;
        });
        change((draft) =>
          updateNode(draft, nodeId, (node) => {
            if (node.type !== "note") return node;
            let next = node;
            if (patch.text !== undefined && patch.text !== node.config.text) next = { ...next, config: { ...next.config, text: patch.text } };
            if (patch.size) next = { ...next, size: patch.size } as typeof next;
            if (patch.position) {
              next = { ...next, position: { x: Math.round(patch.position.x / GRID) * GRID, y: Math.round(patch.position.y / GRID) * GRID } };
            }
            return next;
          })
        );
      },
      hoveredEdgeId,
      setHoveredEdgeId,
      clearHoveredEdge: (edgeId) => setHoveredEdgeId((current) => (current === edgeId ? null : current)),
      touch: coarse || phone,
      startTapConnect: editable && onTapConnect ? (from) => onTapConnect({ type: "start", from }) : null
    }),
    [editable, onOpenAddMenu, change, hoveredEdgeId, coarse, phone, onTapConnect]
  );

  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Tap-to-connect on a phone: frame the block it starts from and every block it may feed.
  const pickingKey = picking ? `${picking.nodeId}:${picking.handle}` : null;
  useEffect(() => {
    if (!phone || !pickingKey || !connectRoles) return;
    // The source and the (up to three) nearest blocks it may feed, at a size a finger can hit.
    const at = new Map(workflowRef.current.nodes.map((node) => [node.id, node.position]));
    const from = at.get(picking!.nodeId) ?? { x: 0, y: 0 };
    const near = [...connectRoles]
      .filter(([, role]) => role === "valid")
      .map(([id]) => ({ id, d: Math.hypot((at.get(id)?.x ?? 0) - from.x, (at.get(id)?.y ?? 0) - from.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map(({ id }) => ({ id }));
    const ids = [{ id: picking!.nodeId }, ...near];
    const frame = requestAnimationFrame(() => void flow.fitView({ nodes: ids, padding: 0.25, maxZoom: 0.9, minZoom: 0.45, duration: 260 }));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, pickingKey]);
  const fitOptions = useMemo(
    () => {
      const options = canvasFitOptions(workflowRef.current, { phone, run: overlay !== null });
      if (!overlay || phone) return options;
      // A run opens on the part it reached, at a size its cards can be read at.
      const reached = Object.entries(overlay.nodes)
        .filter(([, state]) => state.status !== "skipped" && state.status !== "pending")
        .map(([id]) => ({ id }));
      return reached.length > 0 ? { ...options, minZoom: 0.45, nodes: reached } : options;
    },
    // The opening frame: fixed once per mount (and per layout).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phone]
  );
  const longPress = useLongPress((point, target) => {
    const element = target as Element | null;
    if (!element || typeof element.closest !== "function") return;
    const nodeElement = element.closest(".react-flow__node");
    const nodeId = nodeElement?.getAttribute("data-id");
    if (nodeId) {
      onLongPressNode?.(nodeId, point);
      return;
    }
    if (element.closest(".react-flow__pane") && editable) {
      onLongPressPane?.({ clientPoint: point, flowPoint: flow.screenToFlowPosition(point) });
    }
  });

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div
        ref={wrapperRef}
        className={cn("wf-canvas relative h-full w-full", picking && "wf-connecting", className)}
        onMouseMove={(event) => onPointerMove?.({ x: event.clientX, y: event.clientY })}
        {...(onLongPressNode || onLongPressPane ? longPress : {})}
        onDoubleClick={(event) => {
          if (!editable) return;
          const target = event.target as Element;
          if (!target.classList?.contains("react-flow__pane")) return;
          const clientPoint = { x: event.clientX, y: event.clientY };
          onOpenAddMenu?.({ clientPoint, flowPoint: flow.screenToFlowPosition(clientPoint) });
        }}
        onDragOver={(event) => {
          if (!editable || !event.dataTransfer.types.includes(BLOCK_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          if (!editable) return;
          const type = event.dataTransfer.getData(BLOCK_DRAG_TYPE) as WorkflowNodeType;
          if (!type) return;
          event.preventDefault();
          const flowPoint = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          onDropBlock?.(type, { x: flowPoint.x - 120, y: flowPoint.y - 40 });
        }}
      >
        <ReactFlow<BlockFlowNode | NoteFlowNode, WorkflowFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          connectionLineComponent={WorkflowConnectionLine}
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionRadius={28}
          onNodeDoubleClick={(_event, node) => onNodeDoubleClick?.(node.id)}
          onNodeClick={(_event, node) => {
            if (picking) onTapConnect?.({ type: "tap-node", nodeId: node.id });
            else onNodeTap?.(node.id);
          }}
          onPaneClick={() => {
            if (picking) onTapConnect?.({ type: "cancel" });
          }}
          onEdgeMouseEnter={(_event, edge) => {
            if (leaveTimer.current) clearTimeout(leaveTimer.current);
            setHoveredEdgeId(edge.id);
          }}
          onEdgeMouseLeave={(_event, edge) => {
            if (leaveTimer.current) clearTimeout(leaveTimer.current);
            leaveTimer.current = setTimeout(
              () => setHoveredEdgeId((current) => (current === edge.id ? null : current)),
              220
            );
          }}
          snapToGrid
          snapGrid={[GRID, GRID]}
          fitView={!phone}
          fitViewOptions={fitOptions}
          onInit={(instance) => {
            if (!phone) return;
            const rect = wrapperRef.current?.getBoundingClientRect();
            const opening = rect ? phoneOpeningViewport(workflowRef.current, { width: rect.width, height: rect.height }) : null;
            if (opening) void instance.setViewport(opening);
            else void instance.fitView(fitOptions);
          }}
          minZoom={0.15}
          maxZoom={2}
          deleteKeyCode={null}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          disableKeyboardA11y
          zoomOnDoubleClick={false}
          selectionOnDrag={!coarse}
          selectionMode={SelectionMode.Partial}
          panOnDrag={coarse ? true : [1, 2]}
          panOnScroll={!coarse}
          zoomOnScroll={false}
          zoomOnPinch
          nodesDraggable={editable}
          nodesConnectable={editable}
          elementsSelectable={!picking}
          connectOnClick={!(coarse || phone)}
          elevateEdgesOnSelect
          attributionPosition="bottom-center"
        >
          <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.4} />
          <Controls
            showInteractive={false}
            position="bottom-left"
            fitViewOptions={fitOptions}
            className={cn(phone && "!hidden")}
          >
            {onToggleMinimap ? (
              <ControlButton
                onClick={onToggleMinimap}
                title={minimap ? "Hide the minimap" : "Show the minimap"}
                aria-label={minimap ? "Hide the minimap" : "Show the minimap"}
                aria-pressed={minimap}
              >
                <MapIcon />
              </ControlButton>
            ) : null}
          </Controls>
          {minimap ? (
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeBorderRadius={6}
              nodeColor={(node) => {
                const data = node.data as BlockNodeData;
                const state = overlay?.nodes[node.id]?.status;
                if (state === "failed") return "rgb(var(--sem-danger-400))";
                if (state === "succeeded") return "rgb(var(--sem-ok-400) / 0.8)";
                if (state === "running" || state === "waiting") return "rgb(var(--sem-info-400))";
                if (data.node.type === "note") return "rgb(var(--n-800))";
                const accent = blockAccent(data.node.type);
                return `rgb(var(--wf-${accent === "note" ? "flow" : accent}) / 0.75)`;
              }}
              maskColor="rgb(var(--n-950) / 0.6)"
              style={{ width: 176, height: 116 }}
            />
          ) : null}
        </ReactFlow>
      </div>
    </CanvasActionsContext.Provider>
  );
});

/** The canvas with a React Flow provider of its own (a run view that has no toolbar of its own). */
export const StandaloneWorkflowCanvas = forwardRef<WorkflowCanvasHandle, WorkflowCanvasProps>(
  function StandaloneWorkflowCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <WorkflowCanvas ref={ref} {...props} />
      </ReactFlowProvider>
    );
  }
);
