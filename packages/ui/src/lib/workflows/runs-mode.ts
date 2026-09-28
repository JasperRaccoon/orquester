/**
 * The editor tab's Runs mode, as decisions (workflows spec §7.3, §7.4): which
 * run it shows when none was asked for, which block of it is selected, and
 * where a phone starts. Pure; `components/workflows/RunsMode.tsx` composes the
 * run components around them.
 */

import { isRunActive, type WorkflowRunSummary } from "@orquester/api";

import { defaultSelectedStep, type TimelineItem } from "./run-view";

/**
 * The run to show: the one asked for (it may be older than the loaded page),
 * else the newest live one, else the newest. `null` when there is none.
 */
export function pickRunId(
  requested: string | null | undefined,
  runs: readonly Pick<WorkflowRunSummary, "id" | "status">[]
): string | null {
  if (requested) return requested;
  const live = runs.find((run) => isRunActive(run.status));
  return live?.id ?? runs[0]?.id ?? null;
}

/**
 * The block to show in the details: the one picked, while the run still has
 * it as a step; else the run's own default — its failed block, its live one,
 * the last one that ran (`defaultSelectedStep`).
 */
export function pickBlockId(items: readonly TimelineItem[], picked: string | null | undefined): string | null {
  if (picked && items.some((item) => item.kind === "step" && item.nodeId === picked)) return picked;
  return defaultSelectedStep(items);
}

/** A phone's run view: its step timeline (the default), or the run drawn on the canvas. */
export type PhoneRunPane = "timeline" | "canvas";

/**
 * Whether a newly listed run should take over the view: a run the user just
 * started (Run now, a retry) is selected by its caller; a run a trigger
 * started never steals the view from a run the user is reading — only from
 * nothing, or from the newest run when that was shown by default.
 */
export function followsNewRun(input: {
  /** The run the user picked, if any (else the view shows the default). */
  picked: string | null;
  newestBefore: string | null;
  newestNow: string | null;
}): boolean {
  if (input.newestNow === null || input.newestNow === input.newestBefore) return false;
  return input.picked === null;
}
