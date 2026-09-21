import React from "react";
import { cn } from "../../../lib/cn";
import { TONE_FILL, type ChatTone } from "./tone";
import { useVisibleAnimation } from "./visible-animation";

export type StatusDotSize = "xs" | "sm" | "md";

const SIZES: Record<StatusDotSize, string> = {
  /** 6px — inside a dense row: the roster, a banner's inline dot. */
  xs: "h-1.5 w-1.5",
  /** 8px — the default, and what a tab strip or status line wants. */
  sm: "h-2 w-2",
  /** 10px — a lone dot with no text beside it. */
  md: "h-2.5 w-2.5"
};

export interface StatusDotProps {
  tone: ChatTone;
  size?: StatusDotSize;
  /**
   * The slow duty-cycled breath. Spend it on *in motion* only — a turn that is
   * running, a session connecting. Never on a settled or idle state.
   */
  pulse?: boolean;
  /**
   * The one-shot-per-cycle halo. Reserved for *act now* (a pending approval,
   * a question waiting) — at most one dot on screen should ever ping.
   */
  ping?: boolean;
  /** Announced to assistive tech. Omit only when adjacent text says the same. */
  label?: string;
  className?: string;
}

/**
 * The status light.
 *
 * Three rules, all of them learned the hard way in T3's live tests:
 *
 *  - **Colour is spent on three meanings only** — act-now, in-motion and
 *    broken. Resting is unlabelled and uncoloured. A palette where everything
 *    is tinted tells you nothing.
 *    *T3: apps/web/src/components/Sidebar.logic.ts:805-818*
 *  - **Idle reads as settled.** An idle-but-resumable agent gets `muted`, not
 *    `info` — T3 shipped a live-coloured idle dot and users read it as stuck.
 *    *T3: apps/web/src/components/AgentsPanel.tsx:42-44*
 *  - **In-flight states all present as one steady look.** `pending`,
 *    `running` and `waiting` are the fleet doing its job; only settled states
 *    differentiate. Do not invent a fourth in-motion colour.
 *    *T3: apps/web/src/components/AgentsPanel.tsx:32-37*
 *
 * The dot is a `span`, not an icon, so it costs nothing to render hundreds of
 * them; both animations are duty-cycled and pause off-screen.
 */
export function StatusDot({
  tone,
  size = "sm",
  pulse = false,
  ping = false,
  label,
  className
}: StatusDotProps): React.ReactElement {
  const animate = useVisibleAnimation();
  const animated = pulse || ping;
  return (
    <span
      ref={animated ? animate : undefined}
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {ping ? (
        <span className={cn("ac-dot ac-dot-ping absolute", SIZES[size], TONE_FILL[tone])} />
      ) : null}
      <span
        className={cn("ac-dot relative", pulse && "ac-dot-pulse", SIZES[size], TONE_FILL[tone])}
      />
    </span>
  );
}
