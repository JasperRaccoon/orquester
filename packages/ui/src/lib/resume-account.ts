import type { AgentConversationSummary } from "@orquester/api";

/**
 * Which managed account a resume must launch under.
 *
 * A conversation only exists inside the HOME the agent wrote it in, so resuming
 * it under an identity that cannot see the transcript hands the CLI an id it
 * has never seen:
 *
 * - `account` → a home whose history dir did NOT alias the system home, so only
 *   that managed account can see the transcript: force it.
 * - `system` → the transcript lives in the system history dir — which every
 *   managed account home ALSO sees, because the daemon symlinks each account's
 *   `projects`/`sessions` back to it by construction (AccountsService
 *   ensureSharedDirSymlink). Any identity works, so honor the caller's
 *   selection/preference; with none, OMIT the id so the daemon applies the
 *   per-agent default — exactly what a fresh launch from the "+" menu gets.
 *   Never pin the host sentinel here: the system home being where the
 *   transcript LIVES says nothing about it being logged in. Grok's system
 *   home is routinely signed out while a managed account works, and pinning
 *   System made every Grok resume fail its `session/load` with
 *   "Authentication required" (the tab read "System" and stayed empty). With
 *   no managed accounts at all an omitted id still resolves to System.
 * - a daemon predating the field → unknowable here, so fall back to whatever
 *   the caller would have launched a fresh session with.
 */
export function resumeAccountId(
  conversation: AgentConversationSummary,
  fallback?: string
): string | undefined {
  if (conversation.home === "account") {
    return conversation.accountId ?? fallback;
  }
  return fallback;
}
