/**
 * Saved prompts — the `{variable}` values, gathered at use time (Insert, Send).
 *
 * Only what the body uses is computed: a prompt without `{diff}` never asks the
 * daemon for a patch, and one with no git variable never touches git; the two
 * git reads it may need run in parallel and stop with the caller's signal.
 * Which names exist and how a body renders is `@orquester/api`'s
 * (`promptVariablesUsed`, `renderPromptTemplate`) — an unknown `{name}`, and a
 * `{{name}}` escape, are its business, not this module's.
 *
 * Pure apart from the API it is handed: the caller reads the labels (project,
 * workspace, the chat's agent and model) off the stores, so every value and
 * every fallback is testable with a fake.
 */

import {
  GIT_WORKING_DIFF_DEFAULT_MAX_BYTES,
  promptVariablesUsed,
  renderPromptTemplate,
  type GitStatusResponse,
  type GitWorkingDiffResponse,
  type PromptVariableName
} from "@orquester/api";
import type { ProviderModel } from "@orquester/api/agent-chat";

import { modelDisplayName } from "../launch-models";
import { savedPromptErrorText } from "./errors";
import { normalizeProjectPath } from "./list.logic";

/** The git routes a prompt may read — `ApiClient` satisfies it; tests pass a fake. */
export interface SavedPromptGitApi {
  gitStatus(path: string, signal?: AbortSignal): Promise<GitStatusResponse>;
  gitWorkingDiff(path: string, maxBytes?: number, signal?: AbortSignal): Promise<GitWorkingDiffResponse>;
}

export const NO_GIT_REPOSITORY = "(no git repository)";
export const NO_UNCOMMITTED_CHANGES = "(no uncommitted changes)";
export const DETACHED_HEAD = "(detached HEAD)";
/** A repo whose status names no branch and is not detached — a daemon edge case. */
export const NO_BRANCH = "(no branch)";
/** `{changedFiles}` lists at most this many files, then says how many more. */
export const CHANGED_FILES_MAX_LINES = 500;
/** What an aborted resolve answers; the caller that aborted it does not show it. */
export const RESOLVE_CANCELLED = "Cancelled.";

export interface ResolveSavedPromptInput {
  body: string;
  /** The open project's directory; "" when none (git variables then read as no repository). */
  projectPath: string;
  /** The chat Insert/Send targets; with none, `{agent}` and `{model}` render as "". */
  sessionId: string | null;
  api: SavedPromptGitApi;
  /** `{project}`: the store's name for the project, else the directory's own name. */
  projectName?: string | null;
  /** `{workspace}`: the store's name for the workspace, else the parent directory's name. */
  workspaceName?: string | null;
  /** `{agent}`: the chat's agent display name. */
  agentLabel?: string | null;
  /** `{model}`: the chat's model display name. */
  modelLabel?: string | null;
  /** The clock `{date}` / `{time}` read; now by default. */
  now?: Date;
  signal?: AbortSignal;
}

export type ResolveSavedPromptResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Render `body` for the chat: compute exactly the variables it uses, then
 * `renderPromptTemplate`. A failed git read resolves nothing — `{ok: false}`
 * with the reason — so no half-rendered prompt reaches the chat.
 */
export async function resolveSavedPrompt(
  input: ResolveSavedPromptInput
): Promise<ResolveSavedPromptResult> {
  const used = promptVariablesUsed(input.body);
  const projectPath = normalizeProjectPath(input.projectPath);
  const needsStatus = used.includes("branch") || used.includes("changedFiles");
  const needsDiff = used.includes("diff");

  let status: GitStatusResponse | null = null;
  let diff: GitWorkingDiffResponse | null = null;
  if (projectPath.length > 0 && (needsStatus || needsDiff)) {
    // Both reads settle before either failure is reported, so the reason can
    // name the one that failed (the status one first, when both did).
    const [statusRead, diffRead] = await Promise.all([
      needsStatus ? settle(input.api.gitStatus(projectPath, input.signal)) : null,
      needsDiff
        ? settle(input.api.gitWorkingDiff(projectPath, GIT_WORKING_DIFF_DEFAULT_MAX_BYTES, input.signal))
        : null
    ]);
    if (input.signal?.aborted) return { ok: false, reason: RESOLVE_CANCELLED };
    if (statusRead !== null && !statusRead.ok) {
      return { ok: false, reason: `Couldn't read git status: ${savedPromptErrorText(statusRead.error)}` };
    }
    if (diffRead !== null && !diffRead.ok) {
      return { ok: false, reason: `Couldn't read the git diff: ${savedPromptErrorText(diffRead.error)}` };
    }
    status = statusRead?.value ?? null;
    diff = diffRead?.value ?? null;
  }
  if (input.signal?.aborted) return { ok: false, reason: RESOLVE_CANCELLED };

  const names = projectNamesFromPath(projectPath);
  const now = input.now ?? new Date();
  const values: Partial<Record<PromptVariableName, string>> = {};
  for (const name of used) {
    switch (name) {
      case "project":
        values.project = input.projectName || names.project;
        break;
      case "workspace":
        values.workspace = input.workspaceName || names.workspace;
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
        values.date = localDate(now);
        break;
      case "time":
        values.time = localTime(now);
        break;
      case "agent":
        values.agent = input.sessionId === null ? "" : (input.agentLabel ?? "");
        break;
      case "model":
        values.model = input.sessionId === null ? "" : (input.modelLabel ?? "");
        break;
      default: {
        // A variable added to the API must be given a value here.
        const unhandled: never = name;
        void unhandled;
      }
    }
  }
  return { ok: true, text: renderPromptTemplate(input.body, values) };
}

type Settled<T> = { ok: true; value: T; error?: undefined } | { ok: false; value?: undefined; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

// ---------------------------------------------------------------------------
// The values
// ---------------------------------------------------------------------------

/** The directory's name and its parent's: `/w/ws/app` → `{project: "app", workspace: "ws"}`. */
export function projectNamesFromPath(projectPath: string): { project: string; workspace: string } {
  const segments = normalizeProjectPath(projectPath)
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
    .map((file) =>
      file.oldPath ? `${file.status} ${file.oldPath} -> ${file.path}` : `${file.status} ${file.path}`
    );
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
 * `{diff}`: the patch; then, when the daemon cut it, a line saying so; then
 * the untracked files, which a patch against HEAD cannot show.
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
  if (diff.truncated) {
    head.push(`… diff truncated at ${formatDiffCap(GIT_WORKING_DIFF_DEFAULT_MAX_BYTES)}`);
  }
  const blocks: string[] = [];
  if (head.length > 0) blocks.push(head.join("\n"));
  if (untracked.length > 0) {
    blocks.push(`Untracked files:\n${untracked.map((path) => `- ${path}`).join("\n")}`);
  }
  return blocks.join("\n\n");
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `{date}`: the local date, `YYYY-MM-DD`. */
export function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** `{time}`: the local time, `HH:MM` (24 h). */
export function localTime(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** `{agent}`: the registry entry's display name, else the id itself. */
export function agentLabelFor(
  refId: string,
  agents: readonly { id: string; name: string }[]
): string {
  const name = agents.find((agent) => agent.id === refId)?.name;
  return name && name.length > 0 ? name : refId;
}

/** `{model}`: the catalogue's name for the slug (as the composer's chip reads it), else the raw slug. */
export function modelLabelFor(
  models: readonly ProviderModel[] | undefined,
  slug: string | null | undefined
): string {
  if (!slug) return "";
  const model = models?.find((candidate) => candidate.slug === slug);
  return model ? modelDisplayName(model) : slug;
}
