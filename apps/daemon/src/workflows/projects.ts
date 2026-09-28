// Automated workflows — the projects a run works in (spec §5.10). Existing projects resolve by the
// MCP's rule (`resolveProject`: `<workspacesDir>/<ws>/<project>`, realpath inside fsRoot, an existing
// directory). Temporary projects are made and removed through the daemon's OWN routes
// (`POST/DELETE /api/workspaces/:ws/projects…`, in-process over `DaemonApi`), so every gate a user
// meets applies — the workspace's git account for a clone, the non-empty-directory refusal, the
// tab cascade on delete.

import type { GitFileChange, GitStatusResponse, ProjectSummary } from "@orquester/api";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import { projectNamesFor, resolveProject } from "../mcp/addressing.ts";
import { daemonError } from "../mcp/errors.ts";
import type { ProjectContext, ProjectOps } from "./contracts.ts";

export interface ProjectOpsDeps {
  /** The daemon's own client (bound late: the unix app is built after the services). */
  api: DaemonApi | (() => DaemonApi | null);
  git: { status(cwd: string): Promise<GitStatusResponse>; currentBranch(cwd: string): Promise<string | null> };
  /** Getters in the daemon: `PUT /api/config/daemon` moves both in place. */
  workspacesDir: string | (() => string);
  fsRoot: string | (() => string);
}

const read = (value: string | (() => string)): string => (typeof value === "function" ? value() : value);

const STATUS_LETTER: Record<GitFileChange["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "?",
  conflicted: "U"
};

/** `git status --short`-style lines from the daemon's parsed status. */
export function shortStatusLines(status: GitStatusResponse): string[] {
  return status.files.map((file) => {
    const letter = STATUS_LETTER[file.status] ?? "M";
    const xy = file.status === "untracked" ? "??" : file.status === "conflicted" ? "UU" : `${file.staged ? letter : " "}${file.unstaged ? letter : " "}`;
    const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
    return `${xy} ${path}`;
  });
}

export function createProjectOps(deps: ProjectOpsDeps): ProjectOps {
  const api = (): DaemonApi => {
    const resolved = typeof deps.api === "function" ? deps.api() : deps.api;
    if (!resolved) throw new Error("The daemon API is not attached yet.");
    return resolved;
  };
  // Read at every use: the addressing rules follow a daemon config change.
  const addressing = {
    get fsRoot(): string {
      return read(deps.fsRoot);
    },
    get workspacesDir(): string {
      return read(deps.workspacesDir);
    }
  };

  return {
    async resolveExisting(projectPath: string): Promise<ProjectContext | null> {
      try {
        const ref = await resolveProject(addressing, projectPath);
        if (!ref.workspace || !ref.name) return null;
        return { path: ref.path, name: ref.name, workspace: ref.workspace, temp: false };
      } catch {
        return null;
      }
    },

    async createTemp(input): Promise<ProjectContext> {
      const body: Record<string, unknown> =
        input.source.kind === "clone"
          ? { source: "clone", name: input.name, url: input.source.url, ...(input.source.ref !== undefined ? { ref: input.source.ref } : {}) }
          : { source: "empty", name: input.name };
      const response = await api().request("POST", `/api/workspaces/${encodeURIComponent(input.workspace)}/projects`, { body });
      if (response.status >= 400) {
        const error = daemonError(response);
        throw new Error(`${error.code}: ${error.message}`);
      }
      const summary = response.body as ProjectSummary;
      if (!summary || typeof summary.path !== "string") throw new Error("The daemon did not say where the project was created.");
      return { path: summary.path, name: summary.name, workspace: summary.workspace, temp: true };
    },

    async deleteProject(path: string): Promise<void> {
      const names = projectNamesFor(path, read(deps.workspacesDir));
      if (!names.workspace || !names.name) throw new Error(`"${path}" is not a project.`);
      const response = await api().request(
        "DELETE",
        `/api/workspaces/${encodeURIComponent(names.workspace)}/projects/${encodeURIComponent(names.name)}`
      );
      // 404: already gone (or never made) — the goal is reached.
      if (response.status >= 400 && response.status !== 404) {
        const error = daemonError(response);
        throw new Error(`${error.code}: ${error.message}`);
      }
    },

    async gitStatusShort(path: string, maxBytes: number): Promise<string> {
      const status = await deps.git.status(path);
      if (!status.isRepo) return "(not a git repository)";
      const lines = shortStatusLines(status);
      if (lines.length === 0) return "(no changes)";
      let out = "";
      for (let index = 0; index < lines.length; index += 1) {
        const line = `${lines[index]}\n`;
        if (Buffer.byteLength(out + line, "utf8") > maxBytes - 40) {
          out += `… (${lines.length - index} more)\n`;
          break;
        }
        out += line;
      }
      return out.trimEnd();
    },

    async currentBranch(path: string): Promise<string | undefined> {
      return (await deps.git.currentBranch(path)) ?? undefined;
    }
  };
}
