/**
 * The phone's Back button closes the topmost workflow sheet (workflows spec
 * §7.4) instead of leaving the app: each open sheet pushes one history entry,
 * a `popstate` closes the top one, and a sheet closed any other way takes its
 * own entry back off. Nothing here navigates: the entries carry no URL change.
 */

interface Entry {
  id: number;
  close: () => void;
}

const stack: Entry[] = [];
let nextId = 1;
let listening = false;
/** `history.back()` calls of our own still to arrive as a `popstate`. */
let ownBacks = 0;
/** Sheets opened while one of those is on its way: their entries are pushed once it lands. */
const deferred: Entry[] = [];

function pushEntry(entry: Entry): void {
  try {
    window.history.pushState({ ...(window.history.state ?? {}), orqWorkflowSheet: entry.id }, "");
  } catch {
    // A sandboxed frame may refuse; Back then does what it always did.
  }
}

function onPopState(): void {
  if (ownBacks > 0) {
    ownBacks -= 1;
    if (ownBacks === 0) for (const entry of deferred.splice(0)) if (stack.includes(entry)) pushEntry(entry);
    return;
  }
  const top = stack.pop();
  top?.close();
}

function canUseHistory(): boolean {
  return typeof window !== "undefined" && typeof window.history?.pushState === "function";
}

/** Register an open sheet; returns what to call when it closes on its own. */
export function pushBackClose(close: () => void): () => void {
  if (!canUseHistory()) return () => undefined;
  if (!listening) {
    window.addEventListener("popstate", onPopState);
    listening = true;
  }
  const entry: Entry = { id: nextId++, close };
  stack.push(entry);
  if (ownBacks > 0) deferred.push(entry);
  else pushEntry(entry);
  return () => {
    const index = stack.indexOf(entry);
    if (index < 0) return; // Back already closed it.
    stack.splice(index, 1);
    const waiting = deferred.indexOf(entry);
    if (waiting >= 0) {
      deferred.splice(waiting, 1);
      return;
    }
    const state = window.history.state as { orqWorkflowSheet?: number } | null;
    if (state?.orqWorkflowSheet === entry.id) {
      ownBacks += 1;
      try {
        window.history.back();
      } catch {
        ownBacks -= 1;
      }
    }
  };
}
