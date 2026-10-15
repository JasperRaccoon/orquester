// Catalog family module `git` (get_git_state) — plan Task 9 (unified MCP design 2026-10-15 §4 row 21, §4.1, D-18):
// read-only views over the daemon's git routes, capped like get_turn_diff. No git write tools.
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { GitBranchesResponse, GitDiffResponse, GitLogEntry, GitStatusResponse, GitWorkingDiffResponse } from "@orquester/api";
import { resolveProject, type ProjectRef } from "../addressing.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ScopeContext } from "../catalog/contract.ts";
import { expectOk, ToolError } from "../errors.ts";
import { clipText, fitJsonBytes, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes } from "../result.ts";

/** Rows a list view keeps before it says `truncated` (each a short record). */
export const MAX_GIT_FILES = 300;
export const MAX_GIT_BRANCHES = 200;
export const MAX_GIT_UNTRACKED = 200;
/** A commit body's most characters in `log`. */
export const MAX_COMMIT_BODY_CHARS = 1_000;
export const DEFAULT_GIT_LOG = 20;
export const MAX_GIT_LOG = 100;

const VIEWS = ["status", "branches", "log", "diff"] as const;

/** The project a call reads: the named one, else the chat caller's own; an external caller must name one. */
async function gitProject(project: string | undefined, ctx: Pick<ScopeContext, "api" | "caller">): Promise<ProjectRef> {
  if (project !== undefined) return resolveProject(ctx.api, project);
  if (ctx.caller.kind === "thread" && ctx.caller.projectPath) return resolveProject(ctx.api, `${ctx.caller.workspace}/${basename(ctx.caller.projectPath)}`);
  throw new ToolError(ctx.caller.kind === "thread" ? "PROJECT_NOT_FOUND" : "INVALID_ARGUMENT", ctx.caller.kind === "thread" ? "This chat has no project: pass project (list_projects)." : "project is required: an absolute path or \"<workspace>/<project>\".");
}

/** `path` inside the project, as the repo-relative path the diff route takes; refused outside it. */
function fileInProject(projectPath: string, path: string): { absolute: string; relative: string } {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(projectPath, path);
  const rel = relative(projectPath, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError("INVALID_ARGUMENT", `path "${clipText(path, MAX_ECHO_CHARS)}" is not a file inside the project.`);
  }
  return { absolute, relative: rel.split(sep).join("/") };
}

/** The first `max` rows and, when some were left out, how many. */
function capped<T>(rows: readonly T[], max: number, key: string): Record<string, unknown> {
  return rows.length > max ? { [key]: rows.slice(0, max), [`${key}Truncated`]: true, [`omitted${key[0]!.toUpperCase()}${key.slice(1)}`]: rows.length - max } : { [key]: [...rows] };
}

/** A diff text cut to what the rest of the result leaves of one result (as get_turn_diff fits its diff). */
function withDiff(frame: Record<string, unknown>, diff: string, cutAlready: boolean): Record<string, unknown> {
  const fitted = fitJsonBytes(diff, MAX_RESULT_BYTES - resultBytes({ ...frame, diff: "", truncated: true }));
  return { ...frame, diff: fitted.text, truncated: cutAlready || fitted.truncated };
}

const getGitState = defineTool({
  name: "get_git_state",
  title: "Get git state",
  description: "A project's git state, read only. status: branch, upstream, ahead/behind, changed files. branches. log: newest commits. diff: uncommitted changes vs HEAD plus untracked files, or one file's (`path`, `staged`). Cut to fit (truncated flags).",
  chatNote: "`project` defaults to this chat's.",
  input: {
    project: z.string().min(1).optional().describe("Path or workspace/project."),
    view: z.enum(VIEWS),
    path: z.string().min(1).max(4096).optional().describe("diff: one file in the project."),
    staged: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_GIT_LOG).default(DEFAULT_GIT_LOG).describe("log: commits.")
  },
  audiences: ["external", "chat"],
  toolset: "files-git",
  tier: "read",
  async scope(args, ctx) {
    const project = await gitProject(args.project, ctx);
    const file = args.path !== undefined ? fileInProject(project.path, args.path) : null;
    return { projects: [project.path], sessions: [], reads: "content", writes: false, causesTurnIn: [], ...(file ? { paths: [file.absolute] } : {}) };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const project = await gitProject(args.project, ctx);
    const where = { path: project.path };
    if (args.path !== undefined && args.view !== "diff") throw new ToolError("INVALID_ARGUMENT", "path applies to view \"diff\" only.");
    const label = `${project.workspace}/${project.name}`;
    switch (args.view) {
      case "status": {
        const status = expectOk<GitStatusResponse>(await api.request("GET", "/api/git/status", { query: where }));
        const { files, ...rest } = status;
        return { project: label, ...rest, ...capped(files, MAX_GIT_FILES, "files") };
      }
      case "branches": {
        const branches = expectOk<GitBranchesResponse>(await api.request("GET", "/api/git/branches", { query: where }));
        return { project: label, current: branches.current, ...capped(branches.local, MAX_GIT_BRANCHES, "local"), ...capped(branches.remote, MAX_GIT_BRANCHES, "remote") };
      }
      case "log": {
        const log = expectOk<GitLogEntry[]>(await api.request("GET", "/api/git/log", { query: { ...where, limit: String(args.limit) } }));
        const commits = log.slice(0, args.limit).map((c) => ({ ...c, body: clipText(c.body, MAX_COMMIT_BODY_CHARS) }));
        // Oldest commits go first when the page would not fit one result.
        let kept = commits.length;
        while (kept > 0 && resultBytes({ project: label, commits: commits.slice(0, kept), truncated: true }) > MAX_RESULT_BYTES) kept -= 1;
        return { project: label, commits: commits.slice(0, kept), ...(kept < commits.length ? { truncated: true } : {}) };
      }
      case "diff": {
        if (args.path !== undefined) {
          const file = fileInProject(project.path, args.path);
          const res = expectOk<GitDiffResponse>(await api.request("GET", "/api/git/diff", { query: { ...where, file: file.relative, staged: String(args.staged) } }));
          return withDiff({ project: label, file: file.relative, staged: args.staged, binary: res.binary }, res.diff, false);
        }
        const res = expectOk<GitWorkingDiffResponse>(await api.request("GET", "/api/git/working-diff", { query: { ...where, maxBytes: String(MAX_RESULT_BYTES) } }));
        const frame = { project: label, isRepo: res.isRepo, ...capped(res.untracked, MAX_GIT_UNTRACKED, "untracked") };
        return withDiff(frame, res.diff, res.truncated);
      }
    }
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const gitFamily: readonly AnyOrquesterTool[] = [getGitState];
