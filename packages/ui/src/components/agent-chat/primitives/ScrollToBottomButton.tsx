import React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../lib/cn";

export interface ScrollToBottomButtonProps {
  onClick: () => void;
  /** Mount only while live-follow is off; the pill has no idle state. */
  visible: boolean;
  /**
   * Distance from the container's bottom edge, in px — normally the composer
   * overlay's published height plus a few px, so the pill floats just above
   * the composer instead of behind it.
   */
  bottom?: number;
  label?: string;
  className?: string;
}

/**
 * The "scroll to end" pill.
 *
 * It exists for exactly one situation: the user scrolled up to read history
 * while a turn is streaming, so live-follow disarmed itself. It is the single
 * affordance that re-arms every follow flag at once, which is why nothing else
 * in the timeline should try to scroll the user back on its own.
 *
 * Centred, pill-shaped, muted until hovered — it must be findable without
 * competing with the message it is floating over. `pointer-events-none` on the
 * positioning wrapper and `auto` on the button itself, so the invisible band
 * around the pill never eats a click meant for the text underneath.
 * *T3: apps/web/src/components/ChatView.tsx:9964-9982*
 */
export function ScrollToBottomButton({
  onClick,
  visible,
  bottom = 0,
  label = "Scroll to end",
  className
}: ScrollToBottomButtonProps): React.ReactElement | null {
  if (!visible) return null;
  return (
    <div
      className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
      style={{ bottom }}
    >
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        // Keep the composer's caret where it is: the pill is a viewport
        // control, not a focus target.
        onPointerDown={(event) => event.preventDefault()}
        className={cn(
          "ac-banner-enter ac-press pointer-events-auto inline-flex h-6 items-center gap-1.5",
          "rounded-full border border-neutral-700 bg-neutral-900/90 px-3 text-xs",
          "text-neutral-400 shadow-lg shadow-black/20 backdrop-blur",
          "hover:border-neutral-600 hover:text-neutral-100",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          className
        )}
      >
        <ChevronDown size={13} aria-hidden />
        {label}
      </button>
    </div>
  );
}
