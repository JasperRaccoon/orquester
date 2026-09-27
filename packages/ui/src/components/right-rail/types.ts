/** The right rail's panels, in rail order. */
export type RightRailPanelId = "prompts" | "history";

/** What both panels receive from the rail — docked on desktop, inside the sheet on mobile. */
export interface RightRailPanelProps {
  /** The chat the panel acts on: the visible chat tab (the focused grid cell), or `null`. */
  sessionId: string | null;
  /** The open project's directory. */
  projectPath: string;
  /** Docked beside the tab content (desktop), or inside the mobile bottom sheet. */
  variant: "docked" | "sheet";
  /** An Insert or a Send landed — the mobile sheet closes on it. */
  onDelivered?: () => void;
}
