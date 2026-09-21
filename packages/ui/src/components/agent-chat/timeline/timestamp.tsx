import React from "react";

import { cn } from "../../../lib/cn";

/**
 * Row timestamps (§5.4 of the design reference).
 *
 * Day-aware and deliberately terse: inside a thread you are reading, the time
 * of day is the whole answer, and the date only starts mattering once a thread
 * spans days. The full stamp is always one hover away in the `title`.
 *
 * Returns `""` — never `"Invalid Date"` — for an unparseable value. These
 * stamps come off four different agent CLIs; a malformed one must shrink the
 * row, not poison it.
 */
export function formatRowTimestamp(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const time = then.getTime();
  if (!Number.isFinite(time)) return "";
  const clock = `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();
  if (sameDay) return clock;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday =
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday ${clock}`;
  const day = then.getDate();
  const month = then.toLocaleDateString(undefined, { month: "short" });
  const year = then.getFullYear() === now.getFullYear() ? "" : ` ${then.getFullYear()}`;
  return `${day} ${month}${year} ${clock}`;
}

/** The full stamp, for the tooltip. */
export function formatRowTimestampTooltip(iso: string): string {
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return "";
  return then.toLocaleString();
}

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
