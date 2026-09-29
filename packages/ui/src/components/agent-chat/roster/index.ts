/**
 * The roster surface (spec §7.6): the dock under the composer, its rows, the
 * workflow groups, and the subagent drill-in.
 *
 * The pure parts — which rows render and how their text is built — are
 * shared by the dock, workflow groups and drill-in.
 */

export { AgentRoster, useFinishedRowsPhase, ROSTER_FADE_MS } from "./AgentRoster";
export { AgentDrillIn } from "./AgentDrillIn";
export { AgentRosterRow, BackgroundShellRow, RosterMainRow } from "./AgentRosterRow";
export {
  collapsedRosterLabel,
  partitionRosterRows,
  rosterKindCounts,
  shellSectionLabel,
  type RosterKindCounts
} from "./roster-summary";
export type { AgentRosterRowProps, RosterMainRowProps } from "./AgentRosterRow";
export { WorkflowGroup, type WorkflowGroupProps } from "./WorkflowGroup";

export {
  isActiveStatus,
  isFinishedRow,
  isLiveBackgroundRow,
  rosterRowTicks,
  rosterStatusVisual,
  selectRosterRows,
  type FinishedRowsPhase,
  type RosterSelection,
  type RosterStatusVisual,
  type RosterVisibleRow,
  type SelectRosterRowsInput
} from "./roster-rows";

export {
  deriveAgentSpawnSummary,
  type AgentSpawnSummary
} from "../../../lib/agent-chat/roster.logic";

export {
  TOOL_PREFIX,
  agentActivityText,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  rosterRoleChip,
  rosterRowMetrics
} from "./format";
