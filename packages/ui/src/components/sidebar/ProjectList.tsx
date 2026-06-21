import React, { useState } from "react";
import { Box, ChevronLeft, FolderPlus, PanelLeftClose, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  ConfirmDialog,
  ContextMenu,
  Dropdown,
  DropdownItem,
  IconButton,
  type ContextMenuItem
} from "../ui";
import { NewItemInput } from "./NewItemInput";
import { NewProjectModal } from "./NewProjectModal";
import { useAppStore } from "../../store/app";
import type { ProjectSummary } from "../../types";

/** Sidebar view shown after entering a workspace: its projects. */
export const ProjectList: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const currentProject = useAppStore((s) => s.currentProject);
  const projects = useAppStore((s) => s.projects);
  const loading = useAppStore((s) => s.projectsLoading);
  const closeWorkspace = useAppStore((s) => s.closeWorkspace);
  const openProject = useAppStore((s) => s.openProject);
  const createProject = useAppStore((s) => s.createProject);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectSummary } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);

  const menuItems = (project: ProjectSummary): ContextMenuItem[] => [
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => setPendingDelete(project)
    }
  ];

  return (
    <>
      <div className="flex h-9 items-center gap-0.5 px-2">
        <IconButton label="Collapse sidebar" className="hidden md:flex" onClick={toggleSidebar}>
          <PanelLeftClose size={15} />
        </IconButton>
        <IconButton label="Back to workspaces" onClick={closeWorkspace}>
          <ChevronLeft size={16} />
        </IconButton>
        <span className="flex-1 truncate text-sm font-medium text-neutral-100">
          {currentWorkspace}
        </span>
        <Dropdown
          trigger={
            <IconButton label="New">
              <Plus size={16} />
            </IconButton>
          }
          align="right"
          width="w-44"
        >
          <DropdownItem icon={<Box size={14} />} onClick={() => setModalOpen(true)}>
            New Project
          </DropdownItem>
          <DropdownItem icon={<FolderPlus size={14} />} onClick={() => setCreatingFolder(true)}>
            New Folder
          </DropdownItem>
        </Dropdown>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {creatingFolder && (
          <NewItemInput
            placeholder="folder-name"
            onCancel={() => setCreatingFolder(false)}
            onSubmit={(name) => {
              setCreatingFolder(false);
              void createProject({ source: "empty", name });
            }}
          />
        )}

        {loading && projects.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">Loading…</p>
        )}
        {!loading && projects.length === 0 && !creatingFolder && (
          <p className="px-2 py-2 text-xs text-neutral-600">No projects yet</p>
        )}
        {projects.map((project) => (
          <button
            key={project.path}
            type="button"
            onClick={() => openProject(project)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, project });
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              project.path === currentProject?.path
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
            )}
          >
            <Box size={15} className="text-neutral-500" />
            <span className="flex-1 truncate">{project.name}</span>
          </button>
        ))}
      </nav>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.project)}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete project"
        message={
          <>
            This permanently deletes <span className="font-medium text-neutral-200">{pendingDelete?.name}</span>{" "}
            and its contents from disk. This cannot be undone.
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const project = pendingDelete;
          setPendingDelete(null);
          if (project) {
            void deleteProject(project);
          }
        }}
      />

      <NewProjectModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
};
