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
  /**
   * Pausing a continuing goal before a Stop reaches the provider (goals §5.5,
   * §6.2.4). Short on purpose: it is a courtesy in front of the interrupt,
   * which must never wait on it.
   */
  goalPauseMs: 1_500,
  /**
   * The host's own `goalCommand {kind:"resume"}` of a goal it held for a
   * deploy (goals §5.7) — when the hold's lease runs out, and after a
   * handover's session resume. Longer than the pause: right after a session
   * (re)start Codex first waits for its resume snapshot to settle (up to 2 s)
   * and then reads and sets the goal, all inside its own 10 s command window —
   * which this outlasts, so the adapter's more precise refusal is what gets
   * logged.
   */
  goalResumeMs: 12_000,
  /** A prompt submit call (OpenCode's `promptAsync`). */
  submitMs: 10_000,
  /** A generic provider probe (version). */
  probeMs: 4_000,
  /** An auth probe, which may touch disk or the network. */
  authProbeMs: 10_000,
  /**
   * The ceiling for a provider snapshot that may have to **start a server
   * before it can read anything** (E9).
   *
   * OpenCode's catalogue lives behind a per-project `opencode serve`, so a
   * first snapshot is two phases — spawn to readiness ({@link handshakeMs} +
   * {@link healthMs}), then the catalogue reads (each already bounded, the
   * longest {@link authProbeMs}). Budgeting both under the 10 s auth window is
   * what made every cold probe fail: measured 10 435 ms, answered 500, and the
   * user's first visit to Settings showed no OpenCode at all. This is a
   * ceiling, not a target — a warm probe still returns in ~20 ms, and each
   * inner phase keeps its own tighter deadline, so a hang is still caught by
   * the phase that hangs rather than by this.
   */
  coldSnapshotMs: 45_000
} as const;

/**
 * Turn liveness watchdog windows (§3.1). Stated here and nowhere else. The
 * deadline does not start until the protocol has produced observable progress
 * and is **paused entirely while an approval or user-input request is
 * pending** — a turn waiting on a human is not a stalled turn.
 *
 * `goalMs` (goals §5.2) is the window while the thread's goal is `active`: a
 * goal run can be silent far longer than one turn — Grok runs the whole goal
 * inside one prompt turn, and its verifier rounds go quiet for 10–20 minutes.
 * It never SHORTENS the other two; the watchdog takes the longer window.
 */
export const TURN_LIVENESS_WINDOWS = {
  idleMs: 10 * 60_000,
  activeToolMs: 30 * 60_000,
  goalMs: 60 * 60_000
} as const;

/**
 * Agent goals §5.7: how long a `POST /goals/hold` keeps continuing goals held.
 * The daemon renews it on every drain re-evaluation — each settled turn, each
 * 15 s health tick — while a deploy waits, so eight missed ticks mean it has
 * stopped asking (the deploy was withdrawn, or a daemon with this host's own
 * code adopted it), and the host resumes what it held.
 */
export const GOAL_HOLD_LEASE_MS = 120_000;

/**
 * Agent goals §5.7: how long a held goal may sit idle — its own turn over,
 * paused — while OTHER work still keeps the deploy's drain waiting. The
 * daemon renews the lease on every blocked evaluation whatever blocks it, so
 * without this bound a goal held while goals were the last thing in the way
 * would stay paused for as long as a fleet or a long run started later in
 * another tab keeps going — hours. Once idle-held this long it is released
 * (resumed) and may be held again when goals are once more all that is left.
 * Three minutes: other work that is short — a quick question in another tab —
 * must not cause a pause/resume churn of rows, and work that is long must not
 * leave the goal idle for its whole length.
 */
export const GOAL_HOLD_IDLE_MS = 3 * 60_000;

/**
 * Goals §4.7, §5.5: how long a goal the provider continues by itself (Codex)
 * still reads as CONTINUING with no turn running — after its last turn
 * settled, or after its session (re)started. Codex starts the next goal turn
 * at once at such an idle point; a continuation that has not started within
 * this is not work, and the thread must not read "working" forever. The
 * summary is recomputed on every read, so it flips without an event.
 */
export const GOAL_CONTINUATION_GRACE_MS = 60_000;
