/**
 * The roster surface (spec §7.6): the dock under the composer, its rows, the
 * workflow groups, and the subagent drill-in.
 *
 * The pure parts — which rows render and how their text is built — are
 * exported too, because they are what the tests and any other surface (a
 * palette entry, a tooltip) should reuse rather than re-derive.
 */

export { AgentRoster, useFinishedRowsPhase, ROSTER_FADE_MS } from "./AgentRoster";
export { AgentDrillIn } from "./AgentDrillIn";
export { AgentRosterRow, BackgroundShellRow, RosterMainRow } from "./AgentRosterRow";
export {
  collapsedRosterLabel,
  expandedRosterLabel,
  partitionRosterRows,
  rosterKindCounts,
  shellSectionLabel,
  type RosterKindCounts
} from "./roster-summary";
export type { AgentRosterRowProps, RosterMainRowProps } from "./AgentRosterRow";
export { WorkflowGroup, type WorkflowGroupProps } from "./WorkflowGroup";

export {
  ROSTER_COLLAPSED_ROWS,
  isActiveStatus,
  isFinishedRow,
  isLiveBackgroundRow,
  rosterDisplayOrder,
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
  type AgentSpawnSummary,
  type AgentSpawnTone
} from "./spawn-summary";

export {
  TOOL_PREFIX,
  agentActivityText,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isLiveStatus,
  rosterRoleChip,
  rosterRowMetrics
} from "./format";
