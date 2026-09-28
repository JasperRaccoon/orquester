import { useEffect, useState } from "react";

/**
 * How much of the layout viewport the visual viewport must lose before it
 * reads as an on-screen keyboard rather than a browser toolbar sliding away
 * (those are ~56–80px; a phone keyboard is 250px and up).
 */
const KEYBOARD_MIN_PX = 150;

function measure(): boolean {
  const viewport = window.visualViewport;
  if (!viewport) return false;
  // A pinch zoom shrinks the visual viewport too; that is not a keyboard.
  if (Math.abs(viewport.scale - 1) > 0.01) return false;
  return window.innerHeight - viewport.height > KEYBOARD_MIN_PX;
}

/**
 * True while a phone's on-screen keyboard is up. Read off the visual viewport
 * (the default `resizes-visual` behaviour of mobile Chrome and Safari: the
 * keyboard shrinks the visual viewport, never the layout one) rather than off
 * focus — a keyboard dismissed with the system back button leaves its field
 * focused. Always false where there is no visual viewport.
 */
export function useSoftKeyboardOpen(): boolean {
  const [open, setOpen] = useState(() => (typeof window === "undefined" ? false : measure()));

  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setOpen(measure());
      });
    };
    setOpen(measure());
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return open;
}
