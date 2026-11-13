import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { pushBackClose } from "../lib/back-close";
import { useIsDesktop } from "./use-media-query";

/** Whether overlays below take the phone's Back: on unless a provider turns it off. */
const BackCloseEnabled = createContext(true);

/**
 * Turns Back-to-close on or off for every overlay below it. Off in the
 * embeddable chat (`apps/web/src/embed/`): the history is the host page's, so
 * nothing there may push entries, move it or listen to its `popstate`.
 */
export function BackCloseProvider(props: { enabled: boolean; children?: ReactNode }): ReactElement {
  return createElement(BackCloseEnabled.Provider, { value: props.enabled }, props.children);
}

/**
 * On a phone, Back closes the calling overlay while `open` is true
 * (`lib/back-close.ts`): it holds one history entry for as long as it is
 * open, and gives it back when it closes any other way. Overlays opened over
 * it hold entries of their own, so Back closes them one at a time, newest
 * first. A desktop viewport keeps the browser's own Back, as does every
 * overlay under a {@link BackCloseProvider} that turns it off.
 *
 * An overlay that refuses the close (a dialog busy with a request, an editor
 * asking "Discard changes?") stays open and takes a fresh entry, so the next
 * Back asks again rather than leaving the app.
 */
export function useBackClose(open: boolean, onClose: () => void): void {
  const phone = !useIsDesktop();
  const enabled = useContext(BackCloseEnabled);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** Bumped by every Back that reached this overlay: re-registers it if it is still open. */
  const [armed, setArmed] = useState(0);
  const active = open && phone && enabled;
  useEffect(() => {
    if (!active) return undefined;
    return pushBackClose(() => {
      closeRef.current();
      setArmed((n) => n + 1);
    });
  }, [active, armed]);
}
