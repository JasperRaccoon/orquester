import React from "react";
import { Clock3, Folder, LayoutGrid } from "lucide-react";
import { isArchivedRecent, useAppStore } from "../../store/app";
import { relativeTime } from "../../lib/relative-time";
import { EmptyState } from "./EmptyState";

/**
 * Landing surface when no workspace is open: the daemon-owned recent-projects
 * list. Daemon-owned rather than per-browser, so the desktop app and every
 * remote client agree on it; it stays live through `recentProjects.changed`.
 *
 * Archived entries are dropped: an archived project is hidden from the sidebar
 * and reachable only through the (optionally password-gated) archived panel, so
 * a recents row must not be a second, ungated door into it.
 */
export const RecentProjects: React.FC = () => {
  const recents = useAppStore((s) => s.recentProjects);
  const openRecentProject = useAppStore((s) => s.openRecentProject);
  const projects = React.useMemo(() => recents.filter((r) => !isArchivedRecent(r)), [recents]);

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid size={40} strokeWidth={1.25} />}
        title="No workspace selected"
        description="Pick a workspace from the sidebar."
      />
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col px-6 py-8">
      <div className="mb-3 shrink-0">
        <p className="text-sm font-medium text-neutral-200">Recent projects</p>
        <p className="mt-0.5 text-xs text-neutral-600">
          Where you have been working, shared across every client of this server.
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {projects.map((project) => (
          <button
            key={project.path}
            type="button"
            onClick={() => void openRecentProject(project)}
            title={project.path}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-neutral-900"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-900 text-neutral-500">
              <Folder size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-neutral-200">{project.name}</span>
              <span className="block truncate text-[11px] text-neutral-600">
                {project.workspace}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-600">
              <Clock3 size={12} />
              {relativeTime(project.lastInteractedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
