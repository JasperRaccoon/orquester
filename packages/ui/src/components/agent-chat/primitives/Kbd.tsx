import React from "react";
import { cn } from "../../../lib/cn";
import { shortcutKeys } from "./shortcut";

export interface KbdProps {
  /**
   * A platform-neutral chord — `"mod+k"`, `"shift+enter"` — rendered as one
   * cap per key. Mutually exclusive with `children`.
   */
  combo?: string;
  /** Literal cap contents, when the key is not expressible as a chord. */
  children?: React.ReactNode;
  /**
   * `plain` drops the cap entirely and renders bare tabular digits — what the
   * approval and question cards use for their 1–9 answer shortcuts, where a
   * row of nine outlined caps would out-shout the options they belong to.
   * *T3: apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx:268-272*
   */
  variant?: "cap" | "plain";
  className?: string;
}

const CAP =
  "inline-flex h-5 min-w-5 select-none items-center justify-center rounded px-1 " +
  "bg-neutral-800 font-medium text-[11px] leading-none text-neutral-400 ac-tabular";

const PLAIN =
  "inline-flex h-5 w-5 select-none items-center justify-center " +
  "text-[10px] font-medium text-neutral-500 ac-tabular";

/**
 * A keyboard hint.
 *
 * Deliberately low-contrast: a shortcut hint is a reward for looking, not a
 * call to action, and at `text-neutral-400` on `bg-neutral-800` it disappears
 * until you go looking for it. `pointer-events-none` because a cap is never
 * the thing you click — the control beside it is.
 * *T3: apps/web/src/components/ui/kbd.tsx:9*
 */
export function Kbd({ combo, children, variant = "cap", className }: KbdProps): React.ReactElement {
  const base = variant === "cap" ? CAP : PLAIN;
  if (combo === undefined) {
    return <kbd className={cn("pointer-events-none", base, className)}>{children}</kbd>;
  }
  const keys = shortcutKeys(combo);
  return (
    <span className="pointer-events-none inline-flex items-center gap-1">
      {keys.map((key, index) => (
        <kbd key={`${key}-${index}`} className={cn(base, className)}>
          {key}
        </kbd>
      ))}
    </span>
  );
}
