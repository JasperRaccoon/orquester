/**
 * The hint a user turn gets when it refers to another chat ("in another session…", "that chat
 * said…"): Orquester can read it. Without it, agents treated a quote from another chat as all
 * there was — "I haven't seen the other session's output beyond the quote you gave me" — even
 * with `search_sessions` fully described in their tool list (tool-use eval
 * `other-chat-read-through-session-tools`: 0 of 18 samples on Sonnet 5.5 across three wordings
 * of the instruction block and the tool's description; 4 of 4 with this hint on the turn).
 *
 * Pure: an adapter attaches the hint through a channel that is not the user's text, so nothing is
 * stripped from history — Claude: a `UserPromptSubmit` hook's `additionalContext`; Codex: its own
 * `turn/start` `additionalContext` entry; OpenCode: the turn's `system`. Grok takes rules only when
 * a session starts, so it gets none.
 */

import { parseThreadMessage } from "@orquester/api/agent-chat";

export const SESSION_MENTION_HINT =
  "The user refers to another chat. Orquester can read it: find it with search_sessions (a phrase from it), then read its recent turns with read_transcript, since a quote or snippet leaves its context out.";

/** "another session", "the other chat", "that thread", "my previous conversation", "otra sesión"… */
const MENTION =
  /\b(?:an?other|the other|my other|that|previous|earlier|last|older)\s+(?:agent\s+)?(?:chat|session|thread|conversation)s?\b|\b(?:otr[oa]s?|la otra|el otro|esa|ese)\s+(?:sesi[oó]n|chat|conversaci[oó]n|hilo)(?:es|s)?\b/i;

/**
 * The hint for a user turn's text, or undefined when it names no other chat. A message from
 * another chat (`[Sent by …]`, `[Reply from …]`, … — `parseThreadMessage`) already names its
 * chat and session: no hint.
 */
export function sessionMentionHint(text: string): string | undefined {
  if (parseThreadMessage(text) !== null) return undefined;
  return MENTION.test(text) ? SESSION_MENTION_HINT : undefined;
}
