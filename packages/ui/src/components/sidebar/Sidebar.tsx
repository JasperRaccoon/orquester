import React from "react";
import { cn } from "../../lib/cn";
import { ActivityBar } from "./ActivityBar";
import { ProjectsView } from "./ProjectsView";
import { SidebarPanel } from "./SidebarPanel";
import { useSidebarView } from "./sidebar-view";
import { ServerSwitcher } from "../servers";
import { ResizeHandle } from "../ui";
import { useIsDesktop } from "../../hooks";
import { useAppStore, useSidebarWidth } from "../../store/app";
import { SIDEBAR_MIN, SIDEBAR_MAX, PANE_FLEX_RESERVE } from "../../lib/panel-sizes";

/**
 * Left navigation. Desktop: the activity bar, then the resizable panel it
 * picks — the projects tree (search, opened agents, workspaces), workflows or
 * the agent profile — over the server footer. Mobile: an off-canvas drawer
 * (with backdrop) toggled from the top bar, holding the projects tree only; a
 * phone reaches workflows and the agent profile from its bottom section bar.
 */
export const Sidebar: React.FC = () => {
  const isDesktop = useIsDesktop();
  const view = useSidebarView();
  const drawerOpen = useAppStore((s) => s.sidebarDrawerOpen);
  const setDrawer = useAppStore((s) => s.setSidebarDrawer);
  const sidebarWidth = useSidebarWidth();
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const resetSidebarWidth = useAppStore((s) => s.resetSidebarWidth);

  // --- Desktop ---
  if (isDesktop) {
    // The aside keeps its own border-box `border-r`; the ResizeHandle is a
    // zero-footprint overlay seam that paints only on hover/drag. The
    // `maxWidth` guard keeps the main area from collapsing on a narrow window.
    return (
      <>
        <ActivityBar />
        <aside
          className="flex shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/40"
          style={{ width: sidebarWidth, maxWidth: `calc(100% - ${PANE_FLEX_RESERVE}px)` }}
        >
          {view === "projects" ? <ProjectsView /> : <SidebarPanel key={view} id={view} />}
          <ServerSwitcher />
        </aside>
        <ResizeHandle
          orientation="vertical"
          aria-label="Resize sidebar"
          getCurrent={() => useAppStore.getState().sidebarWidth}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          onResize={(px) => setSidebarWidth(px, false)}
          onCommit={(px) => setSidebarWidth(px, true)}
          onReset={resetSidebarWidth}
        />
      </>
    );
  }

  // --- Mobile drawer ---
  return (
    <>
      {drawerOpen && (
        <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setDrawer(false)} />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-80 max-w-[85vw] flex-col border-r border-neutral-800 bg-neutral-900 shadow-xl transition-transform duration-200",
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <ProjectsView />
        <ServerSwitcher />
      </aside>
    </>
  );
};
