import { useEffect, useState } from "react";

export interface VisualViewportBox {
  /** The visual viewport's top in layout-viewport px (iOS scrolls it under the keyboard). */
  top: number;
  height: number;
  /** An on-screen keyboard is up (the visual viewport lost ≥ 150 px). */
  keyboard: boolean;
}

function measure(): VisualViewportBox {
  const viewport = typeof window !== "undefined" ? window.visualViewport : null;
  if (!viewport) {
    const height = typeof window !== "undefined" ? window.innerHeight : 0;
    return { top: 0, height, keyboard: false };
  }
  const zoomed = Math.abs(viewport.scale - 1) > 0.01;
  return {
    top: Math.round(viewport.offsetTop),
    height: Math.round(viewport.height),
    keyboard: !zoomed && window.innerHeight - viewport.height > 150
  };
}

/**
 * The visible part of the screen, for a fixed overlay that must stay above the
 * soft keyboard (a sheet, a full-screen editor): position it at `top` with
 * `height` and the focused field is never behind the keyboard. One
 * measurement per frame, like `useViewportHeight`.
 */
export function useVisualViewportBox(active = true): VisualViewportBox {
  const [box, setBox] = useState(measure);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const update = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setBox((current) => {
          const next = measure();
          return next.top === current.top && next.height === current.height && next.keyboard === current.keyboard ? current : next;
        });
      });
    };
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  return box;
}
