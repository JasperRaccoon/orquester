import React, { useMemo, useState } from "react";
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
import { LONG_PRESS_SURFACE, useLongPress } from "../../hooks/use-long-press";
import {
  AdaptiveMenu,
  ConfirmDialog,
  ContextMenu,
  DropdownItem,
  DropdownSeparator,
  type ContextMenuItem
} from "../ui";
import { useAppStore } from "../../store/app";
import { copyText } from "../../lib/clipboard";
import type { WorkspaceSummary } from "../../types";
import { ArchivedFooter } from "./ArchivedFooter";
import { CountPill, RowActionsButton, SectionHeader } from "./parts";
import { WorkspaceProjects, type InlineCreate } from "./WorkspaceProjects";
import type { NewProjectPreset } from "./NewProjectModal";

/** Something to create inside a workspace, from its menu or the Workspaces "+". */
export type WorkspaceCreateKind = "project" | "folder" | "todo";

export interface WorkspaceListProps {
  /** A folder or to-do list being named inline in the open workspace. */
  inlineCreate: InlineCreate;
  onInlineCreateDone: () => void;
  /** Create something in `workspace` (opening it first when it is not the open one). */
  onCreate: (kind: WorkspaceCreateKind, workspace: string) => void;
  /** A repo group's "+": a fresh clone of that repo into `workspace`. */
  onCloneRepo?: (workspace: string, preset: NewProjectPreset) => void;
  onNewWorkspace: () => void;
}

/**
 * The workspaces, as an accordion: each row expands in place to its projects
 * and to-do lists. The expanded row is the open workspace (`currentWorkspace`)
 * — opening another collapses it, and collapsing it closes it — so the tree
 * never shows a project list the store does not hold.
 *
 * The header's "+" opens the "New" menu: a project, folder or to-do list in
 * the open workspace, or a new workspace.
 */
export const WorkspaceList: React.FC<WorkspaceListProps> = ({
  inlineCreate,
  onInlineCreateDone,
  onCreate,
  onCloneRepo,
  onNewWorkspace
}) => {
  const workspaces = useAppStore((s) => s.workspaces);
  const loading = useAppStore((s) => s.workspacesLoading);
  const accounts = useAppStore((s) => s.accounts);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const closeWorkspace = useAppStore((s) => s.closeWorkspace);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace);
  const setWorkspaceArchived = useAppStore((s) => s.setWorkspaceArchived);

  const [menu, setMenu] = useState<{ x: number; y: number; workspace: WorkspaceSummary } | null>(null);
  // A workspace row's menu: right-click, or a long press on a touch screen
  // (iOS fires no `contextmenu`). One handler for every row; the pressed row
  // names its workspace.
  const press = useLongPress((point, target) => {
    const name = target instanceof Element ? target.closest("[data-workspace-row]")?.getAttribute("data-workspace-row") : null;
    const workspace = name ? workspaces.find((w) => w.name === name) : undefined;
    if (workspace) setMenu({ ...point, workspace });
  });
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null);

  // Archived workspaces live only behind the archived entry at the bottom.
  const visibleWorkspaces = workspaces.filter((w) => !w.isArchived);

  // id → label, for rendering the bound account on each row.
  const accountLabel = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.label] as const));
    return (id?: string | null) => (id ? map.get(id) ?? null : null);
  }, [accounts]);

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
        <AdaptiveMenu
          trigger={
            // A span: AdaptiveMenu wraps the trigger in its own <button>.
            <span
              aria-label="New"
              title="New"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
            >
              <Plus size={15} />
            </span>
          }
          align="right"
          width="w-48"
          title="New"
        >
          {currentWorkspace && (
            <>
              <DropdownItem icon={<Box size={14} />} onClick={() => onCreate("project", currentWorkspace)}>
                New Project
              </DropdownItem>
              <DropdownItem icon={<FolderPlus size={14} />} onClick={() => onCreate("folder", currentWorkspace)}>
                New Folder
              </DropdownItem>
              <DropdownItem icon={<ListTodo size={14} />} onClick={() => onCreate("todo", currentWorkspace)}>
                New to-do list
              </DropdownItem>
              <DropdownSeparator />
            </>
          )}
          <DropdownItem icon={<FolderPlus size={14} />} onClick={onNewWorkspace}>
            New Workspace
          </DropdownItem>
        </AdaptiveMenu>
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
      {visibleWorkspaces.map((workspace) => {
        const label = accountLabel(workspace.gitAccountId);
        const isOpen = workspace.name === currentWorkspace;
        // Visible projects only — archived rows are hidden from the list this
        // count sits next to, so counting them would promise rows the user
        // cannot see.
        const count = Math.max(0, workspace.projectCount - (workspace.archivedProjectCount ?? 0));
        const FolderIcon = isOpen ? FolderOpen : Folder;
        return (
          <div
            key={workspace.path}
            className={cn(
              "rounded-xl transition-colors",
              isOpen && "bg-neutral-900/70 pb-1.5 ring-1 ring-inset ring-neutral-800"
            )}
          >
            <div
              data-workspace-row={workspace.name}
              {...press}
              className={cn(
                "group flex items-center rounded-xl transition-colors",
                LONG_PRESS_SURFACE,
                isOpen ? "text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
              )}
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => (isOpen ? closeWorkspace() : void openWorkspace(workspace.name))}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left text-[13px] font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
              >
                <ChevronRight
                  size={14}
                  aria-hidden
                  className={cn(
                    "shrink-0 text-neutral-500 transition-transform duration-150 motion-reduce:transition-none",
                    isOpen && "rotate-90"
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

            {isOpen && (
              <WorkspaceProjects
                workspace={workspace.name}
                creating={inlineCreate}
                onCreatingDone={onInlineCreateDone}
                onCloneRepo={onCloneRepo && ((preset) => onCloneRepo(workspace.name, preset))}
              />
            )}
          </div>
        );
      })}

      <div className="pt-1">
        <ArchivedFooter scope="workspaces" />
      </div>

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
