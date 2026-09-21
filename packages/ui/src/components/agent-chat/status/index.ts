/**
 * The status line and the context-window meter (spec §7.6).
 */

export { ChatStatusLine } from "./ChatStatusLine";
export { ContextMeter, type ContextMeterProps } from "./ContextMeter";

export {
  deriveContextMeter,
  formatAutoCompactionSentence,
  formatContextTokens,
  formatContextUsage,
  type ContextMeterInput,
  type ContextMeterModel
} from "./context-meter";

export {
  formatPlanProgress,
  planIsRunning,
  resolveStatusLine,
  type StatusLineInput,
  type StatusLineModel
} from "./status-line";
