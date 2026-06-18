import React from "react";
import { WorkspaceList } from "./WorkspaceList";
import { ProjectList } from "./ProjectList";
import { SidebarRail } from "./SidebarRail";
import { ServerSwitcher } from "../servers";
import { useAppStore } from "../../store/app";

/**
 * Left navigation. Collapses to an icon-only rail (with hover labels) and back.
 * Expanded: workspace folders → a workspace's projects + the server switcher.
 */
export const Sidebar: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);

  if (collapsed) {
    return <SidebarRail />;
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/40">
      {currentWorkspace ? <ProjectList /> : <WorkspaceList />}
      <ServerSwitcher />
    </aside>
  );
};
