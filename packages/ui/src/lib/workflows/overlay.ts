/**
 * The run overlay the canvas draws over a run's frozen definition (workflows
 * spec §7.3): per block its state, duration, attempt, the handle it left by
 * and — for agents — the account and hop count; per edge whether the run went
 * down it.
 *
 * Edge states: `taken` (the run went this way), `active` (taken, and its
 * target is running right now — the canvas animates it), `dead` (dead-path
 * elimination closed it) and `idle` (not reached yet). The run's own
 * `takenEdges` / `deadEdges` decide; an edge in neither is read off its source
 * block when that block has finished (the handle it took is live, every other
 * handle is dead), so a run loaded before its edge lists caught up still draws
 * the path it took.
 *
 * Loop edges (spec 2026-11-10 §7.4) are read off the run's loop counters
 * instead: `taken` once the run went back along one (`active` while its
 * target runs again), else `dead` when its source finished on another
 * handle. Each carries its counter (`loops`), which the canvas labels
 * "used/max". A block a loop ran again carries its pass and pass count.
 *
 * Pure: the caller passes `now` for a running block's elapsed time.
 */

import {
  isLoopEdge,
  workflowHandleLabel,
  type Workflow,
  type WorkflowBlockRun,
  type WorkflowBlockStatus,
  type WorkflowNode,
  type WorkflowRunStatus
} from "@orquester/api";

import { loopCounterOf, type LoopCounter } from "./loops";

export type OverlayEdgeState = "taken" | "dead" | "active" | "idle";

export interface OverlayNodeState {
  status: WorkflowBlockStatus;
  /** Finished: ended − started; running: now − started. */
  durationMs?: number;
  /** 1-based; 0 before the first attempt. */
  attempt: number;
  /** The output handle it finished on. */
  handle?: string;
  /** Agents: who is (or was last) running it. */
  accountLabel?: string;
  /** Agents: how many sessions/accounts it went through. */
  hopCount?: number;
  /** The latest activity line while running. */
  activity?: string;
  errorMessage?: string;
  /** Output from pinned data (test runs). */
  pinned?: boolean;
  /** A Wait block or a wait-for-reset: until when. */
  waitingUntil?: string;
  /** A loop ran it again: its current pass (1-based) and how many passes it has had. */
  pass?: number;
  passCount?: number;
  /**
   * An agent block with outcomes (spec 2026-11-10 §5): the outcome it finished on, or — still
   * running — the one its agent reported so far (`final: false`, a later report may replace it).
   */
  outcome?: { id: string; label: string; final: boolean };
}

export interface RunOverlay {
  runStatus: WorkflowRunStatus;
  nodes: Record<string, OverlayNodeState>;
  edges: Record<string, OverlayEdgeState>;
  /** Every loop edge's counter in this run, by edge id. */
  loops: Record<string, LoopCounter>;
}

export interface RunOverlayInput {
  status: WorkflowRunStatus;
  blocks: Readonly<Record<string, WorkflowBlockRun>>;
  takenEdges: readonly string[];
  deadEdges: readonly string[];
  /** How often each loop edge was taken (absent = 0), and limits raised for this run. */
  loopCounters?: Readonly<Record<string, number>>;
  loopLimits?: Readonly<Record<string, number>>;
}

const FINISHED: ReadonlySet<WorkflowBlockStatus> = new Set(["succeeded", "failed", "skipped", "cancelled"]);
const LIVE: ReadonlySet<WorkflowBlockStatus> = new Set(["running", "waiting"]);

