/**
 * Agent host — bounded waits (spec §3.1 "Every step that waits on a child has
 * a deadline").
 *
 * This is the one place the design deliberately departs from T3: its Codex
 * handshake is an unbounded await, unblocked only by the child exiting, which
 * turns a provider that starts but never answers into a permanently
 * `starting` thread. Every spawn-to-handshake window, resume/load call, cancel
 * and interrupt in this host goes through {@link withDeadline}.
 */

/** Thrown when a {@link withDeadline} window expires. */
export class DeadlineExceededError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "DeadlineExceededError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export interface DeadlineOptions {
  /** Named in the error message, so an expiry says which step gave up. */
  label: string;
  timeoutMs: number;
  /**
   * Run on expiry — this is where a caller kills the child rather than leaving
   * the thread `starting` forever. Its own failures are swallowed: the
   * deadline error is what the caller needs to see.
   */
  onTimeout?: () => void;
  /** Aborts the wait early; the rejection is this signal's reason. */
  signal?: AbortSignal;
}

/**
 * Race `work` against a timer. The underlying promise is NOT cancelled — it
 * cannot be, in general — so `onTimeout` is what makes the expiry effective.
 * A rejection from `work` after the deadline has already fired is swallowed
 * rather than becoming an unhandled rejection.
 */
export function withDeadline<T>(
  work: Promise<T> | (() => Promise<T>),
  options: DeadlineOptions
): Promise<T> {
  const { label, timeoutMs, onTimeout, signal } = options;
  const promise = typeof work === "function" ? work() : work;

  if (signal?.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          onTimeout?.();
        } catch {
          // The deadline error is what the caller needs; a failing cleanup
          // must not replace it.
        }
        reject(new DeadlineExceededError(label, timeoutMs));
      });
    }, timeoutMs);
    // Deliberately NOT unref'd: `onTimeout` is what kills a wedged child, and
    // a timer the loop is free to skip would let the host exit with the child
    // still running. Callers that need an early exit pass `signal`.

    const onAbort = (): void => {
      finish(() => reject(abortReason(signal!)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason ?? new Error("Aborted");
}

/**
 * The windows §3.1 and §4.5 state. Every adapter reads its deadlines from
 * here so a change is one edit, not four.
 */
export const AGENT_HOST_DEADLINES = {
  /** Spawn to protocol handshake (`initialize`, or the server's ready line). */
  handshakeMs: 30_000,
  /** A health call after a server reports ready. */
  healthMs: 5_000,
  /** `session/new`, `session/load`, `thread/resume`. */
  sessionOpenMs: 90_000,
  /** One provider cancel, after which the child is retired. */
  cancelMs: 15_000,
  /** One child turn's interrupt during a fleet stop. */
  interruptChildMs: 3_000,
  /** The whole fleet interrupt, however many children there are. */
  interruptAllMs: 10_000,
  /** A prompt submit call (OpenCode's `promptAsync`). */
  submitMs: 10_000,
  /** A generic provider probe (version). */
  probeMs: 4_000,
  /** An auth probe, which may touch disk or the network. */
  authProbeMs: 10_000
} as const;

/**
 * Turn liveness watchdog windows (§3.1). Stated here and nowhere else. The
 * deadline does not start until the protocol has produced observable progress
 * and is **paused entirely while an approval or user-input request is
 * pending** — a turn waiting on a human is not a stalled turn.
 */
export const TURN_LIVENESS_WINDOWS = {
  idleMs: 10 * 60_000,
  activeToolMs: 30 * 60_000
} as const;
