import React, { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Box,
  ChevronRight,
  ClipboardCopy,
  Folder,
  FolderOpen,
  FolderPlus,
  ListTodo,
  Plus,
  Trash2
} from "lucide-react";
import { cn } from "../../lib/cn";
import { ConfirmDialog, ContextMenu, IconButton, type ContextMenuItem } from "../ui";
import { useAppStore } from "../../store/app";
import { useApi } from "../../context/orquester-context";
import { copyText } from "../../lib/clipboard";
import { matchesSidebarQuery } from "../../lib/opened-agents";
import { ensureProjectIndex, useProjectIndex } from "../../lib/project-index";
import { useWorkflowTempProjects } from "../../lib/workflows/hooks";
import { isWorkflowTempProject } from "../../lib/workflows/temp-projects";
import type { ProjectSummary, WorkspaceSummary } from "../../types";
import { ArchivedFooter } from "./ArchivedFooter";
import { CountPill, RowActionsButton, SectionHeader } from "./parts";
import { ProjectRow, WorkspaceProjects, type InlineCreate } from "./WorkspaceProjects";

/** Something to create inside a workspace, from its menu or the sidebar's "+". */
export type WorkspaceCreateKind = "project" | "folder" | "todo";

export interface WorkspaceListProps {
  /** The sidebar search; empty shows the plain tree. */
  query: string;
  /** A folder or to-do list being named inline in the open workspace. */
  inlineCreate: InlineCreate;
  onInlineCreateDone: () => void;
  /** Create something in `workspace` (opening it first when it is not the open one). */
  onCreate: (kind: WorkspaceCreateKind, workspace: string) => void;
  onNewWorkspace: () => void;
}

/**
 * Open a project of any workspace: its workspace first when another one is
 * open — the store lists only the open workspace's projects — then the
 * project, as the daemon lists it now (an archived or vanished one leaves just
 * its workspace open).
 */
async function openProjectAnywhere(project: ProjectSummary): Promise<void> {
  if (useAppStore.getState().currentWorkspace !== project.workspace) {
    await useAppStore.getState().openWorkspace(project.workspace);
  }
  const fresh = useAppStore.getState().projects.find((p) => p.path === project.path);
  if (fresh && !fresh.isArchived) {
    useAppStore.getState().openProject(fresh);
  }
}

/**
 * The workspaces, as an accordion: each row expands in place to its projects
 * and to-do lists. The expanded row is the open workspace (`currentWorkspace`)
 * — opening another collapses it, and collapsing it closes it — so the tree
 * never shows a project list the store does not hold.
 *
 * While searching, every workspace whose name or projects match stays listed,
 * and one with matching projects shows them even when it is not the open one
 * (from the verified project index, so an archived project never surfaces).
 */
