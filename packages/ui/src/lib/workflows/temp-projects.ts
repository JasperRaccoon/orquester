/**
 * Which projects are a workflow run's temporary project (workflows spec
 * §5.10: "the sidebar shows it with a small workflow marker").
 *
 * The workflows store is the evidence: every run it knows — a workflow row's
 * last and active runs, the recent-runs lists, the runs loaded whole —
 * names its `tempProject.path`. A project there (not yet deleted) is one.
 * The `wf-<slug>-<runId8>` name is only a fallback, and only when a run the
 * store knows confirms it (its id starts with those eight characters): a
 * user's own folder called `wf-…` is never marked on its name alone.
 *
 * Pure.
 */

import type { WorkflowRunSummary } from "@orquester/api";

import type { WorkflowsState } from "./store";

export interface WorkflowTempProjects {
  /** Paths (no trailing slash) of known, not deleted, temporary projects. */
  paths: ReadonlySet<string>;
  /** The first eight characters of every known run id (the name fallback's confirmation). */
  runIdPrefixes: ReadonlySet<string>;
}

const TEMP_NAME = /^wf-.+-([0-9a-z]{8})$/i;

const normalize = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

export function workflowTempProjects(state: Pick<WorkflowsState, "summaries" | "recentRuns" | "runs">): WorkflowTempProjects {
  const paths = new Set<string>();
  const runIdPrefixes = new Set<string>();
  const see = (run: WorkflowRunSummary | undefined): void => {
    if (!run || run.tempProject?.deleted) return;
    runIdPrefixes.add(run.id.slice(0, 8).toLowerCase());
    if (run.tempProject && !run.tempProject.deleted && run.tempProject.path) paths.add(normalize(run.tempProject.path));
  };
  for (const summary of state.summaries.values()) {
    see(summary.lastRun);
    for (const run of summary.activeRuns) see(run);
  }
  for (const list of Object.values(state.recentRuns)) for (const run of list.runs) see(run);
  for (const entry of Object.values(state.runs)) see(entry.summary);
  return { paths, runIdPrefixes };
}

export function isWorkflowTempProject(project: { path: string; name: string }, known: WorkflowTempProjects): boolean {
  if (known.paths.has(normalize(project.path))) return true;
  const match = TEMP_NAME.exec(project.name);
  return match !== null && known.runIdPrefixes.has(match[1]!.toLowerCase());
}

/** A project's name looks like a temporary project's (worth loading the workflows to confirm). */
export function looksLikeWorkflowTempProject(name: string): boolean {
  return TEMP_NAME.test(name);
}
