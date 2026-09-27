export { SavedPromptsPanel } from "./saved-prompts/SavedPromptsPanel";
export { SavedPromptEditorHost } from "./saved-prompts/SavedPromptEditorHost";
export {
  openSavedPromptEditor,
  subscribeSavedPromptEditor,
  subscribeSavedPromptEditorOpened,
  type SavedPromptEditorRequest
} from "./saved-prompts/editor-bridge";
export { PromptHistoryPanel } from "./history/PromptHistoryPanel";
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
  RightRailSheet,
  RightRailSheetBody,
  RightRailSheetButton,
  type RightRailSheetBodyProps,
  type RightRailSheetProps
} from "./RightRailSheet";
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
  setRightRailSheetPanel,
  setRightRailWidth,
  subscribeRightRail,
  toggleRightRailPanel,
  useRightRailState,
  type RightRailState
} from "./right-rail-state";
