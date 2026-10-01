// Suppress only Node 20's MockTimers experimental warning. Package test scripts
// preload this in every worker; all unrelated warnings still reach Node.

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
