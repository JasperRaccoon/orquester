/**
 * Loop edges in the editor and the run view (spec 2026-11-10 §7.1, §7.4), as
 * pure functions: the words a loop is shown with ("↺ back to Fix (max 2, same
 * chat)", "changes · 1/2"), its settings edits (clamped to the limits the
 * validator enforces), turning an edge into a loop or back, and a run's
 * counter for each loop edge.
 *
 * "Ancestor" always means through the graph WITHOUT loop edges — the forward
 * graph every order and readiness helper reads.
 */

import {
  downstreamOf,
  isLoopEdge,
  WORKFLOW_LIMITS,
  withoutLoopEdges,
  workflowHandleLabel,
  type Workflow,
  type WorkflowEdge,
  type WorkflowEdgeLoop,
  type WorkflowLoopSessionMode
} from "@orquester/api";

type Graph = Pick<Workflow, "nodes" | "edges">;

export interface LoopSessionOption {
  id: WorkflowLoopSessionMode;
  label: string;
  /** The word the canvas and the step list use. */
  short: string;
  hint: string;
}

export const LOOP_SESSION_OPTIONS: readonly LoopSessionOption[] = [
  {
    id: "continue",
    label: "Continue in the same chat",
    short: "same chat",
    hint: "Every agent step the loop runs again gets a follow-up turn in its chat from the pass before."
  },
  {
    id: "new",
    label: "Start a new chat",
    short: "new chat",
    hint: "Every agent step the loop runs again starts a fresh chat, with the feedback and its last report."
  }
];

/** The settings a loop drawn in the editor starts with. */
export function defaultLoopSettings(): WorkflowEdgeLoop {
  return { ...WORKFLOW_LIMITS.defaultLoop };
}

export function loopSessionShort(mode: WorkflowLoopSessionMode | undefined): string {
  return (LOOP_SESSION_OPTIONS.find((option) => option.id === mode) ?? LOOP_SESSION_OPTIONS[0]!).short;
}

