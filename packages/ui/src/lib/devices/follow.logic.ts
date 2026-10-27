/**
 * Devices — "Show the device when an agent opens one" (spec §10.2), as a pure reducer.
 *
 * - The first lease list a connection loads is the **baseline**: nothing in it opens the panel
 *   (a reload never reopens a device, as t3code's `useAgentOpenedPreviews`).
 * - A lease seen for the first time after that, opened by an agent for the visible chat, opens the
 *   rail on the Device panel and selects it — unless the setting is off, or the user closed the
 *   Device panel while that chat was visible during this session.
 * - Opening the Device panel again on that chat forgets the dismissal.
 * - The store emptying (a connection switch, the plugin off) starts a new baseline.
 */

import type { DeviceLeaseSummary } from "@orquester/api";

export interface FollowState {
  /** The baseline has been taken (a lease list arrived on this connection). */
  readonly baselined: boolean;
  /** Every lease id seen so far. */
  readonly seen: ReadonlySet<string>;
  /** Chats whose Device panel the user closed this session. */
  readonly dismissed: ReadonlySet<string>;
}

export const INITIAL_FOLLOW_STATE: FollowState = { baselined: false, seen: new Set(), dismissed: new Set() };

export interface FollowOpen {
  threadId: string;
  leaseId: string;
}

/** A new lease list (null: not loaded / reset). */
export function followLeases(
  state: FollowState,
  leases: readonly Pick<DeviceLeaseSummary, "id" | "threadId" | "openedBy" | "state">[] | null,
  context: { visibleThreadId: string | null; follow: boolean }
): { state: FollowState; open: FollowOpen | null } {
  if (leases === null) {
    return { state: state.baselined || state.seen.size > 0 ? { ...state, baselined: false, seen: new Set() } : state, open: null };
  }
  const fresh = leases.filter((lease) => !state.seen.has(lease.id));
  if (state.baselined && fresh.length === 0) return { state, open: null };
  const seen = new Set(state.seen);
  for (const lease of fresh) seen.add(lease.id);
  const next: FollowState = { ...state, baselined: true, seen };
  if (!state.baselined || !context.follow || context.visibleThreadId === null) return { state: next, open: null };
  if (state.dismissed.has(context.visibleThreadId)) return { state: next, open: null };
  const opened = [...fresh]
    .reverse()
    .find((lease) => lease.openedBy === "agent" && lease.threadId === context.visibleThreadId && lease.state !== "released" && lease.state !== "lost");
  return { state: next, open: opened ? { threadId: opened.threadId, leaseId: opened.id } : null };
}

/**
 * The Device panel was shown (`shown: true`) or closed while `threadId` was visible. Closing it
 * counts only when the chat has a device: closing an empty panel dismisses nothing.
 */
export function followPanel(state: FollowState, threadId: string | null, shown: boolean, chatHasDevice: boolean): FollowState {
  if (threadId === null) return state;
  if (shown) {
    if (!state.dismissed.has(threadId)) return state;
    const dismissed = new Set(state.dismissed);
    dismissed.delete(threadId);
    return { ...state, dismissed };
  }
  if (!chatHasDevice || state.dismissed.has(threadId)) return state;
  return { ...state, dismissed: new Set([...state.dismissed, threadId]) };
}
