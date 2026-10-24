/**
 * The one reconnect policy every channel that redials the daemon shares: the
 * store's connection loop, the terminal and browser WebSockets, agent-chat
 * streams, git watches, desktop VNC and audio.
 *
 * Exponential backoff with full jitter, capped. Without jitter every client of
 * a restarted daemon (and every channel inside each client) redials in the
 * same instant; full jitter spreads them over the whole window. The cap keeps
 * a client that can never connect from retrying ever more rarely. A wake (the
 * device came back online, or the page became visible again) fires every
 * pending retry at once instead of leaving it to a timer the browser may have
 * throttled or frozen while the page was hidden.
 */

export interface BackoffPolicy {
  /** Ceiling of the first retry's delay. */
  baseMs: number;
  /** Largest ceiling any retry reaches. */
  maxMs: number;
}

/** The default: retries spread over 0.5 s, then 1 s, 2 s, … up to 30 s. */
export const RECONNECT_BACKOFF: BackoffPolicy = { baseMs: 500, maxMs: 30_000 };

/** The longest delay retry `attempt` (0-based) may wait. */
export function backoffCeilingMs(attempt: number, policy: BackoffPolicy = RECONNECT_BACKOFF): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  // The exponent is clamped so a long outage cannot overflow to Infinity.
  return Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(n, 30));
}

/**
 * The delay before retry `attempt` (0-based): uniform over `[0, ceiling]`.
 */
// Adapted from T3 Code (MIT): packages/client-runtime/src/connection/supervisor.ts
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = RECONNECT_BACKOFF,
  random: () => number = Math.random
): number {
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(unit * backoffCeilingMs(attempt, policy));
}

// ---------------------------------------------------------------------------
// Wakes
// ---------------------------------------------------------------------------

const wakeListeners = new Set<() => void>();

/**
 * Fire every pending {@link scheduleRetry} now. The app calls it when the
 * device comes back online or the page becomes visible again.
 */
export function wakeReconnects(): void {
  for (const listener of [...wakeListeners]) {
    listener();
  }
}

/**
 * Hear every wake, for a channel that is connected rather than waiting — a
 * stream checks whether its connection outlived the freeze. Returns the
 * unsubscribe.
 */
export function onWake(listener: () => void): () => void {
  wakeListeners.add(listener);
  return () => {
    wakeListeners.delete(listener);
  };
}

/** A retry waiting for its delay or a wake. */
export interface PendingRetry {
  cancel(): void;
}

/**
 * Run `retry` after `delayMs`, or at once on {@link wakeReconnects}. `retry`
 * learns which one happened, so a woken retry can start its backoff over: the
 * condition that made it wait has likely changed.
 */
export function scheduleRetry(delayMs: number, retry: (woken: boolean) => void): PendingRetry {
  let settled = false;
  const settle = (): boolean => {
    if (settled) {
      return false;
    }
    settled = true;
    clearTimeout(timer);
    wakeListeners.delete(onWake);
    return true;
  };
  const onWake = (): void => {
    if (settle()) retry(true);
  };
  const timer = setTimeout(() => {
    if (settle()) retry(false);
  }, delayMs);
  wakeListeners.add(onWake);
  return { cancel: () => void settle() };
}
