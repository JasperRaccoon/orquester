/**
 * The status line, the context-window meter (spec §7.6) and the goal chip
 * (goals §8.2).
 */

export { ChatStatusLine } from "./ChatStatusLine";
export { ContextMeter, type ContextMeterProps } from "./ContextMeter";
export { GoalChip, type GoalChipProps } from "./GoalChip";

export {
  deriveGoalChip,
  deriveGoalPanel,
  goalActions,
  goalActionsNote,
  GOAL_ACTION_TEXT,
  type GoalActionModel,
  type GoalActionsInput,
  type GoalChipModel,
  type GoalChipTone,
  type GoalHoldOptions,
  type GoalPanelModel
} from "./goal-chip";

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
