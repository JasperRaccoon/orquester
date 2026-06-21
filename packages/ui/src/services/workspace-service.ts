import type { CreateProjectRequest, ProjectSummary, WorkspaceSummary } from "@orquester/api";
import type { ApiClient } from "../lib/api-client";

/**
 * Domain service for the filesystem-backed workspace/project tree.
 * `(workspacesDir)/<workspace>/<project>`. Thin over {@link ApiClient};
 * the place to add caching/validation later.
 */
export const workspaceService = {
  list(api: ApiClient, signal?: AbortSignal): Promise<WorkspaceSummary[]> {
    return api.listWorkspaces(signal);
  },

  create(api: ApiClient, name: string, gitAccountId?: string): Promise<WorkspaceSummary> {
    return api.createWorkspace({ name, gitAccountId });
  },

  delete(api: ApiClient, name: string): Promise<void> {
    return api.deleteWorkspace(name);
  },

  listProjects(api: ApiClient, workspace: string, signal?: AbortSignal): Promise<ProjectSummary[]> {
    return api.listProjects(workspace, signal);
  },

  createProject(
    api: ApiClient,
    workspace: string,
    req: CreateProjectRequest
  ): Promise<ProjectSummary> {
    return api.createProject(workspace, req);
  },

  deleteProject(api: ApiClient, workspace: string, name: string): Promise<void> {
    return api.deleteProject(workspace, name);
  }
};
