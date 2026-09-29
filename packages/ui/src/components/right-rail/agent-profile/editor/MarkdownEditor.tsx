/**
 * Skills and commands (agent profile spec §6, §7.4). Creating one offers four
 * sources — Write · Git URL · Upload · Copy from agent — under a switcher that
 * stays put while the body scrolls; editing one is Write on its file. The
 * Write form shows the frontmatter fields the agent knows for that kind, the
 * name, and the body in CodeMirror filling the height left. Frontmatter keys
 * it does not show are kept as they are on disk, and said so.
 */

import React, { useCallback, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { ProfileItemDetail, ProfileMutationResponse } from "@orquester/api";

import { cn } from "../../../../lib/cn";
import { CodeArea } from "./CodeArea";
import { useEditorEnv, useEditorWide, useReportDirty, useTouch } from "./env";
import { EditorShell } from "./EditorShell";
import { Field, FOCUS_RING, Segmented, SpecInput, TextInput, describedBy } from "./fields";
import { CopySource, GitSource, UploadSource } from "./ImportSources";
import { MARKDOWN_SOURCES, type MarkdownSource } from "./import.logic";
import { kindTitle } from "./layout.logic";
import {
  COMMAND_BODY_PLACEHOLDER,
  initialMarkdownForm,
  markdownDraftFromForm,
  markdownEditorModel,
  markdownFormFromDocument,
  markdownNameHint,
  SKILL_BODY_PLACEHOLDER,
  validateMarkdownForm,
  type MarkdownEditorModel,
  type MarkdownForm,
  type MarkdownKind,
  type MarkdownValidation
} from "./markdown.logic";
import { SubmitStatus, useProfileSubmit } from "./use-submit";

type MarkdownDetail = Extract<ProfileItemDetail, { kind: "skill" | "command" }>;

/** "+ Add" → Skill or Command: the source switcher over the four sources. */
export const MarkdownCreateEditor: React.FC<{ kind: MarkdownKind; initialSource?: MarkdownSource }> = ({
  kind,
  initialSource = "write"
}) => {
  const { agent } = useEditorEnv();
  const [source, setSource] = useState<MarkdownSource>(initialSource);
  const model = useMemo(() => markdownEditorModel(agent, kind), [agent, kind]);
  // The written draft outlives a look at another source, and so does the
  // unsaved-changes guard over it: the other sources report it with their own.
  const [initialForm] = useState<MarkdownForm>(() => initialMarkdownForm(model));
  const [form, setForm] = useState<MarkdownForm>(initialForm);
  const written = JSON.stringify(form) !== JSON.stringify(initialForm);
  const toolbar = <SourceSwitcher value={source} onChange={setSource} />;
  switch (source) {
    case "git":
      return <GitSource kind={kind} toolbar={toolbar} carriedDirty={written} />;
    case "upload":
      return <UploadSource kind={kind} toolbar={toolbar} carriedDirty={written} />;
    case "copy":
      return <CopySource kind={kind} toolbar={toolbar} carriedDirty={written} />;
    default:
      return <WriteSource kind={kind} model={model} form={form} setForm={setForm} toolbar={toolbar} />;
  }
};

export const SourceSwitcher: React.FC<{ value: MarkdownSource; onChange: (source: MarkdownSource) => void }> = ({
  value,
  onChange
}) => (
  <Segmented
    label="Source"
    options={MARKDOWN_SOURCES.map((source) => ({
      id: source.id,
      label: source.label,
      shortLabel: source.id === "copy" ? "Copy" : source.id === "git" ? "Git" : undefined
    }))}
    value={value}
    onChange={onChange}
  />
);

/** A row's Edit on a skill or command. */
export const MarkdownEditEditor: React.FC<{ detail: MarkdownDetail; onReload?: () => void }> = ({ detail, onReload }) => {
  const { agent } = useEditorEnv();
  const kind = detail.kind;
  const model = useMemo(() => markdownEditorModel(agent, kind, detail.document), [agent, kind, detail]);
  const [form, setForm] = useState<MarkdownForm>(() => markdownFormFromDocument(model, detail.item.name, detail.document));
  return <WriteSource kind={kind} model={model} form={form} setForm={setForm} detail={detail} onReload={onReload} />;
};

const WriteSource: React.FC<{
  kind: MarkdownKind;
  model: MarkdownEditorModel;
  form: MarkdownForm;
  setForm: React.Dispatch<React.SetStateAction<MarkdownForm>>;
  detail?: MarkdownDetail;
  toolbar?: React.ReactNode;
  onReload?: () => void;
}> = ({ kind, model, form, setForm, detail, toolbar, onReload }) => {
  const { agent, api } = useEditorEnv();
  // A new item compares with the empty form (a draft kept across a source switch is still unsaved).
  const [initialSignature] = useState(() =>
    JSON.stringify(detail ? form : initialMarkdownForm(model))
  );
  const [showErrors, setShowErrors] = useState(false);
  const submit = useProfileSubmit();
  const validation = validateMarkdownForm(kind, model, form);
  useReportDirty(JSON.stringify(form) !== initialSignature);

  const change = useCallback(
    (patch: Partial<MarkdownForm>) => {
      setForm((current) => ({ ...current, ...patch }));
      submit.clear();
    },
    [setForm, submit]
  );

  const save = () => {
    if (!validation.valid) {
      setShowErrors(true);
      return;
    }
    const document = markdownDraftFromForm(kind, model, form);
    const draft = kind === "skill" ? { kind: "skill" as const, document } : { kind: "command" as const, document };
    void submit.run((onConflict): Promise<ProfileMutationResponse> =>
      detail
        ? api.updateAgentProfileItem(agent, detail.item.id, { revision: detail.item.revision, draft })
        : api.createAgentProfileItem(agent, { draft, onConflict })
    );
  };

  return (
    <EditorShell
      title={kindTitle(detail ? "edit" : "create", kind)}
      subtitle={detail?.item.path}
      toolbar={toolbar}
      fill
      status={
        <SubmitStatus state={submit} onResolveConflict={detail ? undefined : submit.resolveConflict} onDismiss={submit.clear} onReload={onReload} nameShown />
      }
      primary={{ label: detail ? "Save" : kind === "skill" ? "Create skill" : "Create command", busy: submit.busy, onClick: save }}
    >
      <MarkdownWriteView
        kind={kind}
        mode={detail ? "edit" : "create"}
        model={model}
        form={form}
        onChange={change}
        validation={validation}
        showErrors={showErrors}
        nameError={submit.nameError}
        files={detail && detail.kind === "skill" ? detail.files : undefined}
        onSave={save}
      />
    </EditorShell>
  );
};

export interface MarkdownWriteViewProps {
  kind: MarkdownKind;
  mode: "create" | "edit";
  model: MarkdownEditorModel;
  form: MarkdownForm;
  onChange: (patch: Partial<MarkdownForm>) => void;
  validation: MarkdownValidation;
  showErrors: boolean;
  nameError?: string;
  /** A skill's other files (read-only). */
  files?: string[];
  onSave?: () => void;
  /** Checks: draw "More fields" open. */
  moreOpen?: boolean;
}

export const MarkdownWriteView: React.FC<MarkdownWriteViewProps> = ({
  kind,
  mode,
  model,
  form,
  onChange,
  validation,
  showErrors,
  nameError,
  files,
  onSave,
  moreOpen
}) => {
  const ids = useId();
  const touch = useTouch();
  const wide = useEditorWide();
  const errors = validation.errors;
  const nameMessage = nameError ?? (showErrors || form.name.trim() !== "" ? errors.name : undefined);
  const primary = model.fields.filter((spec) => spec.required);
  const more = model.fields.filter((spec) => !spec.required);
  const [open, setOpen] = useState(
    () =>
      moreOpen ??
      more.some((spec) => {
        const value = form.values[spec.key];
        return spec.type === "boolean" ? spec.key in model.original : typeof value === "string" && value.trim() !== "";
      })
  );
  const setValue = (key: string, value: string | boolean) => onChange({ values: { ...form.values, [key]: value } });
  const field = (spec: (typeof model.fields)[number]) => (
    <SpecInput
      key={spec.key}
      id={`${ids}-fm-${spec.key}`}
      spec={spec}
      value={form.values[spec.key] ?? ""}
      error={showErrors ? errors.fields[spec.key] : undefined}
      onChange={(value) => setValue(spec.key, value)}
    />
  );
  const nameHint = markdownNameHint(kind, model);
  const bodyError = showErrors ? errors.body : undefined;

  return (
    <>
      <div className="shrink-0 space-y-4">
        <Field id={`${ids}-name`} label="Name" required error={nameMessage} hint={nameHint}>
          <TextInput
            id={`${ids}-name`}
            mono
            value={form.name}
            placeholder={kind === "skill" ? "review-pr" : "review"}
            autoFocus={!touch && mode === "create"}
            invalid={Boolean(nameMessage)}
            aria-required
            aria-describedby={describedBy(`${ids}-name`, nameMessage, nameHint)}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
        {primary.map(field)}
        {more.length > 0 ? (
          <div className="rounded-md border border-neutral-800">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${ids}-more`}
              onClick={() => setOpen((value) => !value)}
              className={cn(
                "flex w-full min-w-0 items-center gap-1.5 rounded-md px-3 text-left text-xs font-medium text-neutral-300 hover:text-neutral-100",
                FOCUS_RING,
                touch ? "h-11" : "h-9"
              )}
            >
              {open ? (
                <ChevronDown size={14} aria-hidden className="shrink-0" />
              ) : (
                <ChevronRight size={14} aria-hidden className="shrink-0" />
              )}
              {/* Never wraps: the list of field names beside it gives way instead. */}
              <span className="shrink-0 whitespace-nowrap">More fields</span>
              <span className="ml-auto min-w-0 truncate pl-2 font-normal text-neutral-500">
                {more.map((spec) => spec.label).join(", ")}
              </span>
            </button>
            {open ? (
              <div id={`${ids}-more`} className={cn("gap-3 border-t border-neutral-800 p-3", wide ? "grid grid-cols-2" : "space-y-3")}>
                {more.map((spec) => (
                  <div key={spec.key} className={cn("min-w-0", wide && spec.type !== "string" && spec.type !== "number" && "col-span-2")}>
                    {field(spec)}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {model.keptKeys.length > 0 ? (
          <p className="text-[11px] leading-4 text-neutral-500">
            Other keys kept as they are: <span className="font-mono text-neutral-400">{model.keptKeys.join(", ")}</span>
          </p>
        ) : null}
        {files && files.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-neutral-300">Other files in this skill</p>
            <ul className="max-h-28 overflow-y-auto rounded-md border border-neutral-800 px-2.5 py-1.5 font-mono text-[12px] leading-5 text-neutral-400">
              {files.map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-neutral-500">Kept as they are — only SKILL.md is edited here.</p>
          </div>
        ) : null}
      </div>
      <div className="flex min-h-[260px] flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          {/* The editor names itself (`aria-label`): a <label> cannot point at CodeMirror's group. */}
          <span aria-hidden className="text-xs font-medium text-neutral-300">
            {kind === "skill" ? "Instructions (SKILL.md)" : "Prompt"}
            <span className="text-neutral-500"> *</span>
          </span>
          <span className="text-[11px] text-neutral-500">Markdown</span>
        </div>
        <CodeArea
          id={`${ids}-body`}
          label={kind === "skill" ? "Skill instructions" : "Command prompt"}
          value={form.body}
          placeholder={kind === "skill" ? SKILL_BODY_PLACEHOLDER : COMMAND_BODY_PLACEHOLDER}
          invalid={Boolean(bodyError)}
          describedBy={bodyError ? `${ids}-body-error` : undefined}
          onChange={(body) => onChange({ body })}
          onSave={onSave}
        />
        {bodyError ? (
          <p id={`${ids}-body-error`} className="text-xs text-danger">
            {bodyError}
          </p>
        ) : null}
      </div>
    </>
  );
};
