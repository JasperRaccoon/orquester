import React from "react";
import { cn } from "../../../lib/cn";

export type ChatIconButtonSize = "micro" | "xs" | "sm";
export type ChatIconButtonVariant = "ghost" | "outline" | "danger";

/**
 * `components/ui/icon-button.tsx` starts at 28px, which is right for a toolbar
 * and far too big for a chat row: T3's timeline rows are 24px tall, so a 28px
 * control inside one grows the row it lives in. These are T3's two smaller
 * steps plus the existing 28px as the top of the scale.
 * *T3: apps/web/src/components/ui/button.tsx:24-25 (`icon-micro`, 20px), :30-31 (`icon-xs`, 28→24px)*
 */
const SIZES: Record<ChatIconButtonSize, string> = {
  /** 20px — inside a 24px row (the queued bubble's send/cancel, a row action). */
  micro: "h-5 w-5 rounded",
  /** 24px — the default for chat chrome: banner dismiss, copy, code-block actions. */
  xs: "h-6 w-6 rounded-md",
  /** 28px — matches the app's `IconButton`; use it in the composer control row. */
  sm: "h-7 w-7 rounded-md"
};

const VARIANTS: Record<ChatIconButtonVariant, string> = {
  ghost: "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100",
  outline: "border border-neutral-700 text-neutral-300 hover:bg-neutral-800",
  danger: "text-neutral-500 hover:bg-danger-900/40 hover:text-danger-200"
};

export interface ChatIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Becomes both `aria-label` and `title` — an icon button always has one. */
  label: string;
  size?: ChatIconButtonSize;
  variant?: ChatIconButtonVariant;
}

/**
 * A small, dense icon button.
 *
 * Carries `ac-press`, so the feedback on click is a 3% squeeze rather than a
 * colour change (which would fight the hover state at this size). At 20–24px
 * there is not enough surface for a background flash to read as a press.
 * *T3: apps/web/src/components/ui/button.tsx:11 — `[&:active:not([aria-haspopup])]:scale-[0.97]`*
 */
export const ChatIconButton = React.forwardRef<HTMLButtonElement, ChatIconButtonProps>(
  function ChatIconButton({ className, label, size = "xs", variant = "ghost", ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        className={cn(
          "ac-press inline-flex shrink-0 items-center justify-center",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          "disabled:pointer-events-none disabled:opacity-50",
          SIZES[size],
          VARIANTS[variant],
          className
        )}
        {...props}
      />
    );
  }
);
