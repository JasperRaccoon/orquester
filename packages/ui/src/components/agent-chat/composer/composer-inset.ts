// Ported from T3 Code (MIT): apps/web/src/components/composerFooterLayout.ts
/**
 * The bottom content inset the composer publishes to the timeline (spec §7.4).
 *
 * The overlay is measured live, but a resting composer is much shorter than an
 * expanded one. Reserving only the resting height lets a scroll to the end land
 * flush against the short composer, and the expansion that follows then covers
 * the last rows, because the timeline never moves for footer growth. While
 * resting, the reservation keeps the last expanded height — or at least the
 * resting height plus the empty expansion — so expanding again changes nothing
 * above the composer. **An expanded measurement is authoritative and may shrink
 * it**, which is what stops a tall draft's reservation outliving the draft.
 *
 * *T3: `composerFooterLayout.ts:62-90`.*
 */

/**
 * How much taller the empty expanded composer is than its resting row, from
 * the layout classes in `ChatComposer`: the prompt clamps from its 70px
 * minimum to a single 32px row and the control footer leaves flow.
 */
export const COMPOSER_RESTING_EXPANSION_MIN_PX = 94;

export function resolveComposerTimelineInset(input: {
  currentInset: number;
  overlayHeight: number;
  isResting: boolean;
}): number {
  return input.isResting
    ? Math.max(input.currentInset, input.overlayHeight + COMPOSER_RESTING_EXPANSION_MIN_PX)
    : input.overlayHeight;
}

/**
 * Below the narrow breakpoint the composer collapses to a single row until it
 * is focused or the draft goes multiline (§7.8). Anything docked above it —
 * a banner, an attachment strip — keeps it open, because a control the user
 * can see must stay reachable.
 *
 * *T3: `ChatComposer.tsx:2102-2103` (`isComposerCollapsedMobile`).*
 */
export function isComposerCollapsedMobile(input: {
  isMobileViewport: boolean;
  isFocused: boolean;
  hasMultilineDraft: boolean;
  hasAttachments: boolean;
  hasDockedBanner: boolean;
}): boolean {
  return (
    input.isMobileViewport &&
    !input.isFocused &&
    !input.hasMultilineDraft &&
    !input.hasAttachments &&
    !input.hasDockedBanner
  );
}
