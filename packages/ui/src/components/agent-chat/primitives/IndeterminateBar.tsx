import React from "react";
import { cn } from "../../../lib/cn";

export interface IndeterminateBarProps {
  /** `false` freezes the fill without unmounting the track. */
  live?: boolean;
  className?: string;
}

/**
 * The indeterminate progress hairline — "this is running and I cannot tell you
 * how far along it is".
 *
 * Spent on exactly one meaning: a phase with **no rows of its own**. A tool
 * call gets a row, a turn gets the shimmering label; a context compaction
 * produces neither for minutes at a time, and on a long thread the only honest
 * thing left to show is motion. That is why it is a sliding fill rather than a
 * percentage: there is no percentage, and inventing one would be a lie the
 * user watches stall.
 *
 * Two rules it must keep:
 *
 *  - **Theme-neutral.** Track and fill paint from the `neutral` scale only, so
 *    all seven schemes × light/dark keep working (see the theming note in
 *    AGENTS.md). No literal colour, no semantic tone — the tone belongs to the
 *    label beside it, not to a 2px rule.
 *  - **Reduced motion is a legible static state, never a frozen smudge.** The
 *    shared `.ac-working-bar` utility lands on a full-width, dimmed fill under
 *    `prefers-reduced-motion: reduce`, which still reads as "in progress".
 *
 * `aria-hidden` throughout: every use sits beside a live label that already
 * says what is happening, and a second announcement of the same fact is noise.
 */
export function IndeterminateBar({
  live = true,
  className
}: IndeterminateBarProps): React.ReactElement {
  return (
    <div
      aria-hidden
      className={cn("h-0.5 w-full overflow-hidden rounded-full bg-neutral-800", className)}
    >
      {/* Frozen, it lands on the same shape `prefers-reduced-motion` does —
          a full-width dimmed fill, which still reads as "in progress". */}
      <div
        className={cn(
          "h-full rounded-full bg-neutral-500",
          live ? "ac-working-bar" : "opacity-40"
        )}
      />
    </div>
  );
}

export default IndeterminateBar;
