import { mock } from "node:test";

/** Far above any healthy test, even on a host with ten runnable processes per core. */
const HANG_GUARD_MS = 5 * 60_000;
/** Past every deadline the app-server client arms (the longest is `plugin/install`'s 120 s). */
const PAST_EVERY_DEADLINE_MS = 24 * 60 * 60_000;

/**
 * A wall-clock safety net for a test running on `mock.timers` (call `mock.timers.enable` first).
 * node:test's own `{ timeout }` runs on the mocked `setTimeout` in Node 20, so it would never fire.
 * Here `AbortSignal.timeout` (not mocked) fires after {@link HANG_GUARD_MS}. Then a wedged fake
 * app-server gets the production treatment: the mocked clock jumps past every pending deadline,
 * which fails the hung call and kills the child, and real timers return for whatever comes next.
 * The guard only ever fails a test: call the returned function in `afterEach` (before
 * `mock.timers.reset()`), and it throws if the guard fired.
 */
export function armHangGuard(): () => void {
  let fired = false;
  const signal = AbortSignal.timeout(HANG_GUARD_MS);
  const onAbort = (): void => {
    fired = true;
    process.emitWarning(`hang guard: the test is still running after ${HANG_GUARD_MS / 60_000} min; running every pending deadline`);
    mock.timers.tick(PAST_EVERY_DEADLINE_MS);
    mock.timers.reset();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
    if (fired) {
      throw new Error(`hang guard: the test was still running after ${HANG_GUARD_MS / 60_000} min`);
    }
  };
}
