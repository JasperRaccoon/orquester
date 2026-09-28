/**
 * Automated workflows — what "New workflow" and the empty state's starters
 * send to `POST /api/workflows`.
 *
 * The starter templates (spec §7.1) are named here; what each one builds is a
 * STUB for now — a blank workflow named after the template, with one manual
 * trigger — until `buildTemplate` lands in `@orquester/api` and
 * `createFromTemplate` builds the real graph from it.
 */

import type { CreateWorkflowRequest, WorkflowProject } from "@orquester/api";

export type WorkflowTemplateId = "nightly-agent-task" | "jira-ticket-fixer" | "release-tag-reviewer";

export interface WorkflowTemplateInfo {
  id: WorkflowTemplateId;
  title: string;
  /** One line under the title. */
  description: string;
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplateInfo[] = [
  {
    id: "nightly-agent-task",
    title: "Nightly agent task",
    description: "Run an agent on this project every night."
  },
  {
    id: "jira-ticket-fixer",
    title: "Jira ticket fixer",
    description: "Pick up a ticket, fix it with an agent, report back."
  },
  {
    id: "release-tag-reviewer",
    title: "Release-tag reviewer",
    description: "Review what changed whenever a new tag is pushed."
  }
];

/** A blank workflow: its name, its project, and one manual trigger the daemon names and places. */
export function blankWorkflowRequest(name: string, project: WorkflowProject): CreateWorkflowRequest {
  return {
    name: name.trim() || "Untitled workflow",
    project,
    nodes: [{ type: "trigger.manual", config: {} }],
    autoLayout: true
  };
}

/**
 * What a starter template creates. STUB: a blank workflow named after the
 * template; the real graphs come with `buildTemplate` (another builder's).
 */
export function createFromTemplate(id: WorkflowTemplateId, project: WorkflowProject): CreateWorkflowRequest {
  const template = WORKFLOW_TEMPLATES.find((entry) => entry.id === id);
  return blankWorkflowRequest(template?.title ?? "Untitled workflow", project);
}
