// Automated workflows — bounded loop edges: the run-state side (spec 2026-11-10 §7.2, §7.5).
//
// Pure functions over a run and its frozen definition; the engine calls them from a few hooks
// (engine.ts, search "Loops:"). Taking a loop edge is ONE synchronous mutation of the run — the
// counter, every reset block's new pass and its archived previous pass, the target's feedback —
// made before the engine saves and before it stops anything still running, so `run.json` never
// holds a source finished on a loop handle with its loop not taken (restart safety).
//
// Attempts: `block.attempt` counts within a pass (retry policy, `{{ run.attempt }}`); storage —
// attempt directories, output files, a Run workflow block's child-run id — uses
// `passAttemptBase + attempt` (`storageAttempt`), so pass 2 never re-binds pass 1's child run.

import {
  isLoopEdge,
  loopEdgeFrom,
  loopResetSet,
  type Workflow,
  type WorkflowBlockPass,
  type WorkflowEdge,
  type WorkflowEdgeLoop,
  type WorkflowNode
} from "@orquester/api";

import type { NodeLoopContext, PersistedBlockPass, PersistedBlockState, PersistedRun, WaitingOn } from "../contracts.ts";
import { isFinishedBlockStatus } from "../run-context.ts";

export type LoopEdge = WorkflowEdge & { loop: WorkflowEdgeLoop };

/** Feedback longer than this is cut (a gate comment has no limit of its own). */
const MAX_FEEDBACK_CHARS = 8_000;

const INTERRUPTED_MESSAGE = "A loop ran this block again before it finished.";

/** The storage key of an attempt of the block's current pass (see the header). */
export function storageAttempt(block: Pick<PersistedBlockState, "attempt" | "passAttemptBase">, attempt: number = block.attempt): number {
  return (block.passAttemptBase ?? 0) + attempt;
}

/** The loop edge a block that finished on `handle` takes, if that handle carries one. */
export function loopEdgeTaken(def: Pick<Workflow, "edges">, nodeId: string, handle: string | undefined): LoopEdge | undefined {
  if (handle === undefined || handle === "error") return undefined;
  return loopEdgeFrom(def, nodeId, handle) as LoopEdge | undefined;
}

/** How many times the loop edge was taken in this run. */
export function loopCount(run: Pick<PersistedRun, "loopCounters">, edgeId: string): number {
  const value = run.loopCounters?.[edgeId];
  return typeof value === "number" && value > 0 ? value : 0;
}

