/**
 * The phone's Steps view (workflows spec §7.4), as pure functions: the rows
 * it draws — the shared outline (`buildStepOutline`) dressed with each
 * block's name, summary, problems and outputs — and the edits it makes, each
 * a recipe over a definition the editor store turns into one undo step:
 * add after an output (and connect, splicing into a chain), connect an
 * output to a block, move a block to another output, delete a block and heal
 * the chain around it, duplicate a block right after itself, disable it.
 *
 * A whole workflow is buildable from these alone, without the canvas.
 */

import {
  acceptsInput,
  buildStepOutline,
  downstreamOf,
  isTriggerType,
  LAYOUT_NODE_WIDTH,
  LAYOUT_RANK_SEP,
  outputHandles,
  placeNewNodes,
  workflowHandleLabel,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowProblem
} from "@orquester/api";

import { duplicateWorkflowNodes } from "../../../lib/workflows/clipboard";
import { displayOutline } from "../../../lib/workflows/outline-display";
import { connectBlocks, connectionRefusal } from "../canvas/connection";
import { addBlock, GRID, removeElements } from "../canvas/ops";

type Graph = Pick<Workflow, "nodes" | "edges"> & { pinned?: Workflow["pinned"] };

export type OutputTone = "ok" | "danger" | "info" | "neutral";

export interface StepOutput {
  handle: string;
  /** "success", "failure", "true", "Bug"… */
  label: string;
  tone: OutputTone;
  /** Edges leave by it. */
  connected: boolean;
  /** The names of the blocks it leads to. */
  targets: string[];
}

export interface StepRow {
  key: string;
  kind: "node" | "join-ref";
  nodeId: string;
  depth: number;
  /**
   * The output of the parent this row hangs from, when that is worth saying (a
   * branch, a failure) — with the parent's name when the row is not right
   * under it.
   */
  via: { handle: string; label: string; tone: OutputTone; parentName: string | null } | null;
  /** The parent this row hangs from (its edge). */
  parentId: string | null;
  name: string;
  type: WorkflowNodeType;
  summary: string;
  disabled: boolean;
  unreachable: boolean;
  /** A join's own row: the names of the blocks leading into it (two or more). */
  joinOf: string[];
  /** Only failures lead into this join (every edge into it leaves by `error`). */
  failureJoin: boolean;
  errors: number;
  warnings: number;
  /** The first problem, errors first. */
  firstProblem: string | null;
  outputs: StepOutput[];
  /** The first unreachable row (the "Not connected to a trigger" heading goes above it). */
  firstUnreachable: boolean;
}

export interface StepsModel {
  rows: StepRow[];
  /** Some trigger exists. */
  hasTrigger: boolean;
  /** Blocks (notes aside). */
  blockCount: number;
}

/** The tone an output is painted in (the canvas's handle colours). */
export function outputTone(handle: string): OutputTone {
  if (handle === "success" || handle === "true") return "ok";
  if (handle === "error") return "danger";
  if (handle.startsWith("case:")) return "info";
  return "neutral";
}

