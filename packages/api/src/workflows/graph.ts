// Automated workflows — the graph: handles, order, reachability and the engine's readiness step
// (spec §3.4). Pure functions over a definition; shared by the daemon's engine, the editor and the
// MCP.

import type { WorkflowBlockStatus } from "./types.ts";
import { isTriggerType, type Workflow, type WorkflowEdge, type WorkflowNode } from "./types.ts";

type NodeLike = Pick<WorkflowNode, "id" | "type"> & { config?: unknown };
type GraphLike = { nodes: readonly NodeLike[]; edges: readonly Pick<WorkflowEdge, "id" | "source" | "sourceHandle" | "target">[] };

/** The output handles a block exposes, in the order the editor draws them. */
export function outputHandles(node: NodeLike): string[] {
  switch (node.type) {
    case "trigger.manual":
    case "trigger.schedule":
    case "trigger.git":
      return ["success"];
    case "agent":
    case "code":
    case "shell":
    case "http":
    case "merge":
    case "wait":
    case "workflow":
      return ["success", "error"];
    case "if":
      return ["true", "false", "error"];
    case "switch": {
      const config = (node.config ?? {}) as { cases?: unknown; fallback?: unknown };
      const cases = Array.isArray(config.cases) ? config.cases.length : 0;
      const handles = Array.from({ length: cases }, (_, index) => `case:${index}`);
      if (config.fallback !== false) handles.push("default");
      handles.push("error");
      return handles;
    }
    case "stop":
    case "note":
      return [];
    default: {
      const unhandled: never = node.type;
      void unhandled;
      return [];
    }
  }
}

/** Human label of a handle: "success", "failure", "true", "case 1 · Label", "default". */
export function workflowHandleLabel(node: NodeLike, handle: string): string {
  if (handle === "error") return "failure";
  const match = /^case:(\d+)$/.exec(handle);
  if (match) {
    const index = Number(match[1]);
    const config = (node.config ?? {}) as { cases?: { label?: unknown }[] };
    const label = Array.isArray(config.cases) ? config.cases[index]?.label : undefined;
    return typeof label === "string" && label.trim().length > 0 ? label.trim() : `case ${index + 1}`;
  }
  return handle;
}

/** Triggers start runs and notes never run: neither takes an input edge. */
export function acceptsInput(node: NodeLike): boolean {
  return !isTriggerType(node.type) && node.type !== "note";
}

/** Every node but sticky notes. */
export function executableNodes<N extends NodeLike>(workflow: { nodes: readonly N[] }): N[] {
  return workflow.nodes.filter((node) => node.type !== "note");
}

interface Adjacency {
  ids: string[];
  index: Map<string, number>;
  out: Map<string, string[]>;
  inc: Map<string, string[]>;
}

/** Adjacency over executable nodes; edges naming a missing or note node are ignored. */
function adjacency(workflow: GraphLike): Adjacency {
  const ids = executableNodes(workflow).map((node) => node.id);
  const index = new Map(ids.map((id, position) => [id, position]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const inc = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of workflow.edges) {
    if (!index.has(edge.source) || !index.has(edge.target)) continue;
    out.get(edge.source)!.push(edge.target);
    inc.get(edge.target)!.push(edge.source);
  }
  return { ids, index, out, inc };
}

/**
 * Executable node ids in a topological order (ties in definition order), or null when the graph has
 * a cycle. Notes are left out.
 */
export function topologicalOrder(workflow: GraphLike): string[] | null {
  const { ids, index, out, inc } = adjacency(workflow);
  const remaining = new Map(ids.map((id) => [id, inc.get(id)!.length]));
  const ready = ids.filter((id) => remaining.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    // Smallest definition index first — deterministic and stable under edits elsewhere.
    let best = 0;
    for (let i = 1; i < ready.length; i += 1) if (index.get(ready[i]!)! < index.get(ready[best]!)!) best = i;
    const id = ready.splice(best, 1)[0]!;
    order.push(id);
    for (const target of out.get(id)!) {
      const left = remaining.get(target)! - 1;
      remaining.set(target, left);
      if (left === 0) ready.push(target);
    }
  }
  return order.length === ids.length ? order : null;
}

/** The node sets of every cycle (strongly connected components of size > 1, and self-loops). */
export function findCycles(workflow: GraphLike): string[][] {
  const { ids, out } = adjacency(workflow);
  // Tarjan, iterative (no recursion depth limit on hostile input).
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;
  for (const root of ids) {
    if (indexOf.has(root)) continue;
    const work: { id: string; next: number }[] = [{ id: root, next: 0 }];
    indexOf.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = out.get(frame.id)!;
      if (frame.next < targets.length) {
        const target = targets[frame.next]!;
        frame.next += 1;
        if (!indexOf.has(target)) {
          indexOf.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ id: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, indexOf.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === indexOf.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.id) break;
        }
        const selfLoop = component.length === 1 && out.get(component[0]!)!.includes(component[0]!);
        if (component.length > 1 || selfLoop) cycles.push(component.reverse());
      }
    }
  }
  return cycles;
}

