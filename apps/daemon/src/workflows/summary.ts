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

/**
 * `errorCount` validates the whole workflow; the rail lists every workflow on each `GET` and on
 * every event, so the count is cached per definition object (a write replaces it) and per
 * validation context (a new secret or saved prompt can change it without an edit).
 */
const errorCounts = new WeakMap<Workflow, { key: string; count: number }>();

function validationKey(workflow: Workflow, options: ValidateWorkflowOptions): string {
  const list = (values: readonly string[] | undefined): string => (values === undefined ? "-" : [...values].sort().join("\u0000"));
  return [
    workflow.id,
    String(workflow.revision),
    workflow.updatedAt,
    list(options.secretNames),
    list(options.savedPromptIds),
    list(options.knownWorkflowIds),
    options.strictScheduleIntervals === true ? "strict" : "-"
  ].join("\u0001");
}

export function errorCountOf(workflow: Workflow, options: ValidateWorkflowOptions): number {
  const key = validationKey(workflow, options);
  const cached = errorCounts.get(workflow);
  if (cached && cached.key === key) return cached.count;
  const problems = validateWorkflow(workflow, options).problems;
  const count = hasWorkflowErrors(problems) ? problems.filter((problem) => problem.severity === "error").length : 0;
  errorCounts.set(workflow, { key, count });
  return count;
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
  const summary: WorkflowSummary = {
    id: workflow.id,
    name: workflow.name,
    enabled: workflow.enabled,
    revision: workflow.revision,
    project: workflow.project,
    triggers,
    nodeCount: workflow.nodes.length,
    errorCount: errorCountOf(workflow, deps.validation ?? {}),
    activeRuns: deps.runStore.activeForWorkflow(workflow.id),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt
  };
  if (workflow.description !== undefined) summary.description = workflow.description;
  const lastRun = deps.runStore.latestForWorkflow(workflow.id);
  if (lastRun !== undefined) summary.lastRun = lastRun;
  return summary;
}