export function deriveSteps(
  workflow: Graph,
  problems: readonly WorkflowProblem[],
  summaryOf: (node: WorkflowNode) => string
): StepsModel {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const connected = new Set(workflow.edges.map((edge) => `${edge.source}\u0000${edge.sourceHandle}`));
  const problemsOf = new Map<string, WorkflowProblem[]>();
  for (const problem of problems) {
    if (!problem.nodeId || problem.severity === "info") continue;
    const list = problemsOf.get(problem.nodeId) ?? [];
    list.push(problem);
    problemsOf.set(problem.nodeId, list);
  }
  let sawUnreachable = false;
  const rows: StepRow[] = [];
  for (const item of displayOutline(workflow)) {
    const node = byId.get(item.nodeId);
    if (!node) continue;
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    const depth = item.displayDepth;
    const own = problemsOf.get(node.id) ?? [];
    const errors = own.filter((problem) => problem.severity === "error");
    const warnings = own.filter((problem) => problem.severity === "warning");
    const first = errors[0] ?? warnings[0];
    const firstUnreachable = item.unreachable === true && !sawUnreachable;
    if (item.unreachable) sawUnreachable = true;
    const failureJoin = item.failureJoin;
    rows.push({
      key: item.key,
      kind: item.kind,
      nodeId: node.id,
      depth,
      via:
        item.labelled && parent && item.viaHandle
          ? {
              handle: item.viaHandle,
              label: workflowHandleLabel(parent, item.viaHandle),
              tone: outputTone(item.viaHandle),
              parentName: item.underParent ? null : parent.name
            }
          : failureJoin
            ? { handle: "error", label: "failure", tone: "danger", parentName: null }
            : null,
      parentId: item.parentId ?? null,
      name: node.name,
      type: node.type,
      summary: item.kind === "node" ? summaryOf(node) : "",
      disabled: node.disabled === true,
      unreachable: item.unreachable === true,
      joinOf: (item.joinOf ?? []).map((id) => byId.get(id)?.name ?? id),
      failureJoin,
      errors: errors.length,
      warnings: warnings.length,
      firstProblem: first ? first.message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "") : null,
      outputs: outputHandles(node).map((handle) => {
        const targets = workflow.edges
          .filter((edge) => edge.source === node.id && edge.sourceHandle === handle)
          .map((edge) => byId.get(edge.target)?.name ?? edge.target);
        return {
          handle,
          label: workflowHandleLabel(node, handle),
          tone: outputTone(handle),
          connected: connected.has(`${node.id}\u0000${handle}`),
          targets
        };
      }),
      firstUnreachable
    });
  }
  const blocks = workflow.nodes.filter((node) => node.type !== "note");
  return { rows, hasTrigger: blocks.some((node) => isTriggerType(node.type)), blockCount: blocks.length };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export interface OutputRef {
  nodeId: string;
  handle: string;
}

const STEP_X = LAYOUT_NODE_WIDTH + LAYOUT_RANK_SEP;
const snap = (value: number): number => Math.round(value / GRID) * GRID;

/** Blocks at or right of `x` downstream of `nodeId` move one column right (room for a spliced block). */
function shiftDownstream<W extends Graph>(workflow: W, nodeId: string, x: number): W {
  const after = downstreamOf(workflow, nodeId);
  if (after.size === 0) return workflow;
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      after.has(node.id) && node.position.x >= x - GRID ? { ...node, position: { x: node.position.x + STEP_X, y: node.position.y } } : node
    )
  };
}

/** Put a freshly added block beside what it connects to (`placeNewNodes`), clear of the others. */
function place<W extends Graph>(workflow: W, nodeId: string): W {
  const at = placeNewNodes(workflow, [nodeId])[nodeId];
  if (!at) return workflow;
  return { ...workflow, nodes: workflow.nodes.map((node) => (node.id === nodeId ? { ...node, position: { x: snap(at.x), y: snap(at.y) } } : node)) };
}

/**
 * "+ Add after" an output: a new block of `type` wired from it. When exactly
 * one edge already leaves by that output and the new block has an output of
 * its own, it goes BETWEEN them (the chain continues after it) and the blocks
 * downstream shift one column right; otherwise it is one more branch.
 */
export function addStepAfter<W extends Graph>(
  workflow: W,
  from: OutputRef,
  type: WorkflowNodeType,
  mintId: () => string
): { workflow: W; nodeId: string } {
  const source = workflow.nodes.find((node) => node.id === from.nodeId);
  const leaving = workflow.edges.filter((edge) => edge.source === from.nodeId && edge.sourceHandle === from.handle);
  const splices = leaving.length === 1 && outputHandles({ id: "", type, config: {} }).length > 0;
  if (splices && source) {
    const edge = leaving[0]!;
    const target = workflow.nodes.find((node) => node.id === edge.target);
    const at = { x: source.position.x + STEP_X, y: source.position.y };
    const shifted = target ? shiftDownstream({ ...workflow }, source.id, target.position.x) : workflow;
    const added = addBlock(shifted, type, at, mintId, { intoEdgeId: edge.id });
    return { workflow: added.workflow, nodeId: added.nodeId };
  }
  const added = addBlock(workflow, type, { x: 0, y: 0 }, mintId, { from });
  return { workflow: place(added.workflow, added.nodeId), nodeId: added.nodeId };
}

