export { SavedPromptsPanel } from "./saved-prompts/SavedPromptsPanel";
export { SavedPromptEditorHost } from "./saved-prompts/SavedPromptEditorHost";
export {
  openSavedPromptEditor,
  subscribeSavedPromptEditor,
  type SavedPromptEditorRequest
} from "./saved-prompts/editor-bridge";
export { PromptHistoryPanel } from "./history/PromptHistoryPanel";
export { WorkflowsPanel } from "./workflows/WorkflowsPanel";
export { AgentProfilePanel } from "./agent-profile/AgentProfilePanel";
export { AgentProfileEditorHost } from "./agent-profile/AgentProfileEditorHost";
export {
  notifyAgentProfileEditorSaved,
  openAgentProfileEditor,
  subscribeAgentProfileEditor,
  subscribeAgentProfileEditorSaved,
  type AgentProfileEditorRequest,
  type AgentProfileEditorSaved
} from "./agent-profile/editor-bridge";
export {
  insertIntoChat,
  NO_CHAT_TARGET_REASON,
  sendToChat,
  useActiveChatTarget,
  type ChatDelivery
} from "./chat-target";
export type { RightRailPanelId, RightRailPanelProps } from "./types";
export { RightRail, type RightRailProps } from "./RightRail";
export { RightRailDock, type RightRailDockProps } from "./RightRailDock";
export {
  openProjectPathOf,
  RightRailEditorHost,
  RightRailFrame,
  RightRailRow,
  useOpenProjectPath,
  type RightRailRowProps
} from "./RightRailFrame";
export {
  MOBILE_SECTION_BAR_MAX,
  MobileSectionBar,
  MobileSectionNav,
  MobileSectionOverlay,
  MobileSectionView,
  splitSectionItems,
  type MobileSectionBarProps,
  type MobileSectionViewProps
} from "./MobileSections";
export { mobileSection, setMobileSection, subscribeMobileSection, useMobileSection } from "./mobile-section";
export {
  RIGHT_RAIL_DOCK_ID,
  RIGHT_RAIL_PANEL_ORDER,
  RIGHT_RAIL_PANEL_REGISTRY,
  type RightRailPanelRegistry,
  type RightRailPanelSpec
} from "./panels";
export {
  RIGHT_RAIL_WIDTH_DEFAULT,
  RIGHT_RAIL_WIDTH_MAX,
  RIGHT_RAIL_WIDTH_MIN,
  resetRightRailWidth,
  rightRailState,
  setRightRailOpen,
  setRightRailWidth,
  subscribeRightRail,
  toggleRightRailPanel,
  useRightRailState,
  type RightRailState
} from "./right-rail-state";
