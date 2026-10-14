import React from "react";
import { MessageSquareOff } from "lucide-react";

import { Button } from "../ui";

/**
 * The tab of a chat the agent host does not hold — its stream answered
 * `THREAD_NOT_FOUND` (a fork whose create never landed, a thread deleted
 * there): said plainly, with the way out (close the tab) and a way back in
 * (try again: a fork the daemon confirmed since connects normally). The
 * stream does not reconnect on its own meanwhile.
 *
 * It covers the chat it replaces, so focus that was in that chat (the
 * composer, the timeline) or nowhere moves to its way out; focus elsewhere in
 * the app — another pane — is left where it is.
 */
export function ThreadGoneNotice({ onClose, onRetry }: { onClose: () => void; onRetry: () => void }) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const chat = rootRef.current?.parentElement;
    const active = document.activeElement;
    if (active === null || active === document.body || chat?.contains(active)) {
      closeRef.current?.focus();
    }
  }, []);
  return (
    <div
      ref={rootRef}
      role="alert"
      className="absolute inset-0 z-30 flex items-center justify-center bg-neutral-950/95 px-6"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <MessageSquareOff aria-hidden className="h-6 w-6 text-neutral-500" />
        <p className="text-sm font-medium text-neutral-100">This chat no longer exists</p>
        <p className="text-xs text-neutral-400">
          The agent host has no conversation for this tab, so there is nothing to show or send to.
        </p>
        <div className="flex gap-2">
          <Button ref={closeRef} size="sm" onClick={onClose}>
            Close tab
          </Button>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
