import { SYSTEM_ACCOUNT_ID, type AgentConversationSummary } from "@orquester/api";

/**
 * Which managed account a resume must launch under.
 *
 * A conversation only exists inside the HOME the agent wrote it in, so resuming
 * it under a different identity hands the CLI an id it has never seen. The
 * daemon tells us which home a row came from, and that answer wins over any UI
 * preference:
 *
 * - `account` → that managed account id.
 * - `system` → the explicit host-identity sentinel (not an omitted value, which
 *   would resolve to the per-agent default account instead).
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
    return SYSTEM_ACCOUNT_ID;
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