/**
 * The first step of a workflow with nothing wired yet: after the (first)
 * trigger's output when there is one and `type` takes input, else loose.
 */
export function addFirstStep<W extends Graph>(
  workflow: W,
  type: WorkflowNodeType,
  mintId: () => string
): { workflow: W; nodeId: string } {
  const trigger = workflow.nodes.find((node) => isTriggerType(node.type));
  if (trigger && !isTriggerType(type) && type !== "note") return addStepAfter(workflow, { nodeId: trigger.id, handle: "success" }, type, mintId);
  const added = addBlock(workflow, type, { x: 0, y: 0 }, mintId);
  return { workflow: place(added.workflow, added.nodeId), nodeId: added.nodeId };
}

export interface ConnectCandidate {
  nodeId: string;
  name: string;
  type: WorkflowNodeType;
  /** Why it cannot be connected, or null. */
  refusal: string | null;
}

/** Every block an output could connect to, connectable ones first (in outline order), with why not. */
export function connectCandidates(workflow: Graph, from: OutputRef): ConnectCandidate[] {
  const order = new Map(buildStepOutline(workflow).map((item, index) => [item.nodeId, index]));
  return workflow.nodes
    .filter((node) => node.id !== from.nodeId && node.type !== "note" && acceptsInput(node))
    .map((node) => ({
      nodeId: node.id,
      name: node.name,
      type: node.type,
      refusal: connectionRefusal(workflow, { source: from.nodeId, sourceHandle: from.handle, target: node.id })
    }))
    .sort(
      (a, b) =>
        Number(a.refusal !== null) - Number(b.refusal !== null) ||
        (order.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER)
    );
}

/** An edge from `from` to `targetId`, or the same workflow when it is refused. */
export function connectStep<W extends Graph>(workflow: W, from: OutputRef, targetId: string, mintId: () => string): W {
  return connectBlocks(workflow, { source: from.nodeId, sourceHandle: from.handle, target: targetId }, mintId);
}

export interface MoveCandidate extends OutputRef {
  name: string;
  type: WorkflowNodeType;
  label: string;
  tone: OutputTone;
  /** The output it hangs from now. */
  current: boolean;
  refusal: string | null;
}

/**
 * Every output `nodeId` could hang from instead: any other block's output that
 * would not make a loop. `current` is the one its row hangs from now.
 */
export function moveCandidates(workflow: Graph, nodeId: string, current: OutputRef | null): MoveCandidate[] {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !acceptsInput(node)) return [];
  const below = downstreamOf(workflow, nodeId);
  const order = new Map(buildStepOutline(workflow).map((item, index) => [item.nodeId, index]));
  const out: MoveCandidate[] = [];
  const sources = [...workflow.nodes]
    .filter((source) => source.id !== nodeId && source.type !== "note")
    .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  for (const source of sources) {
    for (const handle of outputHandles(source)) {
      const isCurrent = current !== null && current.nodeId === source.id && current.handle === handle;
      const already = workflow.edges.some((edge) => edge.source === source.id && edge.sourceHandle === handle && edge.target === nodeId);
      out.push({
        nodeId: source.id,
        handle,
        name: source.name,
        type: source.type,
        label: workflowHandleLabel(source, handle),
        tone: outputTone(handle),
        current: isCurrent,
        refusal: isCurrent
          ? null
          : below.has(source.id)
            ? "That would make a loop — workflows run in one direction."
            : already
              ? "Already connected there."
              : null
      });
    }
  }
  return out;
}

/**
 * Hang `nodeId` from another output: the edge it hangs from now (`current`,
 * else every edge into it) is replaced by one from `to`.
 */
