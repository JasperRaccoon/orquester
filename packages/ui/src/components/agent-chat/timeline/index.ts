/**
 * The timeline (spec §7.3) — W12.
 *
 * `ChatTimeline` is the only component other packages mount; everything else
 * is exported for tests and for the roster's drill-in, which renders this same
 * component with an `agentId`.
 */

export { ChatTimeline, default } from "./ChatTimeline";
export { TimelineRow } from "./TimelineRow";
export {
  TimelineRowContext,
  useTimelineRowContext,
  type TimelineRowContextValue
} from "./context";

export { ChatMarkdown, shouldArmIncrementalParser } from "./markdown/ChatMarkdown";
export { CodeBlock } from "./markdown/CodeBlock";
export { loadLanguageParser, resolvedLanguageParser, useLanguageParser } from "./markdown/languages";
export { tokenColor, tokenPalette, type TokenPalette } from "./markdown/token-theme";
export * from "./markdown/highlight-core";
export {
  createIncrementalMarkdownParser,
  createIncrementalMarkdownPlugin,
  hasDefinitions,
  shiftPositions,
  type MdNode,
  type MdRoot
} from "./markdown/incremental";

export * from "./work-presentation";
export * from "./diff-tree";
export * from "./unified-diff";
export * from "./follow";

export * from "./row-format";
// The spawn summary lives beside the roster (W14), because it resolves against
// the roster model; re-exported here so a timeline consumer finds it.
export {
  deriveAgentSpawnSummary,
  type AgentSpawnSummary,
  type AgentSpawnTone
} from "../roster/spawn-summary";
export {
  formatRowTimestamp,
  formatRowTimestampTooltip,
  TimelineRowTimestamp
} from "./timestamp";