/** The edge's limit for this run: `maxLoops`, unless the run raised it (`loopLimits`). */
export function loopLimit(run: Pick<PersistedRun, "loopLimits">, edge: LoopEdge): number {
  const raised = run.loopLimits?.[edge.id];
  return typeof raised === "number" && raised > edge.loop.maxLoops ? raised : edge.loop.maxLoops;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clipFeedback(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_FEEDBACK_CHARS ? `${trimmed.slice(0, MAX_FEEDBACK_CHARS)}…` : trimmed;
}

/**
 * The feedback a loop edge carries into its target's next pass (§7.2): an agent's report `summary`
 * (the pass's `report`, else its output's `summary`), a gate decision's choice label and comment
 * (its output `{ choice, comment }`), nothing for If / Switch or any other block.
 */
export function loopFeedbackOf(source: WorkflowNode, block: Pick<PersistedBlockState, "report">, output: unknown): string | undefined {
  if (source.type === "agent") {
    const summary = block.report?.summary ?? (isRecord(output) ? output.summary : undefined);
    return typeof summary === "string" ? clipFeedback(summary) : undefined;
  }
  if (source.type === "gate") {
    if (!isRecord(output) || typeof output.choice !== "string") return undefined;
    const choices = isRecord(source.config) && Array.isArray(source.config.choices) ? (source.config.choices as unknown[]) : [];
    const declared = choices.find((choice) => isRecord(choice) && choice.id === output.choice) as Record<string, unknown> | undefined;
    const label = typeof declared?.label === "string" && declared.label.trim().length > 0 ? declared.label.trim() : output.choice;
    const comment = typeof output.comment === "string" ? output.comment.trim() : "";
    return clipFeedback(comment.length > 0 ? `${label}: ${comment}` : label);
  }
  return undefined;
}

/** A wait whose side effect outlives the engine — a stopped pass must still stop it (after a restart too). */
function needsCleanup(waitingOn: WaitingOn | undefined): waitingOn is WaitingOn {
  return waitingOn !== undefined && waitingOn.kind !== "timer" && waitingOn.kind !== "http";
}

/** Whether the block did anything in its current pass (pending, or queued before its first attempt, did not). */
function ranThisPass(block: PersistedBlockState): boolean {
  if (block.status === "pending") return false;
  return !(block.status === "queued" && block.startedAt === undefined);
}

/** The block's current pass as an archived record. */
function archive(block: PersistedBlockState, now: string): PersistedBlockPass {
  const { nodeId: _nodeId, name: _name, type: _type, passes: _passes, waitingOn, passAttemptBase: _base, loopEdgeId: _edge, ...rest } = block;
  const pass: PersistedBlockPass = { ...structuredClone(rest), pass: block.pass ?? 1 };
  if (!isFinishedBlockStatus(block.status)) {
    pass.status = "cancelled";
    pass.error = { kind: "interrupted", message: INTERRUPTED_MESSAGE };
    pass.endedAt = now;
    delete pass.activity;
    delete pass.waitingUntil;
    if (needsCleanup(waitingOn)) pass.interruptedFrom = structuredClone(waitingOn);
  }
  return pass;
}

export interface LoopReset {
  /** The reset set (target first, then the definition's order). */
  reset: string[];
  /** Blocks of the set still executing (the source excluded): the engine stops each. */
  interrupt: string[];
  /** Blocks whose archived pass had not finished: their latest output is gone. */
  unfinished: string[];
}

/**
 * Take a loop edge whose count is under its limit (§7.2): count it, give every block of its reset
 * set a new pass (archiving the one it had), reset the counters of loops nested inside the set,
 * and hand the target its feedback. Mutates `run`; the caller saves and then stops `interrupt`.
 */
export function applyLoopReset(input: {
  run: PersistedRun;
  def: Workflow;
  edge: LoopEdge;
  /** The block that took the edge (its execution is ending: never interrupted). */
  sourceId: string;
  /** Blocks executing now (the engine's in-flight set). */
  inFlight: ReadonlySet<string>;
  feedback?: string;
  now: string;
}): LoopReset {
  const { run, def, edge, now } = input;
  const counters = (run.loopCounters ??= {});
  counters[edge.id] = loopCount(run, edge.id) + 1;
  const set = loopResetSet(def, edge);
  // An outer loop gives the loops inside what it runs again a fresh budget.
  for (const other of def.edges) {
    if (other.id === edge.id || !isLoopEdge(other)) continue;
    if (set.has(other.source) && set.has(other.target)) delete counters[other.id];
  }
  const order = [edge.target, ...def.nodes.map((node) => node.id).filter((id) => id !== edge.target && set.has(id))];
  const result: LoopReset = { reset: [], interrupt: [], unfinished: [] };
  for (const id of order) {
    const block = run.blocks[id];
    if (!block) continue;
    result.reset.push(id);
    const executing = input.inFlight.has(id) && id !== input.sourceId;
    if (executing) result.interrupt.push(id);
    let next: PersistedBlockState;
    if (ranThisPass(block)) {
      const archived = archive(block, now);
      if (!isFinishedBlockStatus(block.status)) result.unfinished.push(id);
      next = {
        nodeId: block.nodeId,
        name: block.name,
        type: block.type,
        status: "pending",
        attempt: 0,
        pass: (block.pass ?? 1) + 1,
        passes: [...(block.passes ?? []), archived],
        passAttemptBase: storageAttempt(block)
      };
    } else {
      // It has not run in this pass: it keeps the pass, re-waiting for its inputs. A fresh object
      // all the same when it is executing (queued for a slot): the engine tells a stale execution
      // by its block object.
      next = executing ? { ...structuredClone(block), status: "pending" } : block;
      delete next.queuedAt;
    }
    next.loopEdgeId = edge.id;
    if (id === edge.target && input.feedback !== undefined) next.loopFeedback = input.feedback;
    else delete next.loopFeedback;
    run.blocks[id] = next;
  }
  return result;
}

/** The newest archived pass still waiting to be stopped, if any (a block has at most one). */
function interruptedPass(block: PersistedBlockState | undefined): PersistedBlockPass | undefined {
  const passes = block?.passes ?? [];
  for (let index = passes.length - 1; index >= 0; index -= 1) if (passes[index]!.interruptedFrom !== undefined) return passes[index];
  return undefined;
}

/** The pass a stale execution of `nodeId` left to settle: its `interruptedFrom` marker, cleared. */
export function settleInterruptedPass(block: PersistedBlockState | undefined): boolean {
  const pass = interruptedPass(block);
  if (!pass) return false;
  delete pass.interruptedFrom;
  return true;
}

/** Every block with a pass a loop stopped whose stopping a restart cut short: its wait to stop now. */
export function pendingInterruptions(run: PersistedRun): { nodeId: string; pass: PersistedBlockPass }[] {
  const out: { nodeId: string; pass: PersistedBlockPass }[] = [];
  for (const [nodeId, block] of Object.entries(run.blocks)) {
    const pass = interruptedPass(block);
    if (pass) out.push({ nodeId, pass });
  }
  return out;
}

/** The block's latest archived pass (what `nodes.<Name>` reads while the block waits for its next one). */
export function latestPass(block: PersistedBlockState): PersistedBlockPass | undefined {
  return block.passes?.at(-1);
}

/** An archived pass as it crosses the wire: no output file path, no interruption marker. */
export function publicPass(pass: PersistedBlockPass): WorkflowBlockPass {
  const { outputFile: _file, interruptedFrom: _interrupted, ...rest } = pass;
  return structuredClone(rest);
}

/** What the block's executor learns of the loop that ran it again (from pass 2 on). */
export function nodeLoopContext(run: PersistedRun, def: Workflow, block: PersistedBlockState): NodeLoopContext | undefined {
  const pass = block.pass ?? 1;
  if (pass < 2 || block.loopEdgeId === undefined) return undefined;
  const edge = def.edges.find((candidate) => candidate.id === block.loopEdgeId);
  if (!edge || !isLoopEdge(edge)) return undefined;
  const loop = edge as LoopEdge;
  const names = new Map(def.nodes.map((node) => [node.id, node.name]));
  const previous = latestPass(block);
  const context: NodeLoopContext = {
    pass,
    edgeId: loop.id,
    loopPass: Math.max(2, loopCount(run, loop.id) + 1),
    maxPasses: loopLimit(run, loop) + 1,
    session: loop.loop.session ?? "continue",
    target: loop.target === block.nodeId,
    sourceName: names.get(loop.source) ?? loop.source,
    targetName: names.get(loop.target) ?? loop.target
  };
  if (context.target && block.loopFeedback !== undefined) context.feedback = block.loopFeedback;
  if (previous) context.previous = publicPass(previous);
  return context;
}

/** A block's `loop` expression namespace: `{ pass }`, plus `feedback` on a target's later pass. */
export function loopNamespace(block: Pick<PersistedBlockState, "pass" | "loopFeedback"> | undefined): { pass: number; feedback?: string } {
  const namespace: { pass: number; feedback?: string } = { pass: block?.pass ?? 1 };
  if (block?.loopFeedback !== undefined) namespace.feedback = block.loopFeedback;
  return namespace;
}
