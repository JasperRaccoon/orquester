import React, { useEffect, useState } from "react";
import {
  Archive,
  Box,
  ClipboardCopy,
  ListTodo,
  Pencil,
  Trash2,
  Workflow as WorkflowIcon
} from "lucide-react";
import { cn } from "../../lib/cn";
import { ConfirmDialog, ContextMenu, type ContextMenuItem } from "../ui";
import { NewItemInput } from "./NewItemInput";
import { ArchivedFooter } from "./ArchivedFooter";
import { RowActionsButton } from "./parts";
import { useAppStore } from "../../store/app";
import { copyText } from "../../lib/clipboard";
import { matchesSidebarQuery } from "../../lib/opened-agents";
import type { ProjectSummary } from "../../types";
import type { TodoListRecord } from "@orquester/api";
import { useApi } from "../../context/orquester-context";
import { useWorkflowsLoadStatus, useWorkflowTempProjects } from "../../lib/workflows/hooks";
import { loadWorkflows } from "../../lib/workflows/store";
import { isWorkflowTempProject, looksLikeWorkflowTempProject } from "../../lib/workflows/temp-projects";

/** What the sidebar is naming inline inside the open workspace, if anything. */
export type InlineCreate = "folder" | "todo" | null;

/**
 * One project row inside a workspace. The open project reads as selected: a
 * raised row with an accent bar on its left edge.
 */
export const ProjectRow: React.FC<{
  project: ProjectSummary;
  active: boolean;
  tempMarker: boolean;
  onOpen: () => void;
  onMenu?: (at: { x: number; y: number }) => void;
}> = ({ project, active, tempMarker, onOpen, onMenu }) => (
  <div
    onContextMenu={(event) => {
      if (!onMenu) return;
      event.preventDefault();
      onMenu({ x: event.clientX, y: event.clientY });
    }}
    className={cn(
      "group relative flex items-center rounded-lg transition-colors",
      active
        ? "bg-neutral-800 text-neutral-50"
        : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
    )}
  >
    {active && (
      <span aria-hidden className="absolute -left-1.5 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-neutral-400" />
    )}
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
    >
      <Box size={15} className={cn("shrink-0", active ? "text-neutral-300" : "text-neutral-500")} />
      <span className="flex-1 truncate">{project.name}</span>
      {tempMarker ? (
        <span
          title="Temporary project of a workflow run"
          aria-label="Temporary project of a workflow run"
          className="shrink-0 text-neutral-500"
        >
          <WorkflowIcon size={12} aria-hidden />
        </span>
      ) : null}
    </button>
    {onMenu && <RowActionsButton label={`Actions for ${project.name}`} onOpen={onMenu} />}
  </div>
);

/**
 * The open workspace's contents, under its expanded row: its projects, its
 * to-do lists and its archived projects. `query` narrows the rows to those
 * whose name matches (the sidebar search); `creating` names a new folder or
 * to-do list inline, at the top of its list.
 */
