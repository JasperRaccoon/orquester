/**
 * "New workflow": a name and where it runs — this project (the default),
 * another existing project, or a temporary project created per run in a
 * workspace (empty, or a clone). Creates the workflow with one manual trigger
 * the daemon names and places, then hands it back so the panel opens its
 * editor tab.
 */

import React, { useEffect, useId, useMemo, useState } from "react";
import { FolderGit2, FolderOpen, Loader2, Sparkles } from "lucide-react";

import type { Workflow } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { useIsDesktop } from "../../../hooks/use-media-query";
import { cn } from "../../../lib/cn";
import { KEYBOARD_SURFACE_PROPS } from "../../../lib/keyboard-surfaces";
import { ensureProjectIndex, useProjectIndex } from "../../../lib/project-index";
import {
  initialNewWorkflowDraft,
  resolveNewWorkflow,
  type NewWorkflowDraft,
  type NewWorkflowTarget
} from "../../../lib/workflows/new-workflow";
import { createWorkflow } from "../../../lib/workflows/store";
import { blankWorkflowRequest } from "../../../lib/workflows/templates";
import { useAppStore } from "../../../store/app";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Modal } from "../../ui/modal";
import { RailSegmented, type RailSegmentOption } from "../primitives";
import { DialogHeader, Field, SelectField } from "./dialog-parts";

export interface NewWorkflowDialogProps {
  /** The open project ("" for none). */
  projectPath: string;
  onClose: () => void;
  onCreated: (workflow: Workflow) => void;
}

const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

export const NewWorkflowDialog: React.FC<NewWorkflowDialogProps> = ({ projectPath, onClose, onCreated }) => {
  const api = useApi();
  const ids = useId();
  const touch = !useIsDesktop();
  const workspaces = useAppStore((state) => state.workspaces);
  const index = useProjectIndex();
  const [draft, setDraft] = useState<NewWorkflowDraft>(() => initialNewWorkflowDraft(projectPath));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    void ensureProjectIndex(api, workspaces).catch(() => undefined);
  }, [api, workspaces]);

  const projects = useMemo(
    () =>
      [...(index?.visible.values() ?? [])].sort(
        (a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name)
      ),
    [index]
  );
  const liveWorkspaces = useMemo(() => workspaces.filter((ws) => !ws.isArchived), [workspaces]);

  const change = (patch: Partial<NewWorkflowDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const resolution = resolveNewWorkflow(draft, projectPath);
  const fieldError = (field: string): string | null =>
    touched && !resolution.ok && resolution.field === field ? resolution.message : null;

  const submit = async () => {
    setTouched(true);
    if (!resolution.ok || saving) return;
    setSaving(true);
    setError(null);
    const result = await createWorkflow(api, blankWorkflowRequest(resolution.name, resolution.project), {
      quiet: true
    });
    setSaving(false);
    if (result.ok) onCreated(result.value);
    else setError(result.error);
  };

  const targetOptions: RailSegmentOption<NewWorkflowTarget>[] = [
    {
      id: "this",
      label: "This project",
      title: projectPath ? baseName(projectPath) : "Open a project to use it",
      disabled: projectPath.length === 0
    },
    { id: "other", label: "Another", title: "An existing project" },
    { id: "temp", label: "Temporary", title: "A fresh project created for each run" }
  ];

  return (
    <Modal open onClose={onClose} className="max-h-[calc(100dvh-1.5rem)] max-w-md sm:max-h-[90vh]">
      <form
        {...KEYBOARD_SURFACE_PROPS}
        className="flex min-h-0 w-full flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader title="New workflow" subtitle="Starts with a manual trigger — build it in the editor." onClose={onClose} />
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <Field id={`${ids}-name`} label="Name" error={fieldError("name")}>
            <Input
              id={`${ids}-name`}
              autoFocus
              value={draft.name}
              maxLength={200}
              placeholder="Nightly dependency bump"
              onChange={(event) => change({ name: event.target.value })}
              className={cn(touch && "h-10 text-[15px]")}
            />
          </Field>

          <div className="space-y-2">
            <div className="text-xs text-neutral-400">Runs in</div>
            <RailSegmented
              label="Where the workflow runs"
              options={targetOptions}
              value={draft.target}
              onChange={(target) => change({ target })}
            />
            <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
              {draft.target === "this" ? (
                <div className="flex items-center gap-2.5 text-sm">
                  <FolderOpen size={15} aria-hidden className="shrink-0 text-neutral-500" />
                  <div className="min-w-0">
                    <div className="truncate text-neutral-200">{baseName(projectPath)}</div>
                    <div className="truncate text-xs text-neutral-500">{projectPath}</div>
                  </div>
                </div>
              ) : draft.target === "other" ? (
                <Field id={`${ids}-project`} label="Project" error={fieldError("project")}>
                  <SelectField
                    id={`${ids}-project`}
                    touch={touch}
                    value={draft.otherPath}
                    onChange={(event) => change({ otherPath: event.target.value })}
                  >
                    <option value="">{index === null ? "Loading projects…" : "Choose a project"}</option>
                    {projects.map((project) => (
                      <option key={project.path} value={project.path}>
                        {project.workspace} / {project.name}
                      </option>
                    ))}
                  </SelectField>
                </Field>
              ) : (
                <div className="space-y-3">
                  <Field
                    id={`${ids}-workspace`}
                    label="Workspace"
                    hint="Each run gets its own project here; it is deleted after a successful run."
                    error={fieldError("workspace")}
                  >
                    <SelectField
                      id={`${ids}-workspace`}
                      touch={touch}
                      value={draft.workspace}
                      onChange={(event) => change({ workspace: event.target.value })}
                    >
                      <option value="">Choose a workspace</option>
                      {liveWorkspaces.map((ws) => (
                        <option key={ws.name} value={ws.name}>
                          {ws.name}
                        </option>
                      ))}
                    </SelectField>
                  </Field>
                  <RailSegmented
                    label="What the temporary project starts from"
                    options={[
                      { id: "empty", label: "Empty" },
                      { id: "clone", label: "Clone a repository" }
                    ]}
                    value={draft.source}
                    onChange={(source) => change({ source })}
                  />
                  {draft.source === "clone" ? (
                    <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                      <Field id={`${ids}-url`} label="Repository" error={fieldError("cloneUrl")}>
                        <Input
                          id={`${ids}-url`}
                          value={draft.cloneUrl}
                          spellCheck={false}
                          autoCapitalize="off"
                          placeholder="git@github.com:org/repo.git"
                          onChange={(event) => change({ cloneUrl: event.target.value })}
                          className={cn(touch && "h-10")}
                        />
                      </Field>
                      <Field id={`${ids}-ref`} label="Ref (optional)">
                        <Input
                          id={`${ids}-ref`}
                          value={draft.cloneRef}
                          spellCheck={false}
                          autoCapitalize="off"
                          placeholder="main"
                          onChange={(event) => change({ cloneRef: event.target.value })}
                          className={cn(touch && "h-10")}
                        />
                      </Field>
                    </div>
                  ) : (
                    <p className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                      <FolderGit2 size={12} aria-hidden />
                      An empty directory, fresh for every run.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {error !== null ? (
            <p role="alert" className="break-words text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <Button type="button" variant="outline" onClick={onClose} className={cn(touch && "h-10 flex-1")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} className={cn(touch && "h-10 flex-1")}>
            {saving ? <Loader2 size={14} aria-hidden className="animate-spin" /> : <Sparkles size={14} aria-hidden />}
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
};
