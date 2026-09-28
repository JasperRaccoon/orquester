import React from "react";

import { useIsDesktop } from "../../hooks";
import { cn } from "../../lib/cn";
import { useCurrentContext, type TabContext } from "../../store/app";
import { RightRail } from "./RightRail";
import { RightRailDock } from "./RightRailDock";
import { MobileSectionOverlay } from "./MobileSections";
import type { RightRailPanelRegistry } from "./panels";
import { toggleRightRailPanel, useRightRailState } from "./right-rail-state";
import { SavedPromptEditorHost } from "./saved-prompts/SavedPromptEditorHost";
import type { RightRailPanelId } from "./types";

/**
 * The open project's directory, or `null`: the landing view (nothing open) and
 * a workspace's to-do context have no project.
 */
export function openProjectPathOf(ctx: TabContext | null): string | null {
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
  open: RightRailPanelId | null;
  /** The dock's stored width (px). */
  width: number;
  /** The panels by id (the real ones unless a check passes fakes). */
  panels?: RightRailPanelRegistry;
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
          panels={panels}
        />
      ) : null}
      {projectPath !== null ? (
        <RightRail open={open} onToggle={toggleRightRailPanel} panels={panels} />
      ) : null}
    </div>
  );
};

/**
 * {@link RightRailRow} wired to the app: the rail — and the dock, while a
 * panel is open — appears only on desktop and only with a project open. Phones
 * reach the same panels through the bottom section bar, which shows them over
 * the tab content (`MobileSections.tsx`).
 */
export const RightRailFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isDesktop = useIsDesktop();
  const projectPath = useOpenProjectPath();
  const { open, width } = useRightRailState();
  return (
    <RightRailRow
      projectPath={isDesktop ? projectPath : null}
      open={open}
      width={width}
      overlay={<MobileSectionOverlay projectPath={isDesktop ? null : projectPath} />}
      isolateContent={!isDesktop}
    >
      {children}
    </RightRailRow>
  );
};

/**
 * The saved-prompt editor, mounted once while a project is open — desktop or
 * mobile, whichever panel is showing — so both panels (docked, or a phone's
 * section) open it through `saved-prompts/editor-bridge.ts`.
 */
export const RightRailEditorHost: React.FC = () => {
  const projectPath = useOpenProjectPath();
  return projectPath !== null ? <SavedPromptEditorHost /> : null;
};
