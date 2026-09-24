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
 * Two commands are host-native:
 *
 * - **`/compact`, on every adapter.** The rule is deliberately narrow — role
 *   `user`, **no attachments**, and the trimmed lowercased text is exactly
 *   `/compact`.
 * - **`/goal …`, on an adapter whose `capabilities.goals.command` is `"host"`**
 *   (Codex, whose app-server takes goals as `thread/goal/*` requests and would
 *   otherwise read `/goal clear` as a prompt — T3 #13252; goals §5.1). It is
 *   parsed by {@link parseHostGoalCommand}, never forwarded, and a malformed
 *   one is refused before anything is committed. On every other adapter
 *   `/goal …` is an ordinary command, and its CLI parses it.
 *
 * Everything else is forwarded as the turn text, as typed: the host does not
 * validate the name against the catalog and does not rewrite it. The CLI
 * decides — with one refusal, Grok's `/always-approve`
 * ({@link blockedProviderCommandMessage}).
 */

import type { AgentAdapterId, AttachmentRef } from "@orquester/api/agent-chat";

import type { HostGoalCommand } from "../adapter.ts";
import { GROK_BLOCKED_COMMAND_MESSAGE, isBlockedGrokCommand } from "../adapters/grok/index.ts";

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
 * The longest goal objective, in characters (goals §5.1). Codex's own bound
 * (`MAX_THREAD_GOAL_OBJECTIVE_CHARS`), counted the way Codex counts it —
 * `chars().count()`, i.e. code points, not UTF-16 units — so the host never
 * refuses an objective the provider would take, nor forwards one it refuses.
 */
export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

const GOAL_COMMAND_PATTERN = /^\/goal(?:\s|$)/i;
const GOAL_EDIT_PATTERN = /^edit(?:\s+([\s\S]*))?$/i;
const GOAL_OBJECTIVE_TOO_LONG_MESSAGE = `A goal is limited to ${MAX_GOAL_OBJECTIVE_CHARS} characters.`;

/** 1–{@link MAX_GOAL_OBJECTIVE_CHARS} code points; the caller has already trimmed it. */
function objectiveFits(objective: string): boolean {
  // Code points never outnumber UTF-16 units, so almost every objective is
  // decided without walking it; the input itself is capped at 120 000 units.
  return (
    objective.length <= MAX_GOAL_OBJECTIVE_CHARS ||
    Array.from(objective).length <= MAX_GOAL_OBJECTIVE_CHARS
  );
}

/**
 * A host-parsed `/goal …` (goals §5.1): the command, `{error}` for a goal
 * command the host refuses, or `null` for text that is not a goal command at
 * all. Only ever consulted for an adapter whose goals are the host's
 * (`capabilities.goals.command === "host"`).
 *
 * Codex's TUI grammar, `/goal [<objective>|clear|edit|pause|resume]`: the
 * trimmed text must be `/goal` followed by whitespace or nothing (so `/goals`
 * is not one); the rest, trimmed, is the argument. `""` or `status` asks for
 * the status; `pause`, `resume` and `clear` match the WHOLE argument,
 * case-insensitively (`/goal pause the deploy` is an objective); `edit
 * <objective>` rewrites the objective; anything else sets a goal. An
 * objective is 1–{@link MAX_GOAL_OBJECTIVE_CHARS} characters after trimming.
 *
 * The errors are refused on `decide("turn")`, before anything is committed —
 * the same rule as {@link blockedProviderCommandMessage} (R2 #7): a refusal
 * after the user's bubble is on disk cannot be taken back.
 */
export function parseHostGoalCommand(
  text: string,
  attachments: readonly AttachmentRef[] = []
): HostGoalCommand | { error: string } | null {
  const trimmed = text.trim();
  if (!GOAL_COMMAND_PATTERN.test(trimmed)) {
    return null;
  }
  // A goal is a line of text the provider stores, not a prompt: there is
  // nowhere for a file to go.
  if (attachments.length > 0) {
    return { error: "A goal can't include attachments." };
  }
  const args = trimmed.slice("/goal".length).trim();
  const subcommand = args.toLowerCase();
  if (subcommand === "" || subcommand === "status") {
    return { kind: "status" };
  }
  if (subcommand === "pause" || subcommand === "resume" || subcommand === "clear") {
    return { kind: subcommand };
  }
  const edit = GOAL_EDIT_PATTERN.exec(args);
  if (edit !== null) {
    const objective = (edit[1] ?? "").trim();
    if (objective.length === 0) {
      return { error: "Usage: /goal edit <objective>" };
    }
    return objectiveFits(objective)
      ? { kind: "edit", objective }
      : { error: GOAL_OBJECTIVE_TOO_LONG_MESSAGE };
  }
  return objectiveFits(args)
    ? { kind: "set", objective: args }
    : { error: GOAL_OBJECTIVE_TOO_LONG_MESSAGE };
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
