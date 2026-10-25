// --- Main window lifecycle during a titlebar rebuild ---
//
// Turning "Custom titlebar" on or off rebuilds the main window (main.ts
// `createWindow(replacing)`): the replacement loads hidden while the old
// window stays on screen, then takes over. These rules keep every other way
// in — the tray, a second launch, a notification click, the menu — from
// opening a third window or talking to the page that is about to go.

export type ShowWindowPlan = "show-main" | "create" | "wait";

/**
 * What "show the window" does: bring the main window forward (mid-rebuild
 * that is the old one, still on screen — the replacement follows it once it
 * can paint); create one only when there is none and none is on its way.
 */
export function planShowWindow(state: { hasMain: boolean; rebuilding: boolean }): ShowWindowPlan {
  if (state.hasMain) return "show-main";
  return state.rebuilding ? "wait" : "create";
}

/** A replacement takes over showing only if the window it replaces was showing (not hidden to the tray). */
export function replacementShows(replaced: { destroyed: boolean; visible: boolean }): boolean {
  return !replaced.destroyed && replaced.visible;
}

/**
 * Whether a message for the renderer can go now: only to a main window whose
 * page has loaded, and never mid-rebuild, when the page on screen is about
 * to be destroyed — it waits for the replacement instead.
 */
export function canDeliverToRenderer(state: { mainLoaded: boolean; rebuilding: boolean }): boolean {
  return state.mainLoaded && !state.rebuilding;
}

/** Messages waiting for a page to deliver them to, oldest first; the oldest are dropped past `max`. */
export class RendererOutbox<T> {
  private readonly queue: T[] = [];

  push(message: T): void {
    this.queue.push(message);
    if (this.queue.length > 20) this.queue.splice(0, this.queue.length - 20);
  }

  /** Take every waiting message. */
  drain(): T[] {
    return this.queue.splice(0);
  }

}
