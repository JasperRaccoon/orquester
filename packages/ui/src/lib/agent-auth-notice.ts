/**
 * Which provider auth-error toasts the user has already closed (spec §7.7).
 *
 * The publisher re-fires `onAuthError` on **every** successful provider load,
 * and a coarse `agent.providers.changed` forces a load — so while a provider
 * stays signed out the same error arrives again and again. A sink that simply
 * overwrites the toast makes it un-dismissable: close it, and the next bus
 * event brings the identical card straight back.
 *
 * Dismissals are therefore remembered, keyed by *which provider* and *what it
 * said*, so a different failure on the same provider still gets through. This
 * mirrors the per-thread error banner, which already keeps a dismissal set.
 *
 * Pure so the rule is testable without the store.
 */

export interface AgentAuthNotice {
  sessionId: string;
  agentName: string;
  message: string;
}

/**
 * How many dismissals to remember. One entry per provider per distinct
 * message; the list is daemon-scoped state a reconnect clears anyway, so this
 * only bounds a pathological loop of distinct messages.
 */
export const AGENT_AUTH_DISMISSAL_LIMIT = 20;

/** `sessionId` + `message` — the two things that make a toast "the same one". */
export function agentAuthNoticeKey(notice: Pick<AgentAuthNotice, "sessionId" | "message">): string {
  return `${notice.sessionId}\u0000${notice.message}`;
}

/** Whether this notice should be shown, given what has already been dismissed. */
export function shouldRaiseAgentAuthNotice(
  notice: Pick<AgentAuthNotice, "sessionId" | "message">,
  dismissed: readonly string[]
): boolean {
  return !dismissed.includes(agentAuthNoticeKey(notice));
}

/** Record a dismissal, keeping the list bounded and free of duplicates. */
export function rememberAgentAuthDismissal(
  notice: Pick<AgentAuthNotice, "sessionId" | "message">,
  dismissed: readonly string[]
): string[] {
  const key = agentAuthNoticeKey(notice);
  if (dismissed.includes(key)) {
    return dismissed as string[];
  }
  return [...dismissed, key].slice(-AGENT_AUTH_DISMISSAL_LIMIT);
}
