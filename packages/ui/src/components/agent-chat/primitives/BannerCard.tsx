import React from "react";
import { X } from "lucide-react";
import { cn } from "../../../lib/cn";
import { ChatIconButton } from "./ChatIconButton";
import { TONE_BAND, TONE_BAND_TEXT, type ChatTone } from "./tone";

export type BannerVariant = "default" | "info" | "success" | "warning" | "error";
export type BannerDensity = "compact" | "default" | "spacious";

const VARIANT_TONE: Record<BannerVariant, ChatTone> = {
  default: "neutral",
  info: "info",
  success: "ok",
  warning: "warn",
  error: "danger"
};

/**
 * Density is not decoration: it says how much of the user's attention the card
 * is entitled to. `compact` for an ambient notice, `default` for most things,
 * `spacious` only for a card the user must act on before the turn continues —
 * an approval or a question.
 * *T3: apps/web/src/components/chat/ComposerBanner.tsx:164-166, and
 * `ChatComposer.tsx:6150-6155` which picks `spacious` exactly for approvals*
 */
const DENSITY: Record<BannerDensity, string> = {
  compact: "px-2 py-1 gap-1.5",
  default: "px-2.5 py-1.5 gap-2",
  spacious: "px-3 py-3 gap-2"
};

export interface BannerCardProps {
  variant?: BannerVariant;
  density?: BannerDensity;
  /** 12–16px lucide glyph. Sits in a fixed 24px column so titles line up. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** One line, truncated. Anything longer belongs in `children`. */
  description?: React.ReactNode;
  /** `1/N` when several requests are queued behind this one. */
  counter?: React.ReactNode;
  /** Buttons, right-aligned on the first row. */
  actions?: React.ReactNode;
  /** The expanded body — detail blocks, option lists. */
  children?: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Skips the enter animation, e.g. for a banner present on first paint. */
  noEnterAnimation?: boolean;
  className?: string;
}

/**
 * The docked banner — the chat's one interruption surface.
 *
 * Everything that needs the user *now* renders here, between the status line
 * and the composer: approvals, questions, the plan-ready prompt, the
 * background-work stop button, errors. Nothing of the sort goes in the
 * timeline, because the timeline scrolls away and a request that scrolls away
 * is a turn that hangs.
 *
 * Three things make it feel like T3's:
 *
 *  - **It is attached, not floating.** Square bottom corners and no bottom
 *    border, so it reads as a drawer pulled out of the composer rather than a
 *    card resting on top of it.
 *    *T3: apps/web/src/components/chat/ComposerBanner.tsx:55, 111*
 *  - **It never steals focus.** The user can keep typing with an approval
 *    sitting there (spec §7.5). No autofocus, no modal, no focus trap.
 *  - **It leaves downwards.** `ac-banner-exit` drops it 64px behind the
 *    composer over 220ms — long enough to see where it went.
 *
 * The row is a three-column grid — fixed icon column, flexible content,
 * auto actions — so a stack of banners has its icons and titles on the same
 * vertical lines regardless of what each one contains.
 */
export function BannerCard({
  variant = "default",
  density = "default",
  icon,
  title,
  description,
  counter,
  actions,
  children,
  onDismiss,
  dismissLabel = "Dismiss",
  noEnterAnimation = false,
  className
}: BannerCardProps): React.ReactElement {
  const tone = VARIANT_TONE[variant];
  return (
    <div
      data-variant={variant}
      data-density={density}
      className={cn(
        // Square-bottomed and bottom-borderless: the composer closes the shape.
        "rounded-t-xl border border-b-0 text-xs",
        TONE_BAND[tone],
        DENSITY[density],
        !noEnterAnimation && "ac-banner-enter",
        className
      )}
    >
      <div className="grid w-full min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-1.5">
        <span
          className={cn(
            "col-start-1 row-start-1 flex h-6 w-6 items-center justify-center",
            TONE_BAND_TEXT[tone]
          )}
        >
          {icon}
        </span>
        <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-2">
          <span className={cn("shrink-0 font-medium", TONE_BAND_TEXT[tone])}>{title}</span>
          {description ? (
            <span className="min-w-0 truncate text-neutral-500">{description}</span>
          ) : null}
          {counter ? (
            <span className="ac-tabular ml-auto shrink-0 text-[11px] text-neutral-500">
              {counter}
            </span>
          ) : null}
        </div>
        <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-1.5">
          {actions}
          {onDismiss ? (
            <ChatIconButton label={dismissLabel} size="xs" onClick={onDismiss}>
              <X size={12} aria-hidden />
            </ChatIconButton>
          ) : null}
        </div>
      </div>
      {/* Aligned under the title, not under the icon — the icon column is
          chrome, and body text hanging off it reads as a second column. */}
      {children ? <div className="mt-2 min-w-0 ps-[1.875rem]">{children}</div> : null}
    </div>
  );
}
