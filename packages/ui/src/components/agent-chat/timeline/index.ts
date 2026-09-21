/**
 * The timeline (spec §7.3) — W12.
 *
 * `ChatTimeline` is the only component other packages mount; everything else
 * is exported for tests and for the roster's drill-in, which renders this same
 * component with an `agentId`.
 */

export { ChatTimeline, default } from "./ChatTimeline";
export { TimelineRow, rowBottomPadding } from "./TimelineRow";
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

export { deriveAgentSpawnSummary, type AgentSpawnSummary } from "./rows/ActivityRows";
export { compactionLabel, formatTokenCount, planFileName, proposedPlanTitle } from "./rows/StructureRows";
export { queuedStatusLabel, shouldClampUserMessage } from "./rows/MessageRows";
export { looksLikeUnifiedDiff } from "./rows/InlineDiff";
