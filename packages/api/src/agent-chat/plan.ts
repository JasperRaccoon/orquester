/**
 * The proposed-plan follow-up contract shared by the UI (Implement button), the
 * host (`hasActionableProposedPlan`) and the MCP (`implement_plan`). One
 * spelling of the prefix, so no surface can drift.
 */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

/** The turn the client sends when the user clicks Implement. */
export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
}

/** True for a user message that implements a plan (retires the latest proposed plan). */
export function isPlanImplementationMessage(text: string): boolean {
  return text.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX);
}
