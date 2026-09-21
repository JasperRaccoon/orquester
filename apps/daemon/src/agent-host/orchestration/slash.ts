/**
 * Agent host — host-native slash commands (spec §4.6.5(b), §4.6.9).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:95-98`
 * (the exact `/compact` predicate) and
 * `packages/shared/src/model.ts:412-431` (`applyClaudePromptEffortPrefix`'s
 * guard, with the comment "Prefixing a slash command turns it into plain
 * prose, so Claude never runs it").
 *
 * Exactly one command is host-native: `/compact`. The rule is deliberately
 * narrow — role `user`, **no attachments**, and the trimmed lowercased text is
 * exactly `/compact`. Everything else is forwarded as the turn text, as typed:
 * the host does not validate the name against the catalog, does not rewrite it
 * and does not block it. The CLI decides.
 */

import type { AttachmentRef } from "@orquester/api/agent-chat";

/** The literal a compaction turn is persisted as (§4.6.5(b)). */
export const COMPACT_COMMAND_TEXT = "/compact";

/**
 * `/compact` and nothing else. A `/turn` matching this and the `/compact`
 * command of §6.2 land on exactly the same host path, refusal and queueing
 * rules included.
 */
export function isHostNativeCompact(input: {
  text: string;
  attachments?: readonly AttachmentRef[];
}): boolean {
  if (input.attachments !== undefined && input.attachments.length > 0) {
    return false;
  }
  return input.text.trim().toLowerCase() === COMPACT_COMMAND_TEXT;
}

/**
 * A turn whose text starts with `/` is a command invocation for every CLI in
 * the matrix, and that single fact is what makes forwarding work at all
 * (§4.6.9). Orquester never prefixes, indents or wraps such a turn — this
 * predicate exists so the rule is assertable rather than merely observed.
 */
export function isSlashInvocation(text: string): boolean {
  return /^\/[^\s/]+(?:\s|$)/u.test(text);
}

/**
 * The host's whole send-path text policy: return the input unchanged. It is a
 * function rather than an omission so a future prompt-injecting feature has to
 * delete this comment to break §4.6.9.
 */
export function providerInputFor(text: string): string {
  return text;
}
