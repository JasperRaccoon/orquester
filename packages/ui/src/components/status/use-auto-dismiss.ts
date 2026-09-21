import { useEffect } from "react";

/**
 * Auto-dismiss for a toast that only *tells* the user something.
 *
 * The toast column is `fixed … top-3` over the main area, so a toast that
 * never leaves covers the top of whatever is behind it — an end-to-end pass
 * found launch-failure and sign-in toasts still sitting over the timeline and
 * the tab strip after twenty-five minutes.
 *
 * **Only advisory toasts get this.** A toast carrying an action (a refused
 * resume offering "Start fresh", an auth failure offering "Open Settings")
 * must not time out: dismissing it silently discards the one affordance it
 * exists for. Those close when the user closes them, and — since the auth
 * toast's dismissal is now remembered — stay closed.
 *
 * The timer restarts whenever `key` changes, so a second notice arriving while
 * the first is up gets its own full reading time rather than inheriting the
 * remains of the previous one.
 */
export const TOAST_AUTO_DISMISS_MS = 12_000;

export function useAutoDismiss(
  key: string | null,
  dismiss: () => void,
  ms = TOAST_AUTO_DISMISS_MS
): void {
  useEffect(() => {
    if (key === null) {
      return;
    }
    const timer = setTimeout(dismiss, ms);
    return () => clearTimeout(timer);
  }, [key, dismiss, ms]);
}
