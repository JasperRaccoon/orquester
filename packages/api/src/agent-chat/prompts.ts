/**
 * The user's own prompts in a thread — what the right rail's History lists
 * and lets the user reuse (Insert / Send). One rule for the host's
 * `GET …/prompts` and the client's fallback over the retained window.
 */

import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "./plan.ts";

/**
 * A `user` row the provider's own transcript wrote and nobody typed: the
 * Claude CLI records a slash command as `<command-name>…`, its output as
 * `<local-command-stdout>…`, a subagent's completion as `<task-notification>…`,
 * and a few notices as `<system-reminder>…` / `<local-command-caveat>…`. A
 * resumed history projects them as user messages.
 */
export const PROVIDER_INTERNAL_USER_PREFIXES = [
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<task-notification>",
  "<system-reminder>"
] as const;

/** Whether a `user` message's text is one of {@link PROVIDER_INTERNAL_USER_PREFIXES}' rows. */
export function isProviderInternalUserText(text: string): boolean {
  const start = text.trimStart();
  return PROVIDER_INTERNAL_USER_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/** The composer's `[Image #N]` placeholder, with one space before it. */
const IMAGE_PLACEHOLDER = /[ \t]?\[Image #\d+\]/g;

/**
 * A sent `user` message's text as a prompt the user can reuse, or `null` when
 * it is not one they typed: a provider-internal row, the verbatim `/compact`
 * (rendered as a compaction marker, never a bubble), the plan's Implement
 * prompt (the app composed it), or nothing but image placeholders.
 *
 * Reuse is text-only — an image does not come with it — so every `[Image #N]`
 * placeholder goes, with the space before it ("a [Image #1] b" → "a b").
 */
export function recallablePromptText(text: string): string | null {
  if (isProviderInternalUserText(text)) return null;
  const trimmed = text.trim();
  // Length first: a pasted log must not be lowercased whole to learn it is not "/compact".
  if (trimmed.length === "/compact".length && trimmed.toLowerCase() === "/compact") return null;
  if (trimmed.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX.trimEnd())) return null;
  const withoutImages = trimmed.replace(IMAGE_PLACEHOLDER, "").trim();
  return withoutImages.length > 0 ? withoutImages : null;
}
