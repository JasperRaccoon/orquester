// Automated workflows — saved-prompt `{variables}` rendered daemon-side for agent blocks (spec §5.3):
// the shared resolver (`resolvePromptVariables`, @orquester/api) over a GitService-backed source,
// `{date}`/`{time}` in the WORKFLOW's time zone (the daemon's own zone is not the user's). A failed
// git read renders nothing: the block fails naming the variables, never a prompt missing them.

import { resolvePromptVariables, type GitStatusResponse, type GitWorkingDiffResponse } from "@orquester/api";

import type { PromptRenderer } from "./contracts.ts";

export interface PromptRendererDeps {
  git: {
    status(cwd: string): Promise<GitStatusResponse>;
    workingDiff(cwd: string, maxBytes: number): Promise<GitWorkingDiffResponse>;
  };
  savedPrompts: { get(id: string): { body: string; title: string } | undefined | null };
  now?: () => Date;
}

export function createPromptRenderer(deps: PromptRendererDeps): PromptRenderer {
  const now = deps.now ?? (() => new Date());
  return {
    async render(input) {
      const result = await resolvePromptVariables(input.body, {
        projectPath: input.projectPath,
        gitStatus: (path) => deps.git.status(path),
        gitWorkingDiff: (path, maxBytes) => deps.git.workingDiff(path, maxBytes),
        now,
        timeZone: input.timeZone,
        agentLabel: input.agentLabel ?? null,
        modelLabel: input.modelLabel ?? null
      });
      if (result.ok) return { ok: true, text: result.text };
      const names = result.variables.map((name) => `{${name}}`).join(", ");
      return { ok: false, reason: names.length > 0 ? `${result.reason} (needed by ${names})` : result.reason };
    },
    savedPromptBody(promptId) {
      const prompt = deps.savedPrompts.get(promptId);
      return prompt ? { body: prompt.body, title: prompt.title } : null;
    }
  };
}
