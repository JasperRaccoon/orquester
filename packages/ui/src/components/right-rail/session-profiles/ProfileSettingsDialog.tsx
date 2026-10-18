/**
 * A profile's settings (agent profiles spec §4.3): name, icon, description,
 * and per agent "Hide built-in skills" (default on) plus Claude's Workflow
 * tool (default on). The header's gear opens it on a profile; "+ New" opens
 * it empty to create one (`mode: "create"`). Rename in the "⋯" menu opens it
 * with the name focused.
 *
 * Saving sends only what changed (`UpdateSessionProfileRequest`); a cleared
 * icon is `icon: null`. The daemon's refusal — a taken name, a stale
 * revision — is shown in the dialog, which stays open.
 */

import React, { useId, useState } from "react";

import {
  SESSION_PROFILE_AGENTS,
  SESSION_PROFILE_DEFAULT_SETTINGS,
  SESSION_PROFILE_DESCRIPTION_MAX,
  SESSION_PROFILE_ICON_MAX,
  SESSION_PROFILE_NAME_MAX,
  type CreateSessionProfileRequest,
  type SessionProfileAgentId,
  type SessionProfileDetail,
  type SessionProfileSettings,
  type UpdateSessionProfileRequest
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import { agentLabel } from "../../../lib/session-profiles/logic";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Modal, ModalCloseButton } from "../../ui/modal";
import { RailSwitch } from "../primitives";
import { PROFILE_ICON_PRESETS, ProfileIcon } from "./ProfileIcon";

export interface ProfileSettingsForm {
  name: string;
  icon: string;
  description: string;
  settings: SessionProfileSettings;
}

export function profileSettingsForm(profile: SessionProfileDetail | null): ProfileSettingsForm {
  return {
    name: profile?.name ?? "",
    icon: profile?.icon ?? "",
    description: profile?.description ?? "",
    settings: profile?.settings ?? {
      hideBuiltinSkills: { ...SESSION_PROFILE_DEFAULT_SETTINGS.hideBuiltinSkills },
      claudeWorkflowTool: SESSION_PROFILE_DEFAULT_SETTINGS.claudeWorkflowTool
    }
  };
}

export function profileSettingsProblem(form: ProfileSettingsForm): string | null {
  const name = form.name.trim();
  if (name === "") return "Name the profile";
  if (name.length > SESSION_PROFILE_NAME_MAX) return `At most ${SESSION_PROFILE_NAME_MAX} characters`;
  if (form.icon.trim().length > SESSION_PROFILE_ICON_MAX) return `The icon is at most ${SESSION_PROFILE_ICON_MAX} characters`;
  if (form.description.length > SESSION_PROFILE_DESCRIPTION_MAX) {
    return `The description is at most ${SESSION_PROFILE_DESCRIPTION_MAX} characters`;
  }
  return null;
}

/** What a create sends. */
export function createRequestFromForm(form: ProfileSettingsForm): CreateSessionProfileRequest {
  const icon = form.icon.trim();
  return {
    name: form.name.trim(),
    ...(icon !== "" ? { icon } : {}),
    ...(form.description.trim() !== "" ? { description: form.description.trim() } : {}),
    settings: { hideBuiltinSkills: { ...form.settings.hideBuiltinSkills }, claudeWorkflowTool: form.settings.claudeWorkflowTool }
  };
}

/** What an edit sends: only the fields that changed (the revision is the store's). */
export function updatePatchFromForm(
  profile: SessionProfileDetail,
  form: ProfileSettingsForm
): Omit<UpdateSessionProfileRequest, "revision"> {
  const patch: Omit<UpdateSessionProfileRequest, "revision"> = {};
  const name = form.name.trim();
  if (name !== profile.name) patch.name = name;
  const icon = form.icon.trim();
  if (icon !== (profile.icon ?? "")) patch.icon = icon === "" ? null : icon;
  const description = form.description.trim();
  if (description !== profile.description) patch.description = description;
  const hide: Partial<Record<SessionProfileAgentId, boolean>> = {};
  for (const agent of SESSION_PROFILE_AGENTS) {
    if (form.settings.hideBuiltinSkills[agent] !== profile.settings.hideBuiltinSkills[agent]) {
      hide[agent] = form.settings.hideBuiltinSkills[agent];
    }
  }
  const settings: NonNullable<UpdateSessionProfileRequest["settings"]> = {};
  if (Object.keys(hide).length > 0) settings.hideBuiltinSkills = hide;
  if (form.settings.claudeWorkflowTool !== profile.settings.claudeWorkflowTool) {
    settings.claudeWorkflowTool = form.settings.claudeWorkflowTool;
  }
  if (Object.keys(settings).length > 0) patch.settings = settings;
  return patch;
}

export const ProfileSettingsDialog: React.FC<{
  open: boolean;
  mode: "create" | "edit";
  profile: SessionProfileDetail | null;
  /** Focus the name (Rename). */
  focusName?: boolean;
  sheet: boolean;
  onCancel: () => void;
  /** Resolves to the refusal's words, or `null` once saved (the dialog then closes). */
  onSubmit: (form: ProfileSettingsForm) => Promise<string | null>;
}> = ({ open, ...props }) => (
  <Modal open={open} onClose={props.onCancel} className="max-w-md">
    {open ? <SettingsBody {...props} /> : null}
  </Modal>
);

