import { useEffect } from "react";

/**
 * Auto-dismiss for a toast that only *tells* the user something.
 *
 * The toast column is `fixed … top-3` over the main area, so a toast that
 * never leaves covers the top of whatever is behind it — an end-to-end pass
 * found launch-failure and sign-in toasts still sitting over the timeline and
 * the tab strip after twenty-five minutes.
 *
 * A toast carrying an action (a refused resume offering "Start fresh", an auth
 * failure offering "Open Settings") gets the longer {@link ACTION_TOAST_AUTO_DISMISS_MS}
 * rather than no timer at all: the affordance survives the toast — the thread
 * keeps its own auth banner and the usage overview its auth state, and a fresh
 * launch is one "+" away — while a card that never leaves covers the tab strip
 * and the top of every timeline (T3's notices are transient, `sonner` defaults).
 * The remembered auth dismissal still applies, so a timed-out auth toast does
 * not come back for the same failure.
 *
 * The timer restarts whenever `key` changes, so a second notice arriving while
 * the first is up gets its own full reading time rather than inheriting the
 * remains of the previous one.
 */
export const TOAST_AUTO_DISMISS_MS = 12_000;
export const ACTION_TOAST_AUTO_DISMISS_MS = 20_000;

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
