/**
 * The phone's Back button (Android's hardware or gesture Back, a browser's
 * Back) closes the topmost open overlay instead of leaving the app: the
 * drawer, a bottom sheet, a mobile section, a modal, a workflow sheet. Each
 * open overlay owns one history entry; a Back closes the newest overlay, and
 * an overlay closed any other way takes one entry back off, so the next Back
 * neither does nothing nor closes two. Nothing here navigates: the entries
 * carry no URL change, only their depth (`orqBackClose`).
 *
 * The entries are counted, not matched to their overlay: they all look the
 * same, so when an inner overlay outlives the outer one that closed under it,
 * any one of them may go. History only ever moves to make the count of entries
 * match the count of open overlays, once per task (an overlay that closes as
 * another opens moves nothing), and never while a move of ours is still
 * travelling (`history.go` is asynchronous: an entry pushed before it lands
 * would be the one it pops).
 */

/** Where an entry records its depth: how many of our entries it stands on, itself included. */
const DEPTH_KEY = "orqBackClose";

interface Entry {
  close: () => void;
}

/** What the stack needs of `window`; a fake one in tests. */
export interface BackCloseHost {
  history: Pick<History, "state" | "pushState" | "go">;
  addEventListener: (type: "popstate", listener: () => void) => void;
}

export interface BackCloseStack {
  /** Register an open overlay; returns what to call when it closes on its own (idempotent). */
  push: (close: () => void) => () => void;
}

function depthOf(state: unknown): number {
  const depth = state && typeof state === "object" ? (state as Record<string, unknown>)[DEPTH_KEY] : undefined;
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 0;
}

export function createBackCloseStack(host: BackCloseHost): BackCloseStack {
  /** Open overlays, oldest first. */
  const stack: Entry[] = [];
  /** Our entries on the history, as of the current entry (a reload keeps the old ones: they are reused). */
  let depth = -1;
  /** A `history.go` of ours whose `popstate` has not arrived yet. */
  let travelling = false;
  let scheduled = false;
  let listening = false;

  const sync = (): void => {
    scheduled = false;
    if (travelling) return;
    if (depth < stack.length) {
      try {
        while (depth < stack.length) {
          depth += 1;
          const state: unknown = host.history.state;
          host.history.pushState({ ...(state && typeof state === "object" ? state : {}), [DEPTH_KEY]: depth }, "");
        }
      } catch {
        // A sandboxed frame may refuse; Back then does what it always did.
        depth = depthOf(host.history.state);
      }
    } else if (depth > stack.length) {
      const extra = depth - stack.length;
      depth = stack.length;
      travelling = true;
      try {
        host.history.go(-extra);
      } catch {
        travelling = false;
        depth = depthOf(host.history.state);
      }
    }
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(sync);
  };

  const onPopState = (): void => {
    travelling = false;
    const now = depthOf(host.history.state);
    // A Back past entries of ours closes that many overlays, newest first. (A
    // Forward onto an old entry closes nothing; the sync below backs off it.)
    let closing = Math.max(0, depth - now);
    depth = now;
    while (closing > 0 && stack.length > 0) {
      closing -= 1;
      stack.pop()?.close();
    }
    sync();
  };

  return {
    push: (close) => {
      if (!listening) {
        host.addEventListener("popstate", onPopState);
        listening = true;
      }
      if (depth < 0) depth = depthOf(host.history.state);
      const entry: Entry = { close };
      stack.push(entry);
      schedule();
      return () => {
        const index = stack.indexOf(entry);
        if (index < 0) return; // Back already closed it.
        stack.splice(index, 1);
        schedule();
      };
    }
  };
}

let shared: BackCloseStack | null = null;

/**
 * Register an open overlay with the app's one stack; returns what to call
 * when it closes on its own. A Back calls `close` (once) and drops the entry:
 * an overlay that refused to close registers again (`useBackClose` does).
 */
export function pushBackClose(close: () => void): () => void {
  if (typeof window === "undefined" || typeof window.history?.pushState !== "function") return () => undefined;
  shared ??= createBackCloseStack(window);
  return shared.push(close);
}
