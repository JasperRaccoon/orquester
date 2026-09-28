/**
 * The New workflow form's draft and the project it resolves to — pure, so
 * the dialog and the tests agree on what a draft can create.
 */

import { WORKFLOW_LIMITS, type WorkflowProject } from "@orquester/api";
import { WORKFLOW_SECRET_NAME_PATTERN } from "@orquester/config";

export type NewWorkflowTarget = "this" | "other" | "temp";

export interface NewWorkflowDraft {
  name: string;
  target: NewWorkflowTarget;
  /** "Another project": its path. */
  otherPath: string;
  /** "Temporary project": the workspace NAME it is created in. */
  workspace: string;
  source: "empty" | "clone";
  cloneUrl: string;
  cloneRef: string;
}

export function initialNewWorkflowDraft(projectPath: string, name = ""): NewWorkflowDraft {
  return {
    name,
    target: projectPath.trim().length > 0 ? "this" : "other",
    otherPath: "",
    workspace: "",
    source: "empty",
    cloneUrl: "",
    cloneRef: ""
  };
}

export type NewWorkflowResolution =
  | { ok: true; name: string; project: WorkflowProject }
  | { ok: false; field: "name" | "project" | "workspace" | "cloneUrl"; message: string };

/** What a draft creates, or the first thing missing from it. */
export function resolveNewWorkflow(draft: NewWorkflowDraft, projectPath: string): NewWorkflowResolution {
  const name = draft.name.trim();
  if (name.length === 0) return { ok: false, field: "name", message: "Give the workflow a name." };
  if (name.length > WORKFLOW_LIMITS.maxNameLength) {
    return { ok: false, field: "name", message: `Keep the name under ${WORKFLOW_LIMITS.maxNameLength} characters.` };
  }
  switch (draft.target) {
    case "this": {
      const path = projectPath.trim();
      if (path.length === 0) return { ok: false, field: "project", message: "Open a project first, or pick one." };
      return { ok: true, name, project: { kind: "existing", projectPath: path } };
    }
    case "other": {
      const path = draft.otherPath.trim();
      if (path.length === 0) return { ok: false, field: "project", message: "Pick the project it runs in." };
      return { ok: true, name, project: { kind: "existing", projectPath: path } };
    }
    case "temp": {
      const workspace = draft.workspace.trim();
      if (workspace.length === 0) {
        return { ok: false, field: "workspace", message: "Pick the workspace its temporary projects go in." };
      }
      if (draft.source === "empty") {
        return { ok: true, name, project: { kind: "temp", workspace, source: { kind: "empty" } } };
      }
      const url = draft.cloneUrl.trim();
      if (url.length === 0) return { ok: false, field: "cloneUrl", message: "Give the repository to clone." };
      const ref = draft.cloneRef.trim();
      return {
        ok: true,
        name,
        project: { kind: "temp", workspace, source: ref ? { kind: "clone", url, ref } : { kind: "clone", url } }
      };
    }
  }
}

/** A secret's name: the daemon's own pattern (`[A-Z][A-Z0-9_]{0,63}`). */
export function isValidSecretName(name: string): boolean {
  return WORKFLOW_SECRET_NAME_PATTERN.test(name);
}

/** What a typed name becomes: upper case, spaces and dashes as underscores. */
export function normalizeSecretName(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "_");
}
