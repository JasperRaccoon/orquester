// Automated workflows — a workflow's rail row (`WorkflowSummary`, spec §7.1, §8.1).
//
// ONE derivation for every place a summary is built: the list route, the `workflow.upserted`
// event, and the engine's `summarize` (which delegates here, adding its live trigger state).

import { basename } from "node:path";
import {
  isTriggerType,
  repoDisplayName,
  triggerSummaryText,
  validateWorkflow,
  workflowAgentCatalogKey,
  workflowSummaryErrors,
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
  /** Validation context (secret names, saved prompt ids, workflow ids, agent catalogue) for the errors. */
  validation?: ValidateWorkflowOptions;
  /** "Today" for the next-run text. */
  now?: Date;
}

/**
 * The error fields validate the whole workflow; the rail lists every workflow on each `GET` and on
 * every event, so they are cached per definition object (a write replaces it) and per validation
 * context (a new secret, saved prompt or agent catalogue can change them without an edit).
 */
type SummaryErrors = Pick<WorkflowSummary, "errorCount" | "errors" | "errorsOmitted">;
const errorCache = new WeakMap<Workflow, { key: string; value: SummaryErrors }>();

function validationKey(workflow: Workflow, options: ValidateWorkflowOptions): string {
  const list = (values: readonly string[] | undefined): string => (values === undefined ? "-" : [...values].sort().join("\u0000"));
  return [
    workflow.id,
    String(workflow.revision),
    workflow.updatedAt,
    list(options.secretNames),
    list(options.savedPromptIds),
    list(options.knownWorkflowIds),
    options.strictScheduleIntervals === true ? "strict" : "-",
    workflowAgentCatalogKey(options.catalog)
  ].join("\u0001");
}

/** A workflow's errors as its rail row carries them: the count, the first few, how many are left out. */
export function summaryErrorsOf(workflow: Workflow, options: ValidateWorkflowOptions): SummaryErrors {
  const key = validationKey(workflow, options);
  const cached = errorCache.get(workflow);
  if (cached && cached.key === key) return cached.value;
  const value = workflowSummaryErrors(validateWorkflow(workflow, options).problems);
  errorCache.set(workflow, { key, value });
  return value;
}

/** The project a workflow's triggers name: an existing project's directory name, a temp clone's repo. */
function workflowProjectName(workflow: Workflow): string | undefined {
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
    errorCount: 0,
    activeRuns: deps.runStore.activeForWorkflow(workflow.id),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt
  };
  if (workflow.description !== undefined) summary.description = workflow.description;
  const errors = summaryErrorsOf(workflow, deps.validation ?? {});
  summary.errorCount = errors.errorCount;
  if (errors.errors !== undefined) summary.errors = errors.errors.map((problem) => ({ ...problem }));
  if (errors.errorsOmitted !== undefined) summary.errorsOmitted = errors.errorsOmitted;
  const notify = workflow.settings?.notify;
  if (notify) summary.notify = { onFailure: notify.onFailure !== false, onSuccess: notify.onSuccess === true };
  const lastRun = deps.runStore.latestForWorkflow(workflow.id);
  if (lastRun !== undefined) summary.lastRun = lastRun;
  return summary;
}
