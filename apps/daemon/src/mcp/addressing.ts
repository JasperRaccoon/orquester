import { stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { boxToHostPath, hostToBoxPath } from "@orquester/api";
import { isValidName } from "@orquester/config";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import type { ToolCaller } from "./catalog/contract.ts";
import { ToolError } from "./errors.ts";
import { clipText, MAX_ECHO_CHARS } from "./result.ts";

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

/**
 * Where `target` lies relative to the caller's own project (null: the caller has none — every
 * target is "other"): the gate's target classes (§5.2). Pure, so catalog tools that must show
 * data as the gate would classify it use this one rule too.
 */
export function classifyTarget(own: CanonicalProject | null, target: { canonical: string; workspace: string }): "own" | "same-workspace" | "other-workspace" {
  if (own === null) return "other-workspace";
  if (target.canonical === own.canonical) return "own";
  return target.workspace === own.workspace ? "same-workspace" : "other-workspace";
}

/**
 * A path as the daemon COMPARES it: realpath inside the sandbox, else resolved. A comparison key
 * only — never a containment check (its fallback is lexical): use {@link realPathInSandbox}.
 */
export async function canonicalPath(api: { fsRoot: string }, path: string): Promise<string> {
  return (await assertInsideFsRoot(api.fsRoot, path).catch(() => null)) ?? resolve(path);
}

/**
 * A path's realpath when it lies inside the sandbox (`assertInsideFsRoot`: symlinks resolved, the
 * deepest existing ancestor checked), else null. THE containment check: unlike {@link canonicalPath}
 * it never falls back to the lexical path.
 */
export async function realPathInSandbox(api: { fsRoot: string }, path: string): Promise<string | null> {
  return assertInsideFsRoot(api.fsRoot, path).catch(() => null);
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
  // Containment: the project's REAL path must lie inside the sandbox — never the lexical fallback of
  // `canonicalPath`, which would take a project directory that is a symlink out of it for a project.
  const [canonical, root] = await Promise.all([realPathInSandbox(api, projectPath), canonicalWorkspacesDir(api)]);
  if (canonical === null) return null;
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
 * The host path a caller means by a path argument; a relative one is taken from `base` (an absolute
 * host path). A chat whose CLI runs in a Windows box (`boxPaths`) spells paths as the box does —
 * `C:\orq\…`, `build\out.zip`, either slash, any drive-letter case — and those are mapped back to
 * the host path; a POSIX absolute path stays a host path. One outside the box's view of the host
 * (another drive, `C:\Users\…`, a share) is refused, never re-read as something else. Without a
 * map: POSIX, as always (a backslash is a filename character, an absolute path is returned as
 * given). Containment stays the caller's check, after realpath.
 */
export function callerHostPath(caller: ToolCaller, path: string, base: string): string {
  const map = caller.kind === "thread" ? caller.boxPaths : undefined;
  if (map === undefined || map.kind === "identity" || path.startsWith("/")) return isAbsolute(path) ? path : resolve(base, path);
  const host = boxToHostPath(map, win32.resolve(hostToBoxPath(map, posix.resolve(base)), path));
  if (host === null) {
    throw new ToolError("PERMISSION_DENIED", `"${clipText(path, MAX_ECHO_CHARS)}" is outside ${map.prefix}, where this box sees the host's files: paths must lie inside a project.`);
  }
  return posix.normalize(host);
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
