// Ported from T3 Code (MIT): apps/web/src/components/chat/MessagesTimeline.logic.ts:149-172

/**
 * Live-follow's re-arm rule (spec §7.3).
 *
 * Follow is a **render-visible flag, never a ref**, and it re-arms only inside
 * a 40 px band at the very bottom of the content. The band is strict on
 * purpose: T3 shipped a "near end" heuristic that fired within half a viewport,
 * which re-armed follow while the user was reading history and yanked them back
 * down on the next streamed chunk.
 *
 * The measurement is `contentLength - scroll - scrollLength`. The composer
 * overlay's bottom inset appears in `contentLength` (as the footer spacer) and
 * hides exactly the same amount of viewport, so the inset cancels: what is left
 * is the gap between the last real row and the visible edge above the composer.
 */

export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export interface TimelineScrollMetrics {
  /** `scrollHeight` — the full scrollable content, footer spacer included. */
  contentLength: number;
  /** `scrollTop`. */
  scroll: number;
  /** `clientHeight`. */
  scrollLength: number;
}

/** Distance from the bottom of the content, in px. Never negative. */
export function distanceFromEnd(metrics: TimelineScrollMetrics): number {
  return Math.max(0, metrics.contentLength - metrics.scroll - metrics.scrollLength);
}

/** Whether the viewport currently sits inside the re-arm band. */
export function isWithinFollowBand(metrics: TimelineScrollMetrics): boolean {
  return distanceFromEnd(metrics) <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

/**
 * The follow flag after a user scroll.
 *
 * Follow only ever *re-arms* inside the band and *disarms* outside it — there
 * is no third outcome, and in particular a programmatic scroll to the end must
 * go through the same rule rather than setting the flag directly, so the flag
 * and the scroll position can never disagree.
 */
export function nextFollowState(metrics: TimelineScrollMetrics): boolean {
  return isWithinFollowBand(metrics);
}

/**
 * Whether a smooth scroll should be used for this follow step.
 *
 * **Smooth is reserved for streamed growth inside an already-open thread.**
 * Streamed text lands a paragraph at a time; a smooth scroll turns each landing
 * into a short glide instead of a jump. A thread switch, a list that has just
 * received its first page of rows, the pre-first-paint window and a
 * reduced-motion preference all keep the instant variant, so nothing ever
 * visibly travels on the way *into* a thread.
 *
 * *T3: `MessagesTimeline.tsx:1294-1304` — `isWorking && !prefersReducedMotion
 * && settlingListIdentity === null` picks `…_SMOOTH`, everything else the
 * instant `TIMELINE_MAINTAIN_SCROLL_AT_END` (`:389-395`).*
 */
export function shouldAnimateFollow(input: {
  working: boolean;
  reducedMotion: boolean;
  firstPaint: boolean;
  /** The two-frame latch below — true while this list identity is settling. */
  settling: boolean;
}): boolean {
  return input.working && !input.reducedMotion && !input.firstPaint && !input.settling;
}

// ---------------------------------------------------------------------------
// The settle latch
// ---------------------------------------------------------------------------

/**
 * How many animation frames a freshly identified list stays "settling".
 *
 * *T3: `MessagesTimeline.tsx:618-631` — "Two frames covers the fresh-data
 * layout pass and the initial end pin."*
 */
export const TIMELINE_SETTLE_FRAMES = 2;

/**
 * The named latch that keeps a list-identity change instant.
 *
 * It replaces a time-based "be instant for the next 600 ms" window, which was
 * both too long (a turn streaming into a thread opened 500 ms ago jumped
 * instead of gliding) and too short (a slow first fold landed after it
 * expired and glided down in front of the user). Frames, not milliseconds:
 * what has to be covered is *the fresh-data layout pass and the initial end
 * pin*, and those are frames by construction.
 *
 * *T3: `MessagesTimeline.tsx:555-567, :618-631` (`settlingListIdentity`).*
 */
export interface TimelineSettleLatch {
  /** The list identity that is settling, or `null` when nothing is. */
  readonly identity: string | null;
  /** Frames still to elapse before it clears. */
  readonly frames: number;
}

export const IDLE_SETTLE_LATCH: TimelineSettleLatch = { identity: null, frames: 0 };

/**
 * One list's identity.
 *
 * The drill-in mounts a *second* timeline for the same session id while the
 * parent's is still mounted (§7.6), so the agent id is part of the identity —
 * otherwise opening a drill-in would not count as a switch and its first end
 * pin would glide.
 */
export function timelineListIdentity(sessionId: string, agentId?: string | null): string {
  return `${sessionId}\u0000${agentId ?? ""}`;
}

/** Arm the latch for an identity. */
export function armSettleLatch(identity: string): TimelineSettleLatch {
  return { identity, frames: TIMELINE_SETTLE_FRAMES };
}

/** One frame elapsed. The latch clears on the last one. */
export function tickSettleLatch(latch: TimelineSettleLatch): TimelineSettleLatch {
  if (latch.identity === null) {
    return latch;
  }
  const frames = latch.frames - 1;
  return frames > 0 ? { identity: latch.identity, frames } : IDLE_SETTLE_LATCH;
}

/**
 * Whether *this* list is settling.
 *
 * Matched on the identity rather than on "is anything settling", so a latch
 * armed for the thread the user just left can never make the incoming
 * thread's follow instant — or, worse, outlive it and make it jump.
 */
export function isSettling(latch: TimelineSettleLatch, identity: string): boolean {
  return latch.identity === identity && latch.frames > 0;
}
