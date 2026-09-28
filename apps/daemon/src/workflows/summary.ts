// Automated workflows — a workflow's rail row (`WorkflowSummary`, spec §7.1, §8.1).
//
// ONE derivation for every place a summary is built: the list route, the `workflow.upserted`
// event, and the engine's `summarize` (which delegates here, adding its live trigger state).

import { basename } from "node:path";
import {
  hasWorkflowErrors,
  isTriggerType,
  repoDisplayName,
  triggerSummaryText,
  validateWorkflow,
  type ValidateWorkflowOptions,
  type Workflow,
  type WorkflowSummary,
  type WorkflowTriggerSummary
} from "@orquester/api";
import type { RunStore } from "./contracts.ts";

export interface TriggerState {
  nextRunAt?: string | null;
  lastPollAt?: string | null;
  lastError?: string | null;
}

export interface WorkflowSummaryDeps {
  runStore: Pick<RunStore, "latestForWorkflow" | "activeForWorkflow">;
  /** The engine's live trigger state (schedule cursors, git poller), when it runs. */
  triggerState?: (workflowId: string, nodeId: string) => TriggerState | undefined;
  /** How a project-repo trigger names the project; derived from the definition when absent. */
  projectName?: string;
  /** Validation context (secret names, saved prompt ids, workflow ids) for `errorCount`. */
  validation?: ValidateWorkflowOptions;
  /** "Today" for the next-run text. */
  now?: Date;
}

/** The project a workflow's triggers name: an existing project's directory name, a temp clone's repo. */
export function workflowProjectName(workflow: Workflow): string | undefined {
  const project = workflow.project;
  if (project.kind === "existing") return basename(project.projectPath) || undefined;
  if (project.source.kind === "clone") return repoDisplayName(project.source.url);
  return undefined;
}

export function buildWorkflowSummary(workflow: Workflow, deps: WorkflowSummaryDeps): WorkflowSummary {
  const projectName = deps.projectName ?? workflowProjectName(workflow);
  const triggers: WorkflowTriggerSummary[] = [];
  for (const node of workflow.nodes) {
    if (!isTriggerType(node.type)) continue;
    const state = deps.triggerState?.(workflow.id, node.id);
    const trigger: WorkflowTriggerSummary = {
      nodeId: node.id,
      type: node.type,
      text: triggerSummaryText(node, {
        ...(projectName !== undefined ? { projectName } : {}),
        nextRunAt: state?.nextRunAt ?? null,
        timeZone: workflow.settings.timezone,
        ...(deps.now !== undefined ? { now: deps.now } : {})
      })
    };
    if (state?.nextRunAt !== undefined) trigger.nextRunAt = state.nextRunAt;
    if (state?.lastPollAt !== undefined) trigger.lastPollAt = state.lastPollAt;
    if (state?.lastError !== undefined) trigger.lastError = state.lastError;
    triggers.push(trigger);
  }
  const problems = validateWorkflow(workflow, deps.validation ?? {}).problems;
  const summary: WorkflowSummary = {
    id: workflow.id,
    name: workflow.name,
    enabled: workflow.enabled,
    revision: workflow.revision,
    project: workflow.project,
    triggers,
    nodeCount: workflow.nodes.length,
    errorCount: hasWorkflowErrors(problems) ? problems.filter((problem) => problem.severity === "error").length : 0,
    activeRuns: deps.runStore.activeForWorkflow(workflow.id),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt
  };
  if (workflow.description !== undefined) summary.description = workflow.description;
  const notify = workflow.settings?.notify;
  if (notify) summary.notify = { onFailure: notify.onFailure !== false, onSuccess: notify.onSuccess === true };
  const lastRun = deps.runStore.latestForWorkflow(workflow.id);
  if (lastRun !== undefined) summary.lastRun = lastRun;
  return summary;
}
