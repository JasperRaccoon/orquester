/**
 * Agent chat — the component barrel (spec §7).
 *
 * `MainView` dispatches the sixth `ProjectTab` arm (`{type: "agent-chat",
 * sessionId}`) to {@link AgentChatView}; everything else is reached from
 * there. Import prop types from `./contracts`, view models from
 * `../../lib/agent-chat/contracts`.
 */

export { AgentChatView } from "./AgentChatView";
export { ChatTimeline } from "./timeline/ChatTimeline";
export { ChatComposer } from "./composer/ChatComposer";
export { ChatBannerDock } from "./banners/ChatBannerDock";
export { AgentRoster } from "./roster/AgentRoster";
export { AgentDrillIn } from "./roster/AgentDrillIn";
export { ChatStatusLine } from "./status/ChatStatusLine";

export type {
  AgentChatViewProps,
  ChatTimelineProps,
  ChatComposerProps,
  ChatBannerDockProps,
  AgentRosterProps,
  AgentRosterMainRow,
  AgentDrillInProps,
  ChatStatusLineProps
} from "./contracts";
