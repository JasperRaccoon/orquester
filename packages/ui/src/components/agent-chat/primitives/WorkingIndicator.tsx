import React from "react";
import { cn } from "../../../lib/cn";
import { ShimmerText } from "./ShimmerText";
import { ElapsedTicker } from "./ElapsedTicker";
import type { ElapsedStamp } from "./elapsed";

export interface WorkingIndicatorProps {
  /**
   * The current phase, swapped in place as the turn progresses
   * (`Starting…` → `Working` → the live tool label). Pass a plain string; the
   * element around it never changes identity.
   */
  label: React.ReactNode;
  /** Icon slot — a 16px lucide glyph. Optional; the shimmer carries the row. */
  icon?: React.ReactNode;
  /** Start of the turn. Renders `for 1m 04s` beside the label. */
  startedAt?: ElapsedStamp;
  /** `false` freezes the label and the timer without unmounting either. */
  live?: boolean;
  /** Draws the hairline under the row, as T3's working row does. */
  divider?: boolean;
  className?: string;
}

/**
 * "The turn is alive" — the one row that must never be missing.
 *
 * A running turn that shows an empty timeline is the single worst state this
 * UI can be in: the user cannot tell a thinking agent from a hung one. This
 * row exists from the moment a turn starts, before any item has arrived.
 *
 * Two details carry the feel:
 *
 *  - **The label swaps in place.** One span, one shimmer, text replaced. T3
 *    calls this out explicitly — remounting the row restarts the shimmer and
 *    re-measures the line, so the setup-to-working handoff visibly stutters.
 *    *T3: apps/web/src/components/chat/MessagesTimeline.tsx:2528-2536*
 *  - **There is no spinner.** The shimmer is the motion. Keep the spinner for
 *    a control whose own request is in flight.
 *
 * The 24px row height and the hairline are T3's: `h-6`, `border-b` at
 * `border-neutral-800`, which reads as "everything above this line is done".
 */
export function WorkingIndicator({
  label,
  icon,
  startedAt,
  live = true,
  divider = false,
  className
}: WorkingIndicatorProps): React.ReactElement {
  return (
    <div className={cn(divider && "border-b border-neutral-800 pb-2 pt-1", className)}>
      <div className="flex h-6 min-w-0 items-center gap-2 px-1 text-sm leading-relaxed">
        {icon ? (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center text-neutral-500">
            {icon}
          </span>
        ) : null}
        <ShimmerText live={live} className="min-w-0 shrink-0 truncate">
          {label}
        </ShimmerText>
        {startedAt !== null && startedAt !== undefined ? (
          <span className="shrink-0 text-xs text-neutral-500">
            for <ElapsedTicker startedAt={startedAt} live={live} />
          </span>
        ) : null}
      </div>
    </div>
  );
}
