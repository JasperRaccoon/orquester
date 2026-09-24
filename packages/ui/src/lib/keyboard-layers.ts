/**
 * Which floating layers are open right now: dropdowns and popovers, modals,
 * sheets, context menus.
 *
 * Every one of them closes on Escape with a `document` listener, and every one
 * is portaled to `document.body`, outside whatever surface opened it. So the
 * surfaces that ALSO act on Escape through a capture-phase `window` listener —
 * the chat shell interrupts a running turn, and a bare idle Escape counts
 * toward the Esc-Esc rewind — run first and never learn that the key was the
 * layer's. The goal popover (goals §8.2) showed it: Escape on the open popover
 * during a turn stopped the turn (on Codex, paused the goal through Stop) and
 * the popover stayed open, because the shell's `stopPropagation` starved the
 * layer's own listener.
 *
 * So an open layer registers here while it is open, and
 * `anotherLayerOwnsTheKeyboard` — the one gate every such listener already
 * reads — stands them down: the layer closes, and that is all the Escape
 * does. A count, not a flag, because layers nest (a dropdown inside a modal).
 *
 * No React import: a layer registers from its own open-state effect.
 */

let openLayers = 0;

/**
 * Register one open layer. Returns its release, which is idempotent — an
 * effect cleanup that runs twice never releases somebody else's layer.
 */
export function openKeyboardLayer(): () => void {
  openLayers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openLayers -= 1;
  };
}

/** Some floating layer is open, so Escape is its to close. */
export function keyboardLayerOpen(): boolean {
  return openLayers > 0;
}

/** Test seam: forget every registration. */
export function resetKeyboardLayers(): void {
  openLayers = 0;
}
