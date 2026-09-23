// Preloaded by this package's `test` script (`node --import ./test/quiet-mock-timers.mjs`).
//
// node:test's MockTimers is still experimental on Node 20: the first `mock.timers` in a process
// prints "ExperimentalWarning: The MockTimers API is an experimental feature and might change at
// any time", once for every test file that fakes a clock. That warning has no code, and
// `--disable-warning=ExperimentalWarning` would hide every other experimental feature too, so this
// wraps `process.emitWarning` — which Node's own `emitExperimentalWarning` calls — and drops
// exactly that one warning. Every other warning, experimental or not, reaches Node unchanged.
//
// `node --test` hands its `--import` flags on to the child process each test file runs in, which
// is where the warning is emitted.

const MOCK_TIMERS = "The MockTimers API";
const nodeEmitWarning = process.emitWarning;

process.emitWarning = function emitWarning(...args) {
  if (isMockTimersWarning(args[0], args[1])) return;
  return Reflect.apply(nodeEmitWarning, this, args);
};

// Types the warning the way `process.emitWarning` does: an Error by its name, a string by the
// `type` argument or by the `type` of an options object.
function isMockTimersWarning(warning, typeOrOptions) {
  const type =
    warning instanceof Error ? warning.name
    : typeof typeOrOptions === "object" && typeOrOptions !== null ? typeOrOptions.type
    : typeOrOptions;
  const message = warning instanceof Error ? warning.message : warning;
  return type === "ExperimentalWarning" && typeof message === "string" && message.startsWith(MOCK_TIMERS);
}
