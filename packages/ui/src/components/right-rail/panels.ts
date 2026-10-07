/**
 * The right rail's panels, by id: what the rail button, the dock's header, the
 * left sidebar's panel header and a phone's section bar call each one, its icon, and the component that
 * renders it (`RightRailPanelProps`). One table, so the three surfaces never
 * disagree on a name.
 */

import type React from "react";
import { Bookmark, History, SlidersHorizontal, Workflow, type LucideIcon } from "lucide-react";

import { AgentProfilePanel } from "./agent-profile/AgentProfilePanel";
import { PromptHistoryPanel } from "./history/PromptHistoryPanel";
import { SavedPromptsPanel } from "./saved-prompts/SavedPromptsPanel";
import { WorkflowsPanel } from "./workflows/WorkflowsPanel";
import type { DockPanelId, RightRailPanelId, RightRailPanelProps } from "./types";

export interface RightRailPanelSpec {
  id: RightRailPanelId;
  /** The rail button's label and tooltip, and the dock's title. */
  title: string;
  /** A phone's section bar label. */
  shortTitle: string;
  Icon: LucideIcon;
  Component: React.ComponentType<RightRailPanelProps>;
}

export type RightRailPanelRegistry = Readonly<Record<RightRailPanelId, RightRailPanelSpec>>;

/*
 * `Component` is a getter: it is read at render, never while this module
 * evaluates. A panel that imports the rail's barrel (`..`) closes an import
 * cycle through this table, and a top-level read would then find the panel
 * not yet defined — a crash at load, not at first use.
 */
export const RIGHT_RAIL_PANEL_REGISTRY: RightRailPanelRegistry = {
  prompts: {
    id: "prompts",
    title: "Saved prompts",
    shortTitle: "Prompts",
    Icon: Bookmark,
    get Component() {
      return SavedPromptsPanel;
    }
  },
  history: {
    id: "history",
    title: "History & checkpoints",
    shortTitle: "History",
    Icon: History,
    get Component() {
      return PromptHistoryPanel;
    }
  },
  workflows: {
    id: "workflows",
    title: "Automated workflows",
    shortTitle: "Workflows",
    Icon: Workflow,
    get Component() {
      return WorkflowsPanel;
    }
  },
  profile: {
    id: "profile",
    title: "Agent profile",
    shortTitle: "Profile",
    Icon: SlidersHorizontal,
    get Component() {
      return AgentProfilePanel;
    }
  }
};

/** The desktop rail's order, top to bottom. */
export const RIGHT_RAIL_PANEL_ORDER: readonly DockPanelId[] = ["prompts", "history"];

/**
 * A phone's section bar, left to right: every panel, since a phone has no left
 * sidebar panels to host workflows and the agent profile.
 */
export const MOBILE_SECTION_ORDER: readonly RightRailPanelId[] = ["prompts", "history", "workflows", "profile"];

/** The dock's element id — what the active rail button `aria-controls`. */
export const RIGHT_RAIL_DOCK_ID = "right-rail-dock";
