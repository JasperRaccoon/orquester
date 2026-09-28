/**
 * Saved-prompt `{variable}` values, gathered at use time — shared by the right rail (the client
 * renders a saved prompt at Insert / Send) and by workflow agent blocks (the daemon renders the
 * prompt when the block runs, spec §5.3).
 *
 * Only what the body uses is computed: a prompt without `{diff}` never asks for a patch, and one
 * with no git variable never touches git; the two git reads it may need run in parallel and stop
 * with the caller's signal. Which names exist and how a body renders is `saved-prompts.ts`'s
 * (`promptVariablesUsed`, `renderPromptTemplate`).
 *
 * Pure apart from the source it is handed: the caller supplies git, the clock (and the zone the
 * clock is read in — the workflow's on the daemon, the browser's own on the client) and the labels,
 * so every value and every fallback is testable with a fake.
 */

import type { GitStatusResponse, GitWorkingDiffResponse } from "./index.ts";
import { promptVariablesUsed, renderPromptTemplate, type PromptVariableName } from "./saved-prompts.ts";

/** `GIT_WORKING_DIFF_DEFAULT_MAX_BYTES` (index.ts) — restated so this module does not import the root at load. */
export const PROMPT_DIFF_MAX_BYTES = 64 * 1024;

export const NO_GIT_REPOSITORY = "(no git repository)";
export const NO_UNCOMMITTED_CHANGES = "(no uncommitted changes)";
export const DETACHED_HEAD = "(detached HEAD)";
/** A repo whose status names no branch and is not detached — a daemon edge case. */
export const NO_BRANCH = "(no branch)";
/** `{changedFiles}` lists at most this many files, then says how many more. */
export const CHANGED_FILES_MAX_LINES = 500;
/** What an aborted resolve answers; the caller that aborted it does not show it. */
export const RESOLVE_CANCELLED = "Cancelled.";

/** Where the values come from. */
export interface PromptVariableSource {
  /** The project's directory; "" when none (git variables then read as no repository). */
  projectPath: string;
  gitStatus(path: string, signal?: AbortSignal): Promise<GitStatusResponse>;
  gitWorkingDiff(path: string, maxBytes: number, signal?: AbortSignal): Promise<GitWorkingDiffResponse>;
  /** The clock `{date}` / `{time}` read. */
  now(): Date;
  /** IANA zone `{date}` / `{time}` are written in; the runtime's local zone when absent. */
  timeZone?: string;
  /** `{project}`: a display name, else the directory's own name. */
  projectName?: string | null;
  /** `{workspace}`: a display name, else the parent directory's name. */
  workspaceName?: string | null;
  /** `{agent}`; "" when absent. */
  agentLabel?: string | null;
  /** `{model}`; "" when absent. */
  modelLabel?: string | null;
  signal?: AbortSignal;
}

export type PromptVariablesResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: string;
      /** Which read failed ("cancelled": the signal aborted). */
      failure: "git-status" | "git-diff" | "cancelled";
      /** The variables that needed the failed read. */
      variables: PromptVariableName[];
    };

/**
 * Render `body`: compute exactly the variables it uses, then `renderPromptTemplate`. A failed git
 * read resolves nothing — `{ok: false}` with the reason — so no half-rendered prompt goes out.
 */
export async function resolvePromptVariables(body: string, source: PromptVariableSource): Promise<PromptVariablesResult> {
  const used = promptVariablesUsed(body);
  const projectPath = normalizePromptProjectPath(source.projectPath);
  const needsStatus = used.includes("branch") || used.includes("changedFiles");
  const needsDiff = used.includes("diff");
  const cancelled = (): PromptVariablesResult => ({ ok: false, reason: RESOLVE_CANCELLED, failure: "cancelled", variables: [] });

  let status: GitStatusResponse | null = null;
  let diff: GitWorkingDiffResponse | null = null;
  if (projectPath.length > 0 && (needsStatus || needsDiff)) {
    // Both reads settle before either failure is reported, so the reason can name the one that
    // failed (the status one first, when both did).
    const [statusRead, diffRead] = await Promise.all([
      needsStatus ? settle(source.gitStatus(projectPath, source.signal)) : null,
      needsDiff ? settle(source.gitWorkingDiff(projectPath, PROMPT_DIFF_MAX_BYTES, source.signal)) : null
    ]);
    if (source.signal?.aborted) return cancelled();
    if (statusRead !== null && !statusRead.ok) {
      return {
        ok: false,
        reason: `Couldn't read git status: ${promptVariableErrorText(statusRead.error)}`,
        failure: "git-status",
        variables: used.filter((name) => name === "branch" || name === "changedFiles")
      };
    }
    if (diffRead !== null && !diffRead.ok) {
      return {
        ok: false,
        reason: `Couldn't read the git diff: ${promptVariableErrorText(diffRead.error)}`,
        failure: "git-diff",
        variables: ["diff"]
      };
    }
    status = statusRead?.value ?? null;
    diff = diffRead?.value ?? null;
  }
  if (source.signal?.aborted) return cancelled();

  const names = projectNamesFromPath(projectPath);
  const values: Partial<Record<PromptVariableName, string>> = {};
  let now: Date | null = null;
  const clock = (): Date => (now ??= source.now());
  for (const name of used) {
    switch (name) {
      case "project":
        values.project = source.projectName || names.project;
        break;
      case "workspace":
        values.workspace = source.workspaceName || names.workspace;
        break;
      case "projectPath":
        values.projectPath = projectPath;
        break;
      case "branch":
        values.branch = branchText(status);
        break;
      case "changedFiles":
        values.changedFiles = changedFilesText(status);
        break;
      case "diff":
        values.diff = diffText(diff);
        break;
      case "date":
        values.date = formatPromptDate(clock(), source.timeZone);
        break;
      case "time":
        values.time = formatPromptTime(clock(), source.timeZone);
        break;
      case "agent":
        values.agent = source.agentLabel ?? "";
        break;
      case "model":
        values.model = source.modelLabel ?? "";
        break;
      default: {
        // A variable added to the list must be given a value here.
        const unhandled: never = name;
        void unhandled;
      }
    }
  }
  return { ok: true, text: renderPromptTemplate(body, values) };
}

