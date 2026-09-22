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

import type { AgentAdapterId, AttachmentRef } from "@orquester/api/agent-chat";

import { GROK_BLOCKED_COMMAND_MESSAGE, isBlockedGrokCommand } from "../adapters/grok/index.ts";
import { appendAttachmentLines } from "./attachment-lines.ts";

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
 * The host's whole send-path text policy: the input unchanged, followed by the
 * `Attached file: <name> (<absolute path>)` lines of every attachment the
 * adapter does not ingest natively (§4.1) — AFTER the text, never before and
 * never wrapping it, so a turn that opens with `/command` still opens with it.
 * It is a function rather than an omission so a future prompt-injecting
 * feature has to delete this comment to break §4.6.9.
 */
export function providerInputFor(text: string, attachmentLines = ""): string {
  return appendAttachmentLines(text, attachmentLines);
}

/**
 * The refusal message for a provider command the host blocks, or null.
 *
 * §4.6.5(c)/§4.6.6: Grok's `/always-approve` is the only one — a provider-side
 * permission change would desynchronise the host's runtime mode, and on that
 * CLI it is additionally a no-op.
 *
 * The refusal belongs HERE, on `decide("turn")`, not only in the adapter: by
 * the time `sendTurn` throws, the user message is already committed and the
 * user sees their own `/always-approve` bubble followed by a failure, with no
 * way to take it back (R2 #7). The adapter keeps its own check as the backstop
 * for anything that reaches it another way.
 *
 * Keyed on the adapter so the rule stays where a reader looks for it, rather
 * than the orchestrator growing a provider branch.
 */
export function blockedProviderCommandMessage(
  adapterId: AgentAdapterId,
  text: string
): string | null {
  if (adapterId === "grok" && isBlockedGrokCommand(text)) {
    return GROK_BLOCKED_COMMAND_MESSAGE;
  }
  return null;
}
