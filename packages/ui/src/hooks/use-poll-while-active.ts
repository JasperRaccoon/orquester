import { useEffect } from "react";

/**
 * Call `tick` every `intervalMs` while `active` AND the page is visible
 * (document not hidden). Clears the interval when inactive or on unmount; while
 * the page is hidden the tick is skipped (timer keeps running). The first tick
 * fires after one interval — callers refresh on mount/activate themselves.
 */
export function usePollWhileActive(active: boolean, tick: () => void, intervalMs = 3000): void {
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (!document.hidden) tick();
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, tick, intervalMs]);
}
