// Automated workflows — which repository a git trigger watches, and with which account (spec §6.2).
//
//   repo.kind "url"      → the URL as given, its `accountId` (none = a public repository).
//   repo.kind "project"  → an existing project: its `origin` URL (credentials stripped by
//                          `GitService.remoteUrl`) + its workspace's `gitAccountId`;
//                          a temp workflow: its clone URL + that workspace's account;
//                          a temp workflow that starts empty has no repository → null.

import { isAbsolute, relative, sep } from "node:path";
import type { GitRepoRef } from "@orquester/config";
import type { Workflow } from "@orquester/api";

export interface ResolvedRepo {
  url: string;
  accountId: string | null;
}

export type ResolveRepo = (workflow: Workflow, repo: GitRepoRef) => Promise<ResolvedRepo | null>;

export interface RepoResolverDeps {
  git: { remoteUrl(cwd: string): Promise<string | null> };
  /** The workspace's `workspaces.json` side-table entry (by workspace NAME), or null. */
  readWorkspaceMeta(workspace: string): Promise<{ gitAccountId?: string | null } | null | undefined>;
  /** `<appdir>/workspaces`. */
  workspacesDir: string;
}

/** `<workspacesDir>/<ws>/<project>` → `<ws>`; null for any other shape. */
export function workspaceOfProject(workspacesDir: string, projectPath: string): string | null {
  const rel = relative(workspacesDir, projectPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(sep).filter((part) => part.length > 0);
  return parts.length === 2 && parts.every((part) => part !== "." && part !== "..") ? parts[0]! : null;
}

export function createRepoResolver(deps: RepoResolverDeps): ResolveRepo {
  async function accountOf(workspace: string): Promise<string | null> {
    try {
      const meta = await deps.readWorkspaceMeta(workspace);
      return meta?.gitAccountId ?? null;
    } catch {
      return null;
    }
  }

  return async (workflow, repo) => {
    if (repo.kind === "url") {
      const url = repo.url.trim();
      return url ? { url, accountId: repo.accountId ?? null } : null;
    }
    const project = workflow.project;
    if (project.kind === "existing") {
      const workspace = workspaceOfProject(deps.workspacesDir, project.projectPath);
      if (workspace === null) return null;
      let url: string | null;
      try {
        url = await deps.git.remoteUrl(project.projectPath);
      } catch {
        url = null;
      }
      if (!url) return null;
      return { url, accountId: await accountOf(workspace) };
    }
    if (project.source.kind !== "clone") return null;
    const url = project.source.url.trim();
    return url ? { url, accountId: await accountOf(project.workspace) } : null;
  };
}
