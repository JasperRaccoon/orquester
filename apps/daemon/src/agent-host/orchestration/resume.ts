/**
 * Agent host — the §6.1 create-time resume (spec §4.1 "resumeCursor", §6.1).
 *
 * `resumeCursor` is `unknown` by contract and each adapter owns its shape, but
 * a thread created from the resume picker has only a conversation id. §4.1
 * pins the four shapes, so the host builds the minimal cursor for the adapter
 * and refuses — 400 `RESUME_UNAVAILABLE` — rather than opening a fresh thread
 * the user believes is their old one.
 *
 * The id is shape-checked with the same rule the terminal launch path uses
 * (`resumeLaunchArgs` in `apps/daemon/src/sessions.ts`): the leading character
 * excludes `-`, so an id can never arrive as a flag, and no `..` segment can
 * survive.
 */

import type { AgentAdapterId } from "@orquester/api/agent-chat";

const RESUME_ID_PATTERN = /^[\w.][\w.\-/]*$/;

export function isUsableConversationId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return false;
  }
  if (!RESUME_ID_PATTERN.test(value)) {
    return false;
  }
  return !value.split("/").includes("..");
}

/**
 * The minimal cursor for each adapter, exactly as §4.1 documents it. Adapters
 * must accept this partial form: Claude's full cursor additionally carries
 * `resumeSessionAt`, `turnCount` and `turnStartMessageIds`, all of which are
 * refreshed by the adapter itself on the first turn.
 */
export function resumeCursorFor(
  adapter: AgentAdapterId,
  threadId: string,
  conversationId: string
): unknown {
  switch (adapter) {
    case "codex":
      return { threadId: conversationId };
    case "opencode":
    case "grok":
      return { schemaVersion: 1, sessionId: conversationId };
    case "claude":
      return { threadId, resume: conversationId };
    default: {
      const never: never = adapter;
      return never;
    }
  }
}
