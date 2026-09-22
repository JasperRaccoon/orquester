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
  /**
   * `"sign-in"` earns the alarming "needs signing in again" title; `"status"`
   * is the neutral copy for a snapshot that merely failed (§7.7).
   */
  tone?: "sign-in" | "status";
  /**
   * The two snapshot columns the key also spans, so the SAME verdict never
   * re-toasts while a genuinely different one still gets through.
   *
   * *T3: `ProviderStatusBanner.tsx:20-23` — the banner key is
   * `[instanceId, status, auth.status, message]`.*
   */
  providerStatus?: string;
  authStatus?: string;
}

type NoticeKeyFields = Pick<
  AgentAuthNotice,
  "sessionId" | "message" | "providerStatus" | "authStatus"
>;

/**
 * How many dismissals to remember. One entry per provider per distinct
 * message; the list is daemon-scoped state a reconnect clears anyway, so this
 * only bounds a pathological loop of distinct messages.
 */
export const AGENT_AUTH_DISMISSAL_LIMIT = 20;

/**
 * `[adapterId, status, auth.status, message]` — what makes a toast "the same
 * one". The `sessionId` is the synthetic `provider:<adapterId>` the store
 * mints, so the adapter identity rides in it.
 *
 * *T3: `ProviderStatusBanner.tsx:20-23` (`getProviderStatusBannerKey`).*
 */
export function agentAuthNoticeKey(notice: NoticeKeyFields): string {
  return [
    notice.sessionId,
    notice.providerStatus ?? "",
    notice.authStatus ?? "",
    notice.message
  ].join("\u0000");
}

/** Whether this notice should be shown, given what has already been dismissed. */
export function shouldRaiseAgentAuthNotice(
  notice: NoticeKeyFields,
  dismissed: readonly string[]
): boolean {
  return !dismissed.includes(agentAuthNoticeKey(notice));
}

/** Record a dismissal, keeping the list bounded and free of duplicates. */
export function rememberAgentAuthDismissal(
  notice: NoticeKeyFields,
  dismissed: readonly string[]
): string[] {
  const key = agentAuthNoticeKey(notice);
  if (dismissed.includes(key)) {
    return dismissed as string[];
  }
  return [...dismissed, key].slice(-AGENT_AUTH_DISMISSAL_LIMIT);
}
