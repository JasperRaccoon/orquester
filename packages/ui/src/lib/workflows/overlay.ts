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
 * Pure: the caller passes `now` for a running block's elapsed time.
 */

import type { Workflow, WorkflowBlockRun, WorkflowBlockStatus, WorkflowRunStatus } from "@orquester/api";

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
}

export interface RunOverlay {
  runStatus: WorkflowRunStatus;
  nodes: Record<string, OverlayNodeState>;
  edges: Record<string, OverlayEdgeState>;
}

export interface RunOverlayInput {
  status: WorkflowRunStatus;
  blocks: Readonly<Record<string, WorkflowBlockRun>>;
  takenEdges: readonly string[];
  deadEdges: readonly string[];
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

function nodeState(block: WorkflowBlockRun, now: number): OverlayNodeState {
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
    if (block) nodes[node.id] = nodeState(block, now);
  }
  const taken = new Set(run.takenEdges);
  const dead = new Set(run.deadEdges);
  const edges: Record<string, OverlayEdgeState> = {};
  for (const edge of workflow.edges) {
    const target = run.blocks[edge.target];
    let state: OverlayEdgeState = "idle";
    if (taken.has(edge.id)) state = "taken";
    else if (dead.has(edge.id)) state = "dead";
    else {
      const source = run.blocks[edge.source];
      if (source && FINISHED.has(source.status)) {
        const handle = finishedHandle(source);
        state = handle !== null && handle === edge.sourceHandle ? "taken" : "dead";
      }
    }
    if (state === "taken" && target && LIVE.has(target.status)) state = "active";
    edges[edge.id] = state;
  }
  return { runStatus: run.status, nodes, edges };
}
