// Automated workflows — the phone's Steps view (spec §7.4): the workflow as a vertical outline.
//
// A depth-first walk from each trigger (in definition order) following its outputs in handle order
// (success, error; true, false, error; case:0 …, default, error), ties by the targets' position on
// the canvas. A straight line stays flat; a block with several outputs, or one whose only output is
// not `success`, indents its children one level under the handle's label.
//
// A block several edges lead to (a join) appears ONCE, after every branch that leads to it, at the
// level of the block the branches split from; each edge leading to it is a `join-ref` item where the
// edge is ("→ continues at Merge"). Blocks no trigger reaches come last, flat, marked `unreachable`.
// Sticky notes are not steps.

import { outputHandles, reachableFromTriggers } from "./graph.ts";
import { isTriggerType, type WorkflowNode } from "./types.ts";

type OutlineNode = Pick<WorkflowNode, "id" | "type" | "position"> & { config?: unknown };
type OutlineEdge = { id: string; source: string; sourceHandle: string; target: string };

export interface OutlineItem {
  /** Unique within the outline (a block can have several `join-ref` items). */
  key: string;
  /** The block this row shows (for a `join-ref`, the block it points to). */
  nodeId: string;
  depth: number;
  kind: "node" | "join-ref";
  /** The output of `parentId` this row hangs from. */
  viaHandle?: string;
  parentId?: string;
  /** `join-ref` only: the block the edge continues at (= nodeId). */
  joinsNodeId?: string;
  /** A join's own row: every block with an edge into it. */
  joinOf?: string[];
  /** No trigger reaches this block. */
  unreachable?: boolean;
}

export function buildStepOutline(workflow: { nodes: readonly OutlineNode[]; edges: readonly OutlineEdge[] }): OutlineItem[] {
  const nodes = workflow.nodes.filter((node) => node.type !== "note");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = workflow.edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target) && edge.source !== edge.target);
  const graph = { nodes, edges };
  const reachable = reachableFromTriggers(graph);

  // Children in handle order, then by the target's place on the canvas.
  const children = new Map<string, OutlineEdge[]>();
  for (const node of nodes) {
    const handles = outputHandles(node);
    const rank = (handle: string): number => {
      const index = handles.indexOf(handle);
      return index < 0 ? handles.length : index;
    };
    const outs = edges
      .filter((edge) => edge.source === node.id)
      .sort((a, b) => {
        const ta = byId.get(a.target)!;
        const tb = byId.get(b.target)!;
        return (
          rank(a.sourceHandle) - rank(b.sourceHandle) ||
          ta.position.y - tb.position.y ||
          ta.position.x - tb.position.x
        );
      });
    children.set(node.id, outs);
  }

  // Joins: blocks with two or more edges from reachable blocks.
  const incoming = new Map<string, OutlineEdge[]>();
  for (const edge of edges) {
    if (!reachable.has(edge.source)) continue;
    const list = incoming.get(edge.target) ?? [];
    list.push(edge);
    incoming.set(edge.target, list);
  }
  const isJoin = (id: string): boolean => (incoming.get(id)?.length ?? 0) >= 2;
  const remaining = new Map([...incoming].map(([id, list]) => [id, list.length]));

  const descendantsCache = new Map<string, Set<string>>();
  const descendants = (id: string): Set<string> => {
    let set = descendantsCache.get(id);
    if (set === undefined) {
      set = new Set<string>();
      const stack = [...(children.get(id) ?? []).map((edge) => edge.target)];
      while (stack.length > 0) {
        const next = stack.pop()!;
        if (set.has(next)) continue;
        set.add(next);
        stack.push(...(children.get(next) ?? []).map((edge) => edge.target));
      }
      descendantsCache.set(id, set);
    }
    return set;
  };

  const items: OutlineItem[] = [];
  const emitted = new Set<string>();
  const readyJoins: string[] = [];
  const keys = new Map<string, number>();
  const key = (base: string): string => {
    const count = keys.get(base) ?? 0;
    keys.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  };

  const flushJoins = (frameId: string | null, depth: number): void => {
    for (let found = true; found; ) {
      found = false;
      for (let index = 0; index < readyJoins.length; index += 1) {
        const joinId = readyJoins[index]!;
        const parents = [...new Set((incoming.get(joinId) ?? []).map((edge) => edge.source))];
        const covered =
          frameId === null || parents.every((parent) => parent === frameId || descendants(frameId).has(parent));
        if (!covered) continue;
        readyJoins.splice(index, 1);
        if (!emitted.has(joinId)) visit(joinId, depth, undefined, undefined, parents);
        found = true;
        break;
      }
    }
  };

  const visit = (id: string, depth: number, viaHandle?: string, parentId?: string, joinOf?: string[]): void => {
    emitted.add(id);
    items.push({
      key: key(`node:${id}`),
      nodeId: id,
      depth,
      kind: "node",
      ...(viaHandle !== undefined ? { viaHandle } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(joinOf !== undefined ? { joinOf } : {})
    });
    const outs = children.get(id) ?? [];
    const branching = outs.length > 1 || (outs.length === 1 && outs[0]!.sourceHandle !== "success");
    const childDepth = branching ? depth + 1 : depth;
    for (const edge of outs) {
      const target = edge.target;
      remaining.set(target, (remaining.get(target) ?? 1) - 1);
      if (emitted.has(target) || isJoin(target)) {
        items.push({
          key: key(`join:${id}:${edge.sourceHandle}:${target}`),
          nodeId: target,
          depth: childDepth,
          kind: "join-ref",
          viaHandle: edge.sourceHandle,
          parentId: id,
          joinsNodeId: target
        });
        if (!emitted.has(target) && (remaining.get(target) ?? 0) <= 0 && !readyJoins.includes(target)) readyJoins.push(target);
        continue;
      }
      visit(target, childDepth, edge.sourceHandle, id);
    }
    flushJoins(id, depth);
  };

  const triggers = nodes.filter((node) => isTriggerType(node.type));
  for (const trigger of triggers) {
    if (!emitted.has(trigger.id)) visit(trigger.id, 0);
    flushJoins(null, 0);
  }
  // Whatever a trigger reaches but the walk could not place (a cycle keeps a join waiting).
  const leftovers = nodes.filter((node) => reachable.has(node.id) && !emitted.has(node.id));
  for (const node of leftovers) {
    if (emitted.has(node.id)) continue;
    visit(node.id, 0);
    flushJoins(null, 0);
  }
  for (const node of nodes) {
    if (emitted.has(node.id)) continue;
    items.push({ key: key(`node:${node.id}`), nodeId: node.id, depth: 0, kind: "node", unreachable: true });
  }
  return items;
}
