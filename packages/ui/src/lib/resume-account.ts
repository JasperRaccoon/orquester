import { SYSTEM_ACCOUNT_ID, type AgentConversationSummary } from "@orquester/api";

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
 *   selection/preference; forcing the host identity here broke resume whenever
 *   the system home's own login was stale ("session expired, run /login")
 *   while the user's accounts were fine. Only with no fallback at all do we
 *   pin the explicit host sentinel (an *omitted* value would resolve to the
 *   per-agent default downstream, which is fine too — but the sentinel keeps
 *   the no-accounts case byte-identical to a fresh System launch).
 * - `cliproxy`, or a daemon predating the field → unknowable here, so fall back
 *   to whatever the caller would have launched a fresh session with.
 */
export function resumeAccountId(
  conversation: AgentConversationSummary,
  fallback?: string
): string | undefined {
  if (conversation.home === "account") {
    return conversation.accountId ?? fallback;
  }
  if (conversation.home === "system") {
    return fallback ?? SYSTEM_ACCOUNT_ID;
  }
  return fallback;
}

/**
 * Whether a conversation row can be offered as a resume at all.
 *
 * `cliproxy` rows live in a `claude-home-<entryId>` dir owned by the `claudex` /
 * `claudemix` launchers, not by `claude`. Resuming one today would launch plain
 * `claude` with `--resume <id>` under the daemon's own HOME: the CLI never finds
 * the transcript and the tab dies with no error, so the row is hidden instead.
 *
 * FULL FIX (not done here): teach the launcher registry that `claudex`/
 * `claudemix` accept resume args of their own (`canResumeAgent`/`resumeArgsFor`
 * are keyed on the agent id), then route these rows to `conversation.proxyRefId`
 * as the launched refId instead of `conversation.agentRefId` — the account chip
 * comes from the proxy entry, not from a managed account.
 */
export function isResumableConversation(conversation: AgentConversationSummary): boolean {
  return conversation.home !== "cliproxy";
}
