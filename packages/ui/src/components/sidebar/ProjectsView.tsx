import React, { useEffect, useState } from "react";
import { Box, FolderPlus, ListTodo, Plus, Search, X } from "lucide-react";
import { AdaptiveMenu, DropdownItem, DropdownSeparator } from "../ui";
import { useAppStore } from "../../store/app";
import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import { OpenedAgents } from "./OpenedAgents";
import { WorkspaceList, type WorkspaceCreateKind } from "./WorkspaceList";
import { NewProjectModal } from "./NewProjectModal";
import { NewWorkspaceModal } from "./NewWorkspaceModal";
import type { InlineCreate } from "./WorkspaceProjects";

/**
 * The sidebar's main view: a search over agents, workspaces and projects with
 * the "New" menu beside it, then the opened agents and the workspace tree in
 * one scroll. It owns what is being created, since both the "New" menu and a
 * workspace's own menu start the same flows.
 */
export const ProjectsView: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const [query, setQuery] = useState("");
  const [inlineCreate, setInlineCreate] = useState<InlineCreate>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);

  // An inline name field belongs to the workspace it was opened in.
  useEffect(() => setInlineCreate(null), [currentWorkspace]);

  // Creating inside a workspace happens in the open one (the store creates
  // there), so another workspace is opened — expanded — first.
  const create = async (kind: WorkspaceCreateKind, workspace: string) => {
    if (useAppStore.getState().currentWorkspace !== workspace) {
      await openWorkspace(workspace);
    }
    setQuery("");
    if (kind === "project") {
      setProjectModalOpen(true);
    } else {
      setInlineCreate(kind);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
        <label className="relative flex h-9 min-w-0 flex-1 items-center">
          <span className="sr-only">Search agents, workspaces and projects</span>
          <Search size={15} aria-hidden className="pointer-events-none absolute left-2.5 text-neutral-500" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search agents, workspaces…"
            spellCheck={false}
            // The visible chat's chords stand down for keys typed here.
            {...KEYBOARD_SURFACE_PROPS}
            className="h-full w-full rounded-lg border border-neutral-800 bg-neutral-900/70 pl-8 pr-7 text-[13px] text-neutral-100 placeholder:text-neutral-500 transition-colors hover:border-neutral-700 focus:border-neutral-600 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:text-neutral-200"
            >
              <X size={13} />
            </button>
          )}
        </label>
        <AdaptiveMenu
          trigger={
            // A span: AdaptiveMenu wraps the trigger in its own <button>.
            <span
              aria-label="New"
              title="New"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-600 transition-colors hover:bg-neutral-700"
            >
              <Plus size={17} />
            </span>
          }
          align="right"
          width="w-48"
          title="New"
        >
          {currentWorkspace && (
            <>
              <DropdownItem icon={<Box size={14} />} onClick={() => void create("project", currentWorkspace)}>
                New Project
              </DropdownItem>
              <DropdownItem icon={<FolderPlus size={14} />} onClick={() => void create("folder", currentWorkspace)}>
                New Folder
              </DropdownItem>
              <DropdownItem icon={<ListTodo size={14} />} onClick={() => void create("todo", currentWorkspace)}>
                New to-do list
              </DropdownItem>
              <DropdownSeparator />
            </>
          )}
          <DropdownItem icon={<FolderPlus size={14} />} onClick={() => setWorkspaceModalOpen(true)}>
            New Workspace
          </DropdownItem>
        </AdaptiveMenu>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3 pt-1">
        <OpenedAgents query={query} />
        <div className="border-t border-neutral-800/80 pt-3">
          <WorkspaceList
            query={query}
            inlineCreate={inlineCreate}
            onInlineCreateDone={() => setInlineCreate(null)}
            onCreate={(kind, workspace) => void create(kind, workspace)}
            onNewWorkspace={() => setWorkspaceModalOpen(true)}
          />
        </div>
      </div>

      <NewProjectModal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} />
      <NewWorkspaceModal open={workspaceModalOpen} onClose={() => setWorkspaceModalOpen(false)} />
    </div>
  );
};
