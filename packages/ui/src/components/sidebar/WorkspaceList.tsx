import React, { useState } from "react";
import { Folder, FolderPlus, PanelLeftClose, Trash2 } from "lucide-react";
import { ConfirmDialog, ContextMenu, IconButton, type ContextMenuItem } from "../ui";
import { NewItemInput } from "./NewItemInput";
import { useAppStore } from "../../store/app";
import type { WorkspaceSummary } from "../../types";

/** Root sidebar view: the list of workspace folders. */
export const WorkspaceList: React.FC = () => {
  const workspaces = useAppStore((s) => s.workspaces);
  const loading = useAppStore((s) => s.workspacesLoading);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; workspace: WorkspaceSummary } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null);

  const menuItems = (workspace: WorkspaceSummary): ContextMenuItem[] => [
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => setPendingDelete(workspace)
    }
  ];

  return (
    <>
      <div className="flex h-9 items-center gap-1 px-2">
        <IconButton label="Collapse sidebar" className="hidden md:flex" onClick={toggleSidebar}>
          <PanelLeftClose size={15} />
        </IconButton>
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Workspaces
        </span>
        <IconButton label="New workspace" onClick={() => setCreating(true)}>
          <FolderPlus size={15} />
        </IconButton>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {creating && (
          <NewItemInput
            placeholder="workspace-name"
            onCancel={() => setCreating(false)}
            onSubmit={(name) => {
              setCreating(false);
              void createWorkspace(name);
            }}
          />
        )}

        {loading && workspaces.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">Loading…</p>
        )}
        {!loading && workspaces.length === 0 && !creating && (
          <p className="px-2 py-2 text-xs text-neutral-600">No workspaces yet</p>
        )}
        {workspaces.map((workspace) => (
          <button
            key={workspace.path}
            type="button"
            onClick={() => void openWorkspace(workspace.name)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, workspace });
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            <Folder size={15} className="text-neutral-500" />
            <span className="flex-1 truncate">{workspace.name}</span>
            <span className="text-xs text-neutral-600">{workspace.projectCount}</span>
          </button>
        ))}
      </nav>

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
    </>
  );
};