function walk(start: string, next: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(next.get(start) ?? [])];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(next.get(id) ?? []));
  }
  seen.delete(start);
  return seen;
}

/** Every node that can reach `nodeId` (its transitive inputs), excluding itself. */
export function upstreamOf(workflow: GraphLike, nodeId: string): Set<string> {
  return walk(nodeId, adjacency(workflow).inc);
}

/** Every node `nodeId` can reach, excluding itself. */
export function downstreamOf(workflow: GraphLike, nodeId: string): Set<string> {
  return walk(nodeId, adjacency(workflow).out);
}

/** Nodes reachable from any trigger (triggers included). */
export function reachableFromTriggers(workflow: GraphLike): Set<string> {
  const { out } = adjacency(workflow);
  const seen = new Set<string>();
  for (const node of workflow.nodes) {
    if (!isTriggerType(node.type)) continue;
    seen.add(node.id);
    for (const id of walk(node.id, out)) seen.add(id);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Readiness (dead-path elimination, §3.4)
// ---------------------------------------------------------------------------

export type EdgeState = "live" | "dead" | "pending";

export interface ReadinessState {
  status: Record<string, WorkflowBlockStatus | undefined>;
  /**
   * The handle each finished block took. Absent for a finished block: `success` when it succeeded,
   * `error` when it failed.
   */
  handle: Record<string, string | undefined>;
}

export interface Readiness {
  /** Pending blocks that may start now, in topological order. */
  ready: string[];
  /** Pending blocks that will never run (every input dead), in topological order — transitively. */
  skip: string[];
  /** Every edge's state, as it stands once the `skip` blocks are skipped. */
  edgeStates: Record<string, EdgeState>;
}

const FINISHED: ReadonlySet<WorkflowBlockStatus> = new Set(["succeeded", "failed"]);
const NEVER_RAN: ReadonlySet<WorkflowBlockStatus> = new Set(["skipped", "cancelled"]);

function isPendingStatus(status: WorkflowBlockStatus | undefined): boolean {
  return status === undefined || status === "pending";
}

/**
 * The engine's step: which pending blocks can start and which are dead. A block runs once every
 * incoming edge is settled — live (its source finished and took that handle) or dead (its source
 * was skipped or cancelled, or finished on another handle) — and at least one is live; all dead →
 * skipped, and its own edges die with it (the propagation happens here, in one call). A Merge in
 * `first` mode runs on its first live input without waiting for the rest. A block with no input
 * edge at all never runs (skipped). Triggers and notes are never in either list: the engine sets
 * the trigger that fired and skips the others.
 */
export function computeReadiness(workflow: Workflow | GraphLike, state: ReadinessState): Readiness {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const order = topologicalOrder(workflow) ?? executableNodes(workflow).map((node) => node.id);
  const status = new Map<string, WorkflowBlockStatus | undefined>(
    workflow.nodes.map((node) => [node.id, state.status[node.id]])
  );
  const incoming = new Map<string, GraphLike["edges"][number][]>();
  for (const edge of workflow.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    const list = incoming.get(edge.target) ?? [];
    list.push(edge);
    incoming.set(edge.target, list);
  }

  const edgeState = (edge: GraphLike["edges"][number]): EdgeState => {
    const sourceStatus = status.get(edge.source);
    if (sourceStatus !== undefined && NEVER_RAN.has(sourceStatus)) return "dead";
    if (sourceStatus !== undefined && FINISHED.has(sourceStatus)) {
      const taken = state.handle[edge.source] ?? (sourceStatus === "succeeded" ? "success" : "error");
      return taken === edge.sourceHandle ? "live" : "dead";
    }
    if (!nodes.has(edge.source) || nodes.get(edge.source)!.type === "note") return "dead";
    return "pending";
  };

  const ready: string[] = [];
  const skip: string[] = [];
  for (const id of order) {
    const node = nodes.get(id);
    if (node === undefined || !acceptsInput(node) || !isPendingStatus(status.get(id))) continue;
    const states = (incoming.get(id) ?? []).map(edgeState);
    const live = states.filter((value) => value === "live").length;
    const pending = states.filter((value) => value === "pending").length;
    const firstArrival =
      node.type === "merge" && ((node.config ?? {}) as { mode?: unknown }).mode === "first";
    if (live > 0 && (pending === 0 || firstArrival)) ready.push(id);
    else if (live === 0 && pending === 0) {
      skip.push(id);
      // Later nodes in the order see this one as skipped.
      status.set(id, "skipped");
    }
  }

  const edgeStates: Record<string, EdgeState> = {};
  for (const edge of workflow.edges) edgeStates[edge.id] = nodes.has(edge.target) ? edgeState(edge) : "dead";
  return { ready, skip, edgeStates };
}
