import { useEffect, useState } from "react";

function measure(): number {
  // Rounded: the visual viewport reports fractional px on a zoomed/pinched
  // page, and a sub-pixel delta would re-render the whole shell (and re-fit
  // every terminal) for no visible change.
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

/**
 * The visual viewport height in px (falls back to innerHeight). Used to size
 * the app shell so it always fits *above* the on-screen keyboard — the layout
 * (and the in-flow terminal + key bar) deterministically resizes instead of
 * being overlaid, avoiding scroll jumps and element flashes.
 */
export function useViewportHeight(): number {
  const [height, setHeight] = useState(() => (typeof window === "undefined" ? 0 : measure()));

  useEffect(() => {
    // The keyboard animation fires resize+scroll many times per frame; coalesce
    // to one measurement per frame so the shell re-lays-out once, not per event.
    let frame = 0;
    const update = () => {
      if (frame !== 0) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        setHeight(measure());
      });
    };
    setHeight(measure());
    window.visualViewport?.addEventListener("resize", update);
    // iOS scrolls the layout viewport under the keyboard and only reports the
    // final height on a visualViewport `scroll` — without this the shell keeps
    // the pre-keyboard height for the rest of the interaction.
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return height;
}
