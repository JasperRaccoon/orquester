/**
 * The status line, the context-window meter (spec §7.6) and the goal chip
 * (goals §8.2).
 */

export { ChatStatusLine } from "./ChatStatusLine";
export { ContextMeter, ContextMeterPanel, type ContextMeterProps } from "./ContextMeter";
export { GoalChip, GoalPanel, type GoalChipProps, type GoalPanelProps } from "./GoalChip";

export {
  deriveGoalChip,
  deriveGoalPanel,
  formatGoalPhase,
  goalActions,
  goalActionsNote,
  GOAL_ACTION_TEXT,
  GOAL_ACTIONS_WAIT_NOTE,
  type GoalActionModel,
  type GoalActionsInput,
  type GoalChipModel,
  type GoalChipTone,
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
