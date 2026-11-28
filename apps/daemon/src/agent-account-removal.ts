import { SYSTEM_ACCOUNT_ID, type AgentAccountsResponse, type SessionSummary } from "@orquester/api";

/**
 * Removing a managed account frees it first: every chat tab still pinned to it that is not working
 * moves to another account of the same agent, so only a working session keeps an account from
 * being removed.
 */
export interface AccountReleaseDeps {
  sessions: readonly SessionSummary[];
  accounts: AgentAccountsResponse;
  /** The composer's account switch (`AgentChatService.switchAccount`), applied on the chat's next message. */
  switchAccount(sessionId: string, input: { commandId: string; accountId: string }): Promise<unknown>;
  newCommandId(): string;
}

export type AccountReleaseOutcome =
  | { ok: true; movedTo: string | null; moved: SessionSummary[] }
  | { ok: false; error: string };

export async function releaseAccountForRemoval(accountId: string, deps: AccountReleaseDeps): Promise<AccountReleaseOutcome> {
  const using = deps.sessions.filter((session) => session.accountId === accountId);
  const busy = using.filter(isBusy);
  if (busy.length > 0) {
    const titles = busy.map((session) => `"${session.title}"`).join(", ");
    const one = busy.length === 1;
    return {
      ok: false,
      error: `This account is in use by ${one ? "a session that is" : "sessions that are"} still working: ${titles}. Wait for ${one ? "it" : "them"} to finish or stop ${one ? "it" : "them"}, then remove the account.`
    };
  }
  const idleChats = using.filter((session) => session.kind === "agent-chat");
  if (idleChats.length === 0) return { ok: true, movedTo: null, moved: [] };

  const movedTo = replacementFor(accountId, deps.accounts);
  const moved: SessionSummary[] = [];
  for (const session of idleChats) {
    try {
      await deps.switchAccount(session.id, { commandId: deps.newCommandId(), accountId: movedTo });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Could not move "${session.title}" to another account (${reason}). Try removing the account again.` };
    }
    moved.push(session);
  }
  return { ok: true, movedTo, moved };
}

/** Working means what the sidebar's status light shows as working: the daemon's activity state, nothing else. */
function isBusy(session: SessionSummary): boolean {
  return session.activity?.state === "working";
}

/**
 * The account the removed one's chats move to: the agent's default, then any other signed-in
 * account of the same agent, then any other one, and the server's own login when it was the last.
 */
function replacementFor(accountId: string, accounts: AgentAccountsResponse): string {
  const removed = accounts.accounts.find((account) => account.id === accountId);
  if (!removed) return SYSTEM_ACCOUNT_ID;
  const others = accounts.accounts.filter((account) => account.agent === removed.agent && account.id !== accountId);
  const defaultId = accounts.defaults[removed.agent];
  const pick =
    others.find((account) => account.id === defaultId && !account.needsReauth) ??
    others.find((account) => !account.needsReauth) ??
    others.find((account) => account.id === defaultId) ??
    others[0];
  return pick?.id ?? SYSTEM_ACCOUNT_ID;
}
