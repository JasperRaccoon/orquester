/** Every panel the rail's registry knows — all of them are a phone's sections. */
export type RightRailPanelId = "prompts" | "history" | "workflows" | "profile";

/**
 * The panels the desktop dock hosts: the ones about the visible chat. Workflows
 * and the agent profile live in the left sidebar on desktop (`sidebar/ActivityBar.tsx`).
 */
export type DockPanelId = "prompts" | "history";

/** What every panel receives from the rail — docked on desktop, inside the sheet on mobile. */
export interface RightRailPanelProps {
  /** The chat the panel acts on: the visible chat tab (the focused grid cell), or `null`. */
  sessionId: string | null;
  /** The open project's directory. */
  projectPath: string;
  /** Docked beside the tab content (desktop), or inside the mobile bottom sheet. */
  variant: "docked" | "sheet";
  /** An Insert or a Send landed — a phone goes back to the chat on it. */
  onDelivered?: () => void;
}
