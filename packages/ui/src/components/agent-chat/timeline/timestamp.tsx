import React from "react";

import { cn } from "../../../lib/cn";
import { formatRowTimestamp, formatRowTimestampTooltip } from "./timestamp-format";

// The formatters live in a pure module (fix round 1): logic that needs them —
// the goal chip's popover — must not import a component to get them. They are
// re-exported for this module's existing importers; there is one definition.
export { formatRowTimestamp, formatRowTimestampTooltip };

/**
 * The hover-revealed timestamp.
 *
 * **There is no transition here, on purpose.** It swaps `absolute → static` on
 * hover, so a hidden timestamp occupies no layout and a fading one can never
 * overlap the text it sits beside mid-transition. It is also placed *before*
 * any trailing disclosure control, so revealing the time never moves the
 * chevron. *T3: `MessagesTimeline.tsx:2321-2323`.*
 */
export function TimelineRowTimestamp({
  createdAt,
  group = "timeline-row",
  className
}: {
  createdAt: string;
  /** The Tailwind group name the hover is scoped to. */
  group?: "timeline-row" | "assistant";
  className?: string;
}): React.ReactElement | null {
  const label = formatRowTimestamp(createdAt);
  if (label.length === 0) return null;
  return (
    <span
      title={formatRowTimestampTooltip(createdAt)}
      className={cn(
        "ac-tabular pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-xs text-neutral-500 opacity-0",
        group === "assistant"
          ? "group-hover/assistant:pointer-events-auto group-hover/assistant:static group-hover/assistant:opacity-100 group-focus-within/assistant:pointer-events-auto group-focus-within/assistant:static group-focus-within/assistant:opacity-100"
          : "group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
        className
      )}
    >
      {label}
    </span>
  );
}
