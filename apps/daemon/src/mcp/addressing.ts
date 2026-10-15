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

/** Why a directory projectNamesFor names nothing in is not a project: it is the root, one workspace, or outside the root. */
function notAProject(raw: string, rel: string): string {
  if (!rel) return `"${raw}" is the workspaces root, not a project.`;
  if (rel.startsWith("..") || isAbsolute(rel)) return `"${raw}" is not inside a workspace.`;
  return `"${raw}" is a workspace, not a project.`;
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
  if (!names.workspace || !names.name) throw new ToolError("PROJECT_NOT_FOUND", `${notAProject(raw, relative(api.workspacesDir, path))} Pass "<workspace>/<project>" (list_projects names them).`);
  // A project is exactly `<workspacesDir>/<ws>/<name>` (spec §5): a deeper directory would hand the
  // daemon a projectPath that no session carries.
  if (path !== join(api.workspacesDir, names.workspace, names.name)) {
    throw new ToolError("PROJECT_NOT_FOUND", `"${raw}" is inside project ${names.workspace}/${names.name}; pass the project itself.`);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Canonical projects, workspaces and path classification (unified MCP design 2026-10-15 §5.1)
// ---------------------------------------------------------------------------

/** A project as the gate compares it. */
export interface CanonicalProject {
  /** Realpath inside the sandbox, else `path.resolve` — the form two spellings of one project share. */
  canonical: string;
  /** `<workspace>` and `<project>` under the (canonical) workspaces root. */
  workspace: string;
  name: string;
}

/** A path as the daemon compares it: realpath inside the sandbox, else resolved. */
export async function canonicalPath(api: { fsRoot: string }, path: string): Promise<string> {
  return (await assertInsideFsRoot(api.fsRoot, path).catch(() => null)) ?? resolve(path);
}

/** The workspaces root, canonical (it may itself be reached through a symlink). */
async function canonicalWorkspacesDir(api: { fsRoot: string; workspacesDir: string }): Promise<string> {
  return canonicalPath(api, api.workspacesDir);
}

/**
 * The project `projectPath` is, canonical, or null when it is not exactly
 * `<workspacesDir>/<ws>/<project>` (the root, a workspace, anything deeper or outside) or no
 * longer exists as a directory (a removed project or workspace is `PROJECT_NOT_FOUND`, §13).
 */
export async function canonicalProject(api: { fsRoot: string; workspacesDir: string }, projectPath: string): Promise<CanonicalProject | null> {
  if (!projectPath) return null;
  const [canonical, root] = await Promise.all([canonicalPath(api, projectPath), canonicalWorkspacesDir(api)]);
  const rel = relative(root, canonical);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts.length !== 2 || !isValidName(parts[0]) || !isValidName(parts[1])) return null;
  if (!(await isDirectory(canonical))) return null;
  return { canonical: join(root, parts[0], parts[1]), workspace: parts[0], name: parts[1] };
}

/** The workspace a project path lies in ("" when it is no project). */
export async function workspaceOfProject(api: { fsRoot: string; workspacesDir: string }, projectPath: string): Promise<string> {
  return (await canonicalProject(api, projectPath))?.workspace ?? "";
}

/**
 * Where a filesystem path a chat caller passes lies (ruling S6): inside a project directory
 * (`<workspacesDir>/<ws>/<project>[/…]`, the project directory itself included) → that project;
 * anything else — outside the sandbox, the workspaces root, a workspace directory itself, a file
 * directly in the root or in a workspace (`<ws>/notes.txt` is no project), a project directory that
 * does not exist — is `outside`, which the gate refuses (never "unclassified"). A relative path is
 * taken from `cwd`. Symlinks are resolved first, so a link inside a project that points elsewhere
 * classifies by its target.
 */
export type PathClass = { kind: "project"; project: CanonicalProject; path: string } | { kind: "outside"; path: string };

export async function classifyPath(api: { fsRoot: string; workspacesDir: string }, rawPath: string, cwd: string): Promise<PathClass> {
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd || "/", rawPath);
  let real: string;
  try {
    real = await assertInsideFsRoot(api.fsRoot, resolved);
  } catch {
    return { kind: "outside", path: resolved };
  }
  const root = await canonicalWorkspacesDir(api);
  const rel = relative(root, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { kind: "outside", path: real };
  const [workspace, name] = rel.split(sep);
  if (!isValidName(workspace) || !isValidName(name)) return { kind: "outside", path: real };
  // A project is a DIRECTORY: a file beside the projects (`<ws>/notes.txt`) is no project.
  const project = join(root, workspace, name);
  if (!(await isDirectory(project))) return { kind: "outside", path: real };
  return { kind: "project", project: { canonical: project, workspace, name }, path: real };
}
