// Ported from T3 Code (MIT): apps/web/src/lib/visibleAnimation.ts

import React from "react";

/**
 * Pauses a looping chat animation whenever it cannot be seen.
 *
 * One shared `IntersectionObserver`, one `visibilitychange` listener and one
 * `prefers-reduced-motion` query drive every animated element in the app; each
 * observed node gets `--ac-anim-state` set to `running` or `paused`, which
 * every looping `ac-*` utility in `styles/agent-chat.css` consumes as its
 * `animation-play-state`.
 *
 * This matters more here than it looks: a busy thread can hold a shimmering
 * group label, a working row, a dozen roster dots and a spinner at once, and a
 * chat tab is routinely left open in a background window for hours.
 *
 * DELIBERATE DIFFERENCE FROM T3: the CSS defaults to `running`, so an element
 * that never gets observed still animates (T3 defaults to `paused`, where a
 * forgotten ref means a silently dead indicator). Attaching this is the
 * optimisation, not the switch that turns motion on.
 *
 * Usage — attach to the *stable* container, not to the node that re-renders:
 * ```tsx
 * const animate = useVisibleAnimation();
 * return <span ref={animate} className="ac-shimmer">{label}</span>;
 * ```
 */

interface Observed {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
}

const observed = new Map<Element, Observed>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

function apply(entry: Observed): void {
  const running =
    entry.intersecting && document.visibilityState === "visible" && reducedMotion?.matches !== true;
  entry.element.style.setProperty("--ac-anim-state", running ? "running" : "paused");
  entry.element.style.setProperty("--ac-anim-will-change", running ? "transform" : "auto");
}

function applyAll(): void {
  for (const entry of observed.values()) apply(entry);
}

/** Imperative form, for code that already owns a node. Returns a detach fn. */
export function observeVisibleAnimation(
  element: HTMLElement | SVGElement | null
): (() => void) | undefined {
  if (element === null) return undefined;
  if (typeof IntersectionObserver === "undefined") return undefined;

  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", applyAll);
    document.addEventListener("visibilitychange", applyAll);
    observer = new IntersectionObserver((entries, source) => {
      // A stale observer's callback can still fire after `disconnect()`.
      if (source !== observer) return;
      for (const entry of entries) {
        const tracked = observed.get(entry.target);
        if (!tracked) continue;
        tracked.intersecting = entry.isIntersecting;
        apply(tracked);
      }
    });
  }

  const entry: Observed = { element, intersecting: false };
  observed.set(element, entry);
  observer.observe(element);
  // Assume visible until the first callback lands, so an element that mounts
  // on screen never shows a frozen frame for one tick.
  entry.intersecting = true;
  apply(entry);

  return () => {
    // Guard against a detach that races a re-observe of the same node.
    if (observed.get(element) !== entry) return;
    observed.delete(element);
    observer?.unobserve(element);
    element.style.removeProperty("--ac-anim-state");
    element.style.removeProperty("--ac-anim-will-change");
    if (observed.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", applyAll);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", applyAll);
    }
  };
}

/** React ref-callback form. Stable across renders. */
export function useVisibleAnimation(): (element: HTMLElement | SVGElement | null) => void {
  const detach = React.useRef<(() => void) | undefined>(undefined);
  React.useEffect(() => () => detach.current?.(), []);
  return React.useCallback((element: HTMLElement | SVGElement | null) => {
    detach.current?.();
    detach.current = observeVisibleAnimation(element);
  }, []);
}
