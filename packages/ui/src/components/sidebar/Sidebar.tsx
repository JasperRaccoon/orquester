import React from "react";
import { Waypoints } from "lucide-react";
import { KNOWLEDGE_GRAPH_PLUGIN_ID } from "@orquester/api";
import { cn } from "../../lib/cn";
import { isGlobalPluginEnabled } from "../../lib/plugins-state";
import { ActivityBar } from "./ActivityBar";
import { ProjectsView } from "./ProjectsView";
import { SidebarPanel } from "./SidebarPanel";
import { useSidebarView } from "./sidebar-view";
import { ServerSwitcher } from "../servers";
import { ResizeHandle } from "../ui";
import { useIsDesktop } from "../../hooks";
import { useBackClose } from "../../hooks/use-back-close";
import { useAppStore, useSidebarWidth } from "../../store/app";
import { SIDEBAR_MIN, SIDEBAR_MAX, PANE_FLEX_RESERVE } from "../../lib/panel-sizes";

/**
 * The drawer's way to the server-level Knowledge view (a phone has no activity
 * bar), while the Knowledge Graph plugin is on. Opening it closes the drawer.
 */
export const KnowledgeDrawerEntry: React.FC = () => {
  const on = useAppStore((s) => isGlobalPluginEnabled(s.plugins, KNOWLEDGE_GRAPH_PLUGIN_ID));
  const open = useAppStore((s) => s.knowledgeView.open);
  const openKnowledge = useAppStore((s) => s.openKnowledge);
  if (!on) return null;
  return (
    <div className="shrink-0 border-t border-neutral-800 px-2 py-1.5">
      <button
        type="button"
        aria-pressed={open}
        onClick={openKnowledge}
        className={cn(
          "flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          open ? "bg-neutral-800 text-neutral-50" : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
        )}
      >
        <Waypoints size={16} aria-hidden className="shrink-0 text-neutral-400" />
        Knowledge
      </button>
    </div>
  );
};

/**
 * Left navigation. Desktop: the activity bar, then the resizable panel it
 * picks — the projects tree (search, opened agents, workspaces) or workflows —
 * over the server footer. Mobile: an off-canvas drawer (with backdrop) toggled
 * from the top bar, holding the projects tree, then Knowledge (the activity
 * bar's one non-view button); a phone reaches workflows from its bottom
 * section bar. Back closes the drawer.
 */
export const Sidebar: React.FC = () => {
  const isDesktop = useIsDesktop();
  const view = useSidebarView();
  const drawerOpen = useAppStore((s) => s.sidebarDrawerOpen);
  const setDrawer = useAppStore((s) => s.setSidebarDrawer);
  const sidebarWidth = useSidebarWidth();
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const resetSidebarWidth = useAppStore((s) => s.resetSidebarWidth);
  useBackClose(!isDesktop && drawerOpen, () => setDrawer(false));

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
        <KnowledgeDrawerEntry />
        <ServerSwitcher />
      </aside>
    </>
  );
};
