import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isValidName } from "@orquester/config";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./errors.ts";

export interface ProjectRef { workspace: string | null; name: string | null; path: string }

/** `<workspacesDir>/<ws>/<name>[/…]` → names; anything else → nulls (spec §5). */
export function projectNamesFor(projectPath: string, workspacesDir: string): ProjectRef {
  const rel = relative(workspacesDir, projectPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { workspace: null, name: null, path: projectPath };
  const [workspace, name] = rel.split(sep);
  if (!workspace || !name) return { workspace: null, name: null, path: projectPath };
  return { workspace, name, path: projectPath };
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/**
 * Resolve a `project` argument: an absolute path inside the sandbox, or
 * `"<workspace>/<project>"`. The canonical path is the plain joined path (names)
 * or `path.resolve(input)` (path) — the exact string the GUI uses.
 */
export async function resolveProject(api: { fsRoot: string; workspacesDir: string }, input: string): Promise<ProjectRef> {
  const raw = input.trim();
  if (!raw) throw new ToolError("PROJECT_NOT_FOUND", "project is required: an absolute path or \"<workspace>/<project>\".");
  let path: string;
  if (isAbsolute(raw)) {
    path = resolve(raw);
  } else {
    const parts = raw.split("/");
    if (parts.length !== 2 || !isValidName(parts[0]) || !isValidName(parts[1])) {
      throw new ToolError("PROJECT_NOT_FOUND", `"${raw}" is not a "<workspace>/<project>" name pair or an absolute path.`);
    }
    path = join(api.workspacesDir, parts[0], parts[1]);
  }
  try {
    await assertInsideFsRoot(api.fsRoot, path);
  } catch (error) {
    if (error instanceof FsSandboxError) throw new ToolError("PATH_NOT_ALLOWED", "Path is not allowed (outside the sandbox).");
    throw new ToolError("PROJECT_NOT_FOUND", `No project at "${raw}".`);
  }
  if (!(await isDirectory(path))) throw new ToolError("PROJECT_NOT_FOUND", `No project directory at "${raw}". Use list_projects.`);
  const names = projectNamesFor(path, api.workspacesDir);
  if (!names.workspace || !names.name) throw new ToolError("PROJECT_NOT_FOUND", `"${raw}" is a workspace, not a project. Use "<workspace>/<project>".`);
  // A project is exactly `<workspacesDir>/<ws>/<name>` (spec §5): a deeper directory would hand the
  // daemon a projectPath that no session carries.
  if (path !== join(api.workspacesDir, names.workspace, names.name)) {
    throw new ToolError("PROJECT_NOT_FOUND", `"${raw}" is inside project ${names.workspace}/${names.name}; pass the project itself.`);
  }
  return names;
}
