import React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../../lib/cn";
import { ChatIconButton, type ChatIconButtonSize } from "./ChatIconButton";

/** How long the tick stays after a successful copy. T3 and this codebase agree. */
export const COPY_FEEDBACK_MS = 1200;

export interface CopyButtonProps {
  /**
   * The text, or a getter for it. Use the getter form when the value is
   * expensive to build (a whole message's markdown, a diff) — it is only
   * called on click.
   */
  value: string | (() => string);
  label?: string;
  size?: ChatIconButtonSize;
  /**
   * Hide until the containing row is hovered or focused. Requires `group` on
   * an ancestor. Always visible on a coarse pointer — there is no hover on a
   * phone, and a control you cannot reveal is a control that does not exist.
   */
  reveal?: boolean;
  className?: string;
  onCopied?: () => void;
}

/**
 * Copy, with the tick that tells you it worked.
 *
 * The icon swaps in place (Copy → Check) and reverts after 1.2s; the button
 * does not resize, because a control that changes width when clicked pushes
 * the row around under the pointer. The tick is `ok`-toned — the one place a
 * success colour appears in the timeline, and it is gone again in a second.
 * *T3: apps/web/src/components/ChatMarkdown.tsx:944-951, 1011-1021*
 */
export function CopyButton({
  value,
  label = "Copy",
  size = "xs",
  reveal = false,
  className,
  onCopied
}: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  const copy = React.useCallback(() => {
    const text = typeof value === "function" ? value() : value;
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // A denied clipboard permission is not worth a toast: the user can
        // still select the text. Swallow it and leave the icon unchanged.
        return;
      }
      setCopied(true);
      onCopied?.();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    })();
  }, [value, onCopied]);

  return (
    <ChatIconButton
      label={copied ? "Copied" : label}
      size={size}
      onClick={copy}
      className={cn(reveal && "ac-reveal", className)}
      data-visible={copied ? "true" : undefined}
    >
      {copied ? (
        <Check size={12} className="text-ok" aria-hidden />
      ) : (
        <Copy size={12} aria-hidden />
      )}
    </ChatIconButton>
  );
}
