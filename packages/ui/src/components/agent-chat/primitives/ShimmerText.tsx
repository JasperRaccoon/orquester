import React from "react";
import { cn } from "../../../lib/cn";
import { useVisibleAnimation } from "./visible-animation";

export interface ShimmerTextProps {
  /**
   * The label. Change it freely — the element identity never changes, so a
   * `starting → running → Read 3 files` progression is a text swap in place,
   * not a remount, and the row never reflows or restarts the shimmer.
   * *T3: apps/web/src/components/chat/MessagesTimeline.tsx:2530-2536*
   */
  children: React.ReactNode;
  /** `true` while the thing this labels is actually running. */
  live?: boolean;
  /** `span` by default; pass `"div"` when it must be a block. */
  as?: "span" | "div";
  className?: string;
  title?: string;
}

/**
 * The live label — a band of light travelling across the text itself.
 *
 * This is the single most recognisable T3 motion, and it is used for exactly
 * one meaning: *this label describes something happening right now*. The
 * activity-group header while a tool runs, the "Thinking" row, the working
 * row's phase label. It is never decoration, and never applied to a settled
 * summary — a shimmer on finished text makes the whole timeline look busy.
 *
 * Do not add a `text-*` class: `.ac-shimmer` owns the colour in both states
 * (see the note in `styles/agent-chat.css`). Sizing, weight, truncation and
 * layout classes are all fine and expected — `min-w-0 flex-1 truncate` is the
 * usual companion set.
 */
export const ShimmerText = React.forwardRef<HTMLElement, ShimmerTextProps>(function ShimmerText(
  { children, live = false, as = "span", className, title },
  forwardedRef
) {
  const animate = useVisibleAnimation();
  const Tag = as as "span";
  const setRef = React.useCallback(
    (node: HTMLElement | null) => {
      if (live) animate(node);
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [animate, live, forwardedRef]
  );
  return (
    <Tag
      ref={setRef}
      title={title}
      className={cn(live ? "ac-shimmer" : "ac-shimmer-settled", className)}
    >
      {children}
    </Tag>
  );
});
