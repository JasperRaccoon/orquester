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
 * Streamed text lands a paragraph at a time; a smooth scroll turns each landing
 * into a short glide instead of a jump. Thread switches, layout settles and a
 * reduced-motion preference all keep the instant variant so nothing visibly
 * travels. *T3: `MessagesTimeline.tsx:1294-1304`.*
 */
export function shouldAnimateFollow(input: {
  working: boolean;
  reducedMotion: boolean;
  firstPaint: boolean;
}): boolean {
  return input.working && !input.reducedMotion && !input.firstPaint;
}
