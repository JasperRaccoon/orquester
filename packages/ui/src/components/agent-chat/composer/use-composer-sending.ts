import React from "react";

import { isComposerSending, subscribeComposerSends } from "./composer-sends";

/**
 * Whether a send from this thread is in flight, whichever composer sent it
 * (§7.4) — the one a project switch unmounted included. A boolean snapshot, so
 * a change on another thread re-renders nothing here.
 */
export function useComposerSending(sessionId: string): boolean {
  const read = React.useCallback(() => isComposerSending(sessionId), [sessionId]);
  return React.useSyncExternalStore(subscribeComposerSends, read, read);
}
