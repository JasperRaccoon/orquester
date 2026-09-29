/**
 * Automated workflows — what "New workflow" and the empty state's starters
 * send to `POST /api/workflows`.
 *
 * The starter templates (spec §7.1) are the owner's own examples, built by
 * `buildTemplate` in `@orquester/api` (the MCP's too), created DISABLED so
 * nothing runs before the user has read them, in the creating browser's time
 * zone. The ids here are the rail's; `API_TEMPLATE_ID` maps them.
 */

import { buildTemplate, type CreateWorkflowRequest, type WorkflowProject, type WorkflowTemplateId as ApiTemplateId } from "@orquester/api";
import type { ProviderSnapshot } from "@orquester/api/agent-chat";

import { withLiveChainModels } from "./chain-models";

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

const API_TEMPLATE_ID: Record<WorkflowTemplateId, ApiTemplateId> = {
  "nightly-agent-task": "nightly-agent",
  "jira-ticket-fixer": "jira-fixer",
  "release-tag-reviewer": "release-reviewer"
};

/** The zone this browser is in (a new workflow's schedules default to it). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * A blank workflow: its name, its project, one manual trigger the daemon names
 * and places, and this browser's time zone (a schedule added later reads in it).
 */
export function blankWorkflowRequest(
  name: string,
  project: WorkflowProject,
  timezone: string = browserTimeZone()
): CreateWorkflowRequest {
  return {
    name: name.trim() || "Untitled workflow",
    project,
    settings: { timezone },
    nodes: [{ type: "trigger.manual", config: {} }],
    autoLayout: true
  };
}

/**
 * What a starter template creates: the template's whole graph for an existing
 * project. A temporary project gets the same graph, re-pointed at it. Each
 * agent block's models are resolved against the live catalogue (`providers`,
 * this client's provider snapshots by default), so a template never names a
 * slug the host does not list (`withLiveChainModels`).
 */
export function createFromTemplate(
  id: WorkflowTemplateId,
  project: WorkflowProject,
  timezone: string = browserTimeZone(),
  providers?: readonly ProviderSnapshot[]
): CreateWorkflowRequest {
  const projectPath = project.kind === "existing" ? project.projectPath : "";
  const request = withLiveChainModels(buildTemplate(API_TEMPLATE_ID[id], { projectPath, timezone }), providers);
  return project.kind === "existing" ? request : { ...request, project };
}
