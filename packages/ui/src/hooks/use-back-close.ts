import { useEffect, useRef, useState } from "react";

import { pushBackClose } from "../lib/back-close";
import { useIsDesktop } from "./use-media-query";

/**
 * On a phone, Back closes the calling overlay while `open` is true
 * (`lib/back-close.ts`): it holds one history entry for as long as it is
 * open, and gives it back when it closes any other way. Overlays opened over
 * it hold entries of their own, so Back closes them one at a time, newest
 * first. A desktop viewport keeps the browser's own Back.
 *
 * An overlay that refuses the close (a dialog busy with a request, an editor
 * asking "Discard changes?") stays open and takes a fresh entry, so the next
 * Back asks again rather than leaving the app.
 */
export function useBackClose(open: boolean, onClose: () => void): void {
  const phone = !useIsDesktop();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** Bumped by every Back that reached this overlay: re-registers it if it is still open. */
  const [armed, setArmed] = useState(0);
  const active = open && phone;
  useEffect(() => {
    if (!active) return undefined;
    return pushBackClose(() => {
      closeRef.current();
      setArmed((n) => n + 1);
    });
  }, [active, armed]);
}
