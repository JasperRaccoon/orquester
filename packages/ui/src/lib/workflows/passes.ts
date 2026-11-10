/**
 * A block's passes in a run (spec 2026-11-10 §7.2, §7.4): a loop runs a
 * block again as a new pass; the run keeps every earlier one (status,
 * output, error, report, sessions, decision) in `passes`, and the block's own
 * fields are always the latest pass. Here, as pure functions: the passes in
 * order, one pass as a block record the details pane can draw, the chips
 * (#1, #2, …) that pick one, and which pass a selection shows.
 */

import type { WorkflowBlockPass, WorkflowBlockRun } from "@orquester/api";

import { blockElapsedMs, blockStatusView, finishedHandleText, type StatusView } from "./run-view";

/** The latest pass's number: `pass`, else one more than the earlier passes kept. */
export function latestPassOf(block: Pick<WorkflowBlockRun, "pass" | "passes"> | undefined): number {
  if (!block) return 1;
  const kept = (block.passes ?? []).reduce((highest, pass) => Math.max(highest, pass.pass), 0);
  return Math.max(block.pass ?? 1, kept + 1);
}

/** How many passes the block has had (1 when no loop ran it again). */
export function passCountOf(block: Pick<WorkflowBlockRun, "pass" | "passes"> | undefined): number {
  return latestPassOf(block);
}

/** One earlier pass as a block record (the block's identity, the pass's state); no `passes` of its own. */
function asBlock(block: WorkflowBlockRun, pass: WorkflowBlockPass): WorkflowBlockRun {
  return { ...pass, nodeId: block.nodeId, name: block.name, type: block.type };
}

/**
 * The block as it was on `pass` — the latest pass (the block itself) for
 * null, the latest number, or a pass the run did not keep.
 */
export function blockAtPass(block: WorkflowBlockRun | undefined, pass: number | null): WorkflowBlockRun | undefined {
  if (!block || pass === null || pass === latestPassOf(block)) return block;
  const kept = block.passes?.find((candidate) => candidate.pass === pass);
  return kept ? asBlock(block, kept) : block;
}

/** The pass a selection shows: an earlier pass the run kept, else the latest. */
export function shownPass(block: WorkflowBlockRun | undefined, selected: number | null): number {
  const latest = latestPassOf(block);
  if (selected === null || !block) return latest;
  return selected === latest || block.passes?.some((pass) => pass.pass === selected) ? selected : latest;
}

export interface PassChip {
  pass: number;
  /** "#2". */
  label: string;
  /** The pass the block is on now. */
  latest: boolean;
  view: StatusView;
  /** For a tooltip and screen readers: "Pass 1 · Succeeded · changes requested · 4m". */
  description: string;
  durationMs: number | null;
}

/** One chip per pass, oldest first; [] when the block ran once. */
export function passChips(
  block: WorkflowBlockRun | undefined,
  node: Parameters<typeof finishedHandleText>[0],
  now: number
): PassChip[] {
  if (!block) return [];
  const latest = latestPassOf(block);
  if (latest <= 1) return [];
  const records = new Map<number, WorkflowBlockRun>();
  for (const pass of block.passes ?? []) records.set(pass.pass, asBlock(block, pass));
  records.set(latest, block);
  return [...records.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pass, record]) => {
      const view = blockStatusView(record.status);
      const durationMs = blockElapsedMs(record, now);
      const finished = record.status === "succeeded" || record.status === "failed" ? finishedHandleText(node, record.handle) : null;
      const bits = [`Pass ${pass}`, view.label, ...(finished ? [finished] : [])];
      return { pass, label: `#${pass}`, latest: pass === latest, view, description: bits.join(" · "), durationMs };
    });
}

/** What the details pane says about a pass: the loop's feedback it started with, and why it is in a new chat. */
export interface PassNotes {
  feedback: string | null;
  sessionNote: string | null;
}

export function passNotes(block: Pick<WorkflowBlockRun, "loopFeedback" | "sessionNote"> | undefined): PassNotes {
  const feedback = block?.loopFeedback?.trim() ? block.loopFeedback.trim() : null;
  const sessionNote = block?.sessionNote?.trim() ? block.sessionNote.trim() : null;
  return { feedback, sessionNote };
}
