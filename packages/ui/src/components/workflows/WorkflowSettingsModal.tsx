/**
 * A workflow's settings (workflows spec §3.1, §5.10, §5.11, §7.2): where it
 * runs (an existing project, or a temporary one per run), what happens when a
 * trigger fires while it is still running, its time zone, run timeout,
 * notifications, how long a failed temporary project is kept, and its secrets.
 * Every change is an edit of the draft — autosaved and undoable like the rest.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { KeyRound, Search } from "lucide-react";

import { isValidTimeZone, type Workflow, type WorkflowProject, type WorkflowSettings } from "@orquester/api";

import { cn } from "../../lib/cn";
import type { WorkflowEditor } from "../../lib/workflows/editor-store";
import { browserTimeZone } from "../../lib/workflows/templates";
import { useAppStore } from "../../store/app";
import { WorkspaceRepoPicker } from "./RepoPicker";
import { Modal, ModalCloseButton } from "../ui/modal";
import { Field, NumberInput, Section, Segmented, SelectInput, SmallButton, TextInput, ToggleRow } from "./ui/controls";
import { ProjectSelect } from "./ui/ProjectSelect";

export { browserTimeZone };

/** Every IANA zone this runtime knows (a short list when it cannot say). */
export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.("timeZone");
    if (all && all.length > 0) return all.includes("UTC") ? all : ["UTC", ...all];
  } catch {
    // fall through
  }
  return ["UTC", "Europe/London", "Europe/Madrid", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];
}

const TimeZonePicker: React.FC<{ value: string; onChange: (zone: string) => void }> = ({ value, onChange }) => {
  const [query, setQuery] = useState("");
  const zones = useMemo(timeZones, []);
  const local = browserTimeZone();
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Open on the chosen zone, not on "Africa/Abidjan".
    const list = listRef.current;
    const chosen = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && chosen) list.scrollTop = chosen.offsetTop - 48;
  }, []);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/\s+/g, "_");
    const list = needle ? zones.filter((zone) => zone.toLowerCase().includes(needle)) : zones;
    return list;
  }, [query, zones]);
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search size={13} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
        <TextInput value={query} onValue={setQuery} placeholder={`Search — now ${value}`} aria-label="Search time zones" className="pl-7" />
      </div>
      <div ref={listRef} role="listbox" aria-label="Time zones" className="relative max-h-40 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950/40 p-1">
        {!zones.includes(value) ? (
          <div className="px-2 py-1 text-[12px] text-danger">“{value}” is not a zone this browser knows.</div>
        ) : null}
        {shown.map((zone) => (
          <button
            key={zone}
            type="button"
            role="option"
            aria-selected={zone === value}
            onClick={() => onChange(zone)}
            className={cn(
              "flex w-full items-center justify-between rounded px-2 py-1 text-left text-[12px]",
              zone === value ? "bg-neutral-800 text-neutral-50" : "text-neutral-300 hover:bg-neutral-900"
            )}
          >
            <span className="truncate">{zone.replace(/_/g, " ")}</span>
            {zone === local ? <span className="shrink-0 text-[10.5px] text-neutral-500">this device</span> : null}
          </button>
        ))}
        {shown.length === 0 ? <div className="px-2 py-1.5 text-[12px] text-neutral-500">No zone matches.</div> : null}
      </div>
    </div>
  );
};

export interface WorkflowSettingsModalProps {
  open: boolean;
  onClose: () => void;
  editor: WorkflowEditor;
  workflow: Workflow;
  readOnly: boolean;
  onOpenSecrets: () => void;
  /** The project a switch back to "existing" starts with (the tab's). */
  defaultProjectPath: string;
}

