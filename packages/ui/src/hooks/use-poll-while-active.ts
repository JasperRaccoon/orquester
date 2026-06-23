import { useEffect, useRef } from "react";

/**
 * Call `tick` every `intervalMs` while `active` AND the page is visible
 * (document not hidden). Clears the interval when inactive or on unmount; while
 * the page is hidden the tick is skipped (timer keeps running). The first tick
 * fires after one interval — callers refresh on mount/activate themselves.
 *
 * `tick` is read through a ref so the interval is NOT torn down and recreated
 * when the callback's identity changes between renders — a caller may pass an
 * inline (unmemoized) function without silently resetting the timer every render
 * (which would mean the interval never elapses and the poll never fires).
 */
export function usePollWhileActive(active: boolean, tick: () => void, intervalMs = 3000): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (!document.hidden) tickRef.current();
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
}
