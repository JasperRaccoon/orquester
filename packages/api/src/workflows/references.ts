// Automated workflows — what a definition references: THE rules for "a workflow runs another as a
// sub-workflow" and "a workflow uses a saved prompt". One source for the daemon's reference index
// (`apps/daemon/src/workflows/reference-index.ts`), the MCP's previews and the saved-prompt rows.

import type { WorkflowNode, WorkflowProject } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What one definition names: its project, its blocks' overrides, its sub-workflows. */
export interface WorkflowMembers {
  /** Existing project paths, as stored (absolute). */
  projects: string[];
  /** A temporary project's workspace (one per run, not created yet). */
  pendingWorkspaces: string[];
  /** Workflow ids `workflow` blocks run. */
  childIds: string[];
}

export function membersOf(workflow: { project?: WorkflowProject; nodes?: readonly WorkflowNode[] }): WorkflowMembers {
  const members: WorkflowMembers = { projects: [], pendingWorkspaces: [], childIds: [] };
  const project = workflow.project;
  if (project?.kind === "existing") members.projects.push(project.projectPath);
  else if (project?.kind === "temp") members.pendingWorkspaces.push(project.workspace);
  for (const node of workflow.nodes ?? []) {
    if (typeof node.projectOverride === "string" && node.projectOverride !== "") members.projects.push(node.projectOverride);
    if (node.type === "workflow" && isRecord(node.config) && typeof node.config.workflowId === "string" && node.config.workflowId !== "") {
      members.childIds.push(node.config.workflowId);
    }
  }
  return members;
}

/**
 * THE rule for "a workflow references a saved prompt" (one source for the tools and the saved-prompt
 * list rows' `usedByWorkflows`): an agent block — a disabled one too, it is still part of the
 * definition — whose prompt is `{kind: "saved", promptId}`. The id, or null for any other block.
 */
export function savedPromptIdOfNode(node: { type: string; config?: unknown }): string | null {
  if (node.type !== "agent" || !isRecord(node.config) || !isRecord(node.config.prompt)) return null;
  const prompt = node.config.prompt;
  return prompt.kind === "saved" && typeof prompt.promptId === "string" ? prompt.promptId : null;
}

/** Every saved-prompt id the definition's agent blocks reference, in block order, each once. */
export function savedPromptIdsOf(workflow: { nodes?: readonly { type: string; config?: unknown }[] }): string[] {
  const ids: string[] = [];
  for (const node of workflow.nodes ?? []) {
    const id = savedPromptIdOfNode(node);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