export function moveStepToOutput<W extends Graph>(
  workflow: W,
  nodeId: string,
  current: OutputRef | null,
  to: OutputRef,
  mintId: () => string
): W {
  if (current && current.nodeId === to.nodeId && current.handle === to.handle) return workflow;
  const dropped = workflow.edges.filter(
    (edge) =>
      edge.target === nodeId && (current === null || (edge.source === current.nodeId && edge.sourceHandle === current.handle))
  );
  const without: W = { ...workflow, edges: workflow.edges.filter((edge) => !dropped.includes(edge)) };
  const next = connectBlocks(without, { source: to.nodeId, sourceHandle: to.handle, target: nodeId }, mintId);
  return next === without ? workflow : next;
}

/**
 * Delete a block and heal the chain: when exactly one edge leads into it, what
 * its first output fed is fed from that edge's output instead (a straight line
 * stays a line). Its other outputs' blocks are left unconnected.
 */
export function deleteStep<W extends Graph>(workflow: W, nodeId: string, mintId: () => string): W {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return workflow;
  const into = workflow.edges.filter((edge) => edge.target === nodeId);
  const primary = outputHandles(node)[0];
  const onwards = primary ? workflow.edges.filter((edge) => edge.source === nodeId && edge.sourceHandle === primary) : [];
  let next = removeElements(workflow, [nodeId], []);
  if (into.length === 1) {
    const from = into[0]!;
    for (const edge of onwards) {
      next = connectBlocks(next, { source: from.source, sourceHandle: from.sourceHandle, target: edge.target }, mintId);
    }
  }
  return next;
}

/**
 * A copy of the block right after it: wired from its first output, taking over
 * what that output fed (a list's "duplicate" puts the copy below). A block
 * without outputs (Stop) gets its copy as one more branch of what feeds it.
 */
export function duplicateStepAfter<W extends Graph>(workflow: W, nodeId: string, mintId: () => string): { workflow: W; nodeId: string } | null {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  const copy = duplicateWorkflowNodes(workflow, [nodeId], mintId);
  const copyId = copy?.nodeIds[0];
  if (!copy || !copyId) return null;
  let next = copy.workflow;
  const primary = outputHandles(node)[0];
  if (primary && acceptsInput(node)) {
    const onwards = next.edges.filter((edge) => edge.source === nodeId && edge.sourceHandle === primary);
    const copyOut = primary;
    // Shift what follows BEFORE the edges go: with them gone nothing is downstream any more.
    next = shiftDownstream(next, nodeId, node.position.x + STEP_X);
    next = { ...next, edges: next.edges.filter((edge) => !onwards.some((gone) => gone.id === edge.id)) };
    next = connectBlocks(next, { source: nodeId, sourceHandle: primary, target: copyId }, mintId);
    for (const edge of onwards) next = connectBlocks(next, { source: copyId, sourceHandle: copyOut, target: edge.target }, mintId);
  } else {
    for (const edge of workflow.edges.filter((candidate) => candidate.target === nodeId)) {
      next = connectBlocks(next, { source: edge.source, sourceHandle: edge.sourceHandle, target: copyId }, mintId);
    }
  }
  const at = { x: node.position.x + (primary && acceptsInput(node) ? STEP_X : 0), y: node.position.y + (primary && acceptsInput(node) ? 0 : 128) };
  next = { ...next, nodes: next.nodes.map((candidate) => (candidate.id === copyId ? { ...candidate, position: { x: snap(at.x), y: snap(at.y) } } : candidate)) };
  return { workflow: next, nodeId: copyId };
}

/** Disable or enable blocks (a disabled block is skipped by runs, and its branch with it). */
export function setStepsDisabled<W extends Graph>(workflow: W, nodeIds: readonly string[], disabled: boolean): W {
  const ids = new Set(nodeIds);
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (!ids.has(node.id)) return node;
      const { disabled: _old, ...rest } = node;
      return (disabled ? { ...rest, disabled: true } : rest) as typeof node;
    })
  };
}