function durationOf(block: WorkflowBlockRun, now: number): number | undefined {
  const start = block.startedAt ? Date.parse(block.startedAt) : Number.NaN;
  if (Number.isNaN(start)) return undefined;
  const end = block.endedAt ? Date.parse(block.endedAt) : block.status === "running" || block.status === "waiting" ? now : Number.NaN;
  if (Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

/** The handle a finished block left by: its own word, else success / error by its state. */
function finishedHandle(block: WorkflowBlockRun): string | null {
  if (block.handle) return block.handle;
  if (block.status === "succeeded") return "success";
  if (block.status === "failed") return "error";
  return null;
}

/** The outcome chip of an agent block: the outcome handle it took, else a running pass's report. */
function outcomeOf(block: WorkflowBlockRun, node: Pick<WorkflowNode, "id" | "type" | "config">): OverlayNodeState["outcome"] | undefined {
  const taken = block.handle?.startsWith("outcome:") ? block.handle.slice("outcome:".length) : undefined;
  const reported = LIVE.has(block.status) ? block.report?.outcome : undefined;
  const id = taken ?? reported;
  if (id === undefined) return undefined;
  return { id, label: workflowHandleLabel(node, `outcome:${id}`), final: taken !== undefined };
}

function nodeState(block: WorkflowBlockRun, now: number, node: Pick<WorkflowNode, "id" | "type" | "config">): OverlayNodeState {
  const state: OverlayNodeState = { status: block.status, attempt: block.attempt };
  const duration = durationOf(block, now);
  if (duration !== undefined) state.durationMs = duration;
  if (block.handle) state.handle = block.handle;
  const hops = block.hops ?? [];
  const lastHop = hops[hops.length - 1];
  const label =
    lastHop?.accountLabel ??
    lastHop?.accountId ??
    block.selection?.chosen?.accountLabel ??
    block.selection?.chosen?.accountId;
  if (label) state.accountLabel = label;
  if (hops.length > 0) state.hopCount = hops.length;
  if (block.activity && LIVE.has(block.status)) state.activity = block.activity;
  if (block.error?.message) state.errorMessage = block.error.message;
  if (block.pinned) state.pinned = true;
  if (block.waitingUntil) state.waitingUntil = block.waitingUntil;
  const passCount = Math.max(block.pass ?? 1, (block.passes?.length ?? 0) + 1);
  if (passCount > 1) {
    state.pass = block.pass ?? passCount;
    state.passCount = passCount;
  }
  const outcome = outcomeOf(block, node);
  if (outcome) state.outcome = outcome;
  return state;
}

export function deriveRunOverlay(
  run: RunOverlayInput,
  workflow: Pick<Workflow, "nodes" | "edges">,
  now: number = Date.now()
): RunOverlay {
  const nodes: Record<string, OverlayNodeState> = {};
  for (const node of workflow.nodes) {
    const block = run.blocks[node.id];
    if (block) nodes[node.id] = nodeState(block, now, node);
  }
  const taken = new Set(run.takenEdges);
  const dead = new Set(run.deadEdges);
  const edges: Record<string, OverlayEdgeState> = {};
  const loops: Record<string, LoopCounter> = {};
  for (const edge of workflow.edges) {
    const target = run.blocks[edge.target];
    const source = run.blocks[edge.source];
    let state: OverlayEdgeState = "idle";
    const counter = isLoopEdge(edge) ? loopCounterOf(edge, run) : null;
    if (counter) {
      loops[edge.id] = counter;
      // A loop edge: taken once the run went back along it; else closed when its source left by another handle.
      if (counter.used > 0 || taken.has(edge.id)) state = "taken";
      else if (dead.has(edge.id)) state = "dead";
      else if (source && FINISHED.has(source.status)) state = finishedHandle(source) === edge.sourceHandle ? "taken" : "dead";
      if (state === "taken" && target && LIVE.has(target.status) && (target.pass ?? 1) > 1) state = "active";
      edges[edge.id] = state;
      continue;
    }
    if (taken.has(edge.id)) state = "taken";
    else if (dead.has(edge.id) && !rerunning(source)) state = "dead";
    else if (source && FINISHED.has(source.status)) {
      const handle = finishedHandle(source);
      state = handle !== null && handle === edge.sourceHandle ? "taken" : "dead";
    }
    if (state === "taken" && target && LIVE.has(target.status)) state = "active";
    edges[edge.id] = state;
  }
  return { runStatus: run.status, nodes, edges, loops };
}

/** A loop is running the block again: its edges are open until this pass settles. */
function rerunning(block: WorkflowBlockRun | undefined): boolean {
  return block !== undefined && (block.pass ?? 1) > 1 && !FINISHED.has(block.status);
}
