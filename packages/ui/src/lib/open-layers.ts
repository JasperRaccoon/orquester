/**
 * The app's open layers: every surface that is up over the rest of the app
 * and closes on Escape — a modal, a bottom sheet, a dropdown or context menu,
 * a composer popover, the command palette. Each registers here for as long as
 * it is open (`useOpenLayer`), and `anotherLayerOwnsTheKeyboard` reads it.
 *
 * **Why a registry and not each layer's own listener.** A layer closes from a
 * `document` listener. The Attention Center's cycle, the chat shell's Escape
 * listener and the composer's `window` arm run before every one of those (on
 * `window`, in the capture phase), and the composer textarea's React handler
 * runs before the bubbling ones — a modal's, a sheet's, a menu's. The shell
 * also stops the event when it acts. So under the output viewer the first
 * Escape interrupted the running turn, and the viewer stayed up. Only the
 * handler that runs first can stand down, and only for a layer it can see:
 * this is how it sees them all, including the ones a later component adds,
 * with no second list to keep in step.
 *
 * Module-level, like the visible chat tab (`agent-chat-active-tab.ts`): the
 * readers are key handlers nowhere near the layers, which portal anywhere.
 */

/** One token per open layer: nesting counts each one, and a release closes its own. */
const openLayers = new Set<symbol>();

/**
 * Count one layer as open until the returned release runs. The release closes
 * exactly this layer and is idempotent — a cleanup that runs twice can never
 * close someone else's, which a counter would.
 */
export function openLayer(): () => void {
  const token = Symbol("open-layer");
  openLayers.add(token);
  return () => {
    openLayers.delete(token);
  };
}

/** True while any layer is open anywhere in the app. */
export function isAnyLayerOpen(): boolean {
  return openLayers.size > 0;
}

/**
 * The effect a layer runs, keyed on `open` (`useOpenLayer`): registered while
 * open, released by the cleanup React runs when `open` turns false, when the
 * layer unmounts open, and between StrictMode's two invocations — so the
 * registry never keeps a phantom layer that would swallow every later Escape.
 */
export function openLayerEffect(open: boolean): (() => void) | undefined {
  return open ? openLayer() : undefined;
}
