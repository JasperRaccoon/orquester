// Ported from T3 Code (MIT): apps/web/src/components/ChatView.logic.ts:374-405
/**
 * The thread-switch paint hold (spec §7.1).
 *
 * > the outgoing thread's rows keep painting until the next thread's snapshot
 * > lands, so a tab switch never flashes an empty timeline. While that hold is
 * > in effect every row callback is a no-op, so a click lands on the thread the
 * > user is actually looking at.
 *
 * Pure, so the rule is testable without a renderer. `AgentChatView` keeps the
 * last non-empty projection in a ref and feeds it back in as `held`.
 */

/** The last non-empty projection this view painted, and whose thread it was. */
export interface HeldTimeline<TRow> {
  sessionId: string;
  rows: readonly TRow[];
}

export interface ThreadSwitchTimeline<TRow> {
  rows: readonly TRow[];
  /**
   * True only while the rows on screen belong to a **different** thread than
   * the one the props name. Every callback must be neutralised and every live
   * flag (`isWorking`, follow, pending counts) forced off while it holds.
   */
  paintOnly: boolean;
  /** Whose rows are actually on screen — the held thread while `paintOnly`. */
  displaySessionId: string;
}

export function resolveThreadSwitchTimeline<TRow>(input: {
  sessionId: string;
  rows: readonly TRow[];
  /** The named thread has no usable projection yet (no snapshot, or reconnecting). */
  loading: boolean;
  held: HeldTimeline<TRow> | null;
}): ThreadSwitchTimeline<TRow> {
  const { sessionId, rows, loading, held } = input;
  // 1. Anything to show for the named thread wins outright.
  if (rows.length > 0) {
    return { rows, paintOnly: false, displaySessionId: sessionId };
  }
  // 2. Nothing yet but we painted this SAME thread before — a reconnect
  //    re-snapshot, not a switch. Keep its own rows; this is not paint-only,
  //    so its callbacks stay live: the user is still on that thread.
  if (loading && held && held.sessionId === sessionId && held.rows.length > 0) {
    return { rows: held.rows, paintOnly: false, displaySessionId: sessionId };
  }
  // 3. Nothing yet and the last paint was another thread: hold it, inert.
  if (loading && held && held.sessionId !== sessionId && held.rows.length > 0) {
    return { rows: held.rows, paintOnly: true, displaySessionId: held.sessionId };
  }
  // 4. Genuinely empty — an empty thread renders its own empty state.
  return { rows, paintOnly: false, displaySessionId: sessionId };
}

/**
 * The next value of the held projection. Only a **settled, non-empty** paint of
 * the named thread is remembered: holding an empty or paint-only result would
 * make the hold self-perpetuating.
 */
export function nextHeldTimeline<TRow>(
  current: HeldTimeline<TRow> | null,
  resolved: ThreadSwitchTimeline<TRow>
): HeldTimeline<TRow> | null {
  if (resolved.paintOnly || resolved.rows.length === 0) {
    return current;
  }
  if (current && current.sessionId === resolved.displaySessionId && current.rows === resolved.rows) {
    return current;
  }
  return { sessionId: resolved.displaySessionId, rows: resolved.rows };
}
