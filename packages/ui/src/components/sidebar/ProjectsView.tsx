import React, { useEffect, useState } from "react";
import { useAppStore } from "../../store/app";
import { OpenedAgents } from "./OpenedAgents";
import { WorkspaceList, type WorkspaceCreateKind } from "./WorkspaceList";
import type { NewProjectPreset } from "./NewProjectModal";
import { lazyDialog, lazyNamed } from "../ui/lazy";
import { NewWorkspaceModal } from "./NewWorkspaceModal";
import type { InlineCreate } from "./WorkspaceProjects";

// Loads with its first opening.
const NewProjectModal = lazyDialog(lazyNamed(() => import("./NewProjectModal"), "NewProjectModal"));

/**
 * The sidebar's main view: the opened agents and the workspace tree in one
 * scroll. It owns what is being created, since both the Workspaces "+" menu
 * and a workspace's own menu start the same flows.
 */
export const ProjectsView: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const [inlineCreate, setInlineCreate] = useState<InlineCreate>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  /** What the project modal opens on: a repo group's fresh clone, or nothing (the plain flow). */
  const [projectPreset, setProjectPreset] = useState<NewProjectPreset | null>(null);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);

  // An inline name field belongs to the workspace it was opened in.
  useEffect(() => setInlineCreate(null), [currentWorkspace]);

  // Creating inside a workspace happens in the open one (the store creates
  // there), so another workspace is opened — expanded — first.
  const create = async (kind: WorkspaceCreateKind, workspace: string) => {
    if (useAppStore.getState().currentWorkspace !== workspace) {
      await openWorkspace(workspace);
    }
    if (kind === "project") {
      setProjectPreset(null);
      setProjectModalOpen(true);
    } else {
      setInlineCreate(kind);
    }
  };

  // A repo group's "+": the same modal, fixed on a fresh clone of that repo.
  const cloneRepo = async (workspace: string, preset: NewProjectPreset) => {
    if (useAppStore.getState().currentWorkspace !== workspace) {
      await openWorkspace(workspace);
    }
    setProjectPreset(preset);
    setProjectModalOpen(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <OpenedAgents />
        <div className="border-t border-neutral-800/80 pt-3">
          <WorkspaceList
            inlineCreate={inlineCreate}
            onInlineCreateDone={() => setInlineCreate(null)}
            onCreate={(kind, workspace) => void create(kind, workspace)}
            onCloneRepo={(workspace, preset) => void cloneRepo(workspace, preset)}
            onNewWorkspace={() => setWorkspaceModalOpen(true)}
          />
        </div>
      </div>

      <NewProjectModal
        open={projectModalOpen}
        preset={projectPreset}
        onClose={() => {
          setProjectModalOpen(false);
          setProjectPreset(null);
        }}
      />
      <NewWorkspaceModal open={workspaceModalOpen} onClose={() => setWorkspaceModalOpen(false)} />
    </div>
  );
};
