import React from "react";
import { Menu, Search, Settings, Waypoints, X } from "lucide-react";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { TabStrip } from "./TabStrip";
import { TabSwitcher } from "./TabSwitcher";
import { NewTabMenu } from "./NewTabMenu";
import { ViewModeToggle } from "./ViewModeToggle";
import { UsageWidget } from "./UsageWidget";
import { openCommandPalette } from "../command-palette";
import { WindowControls } from "../layout/WindowControls";
import { IconButton } from "../ui";
import { useIsDesktop } from "../../hooks";
import { useOrquester } from "../../context/orquester-context";
import { serverViewOpen, useAppStore, useCurrentContext } from "../../store/app";
import { DevicesFleetHeader } from "../devices-fleet/DevicesFleetEntry";

/**
 * Mobile-only opener for the command palette: a phone has no Ctrl+K, and the
 * palette is the reliable way to reach a session in another project from there.
 */
const CommandPaletteButton: React.FC = () => (
  <div className="app-no-drag">
    <IconButton label="Go to session or project" onClick={() => openCommandPalette()}>
      <Search size={15} />
    </IconButton>
  </div>
);

const SettingsButton: React.FC = () => {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  return (
    <div className="app-no-drag">
      <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
        <Settings size={15} />
      </IconButton>
    </div>
  );
};

/**
 * The header of the server-level Knowledge view, in place of the project's
 * switcher and tabs: its title, and the way back to the project.
 */
const KnowledgeHeader: React.FC = () => {
  const closeKnowledge = useAppStore((s) => s.closeKnowledge);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="flex min-w-0 items-center gap-2 px-1 text-sm font-medium text-neutral-200">
        <Waypoints size={15} aria-hidden className="shrink-0 text-neutral-400" />
        Knowledge
      </span>
      <div className="app-no-drag">
        <IconButton label="Close Knowledge" onClick={closeKnowledge}>
          <X size={15} />
        </IconButton>
      </div>
    </div>
  );
};

/**
 * Desktop: a single titlebar row (project switcher · tabs · new tab | usage ·
 * window controls); settings sit at the bottom of the sidebar's activity bar.
 * Mobile: a two-row header (menu · project · usage · settings) then a tab row
 * (current tab switcher · new tab); the right rail's panels are the bottom
 * section bar's (`MobileSections.tsx`). While a server-level view (Knowledge,
 * Devices) shows, its header takes the project's place and the tab row goes.
 */
export const TopBar: React.FC = () => {
  const { useTitlebar } = useOrquester();
  const isDesktop = useIsDesktop();
  const ctx = useCurrentContext();
  const setSidebarDrawer = useAppStore((s) => s.setSidebarDrawer);
  const knowledgeOpen = useAppStore((s) => s.knowledgeView.open);
  const devicesOpen = useAppStore((s) => s.devicesFleetOpen);
  const serverView = useAppStore(serverViewOpen);
  const serverHeader = knowledgeOpen ? <KnowledgeHeader /> : devicesOpen ? <DevicesFleetHeader /> : null;

  if (!isDesktop) {
    return (
      <header className="flex shrink-0 flex-col border-b border-neutral-800 bg-neutral-900/60">
        <div className="flex h-11 items-center gap-1 px-1">
          <IconButton label="Open menu" onClick={() => setSidebarDrawer(true)}>
            <Menu size={18} />
          </IconButton>
          {serverHeader ? (
            serverHeader
          ) : ctx?.kind === "project" ? (
            <ProjectSwitcher />
          ) : (
            <span className="px-1 text-sm text-neutral-500">Select a project</span>
          )}
          <div className="flex-1" />
          <CommandPaletteButton />
          <div className="app-no-drag">
            <UsageWidget />
          </div>
          <SettingsButton />
        </div>
        {ctx && !serverView && (
          <div className="flex h-11 items-center gap-1 border-t border-neutral-800 px-2">
            <TabSwitcher />
            <div className="flex-1" />
            <NewTabMenu />
          </div>
        )}
      </header>
    );
  }

  return (
    <header className="app-drag flex h-11 shrink-0 items-stretch border-b border-neutral-800 bg-neutral-900/60">
      <div className="flex flex-1 items-center gap-2 overflow-hidden pl-2">
        {serverHeader ? (
          serverHeader
        ) : ctx ? (
          <>
            {ctx.kind === "project" && (
              <>
                <ProjectSwitcher />
                <div className="h-4 w-px bg-neutral-800" />
              </>
            )}
            <div className="flex items-center gap-1 overflow-x-auto">
              <TabStrip />
              <NewTabMenu />
            </div>
          </>
        ) : (
          <span className="px-2 text-sm text-neutral-500">Select a project to begin</span>
        )}
      </div>

      <div className="flex items-center gap-1 pr-1">
        {ctx?.kind === "project" && !serverView && (
          <div className="app-no-drag">
            <ViewModeToggle />
          </div>
        )}
        <div className="app-no-drag">
          <UsageWidget />
        </div>
        {useTitlebar && <div className="mx-1 h-4 w-px self-center bg-neutral-800" />}
        {useTitlebar && <WindowControls />}
      </div>
    </header>
  );
};
