/**
 * "Add a marketplace" (agent profile spec §7.4): a GitHub `owner/repo`, a git
 * URL or a local path, an optional ref and name. Marketplaces are added and
 * removed, never edited. Rules: `marketplace.logic.ts`.
 */

import React, { useCallback, useId, useState } from "react";

import { useEditorEnv, useEditorWide, useReportDirty, useTouch } from "./env";
import { EditorShell } from "./EditorShell";
import { Field, Segmented, TextInput, describedBy } from "./fields";
import { kindTitle } from "./layout.logic";
import {
  initialMarketplaceForm,
  marketplaceDraftFromForm,
  validateMarketplaceForm,
  type MarketplaceForm,
  type MarketplaceSourceType,
  type MarketplaceValidation
} from "./marketplace.logic";
import { SubmitStatus, useProfileSubmit } from "./use-submit";

export const MarketplaceEditor: React.FC = () => {
  const { agent, api } = useEditorEnv();
  const [initial] = useState(initialMarketplaceForm);
  const [form, setForm] = useState<MarketplaceForm>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const submit = useProfileSubmit();
  const validation = validateMarketplaceForm(form);
  useReportDirty(JSON.stringify(form) !== JSON.stringify(initial));

  const change = useCallback(
    (patch: Partial<MarketplaceForm>) => {
      setForm((current) => ({ ...current, ...patch }));
      submit.clear();
    },
    [submit]
  );

  const save = () => {
    if (!validation.valid) {
      setShowErrors(true);
      return;
    }
    const marketplace = marketplaceDraftFromForm(form);
    void submit.run((onConflict) => api.createAgentProfileItem(agent, { draft: { kind: "marketplace", marketplace }, onConflict }));
  };

  return (
    <EditorShell
      title={kindTitle("create", "marketplace")}
      status={<SubmitStatus state={submit} onResolveConflict={submit.resolveConflict} onDismiss={submit.clear} nameShown keepBoth={false} />}
      primary={{ label: "Add marketplace", busyLabel: "Adding…", busy: submit.busy, onClick: save }}
    >
      <MarketplaceFormView form={form} onChange={change} validation={validation} showErrors={showErrors} nameError={submit.nameError} />
    </EditorShell>
  );
};

const SOURCE_OPTIONS: { id: MarketplaceSourceType; label: string; shortLabel?: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "git", label: "Git URL", shortLabel: "Git" },
  { id: "path", label: "Local path", shortLabel: "Path" }
];

export const MarketplaceFormView: React.FC<{
  form: MarketplaceForm;
  onChange: (patch: Partial<MarketplaceForm>) => void;
  validation: MarketplaceValidation;
  showErrors: boolean;
  nameError?: string;
}> = ({ form, onChange, validation, showErrors, nameError }) => {
  const ids = useId();
  const touch = useTouch();
  const wide = useEditorWide();
  const errors = showErrors ? validation.errors : {};
  const sourceId = `${ids}-source`;
  const source =
    form.type === "github" ? (
      <Field id={sourceId} label="Repository" required error={errors.source} hint="owner/repo — a github.com URL works too.">
        <TextInput
          id={sourceId}
          mono
          value={form.repo}
          placeholder="anthropics/claude-plugins-official"
          autoFocus={!touch}
          invalid={Boolean(errors.source)}
          aria-required
          aria-describedby={describedBy(sourceId, errors.source, true)}
          onChange={(event) => onChange({ repo: event.target.value })}
        />
      </Field>
    ) : form.type === "git" ? (
      <Field id={sourceId} label="Git URL" required error={errors.source}>
        <TextInput
          id={sourceId}
          mono
          inputMode="url"
          value={form.url}
          placeholder="https://git.example.com/team/plugins.git"
          invalid={Boolean(errors.source)}
          aria-required
          aria-describedby={describedBy(sourceId, errors.source)}
          onChange={(event) => onChange({ url: event.target.value })}
        />
      </Field>
    ) : (
      <Field id={sourceId} label="Folder" required error={errors.source} hint="A path on the machine the daemon runs on.">
        <TextInput
          id={sourceId}
          mono
          value={form.path}
          placeholder="~/plugins/my-marketplace"
          invalid={Boolean(errors.source)}
          aria-required
          aria-describedby={describedBy(sourceId, errors.source, true)}
          onChange={(event) => onChange({ path: event.target.value })}
        />
      </Field>
    );
  const nameMessage = nameError ?? errors.name;

  return (
    <>
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-neutral-300">Source</div>
        <Segmented label="Source" options={SOURCE_OPTIONS} value={form.type} onChange={(type) => onChange({ type })} />
      </div>
      {source}
      <div className={wide ? "grid grid-cols-2 gap-3" : "space-y-4"}>
        {form.type !== "path" ? (
          <Field id={`${ids}-ref`} label="Branch, tag or commit" optional error={errors.ref}>
            <TextInput
              id={`${ids}-ref`}
              mono
              value={form.ref}
              placeholder="main"
              invalid={Boolean(errors.ref)}
              aria-describedby={describedBy(`${ids}-ref`, errors.ref)}
              onChange={(event) => onChange({ ref: event.target.value })}
            />
          </Field>
        ) : null}
        <Field id={`${ids}-name`} label="Name" optional error={nameMessage} hint="Else the marketplace's own name.">
          <TextInput
            id={`${ids}-name`}
            mono
            value={form.name}
            placeholder="my-plugins"
            invalid={Boolean(nameMessage)}
            aria-describedby={describedBy(`${ids}-name`, nameMessage, true)}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
      </div>
    </>
  );
};