export const WorkspaceProjects: React.FC<{
  workspace: string;
  query: string;
  creating: InlineCreate;
  onCreatingDone: () => void;
}> = ({ workspace, query, creating, onCreatingDone }) => {
  const currentProject = useAppStore((s) => s.currentProject);
  const projects = useAppStore((s) => s.projects);
  const loading = useAppStore((s) => s.projectsLoading);
  const openProject = useAppStore((s) => s.openProject);
  const createProject = useAppStore((s) => s.createProject);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const setProjectArchived = useAppStore((s) => s.setProjectArchived);
  const todos = useAppStore((s) => s.todos);
  const createTodo = useAppStore((s) => s.createTodo);
  const openTodo = useAppStore((s) => s.openTodo);
  const renameTodo = useAppStore((s) => s.renameTodo);
  const deleteTodo = useAppStore((s) => s.deleteTodo);
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectSummary } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [todoMenu, setTodoMenu] = useState<{ x: number; y: number; todo: TodoListRecord } | null>(
    null
  );
  const [renamingTodo, setRenamingTodo] = useState<TodoListRecord | null>(null);
  const [pendingTodoDelete, setPendingTodoDelete] = useState<TodoListRecord | null>(null);

  // Archived projects live only behind the archived entry at the bottom.
  const visibleProjects = projects.filter((p) => !p.isArchived);
  const shownProjects = visibleProjects.filter((p) => matchesSidebarQuery(query, p.name));

  // §5.10: a workflow run's temporary project carries a small marker. The
  // workflows store is the evidence; it is asked for only when a project's
  // name looks like one and nothing loaded the workflows yet.
  const api = useApi();
  const tempProjects = useWorkflowTempProjects();
  const workflowsLoad = useWorkflowsLoadStatus();
  const connected = useAppStore((s) => s.connectionStatus === "connected");
  const anyLookalike = visibleProjects.some((p) => looksLikeWorkflowTempProject(p.name));
  useEffect(() => {
    if (connected && anyLookalike && workflowsLoad === "idle") void loadWorkflows(api);
  }, [api, connected, anyLookalike, workflowsLoad]);

  const todoLists = todos
    .filter((t) => t.scope === "workspace" && t.refKey === workspace)
    .filter((t) => matchesSidebarQuery(query, t.name))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const searching = query.trim().length > 0;

  const menuItems = (project: ProjectSummary): ContextMenuItem[] => [
    {
      label: "Copy Full Path",
      icon: <ClipboardCopy size={13} />,
      onClick: () => void copyText(project.path)
    },
    {
      label: "Archive",
      icon: <Archive size={13} />,
      onClick: () => void setProjectArchived(project, true)
    },
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
    <div className="space-y-px pl-6 pr-1.5">
      {creating === "folder" && (
        <NewItemInput
          placeholder="folder-name"
          onCancel={onCreatingDone}
          onSubmit={(name) => {
            onCreatingDone();
            void createProject({ source: "empty", name });
          }}
        />
      )}

      {loading && visibleProjects.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-neutral-600">Loading…</p>
      )}
      {!loading && visibleProjects.length === 0 && creating !== "folder" && (
        <p className="px-2 py-1.5 text-xs text-neutral-600">No projects yet</p>
      )}
      {shownProjects.map((project) => (
        <ProjectRow
          key={project.path}
          project={project}
          active={project.path === currentProject?.path}
          tempMarker={isWorkflowTempProject(project, tempProjects)}
          onOpen={() => openProject(project)}
          onMenu={(at) => setMenu({ ...at, project })}
        />
      ))}

      {(creating === "todo" || todoLists.length > 0) && (
        <div className="pt-2">
          <p className="px-2 pb-1 text-xs text-neutral-500">To-do lists</p>
          {creating === "todo" && (
            <NewItemInput
              placeholder="list-name"
              onCancel={onCreatingDone}
              onSubmit={(name) => {
                onCreatingDone();
                void createTodo("workspace", workspace, name);
              }}
            />
          )}
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
              <div
                key={todo.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setTodoMenu({ x: event.clientX, y: event.clientY, todo });
                }}
                className="group flex items-center rounded-lg text-neutral-300 transition-colors hover:bg-neutral-800/60 hover:text-neutral-100"
              >
                <button
                  type="button"
                  onClick={() => openTodo(todo)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                >
                  <ListTodo size={15} className="shrink-0 text-neutral-500" />
                  <span className="flex-1 truncate">{todo.name}</span>
                </button>
                <RowActionsButton
                  label={`Actions for ${todo.name}`}
                  onOpen={(at) => setTodoMenu({ ...at, todo })}
                />
              </div>
            )
          )}
        </div>
      )}

      {!searching && (
        <div className="pt-1">
          <ArchivedFooter scope="projects" />
        </div>
      )}

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
    </div>
  );
};
