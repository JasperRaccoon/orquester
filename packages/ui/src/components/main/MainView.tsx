import React from "react";
import { FolderTree, GitBranch, LayoutGrid, MousePointerClick, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { EmptyState } from "./EmptyState";
import { TerminalView } from "../terminal";
import { FileBrowser } from "../files";
import { GitView } from "../git";
import { getRegistryIcon } from "../../icons";
import { useIsDesktop } from "../../hooks";
import {
  useActiveTabId,
  useAppStore,
  useProjectTabs,
  useViewMode,
  type ProjectTab
} from "../../store/app";

/** Icon shown in a grid-cell header — mirrors the tab strip. */
function cellIcon(tab: ProjectTab): React.ReactNode {
  return tab.type === "session" ? (
    getRegistryIcon(tab.session.kind, tab.session.refId, 13)
  ) : tab.type === "git" ? (
    <GitBranch size={13} />
  ) : (
    <FolderTree size={13} />
  );
}

function cellTitle(tab: ProjectTab): string {
  return tab.type === "session" ? tab.session.title : tab.title;
}

/** Grid columns for a tab count: 1→1, 2-4→2, 5-9→3, 10+→4 (capped). */
function gridColumns(count: number): number {
  return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count))));
}

/**
 * Main panel. Every tab of the current project is kept mounted (terminal output
 * streams stay open): tab view shows only the active one, grid view lays them
 * all out at once. Both modes share one render tree — only classes/styles
 * change — so toggling never tears a terminal (xterm + output stream) down.
 */
export const MainView: React.FC = () => {
  const currentProject = useAppStore((s) => s.currentProject);
  const tabs = useProjectTabs();
  const activeId = useActiveTabId();
  const viewMode = useViewMode();
  const isDesktop = useIsDesktop();
  const activateTab = useAppStore((s) => s.activateTab);
  const closeTab = useAppStore((s) => s.closeTab);

  // Grid is a desktop-only layout; a persisted "grid" falls back to tab view on
  // narrow viewports (the toggle isn't shown there either).
  const grid = isDesktop && viewMode === "grid";

  if (!currentProject) {
    return (
      <main className="min-h-0 flex-1 overflow-hidden bg-neutral-950">
        <EmptyState
          icon={<LayoutGrid size={40} strokeWidth={1.25} />}
          title="No project selected"
          description="Pick a workspace and open a project from the sidebar to get started."
        />
      </main>
    );
  }

  if (tabs.length === 0) {
    return (
      <main className="min-h-0 flex-1 overflow-hidden bg-neutral-950">
        <EmptyState
          icon={<MousePointerClick size={40} strokeWidth={1.25} />}
          title="No tabs open"
          description='Use the "+" button in the top bar to open a terminal, agent or file browser.'
        />
      </main>
    );
  }

  const columns = gridColumns(tabs.length);

  return (
    <main className="min-h-0 flex-1 overflow-hidden bg-neutral-950">
      <div
        className={cn("h-full w-full", grid && "grid auto-rows-fr gap-px")}
        style={grid ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const show = grid || active; // tab view: only active; grid: every cell
          return (
            <div
              key={tab.id}
              onClick={grid ? () => activateTab(tab.id) : undefined}
              className={cn(
                "h-full w-full min-h-0 min-w-0 flex-col",
                show ? "flex" : "hidden",
                grid && "overflow-hidden border border-neutral-800",
                grid && active && "border-neutral-500 ring-1 ring-inset ring-neutral-500"
              )}
            >
              {/* Header lives in the DOM in both modes (hidden in tab view) so the
                  tree stays structurally stable and terminals never remount. */}
              <div
                className={cn(
                  "h-7 shrink-0 items-center gap-1.5 border-b border-neutral-800 bg-neutral-900/40 px-2",
                  grid ? "flex" : "hidden"
                )}
              >
                <span className="text-neutral-500">{cellIcon(tab)}</span>
                <span className="flex-1 truncate text-xs text-neutral-300">{cellTitle(tab)}</span>
                <button
                  type="button"
                  aria-label="Close tab"
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab.id);
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {tab.type === "session" ? (
                  <TerminalView session={tab.session} active={active} viewMode={viewMode} />
                ) : tab.type === "git" ? (
                  <GitView projectPath={currentProject.path} active={active} />
                ) : (
                  <FileBrowser rootPath={currentProject.path} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
};
