import React from "react";
import { cn } from "../../../lib/cn";
import { elapsedBetween, type ElapsedStamp } from "./elapsed";

export interface ElapsedTickerProps {
  /** When the thing started. `null` renders nothing at all. */
  startedAt: ElapsedStamp;
  /** When it stopped. `null`/omitted with `live` means "still going". */
  endedAt?: ElapsedStamp;
  /** Whether to keep ticking. A settled row freezes at `endedAt`. */
  live?: boolean;
  className?: string;
}

/**
 * A once-a-second elapsed counter that costs **zero React commits**.
 *
 * The first value is rendered normally; every value after that is written
 * straight to the text node with `textContent`. This is the difference between
 * a roster of twenty live agents costing twenty renders a second (each one
 * re-running its parent's memo chain) and costing nothing measurable.
 * *T3: apps/web/src/components/AgentsPanel.tsx:82-113*
 *
 * The companion rule is `ac-tabular`, applied here unconditionally: without
 * tabular figures the string's width changes as the digits change, and a row
 * that twitches once a second is worse than no timer.
 *
 * Note that `live` is narrower than "not finished": T3 ticks for `running` and
 * `waiting` only, so a `pending` agent that has not actually started shows a
 * frozen value rather than counting up time it never spent.
 */
export function ElapsedTicker({
  startedAt,
  endedAt = null,
  live = false,
  className
}: ElapsedTickerProps): React.ReactElement | null {
  const textRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!live || startedAt === null || startedAt === undefined) return;
    const update = () => {
      const node = textRef.current;
      if (node) node.textContent = elapsedBetween(startedAt, null);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (startedAt === null || startedAt === undefined) return null;
  return (
    <span ref={textRef} className={cn("ac-tabular", className)}>
      {elapsedBetween(startedAt, live ? null : endedAt)}
    </span>
  );
}
