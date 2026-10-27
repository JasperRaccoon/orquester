/**
 * The right rail's panels, by id: what the rail button, the dock's header, the
 * left sidebar's panel header and a phone's section bar call each one, its icon, and the component that
 * renders it (`RightRailPanelProps`). One table, so the three surfaces never
 * disagree on a name.
 */

import React from "react";
import { Bookmark, History, Layers, Smartphone, Workflow, type LucideIcon } from "lucide-react";

import { LazyBoundary, lazyNamed } from "../ui/lazy";
import type { DockPanelId, RightRailPanelId, RightRailPanelProps } from "./types";

/**
 * A panel that loads the first time it is shown, never with the app: each is
 * its own chunk (the workflows and Agent Profiles panels are big), drawn in its
 * own loading boundary wherever the registry's `Component` is rendered.
 */
function lazyPanel(
  lazy: React.ComponentType<RightRailPanelProps>
): React.ComponentType<RightRailPanelProps> {
  return function LazyPanel(props: RightRailPanelProps) {
    return React.createElement(LazyBoundary, null, React.createElement(lazy, props));
  };
}

const SavedPromptsPanel = lazyPanel(
  lazyNamed(() => import("./saved-prompts/SavedPromptsPanel"), "SavedPromptsPanel")
);
const PromptHistoryPanel = lazyPanel(
  lazyNamed(() => import("./history/PromptHistoryPanel"), "PromptHistoryPanel")
);
const WorkflowsPanel = lazyPanel(lazyNamed(() => import("./workflows/WorkflowsPanel"), "WorkflowsPanel"));
const SessionProfilesPanel = lazyPanel(
  lazyNamed(() => import("./session-profiles/SessionProfilesPanel"), "SessionProfilesPanel")
);
const DevicePanel = lazyPanel(lazyNamed(() => import("../device/DevicePanel"), "DevicePanel"));

export interface RightRailPanelSpec {
  /** The rail button's label and tooltip, and the dock's title. */
  title: string;
  /** A phone's section bar label. */
  shortTitle: string;
  Icon: LucideIcon;
  Component: React.ComponentType<RightRailPanelProps>;
}

export type RightRailPanelRegistry = Readonly<Record<RightRailPanelId, RightRailPanelSpec>>;

export const RIGHT_RAIL_PANEL_REGISTRY: RightRailPanelRegistry = {
  prompts: {
    title: "Saved prompts",
    shortTitle: "Prompts",
    Icon: Bookmark,
    Component: SavedPromptsPanel
  },
  history: {
    title: "History & checkpoints",
    shortTitle: "History",
    Icon: History,
    Component: PromptHistoryPanel
  },
  workflows: {
    title: "Automated workflows",
    shortTitle: "Workflows",
    Icon: Workflow,
    Component: WorkflowsPanel
  },
  /*
   * The Agent Profiles library and editor (agent profiles spec §5.1), in the
   * slot the old "Agent profile" panel held — that per-agent global config
   * editor is Settings → Agent config. On desktop it lives in the left
   * sidebar (`sidebar/sidebar-view.ts`, `sidebar/ActivityBar.tsx`).
   */
  profile: {
    title: "Agent Profiles",
    shortTitle: "Profiles",
    Icon: Layers,
    Component: SessionProfilesPanel
  },
  /*
   * The visible chat's devices (Device simulators plugin, devices spec §10.1):
   * listed only while the plugin is on (`visibleRailPanels`).
   */
  device: {
    title: "Devices",
    shortTitle: "Device",
    Icon: Smartphone,
    Component: DevicePanel
  }
};

/** The desktop rail's order, top to bottom. */
export const RIGHT_RAIL_PANEL_ORDER: readonly DockPanelId[] = ["prompts", "history", "device"];

/**
 * A phone's section bar, left to right: every panel, since a phone has no left
 * sidebar panels to host workflows and Agent Profiles.
 */
export const MOBILE_SECTION_ORDER: readonly RightRailPanelId[] = ["prompts", "history", "device", "workflows", "profile"];

/** `order` without the panels whose plugin is off (the Device panel without Device simulators). */
export function visibleRailPanels<T extends RightRailPanelId>(order: readonly T[], devicesEnabled: boolean): readonly T[] {
  return devicesEnabled ? order : order.filter((id) => id !== "device");
}

/** The dock's element id — what the active rail button `aria-controls`. */
export const RIGHT_RAIL_DOCK_ID = "right-rail-dock";