type Settled<T> = { ok: true; value: T; error?: undefined } | { ok: false; value?: undefined; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

/**
 * The words a failed read is shown with: the server's own message when it sent one (an
 * `ApiError`'s `serverMessage` — git's stderr), else the error's message. Duck-typed.
 */
function promptVariableErrorText(error: unknown, fallback = "Something went wrong."): string {
  if (typeof error === "object" && error !== null) {
    const server = (error as { serverMessage?: unknown }).serverMessage;
    if (typeof server === "string" && server.trim().length > 0) return server.trim();
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return fallback;
}

// ---------------------------------------------------------------------------
// The values
// ---------------------------------------------------------------------------

/** A project path without trailing separators (a bare root stays itself). */
function normalizePromptProjectPath(path: string): string {
  const stripped = path.replace(/[\\/]+$/, "");
  return stripped.length > 0 || path.length === 0 ? stripped : path.charAt(0);
}

/** The directory's name and its parent's: `/w/ws/app` → `{project: "app", workspace: "ws"}`. */
export function projectNamesFromPath(projectPath: string): { project: string; workspace: string } {
  const segments = normalizePromptProjectPath(projectPath)
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0);
  return {
    project: segments[segments.length - 1] ?? "",
    workspace: segments[segments.length - 2] ?? ""
  };
}

/** `{branch}`: the branch, "(detached HEAD)", or "(no git repository)". `null` = no project to read. */
export function branchText(status: GitStatusResponse | null): string {
  if (status === null || !status.isRepo) return NO_GIT_REPOSITORY;
  if (status.detached) return DETACHED_HEAD;
  return typeof status.branch === "string" && status.branch.length > 0 ? status.branch : NO_BRANCH;
}

/** `{changedFiles}`: `"<status> <path>"` per file (`"<status> <old> -> <new>"` for a rename or copy). */
export function changedFilesText(status: GitStatusResponse | null): string {
  if (status === null || !status.isRepo) return NO_GIT_REPOSITORY;
  const files = Array.isArray(status.files) ? status.files : [];
  if (files.length === 0) return NO_UNCOMMITTED_CHANGES;
  const lines = files
    .slice(0, CHANGED_FILES_MAX_LINES)
    .map((file) => (file.oldPath ? `${file.status} ${file.oldPath} -> ${file.path}` : `${file.status} ${file.path}`));
  if (files.length > CHANGED_FILES_MAX_LINES) {
    lines.push(`… ${files.length - CHANGED_FILES_MAX_LINES} more files`);
  }
  return lines.join("\n");
}

/** "64 KB" for the cap the diff was read with. */
export function formatDiffCap(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * `{diff}`: the patch; then, when the daemon cut it, a line saying so; then the untracked files,
 * which a patch against HEAD cannot show.
 */
export function diffText(diff: GitWorkingDiffResponse | null): string {
  if (diff === null || !diff.isRepo) return NO_GIT_REPOSITORY;
  const patch = typeof diff.diff === "string" ? diff.diff.replace(/\n+$/, "") : "";
  const untracked = Array.isArray(diff.untracked)
    ? diff.untracked.filter((path) => typeof path === "string" && path.length > 0)
    : [];
  if (patch.length === 0 && untracked.length === 0) return NO_UNCOMMITTED_CHANGES;
  const head: string[] = [];
  if (patch.length > 0) head.push(patch);
  if (diff.truncated) head.push(`… diff truncated at ${formatDiffCap(PROMPT_DIFF_MAX_BYTES)}`);
  const blocks: string[] = [];
  if (head.length > 0) blocks.push(head.join("\n"));
  if (untracked.length > 0) blocks.push(`Untracked files:\n${untracked.map((path) => `- ${path}`).join("\n")}`);
  return blocks.join("\n\n");
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Calendar fields of `now` in `timeZone` (null: the zone is unknown to this runtime). */
function zonedFields(now: Date, timeZone: string): { year: string; month: string; day: string; hour: string; minute: string } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now);
  } catch {
    return null;
  }
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** `{date}`: `YYYY-MM-DD` in `timeZone`, else in the runtime's local zone. */
export function formatPromptDate(now: Date, timeZone?: string): string {
  const zoned = timeZone ? zonedFields(now, timeZone) : null;
  if (zoned) return `${zoned.year}-${zoned.month}-${zoned.day}`;
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** `{time}`: `HH:MM` (24 h) in `timeZone`, else in the runtime's local zone. */
export function formatPromptTime(now: Date, timeZone?: string): string {
  const zoned = timeZone ? zonedFields(now, timeZone) : null;
  if (zoned) return `${zoned.hour}:${zoned.minute}`;
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}