export const WorkspaceList: React.FC<WorkspaceListProps> = ({
  query,
  inlineCreate,
  onInlineCreateDone,
  onCreate,
  onNewWorkspace
}) => {
  const api = useApi();
  const workspaces = useAppStore((s) => s.workspaces);
  const loading = useAppStore((s) => s.workspacesLoading);
  const accounts = useAppStore((s) => s.accounts);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const currentProject = useAppStore((s) => s.currentProject);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const closeWorkspace = useAppStore((s) => s.closeWorkspace);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace);
  const setWorkspaceArchived = useAppStore((s) => s.setWorkspaceArchived);
  const index = useProjectIndex();
  const tempProjects = useWorkflowTempProjects();

  const [menu, setMenu] = useState<{ x: number; y: number; workspace: WorkspaceSummary } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null);

  const searching = query.trim().length > 0;

  // A search reaches into every workspace through the project index.
  useEffect(() => {
    if (searching && index === null) {
      void ensureProjectIndex(api, useAppStore.getState().workspaces);
    }
  }, [api, searching, index]);

  // Archived workspaces live only behind the archived entry at the bottom.
  const visibleWorkspaces = workspaces.filter((w) => !w.isArchived);

  // id → label, for rendering the bound account on each row.
  const accountLabel = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.label] as const));
    return (id?: string | null) => (id ? map.get(id) ?? null : null);
  }, [accounts]);

  // Searching: the index's projects that match, by workspace.
  const matchesByWorkspace = useMemo(() => {
    const byWorkspace = new Map<string, ProjectSummary[]>();
    if (!searching || index === null) return byWorkspace;
    for (const project of index.visible.values()) {
      if (!matchesSidebarQuery(query, project.name)) continue;
      const list = byWorkspace.get(project.workspace) ?? [];
      list.push(project);
      byWorkspace.set(project.workspace, list);
    }
    for (const list of byWorkspace.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    return byWorkspace;
  }, [searching, index, query]);

  const rows = searching
    ? visibleWorkspaces.filter(
        (w) => matchesSidebarQuery(query, w.name) || matchesByWorkspace.has(w.name)
      )
    : visibleWorkspaces;

  const menuItems = (workspace: WorkspaceSummary): ContextMenuItem[] => [
    {
      label: "New Project",
      icon: <Box size={13} />,
      onClick: () => onCreate("project", workspace.name)
    },
    {
      label: "New Folder",
      icon: <FolderPlus size={13} />,
      onClick: () => onCreate("folder", workspace.name)
    },
    {
      label: "New to-do list",
      icon: <ListTodo size={13} />,
      onClick: () => onCreate("todo", workspace.name)
    },
    {
      label: "Copy Full Path",
      icon: <ClipboardCopy size={13} />,
      onClick: () => void copyText(workspace.path)
    },
    {
      label: "Archive",
      icon: <Archive size={13} />,
      onClick: () => void setWorkspaceArchived(workspace.name, true)
    },
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => setPendingDelete(workspace)
    }
  ];

  return (
    <section aria-label="Workspaces" className="space-y-1">
      <SectionHeader
        title="Workspaces"
        count={visibleWorkspaces.length > 0 ? <CountPill>{visibleWorkspaces.length}</CountPill> : null}
      >
        <IconButton label="New workspace" onClick={onNewWorkspace}>
          <Plus size={15} />
        </IconButton>
      </SectionHeader>

      {loading && visibleWorkspaces.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-neutral-600">Loading…</p>
      )}
      {!loading && visibleWorkspaces.length === 0 && (
        <button
          type="button"
          onClick={onNewWorkspace}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-neutral-800 px-3 py-2.5 text-left text-[13px] text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
        >
          <FolderPlus size={15} className="shrink-0" />
          Create your first workspace
        </button>
      )}
      {searching && rows.length === 0 && visibleWorkspaces.length > 0 && (
        <p className="px-2 py-1.5 text-xs text-neutral-600">
          {index === null ? "Searching…" : "No matching workspaces or projects"}
        </p>
      )}

      {rows.map((workspace) => {
        const label = accountLabel(workspace.gitAccountId);
        const isOpen = workspace.name === currentWorkspace;
        const matches = matchesByWorkspace.get(workspace.name);
        const expanded = isOpen || (searching && matches !== undefined);
        // Visible projects only — archived rows are hidden from the list this
        // count sits next to, so counting them would promise rows the user
        // cannot see.
        const count = Math.max(0, workspace.projectCount - (workspace.archivedProjectCount ?? 0));
        const FolderIcon = expanded ? FolderOpen : Folder;
        return (
          <div
            key={workspace.path}
            className={cn(
              "rounded-xl transition-colors",
              expanded && "bg-neutral-900/70 pb-1.5 ring-1 ring-inset ring-neutral-800"
            )}
          >
            <div
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, workspace });
              }}
              className={cn(
                "group flex items-center rounded-xl transition-colors",
                expanded ? "text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
              )}
            >
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => (isOpen ? closeWorkspace() : void openWorkspace(workspace.name))}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left text-[13px] font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
              >
                <ChevronRight
                  size={14}
                  aria-hidden
                  className={cn(
                    "shrink-0 text-neutral-500 transition-transform duration-150 motion-reduce:transition-none",
                    expanded && "rotate-90"
                  )}
                />
                <FolderIcon size={16} aria-hidden className="shrink-0 text-neutral-400" />
                <span className="flex-1 truncate">{workspace.name}</span>
                {label && (
                  <span className="max-w-[40%] truncate text-[11px] font-normal text-neutral-500" title={`git account: ${label}`}>
                    {label}
                  </span>
                )}
                <CountPill>{count}</CountPill>
              </button>
              <RowActionsButton
                label={`Actions for ${workspace.name}`}
                onOpen={(at) => setMenu({ ...at, workspace })}
              />
            </div>

            {isOpen ? (
              <WorkspaceProjects
                workspace={workspace.name}
                query={query}
                creating={inlineCreate}
                onCreatingDone={onInlineCreateDone}
              />
            ) : expanded && matches ? (
              <div className="space-y-px pl-6 pr-1.5">
                {matches.map((project) => (
                  <ProjectRow
                    key={project.path}
                    project={project}
                    active={project.path === currentProject?.path}
                    tempMarker={isWorkflowTempProject(project, tempProjects)}
                    onOpen={() => void openProjectAnywhere(project)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {!searching && (
        <div className="pt-1">
          <ArchivedFooter scope="workspaces" />
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.workspace)}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete workspace"
        confirmText={pendingDelete?.name}
        message={
          <>
            This permanently deletes <span className="font-medium text-neutral-200">{pendingDelete?.name}</span>{" "}
            and all of its projects from disk. This cannot be undone. Type the workspace name to confirm.
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const name = pendingDelete?.name;
          setPendingDelete(null);
          if (name) {
            void deleteWorkspace(name);
          }
        }}
      />
    </section>
  );
};
