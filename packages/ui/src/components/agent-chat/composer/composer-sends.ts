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
 *
 * Beside it, the same kind of marker for the thread's QUEUED sends
 * ({@link beginQueuedSend}): the queue sends one message at a time, and the
 * one on its way may belong to a store generation that is already gone.
 */

/**
 * One token per send, per thread: a thread counts while any of its tokens is
 * open, and each settle closes its own token only, once.
 */
function perThreadTokens(onChange: (sessionId: string) => void) {
  const open = new Map<string, Set<symbol>>();
  return {
    begin(sessionId: string): () => void {
      const token = Symbol(sessionId);
      let tokens = open.get(sessionId);
      if (!tokens) {
        tokens = new Set();
        open.set(sessionId, tokens);
      }
      tokens.add(token);
      onChange(sessionId);
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        const current = open.get(sessionId);
        if (!current || !current.delete(token)) return;
        if (current.size === 0) open.delete(sessionId);
        onChange(sessionId);
      };
    },
    has(sessionId: string): boolean {
      return (open.get(sessionId)?.size ?? 0) > 0;
    },
    /** Forget every token; answers the threads that had one. */
    clear(): string[] {
      const threads = [...open.keys()];
      open.clear();
      return threads;
    }
  };
}

type Listener = () => void;

const listeners = new Set<Listener>();
const composerSends = perThreadTokens(() => {
  for (const listener of [...listeners]) listener();
});

/**
 * Open one send from `sessionId`. Returns its settle: idempotent, and it
 * closes exactly this send's entry, so two overlapping sends on one thread
 * each close their own.
 */
export function beginComposerSend(sessionId: string): () => void {
  return composerSends.begin(sessionId);
}

/** True while any send from this thread is in flight. */
export function isComposerSending(sessionId: string): boolean {
  return composerSends.has(sessionId);
}

/** Hear about every change. Returns the unsubscribe. */
export function subscribeComposerSends(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// The queue's send in flight (§7.4)
// ---------------------------------------------------------------------------

type QueuedListener = (sessionId: string) => void;

const queuedListeners = new Set<QueuedListener>();
const queuedSends = perThreadTokens((sessionId) => {
  for (const listener of [...queuedListeners]) listener(sessionId);
});

/**
 * Open one QUEUED send of `sessionId` — a queued message on its way out, from
 * whichever generation of the thread's store took it. Until every one of them
 * settles, no generation of the thread sends the next queued message: the
 * generation a project switch tore down may still be posting the head of the
 * queue when the thread's next generation — seeded without it, the head had
 * already left the queue — reaches a boundary, and sending the next one then
 * could land it first, or overtake the head outright when that fails and is
 * held at the front. When the last one settles the queue proceeds, in order:
 * a delivered one lets the next go; a failed one is back at the front, held,
 * before its settle is heard.
 *
 * Not a composer send: a queued message never makes the thread read
 * "Sending", as it never did.
 */
export function beginQueuedSend(sessionId: string): () => void {
  return queuedSends.begin(sessionId);
}

/** True while a queued send of this thread is in flight, from any generation. */
export function isQueuedSendInFlight(sessionId: string): boolean {
  return queuedSends.has(sessionId);
}

/** Hear which thread's queued send opened or settled. Returns the unsubscribe. */
export function subscribeQueuedSends(listener: QueuedListener): () => void {
  queuedListeners.add(listener);
  return () => {
    queuedListeners.delete(listener);
  };
}

/** Test seam: forget every send in flight, composer and queued. */
export function resetComposerSends(): void {
  composerSends.clear();
  for (const listener of [...listeners]) listener();
  for (const sessionId of queuedSends.clear()) {
    for (const listener of [...queuedListeners]) listener(sessionId);
  }
}
