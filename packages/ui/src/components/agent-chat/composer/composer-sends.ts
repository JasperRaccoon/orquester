/**
 * Which threads have a composer send in flight (§7.4) — kept OUTSIDE the
 * composer, because the send outlives it.
 *
 * `submit` clears the draft and posts the turn; the post settles whenever its
 * transport answers, retries included (`withCommandRetries` in the thread
 * store: the same `commandId`, backing off while the host restarts, and still
 * going after the store generation that posted it was torn down). A project
 * switch unmounts the composer meanwhile, and the composer that shows the
 * thread when its tab comes back is a new instance: a "sending" flag in
 * component state started out `false` there, and the user could send the same
 * message again — a second `commandId`, which no receipt dedupes, and a
 * duplicate turn.
 *
 * So every send registers here under the thread it left FROM, and settles its
 * OWN entry — never the thread's, never another thread's. A thread is sending
 * while any of its entries is open; every reader of it (the send button and
 * Enter, the rewind picker and "Rewind to here", the account chip) reads that.
 *
 * Module-level, like the composer bridge's handles and the dismissed error
 * banners, because it must outlive the thread store's generation too: that is
 * torn down 2 s after the tab unmounts, while the post keeps running. In
 * memory only: a reload aborts the post, and whatever landed arrives on the
 * stream. Nothing clears an entry but its own settle — not an unmount, not a
 * tab close (a project switch unmounts too).
 */

type Listener = () => void;

const inFlight = new Map<string, Set<symbol>>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Open one send from `sessionId`. Returns its settle: idempotent, and it
 * closes exactly this send's entry, so two overlapping sends on one thread
 * each close their own.
 */
export function beginComposerSend(sessionId: string): () => void {
  const token = Symbol(sessionId);
  let sends = inFlight.get(sessionId);
  if (!sends) {
    sends = new Set();
    inFlight.set(sessionId, sends);
  }
  sends.add(token);
  notify();
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    const current = inFlight.get(sessionId);
    if (!current || !current.delete(token)) return;
    if (current.size === 0) inFlight.delete(sessionId);
    notify();
  };
}

/** True while any send from this thread is in flight. */
export function isComposerSending(sessionId: string): boolean {
  return (inFlight.get(sessionId)?.size ?? 0) > 0;
}

/** Hear about every change. Returns the unsubscribe. */
export function subscribeComposerSends(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget every send in flight. */
export function resetComposerSends(): void {
  inFlight.clear();
  notify();
}
