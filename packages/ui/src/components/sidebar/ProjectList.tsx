import React, { useState } from "react";
import {
  Box,
  ChevronLeft,
  FolderPlus,
  ListTodo,
  PanelLeftClose,
  Pencil,
  Plus,
  Trash2
} from "lucide-react";
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
import type { TodoListRecord } from "@orquester/api";

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
  const todos = useAppStore((s) => s.todos);
  const createTodo = useAppStore((s) => s.createTodo);
  const openTodo = useAppStore((s) => s.openTodo);
  const renameTodo = useAppStore((s) => s.renameTodo);
  const deleteTodo = useAppStore((s) => s.deleteTodo);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectSummary } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [todoMenu, setTodoMenu] = useState<{ x: number; y: number; todo: TodoListRecord } | null>(
    null
  );
  const [renamingTodo, setRenamingTodo] = useState<TodoListRecord | null>(null);
  const [pendingTodoDelete, setPendingTodoDelete] = useState<TodoListRecord | null>(null);

  const todoLists = todos
    .filter((t) => t.scope === "workspace" && t.refKey === currentWorkspace)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const menuItems = (project: ProjectSummary): ContextMenuItem[] => [
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => setPendingDelete(project)
    }
  ];

  const todoMenuItems = (todo: TodoListRecord): ContextMenuItem[] => [
    {
      label: "Rename",
      icon: <Pencil size={13} />,
      onClick: () => setRenamingTodo(todo)
    },
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => setPendingTodoDelete(todo)
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
          <DropdownItem
            icon={<ListTodo size={14} />}
            onClick={() => {
              if (currentWorkspace) {
                void createTodo("workspace", currentWorkspace);
              }
            }}
          >
            New to-do list
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

        {todoLists.length > 0 && (
          <div className="pt-3">
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-600">
              To-do lists
            </p>
            {todoLists.map((todo) =>
              renamingTodo?.id === todo.id ? (
                <NewItemInput
                  key={todo.id}
                  placeholder="list-name"
                  initialValue={todo.name}
                  onCancel={() => setRenamingTodo(null)}
                  onSubmit={(name) => {
                    setRenamingTodo(null);
                    void renameTodo(todo.id, name);
                  }}
                />
              ) : (
                <button
                  key={todo.id}
                  type="button"
                  onClick={() => openTodo(todo)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setTodoMenu({ x: event.clientX, y: event.clientY, todo });
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
                >
                  <ListTodo size={15} className="text-neutral-500" />
                  <span className="flex-1 truncate">{todo.name}</span>
                </button>
              )
            )}
          </div>
        )}
      </nav>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.project)}
          onClose={() => setMenu(null)}
        />
      )}

      {todoMenu && (
        <ContextMenu
          x={todoMenu.x}
          y={todoMenu.y}
          items={todoMenuItems(todoMenu.todo)}
          onClose={() => setTodoMenu(null)}
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

      <ConfirmDialog
        open={pendingTodoDelete !== null}
        title="Delete to-do list"
        message={
          <>
            Delete{" "}
            <span className="font-medium text-neutral-200">{pendingTodoDelete?.name}</span>?
          </>
        }
        onCancel={() => setPendingTodoDelete(null)}
        onConfirm={() => {
          const todo = pendingTodoDelete;
          setPendingTodoDelete(null);
          if (todo) {
            void deleteTodo(todo.id);
          }
        }}
      />

      <NewProjectModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
};
