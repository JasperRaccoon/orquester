/**
 * Agent Profiles — which chats use a profile, from the session summaries the client holds
 * (`SessionSummary.profileId`, spec 2026-10-18 §5.6). The summary comes off the daemon's wire
 * unvalidated, so the field is read here and nowhere else: anything but a sane id is Global.
 */

import type { SessionSummary } from "@orquester/api";

/** A chat tab's Agent Profile id, or null (Global, or not a chat, or a value that does not read). */
export function sessionProfileIdOf(summary: Pick<SessionSummary, "kind"> & { profileId?: unknown }): string | null {
  if (summary.kind !== "agent-chat") return null;
  const value = summary.profileId;
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

/** How many open chat tabs launch with `profileId`. */
export function openChatsUsingProfile(sessions: readonly SessionSummary[], profileId: string): number {
  let count = 0;
  for (const session of sessions) {
    if (session.status !== "exited" && sessionProfileIdOf(session) === profileId) count += 1;
  }
  return count;
}

/** The delete confirmation's line about those chats. */
export function profileDeleteChatsLine(count: number): string {
  if (count === 0) return "No open chat uses it.";
  return count === 1
    ? "1 open chat uses it: it keeps running, and switches to Global with a notice at its next restart."
    : `${count} open chats use it: they keep running, and switch to Global with a notice at their next restart.`;
}