/** A `maxLoops` the validator accepts: a whole number within the limits. */
export function clampMaxLoops(value: number): number {
  const { min, max } = WORKFLOW_LIMITS.loops;
  if (!Number.isFinite(value)) return WORKFLOW_LIMITS.defaultLoop.maxLoops;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** `ancestorId` runs before `nodeId` through ordinary edges (it reaches it). */
export function isAncestor(workflow: Graph, ancestorId: string, nodeId: string): boolean {
  if (ancestorId === nodeId) return false;
  return downstreamOf(withoutLoopEdges(workflow), ancestorId).has(nodeId);
}

/** The step list's row: "↺ back to Fix (max 2, same chat)". */
export function loopRowText(targetName: string, loop: Pick<WorkflowEdgeLoop, "maxLoops" | "session">): string {
  return `↺ back to ${targetName} (max ${loop.maxLoops}, ${loopSessionShort(loop.session)})`;
}

/** A run's use of one loop edge. */
export interface LoopCounter {
  used: number;
  max: number;
  /** Taken as often as it may be: the next time asks the person (a loop-limit gate). */
  exhausted: boolean;
}

/** The counter of `edge` in a run: `loopCounters` (absent = 0) against `loopLimits` (else its `maxLoops`). */
export function loopCounterOf(
  edge: Pick<WorkflowEdge, "id" | "loop">,
  run: { loopCounters?: Readonly<Record<string, number>>; loopLimits?: Readonly<Record<string, number>> }
): LoopCounter | null {
  if (!edge.loop) return null;
  const used = Math.max(0, run.loopCounters?.[edge.id] ?? 0);
  const raised = run.loopLimits?.[edge.id];
  const max = Math.max(1, raised !== undefined ? raised : edge.loop.maxLoops);
  return { used, max, exhausted: used >= max };
}

/**
 * The words on a loop edge: "↺ changes · max 2" in the editor, "↺ changes · 1/2"
 * in a run. A block's only output (`success`) is not named.
 */
export function loopEdgeLabel(
  handleLabel: string | null,
  loop: Pick<WorkflowEdgeLoop, "maxLoops">,
  counter: LoopCounter | null = null
): string {
  const named = handleLabel && handleLabel !== "success" ? `${handleLabel} · ` : "";
  return counter ? `↺ ${named}${counter.used}/${counter.max}` : `↺ ${named}max ${loop.maxLoops}`;
}

/**
 * The label for screen readers and tooltips: "Loops back to Fix on changes, at most 2 times, in the same chat".
 * In a run, "at most" is the run's limit (raised by "Allow one more loop"), the counter's.
 */
export function loopEdgeDescription(
  sourceName: string,
  handleLabel: string | null,
  targetName: string,
  loop: Pick<WorkflowEdgeLoop, "maxLoops" | "session">,
  counter: LoopCounter | null = null
): string {
  const on = handleLabel && handleLabel !== "success" ? ` on ${handleLabel}` : "";
  const max = counter?.max ?? loop.maxLoops;
  const times = max === 1 ? "once" : `${max} times`;
  const used = counter
    ? `; used ${counter.used} of ${counter.max}${counter.exhausted ? ", its limit" : ""}`
    : "";
  return `${sourceName} loops back to ${targetName}${on}, at most ${times}, ${
    loop.session === "new" ? "in a new chat" : "in the same chat"
  }${used}`;
}

/** Change a loop edge's settings (clamped); the same workflow when nothing changes or it is no loop. */
export function setLoopSettings<W extends Graph>(
  workflow: W,
  edgeId: string,
  patch: Partial<Pick<WorkflowEdgeLoop, "maxLoops" | "session">>
): W {
  let changed = false;
  const edges = workflow.edges.map((edge) => {
    if (edge.id !== edgeId || !edge.loop) return edge;
    const maxLoops = patch.maxLoops !== undefined ? clampMaxLoops(patch.maxLoops) : edge.loop.maxLoops;
    const session = patch.session ?? edge.loop.session;
    if (maxLoops === edge.loop.maxLoops && session === edge.loop.session) return edge;
    changed = true;
    return { ...edge, loop: { ...edge.loop, maxLoops, session } };
  });
  return changed ? { ...workflow, edges } : workflow;
}

/** What an edge can be turned into, each with why not (null = it can). */
export interface EdgeConversion {
  /** It points back to an ancestor: making it a loop fixes the cycle. Absent on a loop edge. */
  toLoop?: string | null;
  /** A loop edge whose target no longer runs before its source can become ordinary. Absent on an ordinary edge. */
  toOrdinary?: string | null;
}

function nameOf(workflow: Graph, id: string): string {
  return workflow.nodes.find((node) => node.id === id)?.name ?? id;
}

export function edgeConversion(workflow: Graph, edgeId: string): EdgeConversion {
  const edge = workflow.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return {};
  const others = { ...workflow, edges: workflow.edges.filter((candidate) => candidate.id !== edgeId) };
  const back = edge.source === edge.target || isAncestor(others, edge.target, edge.source);
  if (isLoopEdge(edge)) {
    return { toOrdinary: back ? `${nameOf(workflow, edge.target)} runs before ${nameOf(workflow, edge.source)}, so this must stay a loop.` : null };
  }
  if (!back) return {};
  if (edge.source === edge.target) return { toLoop: "A block cannot loop back to itself." };
  if (edge.sourceHandle === "error") return { toLoop: "A failure output cannot loop back." };
  const shares = workflow.edges.some(
    (candidate) => candidate.id !== edge.id && candidate.source === edge.source && candidate.sourceHandle === edge.sourceHandle
  );
  if (shares) return { toLoop: "Its output leads to other steps too; a loop needs an output of its own." };
  return { toLoop: null };
}

/** Make an ordinary back-edge a loop (default settings), when `edgeConversion` allows it. */
export function convertToLoop<W extends Graph>(workflow: W, edgeId: string): W {
  if (edgeConversion(workflow, edgeId).toLoop !== null) return workflow;
  return { ...workflow, edges: workflow.edges.map((edge) => (edge.id === edgeId ? { ...edge, loop: defaultLoopSettings() } : edge)) };
}

/** Make a loop edge ordinary, when `edgeConversion` allows it. */
export function convertToOrdinary<W extends Graph>(workflow: W, edgeId: string): W {
  if (edgeConversion(workflow, edgeId).toOrdinary !== null) return workflow;
  return {
    ...workflow,
    edges: workflow.edges.map((edge) => {
      if (edge.id !== edgeId) return edge;
      const { loop: _loop, ...rest } = edge;
      return rest as typeof edge;
    })
  };
}

/** A loop edge as the editor shows it. */
export interface LoopEdgeView {
  edgeId: string;
  sourceId: string;
  sourceName: string;
  handle: string;
  handleLabel: string;
  targetId: string;
  targetName: string;
  loop: WorkflowEdgeLoop;
}

export function loopEdgeView(workflow: Graph, edge: WorkflowEdge): LoopEdgeView | null {
  if (!edge.loop) return null;
  const source = workflow.nodes.find((node) => node.id === edge.source);
  const target = workflow.nodes.find((node) => node.id === edge.target);
  return {
    edgeId: edge.id,
    sourceId: edge.source,
    sourceName: source?.name ?? edge.source,
    handle: edge.sourceHandle,
    handleLabel: source ? workflowHandleLabel(source, edge.sourceHandle) : edge.sourceHandle,
    targetId: edge.target,
    targetName: target?.name ?? edge.target,
    loop: edge.loop
  };
}

/**
 * `nodeId` is run again by some loop: it is a loop's target or downstream of
 * one through ordinary edges (its reset set, §3) — `{{ loop.* }}` means
 * something there.
 */
export function inLoopBody(workflow: Graph, nodeId: string): boolean {
  const forward = withoutLoopEdges(workflow);
  return workflow.edges.some(
    (edge) => isLoopEdge(edge) && (edge.target === nodeId || downstreamOf(forward, edge.target).has(nodeId))
  );
}

/**
 * The blocks a loop edge runs again (its reset set, §3): its target and every
 * block downstream of the target through ordinary edges, in definition order.
 */
export function loopResetSet(workflow: Graph, edge: Pick<WorkflowEdge, "target">): Workflow["nodes"] {
  const below = downstreamOf(withoutLoopEdges(workflow), edge.target);
  return workflow.nodes.filter((node) => node.type !== "note" && (node.id === edge.target || below.has(node.id)));
}
