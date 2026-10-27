import React from "react";

import { useIsDesktop } from "../../hooks";
import { cn } from "../../lib/cn";
import { serverViewOpen, useAppStore, useCurrentContext, type TabContext } from "../../store/app";
import { RightRail } from "./RightRail";
import { RightRailDock } from "./RightRailDock";
import { useDevicesEnabled } from "../../lib/devices/hooks";
import { MobileSectionOverlay } from "./MobileSections";
import { RIGHT_RAIL_PANEL_ORDER, visibleRailPanels } from "./panels";
import { rightRailWidthOf, toggleRightRailPanel, useRightRailState } from "./right-rail-state";
import { SavedPromptEditorHost } from "./saved-prompts/SavedPromptEditorHost";
import type { DockPanelId } from "./types";

/**
 * The open project's directory, or `null`: the landing view (nothing open) and
 * a workspace's to-do context have no project.
 */
function openProjectPathOf(ctx: TabContext | null): string | null {
  return ctx?.kind === "project" ? ctx.project.path : null;
}

/** {@link openProjectPathOf} the current context — the source `MainView` renders from. */
export function useOpenProjectPath(): string | null {
  return openProjectPathOf(useCurrentContext());
}

export interface RightRailRowProps {
  /** The tab content (`MainView`). */
  children: React.ReactNode;
  /** The open project on a desktop viewport; `null` shows neither the rail nor the dock. */
  projectPath: string | null;
  /** The docked panel, or `null` with the dock closed. */
  open: DockPanelId | null;
  /** The docked panel's stored width (px). */
  width: number;
  /** The panels the rail offers (default: all of them). */
  panels?: readonly DockPanelId[];
  /**
   * Drawn over the tab content (the row is its containing block): a phone's
   * section, full screen (`MobileSections.tsx`).
   */
  overlay?: React.ReactNode;
  /**
   * Make the tab content its own stacking context (a phone). Without it the
   * chat's own layers — the composer's overlay is `z-20` — painted OVER a
   * section drawn on top of it, and hid the section's last rows. Never on a
   * desktop viewport: there a layer inside the tab content may reach over
   * the dock.
   */
  isolateContent?: boolean;
}

/**
 * The row under the top bar: `[tab content | dock | rail]`, and on a phone a
 * section drawn over the tab content.
 *
 * `children` always renders FIRST, in the same element, whatever else is
 * shown: moving the `MainView` in the tree would remount every tab — every
 * terminal and chat stream with it. And because it arrives as a prop, a width
 * drag that re-renders this row every frame never re-renders the tabs.
 */
export const RightRailRow: React.FC<RightRailRowProps> = ({
  children,
  projectPath,
  open,
  width,
  panels,
  overlay,
  isolateContent = false
}) => {
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={rowRef}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 overflow-hidden",
        isolateContent && "[&>:first-child]:isolate"
      )}
    >
      {children}
      {overlay}
      {projectPath !== null && open !== null ? (
        <RightRailDock
          panel={open}
          projectPath={projectPath}
          width={width}
          rowRef={rowRef}
        />
      ) : null}
      {projectPath !== null ? (
        <RightRail open={open} {...(panels ? { panels } : {})} onToggle={toggleRightRailPanel} />
      ) : null}
    </div>
  );
};

/**
 * {@link RightRailRow} wired to the app: the rail — and the dock, while a
 * panel is open — appears only on desktop and only with a project open. Phones
 * reach the same panels through the bottom section bar, which shows them over
 * the tab content (`MobileSections.tsx`). The server-level views (Knowledge,
 * the Devices fleet) belong to no project, so neither shows beside them.
 */
export const RightRailFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isDesktop = useIsDesktop();
  const openProjectPath = useOpenProjectPath();
  const serverView = useAppStore(serverViewOpen);
  const projectPath = serverView ? null : openProjectPath;
  const railState = useRightRailState();
  // Devices: the Device panel exists only while its plugin is on.
  const devicesOn = useDevicesEnabled();
  const panels = React.useMemo(() => visibleRailPanels(RIGHT_RAIL_PANEL_ORDER, { devices: devicesOn }), [devicesOn]);
  const open = railState.open !== null && panels.includes(railState.open) ? railState.open : null;
  return (
    <RightRailRow
      projectPath={isDesktop ? projectPath : null}
      open={open}
      width={open ? rightRailWidthOf(railState, open) : railState.width}
      panels={panels}
      overlay={<MobileSectionOverlay projectPath={isDesktop ? null : projectPath} />}
      isolateContent={!isDesktop}
    >
      {children}
    </RightRailRow>
  );
};

/**
 * The panels' editors, each mounted once, so every variant of a panel (docked,
 * or a phone's section) opens them through their bridges
 * (`saved-prompts/editor-bridge.ts`). The saved-prompt editor needs an open
 * project. (The agent-config editor is mounted by Settings → Agent config.)
 */
export const RightRailEditorHost: React.FC = () => {
  const projectPath = useOpenProjectPath();
  return projectPath !== null ? <SavedPromptEditorHost /> : null;
};
