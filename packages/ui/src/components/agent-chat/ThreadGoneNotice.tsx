import { MessageSquareOff } from "lucide-react";

import { Button } from "../ui";

/**
 * The tab of a chat the agent host does not hold — its stream answered
 * `THREAD_NOT_FOUND` (a fork whose create never landed, a thread deleted
 * there): said plainly, with the way out (close the tab) and a way back in
 * (try again: a fork the daemon confirmed since connects normally). The
 * stream does not reconnect on its own meanwhile.
 */
export function ThreadGoneNotice({ onClose, onRetry }: { onClose: () => void; onRetry: () => void }) {
  return (
    <div
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
          <Button size="sm" onClick={onClose}>
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