export const WorkflowSettingsModal: React.FC<WorkflowSettingsModalProps> = ({
  open,
  onClose,
  editor,
  workflow,
  readOnly,
  onOpenSecrets,
  defaultProjectPath
}) => {
  const ids = useId();
  const workspaces = useAppStore((state) => state.workspaces);
  const liveWorkspaces = useMemo(() => workspaces.filter((ws) => !ws.isArchived), [workspaces]);
  const settings = workflow.settings;
  const project = workflow.project;

  const setSettings = (patch: Partial<WorkflowSettings>, key: string): void => {
    if (readOnly) return;
    editor.change((draft) => ({ ...draft, settings: { ...draft.settings, ...patch } }), { coalesce: `settings:${key}` });
  };
  const setProject = (next: WorkflowProject, key: string): void => {
    if (readOnly) return;
    editor.change((draft) => ({ ...draft, project: next }), { coalesce: `project:${key}` });
  };
  const setDescription = (description: string): void => {
    if (readOnly) return;
    editor.change(
      (draft) => {
        const { description: _old, ...rest } = draft;
        return description ? { ...rest, description } : (rest as Workflow);
      },
      { coalesce: "description" }
    );
  };

  return (
    <Modal open={open} onClose={onClose} className="max-h-[calc(100dvh-1.5rem)] max-w-xl flex-col sm:max-h-[88vh]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-neutral-100">Workflow settings</div>
          <div className="truncate text-xs text-neutral-500">{workflow.name}</div>
        </div>
        <ModalCloseButton onClose={onClose} />
      </div>
      <fieldset disabled={readOnly} className="min-h-0 flex-1 overflow-y-auto" data-keyboard-surface="">
        <Section title="About">
          <Field label="Description" htmlFor={`${ids}-description`}>
            <textarea
              id={`${ids}-description`}
              value={workflow.description ?? ""}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="What this workflow is for"
              className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-2 text-[13px] text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
          </Field>
        </Section>

        <Section title="Where it runs">
          <Segmented
            label="Project kind"
            value={project.kind}
            onChange={(kind) =>
              setProject(
                kind === "existing"
                  ? { kind: "existing", projectPath: defaultProjectPath }
                  : { kind: "temp", workspace: liveWorkspaces[0]?.name ?? "", source: { kind: "empty" } },
                "kind"
              )
            }
            options={[
              { id: "existing", label: "An existing project" },
              { id: "temp", label: "A temporary project per run" }
            ]}
          />
          {project.kind === "existing" ? (
            <Field label="Project" htmlFor={`${ids}-project`}>
              <ProjectSelect
                id={`${ids}-project`}
                value={project.projectPath}
                onChange={(projectPath) => setProject({ kind: "existing", projectPath }, "path")}
                ariaLabel="Project"
              />
            </Field>
          ) : (
            <div className="space-y-3">
              <Field label="Workspace" hint="Each run gets a fresh project here; it is deleted after a successful run.">
                <SelectInput value={project.workspace} aria-label="Workspace" onValue={(workspace) => setProject({ ...project, workspace }, "workspace")}>
                  {!liveWorkspaces.some((ws) => ws.name === project.workspace) ? <option value={project.workspace}>{project.workspace || "Choose a workspace"}</option> : null}
                  {liveWorkspaces.map((ws) => (
                    <option key={ws.name} value={ws.name}>
                      {ws.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Segmented
                label="Starts from"
                size="sm"
                value={project.source.kind}
                onChange={(kind) => setProject({ ...project, source: kind === "empty" ? { kind: "empty" } : { kind: "clone", url: "" } }, "source")}
                options={[
                  { id: "empty", label: "An empty folder" },
                  { id: "clone", label: "A clone" }
                ]}
              />
              {project.source.kind === "clone" ? (
                <div className="space-y-3">
                  <WorkspaceRepoPicker
                    workspace={project.workspace}
                    value={project.source.url}
                    urlInputClassName="font-mono text-[12px]"
                    onChange={(url) => {
                      const source = project.source as { kind: "clone"; url: string; ref?: string };
                      setProject({ ...project, source: { ...source, url } }, "url");
                    }}
                  />
                  <Field label="Branch, tag or commit (optional)">
                    <TextInput
                      value={project.source.ref ?? ""}
                      placeholder="default branch"
                      className="font-mono text-[12px]"
                      onValue={(ref) => {
                        const source = project.source as { kind: "clone"; url: string };
                        setProject({ ...project, source: ref ? { kind: "clone", url: source.url, ref } : { kind: "clone", url: source.url } }, "ref");
                      }}
                    />
                  </Field>
                </div>
              ) : null}
              <Field label="Keep a failed run's project for" hint="So you can look at what went wrong; 0 deletes it at once.">
                <NumberInput
                  value={settings.keepFailedTempDays}
                  onValue={(days) => setSettings({ keepFailedTempDays: Math.round(days ?? 3) }, "keep")}
                  min={0}
                  max={30}
                  suffix="days"
                  className="w-32"
                  allowEmpty={false}
                  aria-label="Days to keep a failed run's project"
                />
              </Field>
            </div>
          )}
        </Section>

        <Section title="When it is already running">
          <Segmented
            label="Overlap"
            value={settings.overlap}
            onChange={(overlap) => setSettings({ overlap }, "overlap")}
            options={[
              { id: "skip", label: "Skip the new run" },
              { id: "queue", label: "Queue one" },
              { id: "parallel", label: "Run in parallel" }
            ]}
          />
          {settings.overlap === "parallel" ? (
            <Field label="At most, at once">
              <NumberInput
                value={settings.maxConcurrent}
                onValue={(maxConcurrent) => setSettings({ maxConcurrent: Math.round(maxConcurrent ?? 2) }, "concurrent")}
                min={1}
                max={8}
                suffix="runs"
                className="w-32"
                allowEmpty={false}
                aria-label="Maximum concurrent runs"
              />
            </Field>
          ) : (
            <p className="text-[11px] leading-4 text-neutral-500">
              {settings.overlap === "skip"
                ? "A trigger that fires mid-run is recorded as skipped. Run now can still run it anyway."
                : "At most one fire waits; it starts when the running one ends."}
            </p>
          )}
        </Section>

        <Section title="Timing">
          <Field label="Time zone" hint="Schedules and Wait-until times are read in it.">
            <TimeZonePicker value={settings.timezone} onChange={(timezone) => isValidTimeZone(timezone) && setSettings({ timezone }, "timezone")} />
          </Field>
          <Field label="Stop a run after" hint="Empty: no limit for the whole run (each block still has its own).">
            <NumberInput
              value={settings.runTimeoutMinutes}
              onValue={(runTimeoutMinutes) => setSettings({ runTimeoutMinutes }, "timeout")}
              min={1}
              suffix="min"
              placeholder="no limit"
              className="w-36"
              aria-label="Run timeout"
            />
          </Field>
        </Section>

        <Section title="Notifications">
          <ToggleRow
            checked={settings.notify.onFailure}
            onChange={(onFailure) => setSettings({ notify: { ...settings.notify, onFailure } }, "notify-failure")}
            label="When a run fails"
          />
          <ToggleRow
            checked={settings.notify.onSuccess}
            onChange={(onSuccess) => setSettings({ notify: { ...settings.notify, onSuccess } }, "notify-success")}
            label="When a run succeeds"
          />
        </Section>

        <Section title="Secrets">
          <p className="text-[12px] leading-5 text-neutral-400">
            Values the blocks read as <code className="text-neutral-300">{"{{ secrets.NAME }}"}</code> — write-only, and replaced by a
            placeholder in every stored output and log.
          </p>
          <SmallButton icon={<KeyRound size={12} />} onClick={onOpenSecrets}>
            Manage this workflow's secrets
          </SmallButton>
        </Section>
      </fieldset>
    </Modal>
  );
};
