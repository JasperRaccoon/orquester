/**
 * The shared step outline (`buildStepOutline`, workflows spec §7.4) as the
 * phone's Steps view and the run timeline draw it. The outline indents every
 * child of a block with several outputs; drawn as is, a plain chain of
 * success/failure blocks becomes a staircase and every failure edge a row.
 * Here:
 *
 * - a success/failure block's **success** path stays at its own level (its
 *   failure branch is the one indented, and labelled);
 * - a failure edge into a block shown elsewhere is no row of its own (the
 *   step's own output says where its failure goes);
 * - a join only failures lead to is labelled "failure".
 */

import { buildStepOutline, outputHandles, type OutlineItem, type WorkflowNode } from "@orquester/api";

export interface DisplayOutlineItem extends OutlineItem {
  /** The depth to draw it at. */
  displayDepth: number;
  /** Its output is worth a label (a branch or a failure, not a plain chain). */
  labelled: boolean;
  /** The row drawn right before it (a node row) is its parent. */
  underParent: boolean;
  /** A join only failure edges lead into. */
  failureJoin: boolean;
}

type Graph = {
  nodes: readonly (Pick<WorkflowNode, "id" | "type" | "position"> & { config?: unknown })[];
  edges: readonly { id: string; source: string; sourceHandle: string; target: string }[];
};

export function displayOutline(workflow: Graph): DisplayOutlineItem[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const plainSuccess = (parentId: string, handle: string): boolean => {
    const parent = byId.get(parentId);
    return !!parent && handle === "success" && outputHandles(parent).every((h) => h === "success" || h === "error");
  };
  const display = new Map<string, number>();
  const outlineDepth = new Map<string, number>();
  const lastAtDepth: number[] = [];
  let previousNode: string | null = null;
  const out: DisplayOutlineItem[] = [];
  for (const item of buildStepOutline(workflow)) {
    if (!byId.has(item.nodeId)) continue;
    if (item.kind === "join-ref" && item.viaHandle === "error") continue;
    let depth: number;
    let labelled = false;
    if (item.parentId !== undefined && item.viaHandle !== undefined) {
      const indented = item.depth > (outlineDepth.get(item.parentId) ?? item.depth);
      labelled = !plainSuccess(item.parentId, item.viaHandle) && indented;
      depth = (display.get(item.parentId) ?? 0) + (labelled ? 1 : 0);
    } else {
      depth = item.unreachable ? 0 : (lastAtDepth[item.depth] ?? item.depth);
    }
    if (item.kind === "node") {
      display.set(item.nodeId, depth);
      outlineDepth.set(item.nodeId, item.depth);
      lastAtDepth.length = item.depth + 1;
      lastAtDepth[item.depth] = depth;
    }
    const into = item.joinOf ? workflow.edges.filter((edge) => edge.target === item.nodeId) : [];
    out.push({
      ...item,
      displayDepth: depth,
      labelled,
      underParent: item.parentId !== undefined && previousNode === item.parentId,
      failureJoin: into.length > 0 && into.every((edge) => edge.sourceHandle === "error")
    });
    if (item.kind === "node") previousNode = item.nodeId;
  }
  return out;
}
