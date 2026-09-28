/**
 * Saved prompts — the `{variable}` values, gathered at use time (Insert, Send).
 *
 * A thin adapter over `@orquester/api`'s `resolvePromptVariables` (the resolver moved there so
 * workflow agent blocks render prompts daemon-side with the very same rules, spec §5.3): this module
 * binds it to the `ApiClient`'s git routes, the browser's clock and zone, and the target chat's
 * labels. Only what the body uses is computed; which names exist and how a body renders is
 * `@orquester/api`'s (`promptVariablesUsed`, `renderPromptTemplate`).
 */

import {
  resolvePromptVariables,
  type GitStatusResponse,
  type GitWorkingDiffResponse
} from "@orquester/api";
import type { ProviderModel } from "@orquester/api/agent-chat";

import { modelDisplayName } from "../launch-models";

export { projectNamesFromPath } from "@orquester/api";

/** The git routes a prompt may read — `ApiClient` satisfies it; tests pass a fake. */
export interface SavedPromptGitApi {
  gitStatus(path: string, signal?: AbortSignal): Promise<GitStatusResponse>;
  gitWorkingDiff(path: string, maxBytes?: number, signal?: AbortSignal): Promise<GitWorkingDiffResponse>;
}

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
  const now = input.now ?? new Date();
  const result = await resolvePromptVariables(input.body, {
    projectPath: input.projectPath,
    gitStatus: (path, signal) => input.api.gitStatus(path, signal),
    gitWorkingDiff: (path, maxBytes, signal) => input.api.gitWorkingDiff(path, maxBytes, signal),
    // The browser's own clock and zone.
    now: () => now,
    projectName: input.projectName,
    workspaceName: input.workspaceName,
    agentLabel: input.sessionId === null ? "" : (input.agentLabel ?? ""),
    modelLabel: input.sessionId === null ? "" : (input.modelLabel ?? ""),
    signal: input.signal
  });
  return result.ok ? { ok: true, text: result.text } : { ok: false, reason: result.reason };
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