const SettingsBody: React.FC<{
  mode: "create" | "edit";
  profile: SessionProfileDetail | null;
  focusName?: boolean;
  sheet: boolean;
  onCancel: () => void;
  onSubmit: (form: ProfileSettingsForm) => Promise<string | null>;
}> = ({ mode, profile, focusName = false, sheet, onCancel, onSubmit }) => {
  const ids = useId();
  const [form, setForm] = useState<ProfileSettingsForm>(() => profileSettingsForm(profile));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = profileSettingsProblem(form);
  const change = (patch: Partial<ProfileSettingsForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const setHide = (agent: SessionProfileAgentId, value: boolean) =>
    change({ settings: { ...form.settings, hideBuiltinSkills: { ...form.settings.hideBuiltinSkills, [agent]: value } } });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (problem !== null || busy) {
      setError(problem);
      return;
    }
    setBusy(true);
    const refusal = await onSubmit(form);
    setBusy(false);
    if (refusal !== null) setError(refusal);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex max-h-[90vh] w-full flex-col" aria-label="Profile settings">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <ProfileIcon icon={form.icon.trim() || undefined} size="md" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-50">
          {mode === "create" ? "New Agent Profile" : "Profile settings"}
        </h2>
        <ModalCloseButton onClose={onCancel} />
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="space-y-1.5">
          <label htmlFor={`${ids}-name`} className="text-xs font-medium text-neutral-300">
            Name <span className="text-neutral-500">*</span>
          </label>
          <Input
            id={`${ids}-name`}
            value={form.name}
            maxLength={SESSION_PROFILE_NAME_MAX}
            placeholder="Developer, Editor, Research…"
            autoFocus={mode === "create" || focusName}
            onFocus={(event) => {
              if (focusName) event.currentTarget.select();
            }}
            onChange={(event) => change({ name: event.target.value })}
            className={cn(sheet && "h-10 text-base")}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${ids}-icon`} className="text-xs font-medium text-neutral-300">
            Icon <span className="font-normal text-neutral-500">(an emoji)</span>
          </label>
          <div className="flex flex-wrap items-center gap-1">
            {PROFILE_ICON_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-label={`Use ${preset}`}
                aria-pressed={form.icon.trim() === preset}
                onClick={() => change({ icon: preset })}
                className={cn(
                  "flex items-center justify-center rounded-md text-[15px] transition-colors",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  sheet ? "h-10 w-10" : "h-8 w-8",
                  form.icon.trim() === preset ? "bg-neutral-700 ring-1 ring-neutral-500" : "hover:bg-neutral-800"
                )}
              >
                {preset}
              </button>
            ))}
            <Input
              id={`${ids}-icon`}
              value={form.icon}
              maxLength={SESSION_PROFILE_ICON_MAX}
              placeholder="Other"
              aria-label="Icon"
              onChange={(event) => change({ icon: event.target.value })}
              className={cn("w-20", sheet && "h-10 text-base")}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${ids}-description`} className="text-xs font-medium text-neutral-300">
            Description
          </label>
          <textarea
            id={`${ids}-description`}
            rows={2}
            value={form.description}
            maxLength={SESSION_PROFILE_DESCRIPTION_MAX}
            placeholder="What kind of work this profile is for"
            onChange={(event) => change({ description: event.target.value })}
            className={cn(
              "w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
              sheet && "text-base"
            )}
          />
        </div>
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-neutral-300">Hide built-in skills</legend>
          <p className="pb-1 text-[11px] leading-4 text-neutral-500">
            The skills each agent CLI ships with cost context in every chat; hide them in this profile's chats.
          </p>
          {SESSION_PROFILE_AGENTS.map((agent) => (
            <div key={agent} className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-neutral-200">{agentLabel(agent)}</span>
              <RailSwitch
                checked={form.settings.hideBuiltinSkills[agent]}
                sheet={sheet}
                label={`Hide ${agentLabel(agent)}'s built-in skills`}
                onChange={(value) => setHide(agent, value)}
              />
            </div>
          ))}
        </fieldset>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-neutral-300">Claude Workflow tool</div>
            <p className="text-[11px] leading-4 text-neutral-500">Off saves about 1.5k tokens in every Claude chat.</p>
          </div>
          <RailSwitch
            checked={form.settings.claudeWorkflowTool}
            sheet={sheet}
            label="Claude Workflow tool"
            onChange={(value) => change({ settings: { ...form.settings, claudeWorkflowTool: value } })}
          />
        </div>
      </div>
      <footer className="shrink-0 space-y-2 border-t border-neutral-800 px-4 py-3">
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} className={cn(sheet && "h-10")}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || problem !== null} className={cn(sheet && "h-10")}>
            {busy ? "Saving…" : mode === "create" ? "Create profile" : "Save"}
          </Button>
        </div>
      </footer>
    </form>
  );
};
