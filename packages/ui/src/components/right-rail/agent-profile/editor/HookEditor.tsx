/**
 * The hook editor (agent profile spec §7.4): the agent's own events, a
 * matcher only where the event reads one (empty = every tool), the command
 * (monospace, several lines allowed) and a timeout. Rules: `hook.logic.ts`.
 */

import React, { useCallback, useId, useState } from "react";

import type { ProfileItemDetail } from "@orquester/api";

import { useEditorEnv, useEditorWide, useReportDirty, useTouch } from "./env";
import { EditorShell } from "./EditorShell";
import { Field, SelectInput, TextArea, TextInput, describedBy } from "./fields";
import {
  eventTakesMatcher,
  HOOK_MATCHER_PLACEHOLDER,
  hookDraftFromForm,
  hookEvents,
  hookFormSignature,
  initialHookForm,
  validateHookForm,
  type HookForm,
  type HookValidation
} from "./hook.logic";
import { kindTitle } from "./layout.logic";
import { SubmitStatus, useProfileSubmit } from "./use-submit";

type HookDetail = Extract<ProfileItemDetail, { kind: "hook" }>;

export const HookEditor: React.FC<{ detail?: HookDetail; onReload?: () => void }> = ({ detail, onReload }) => {
  const { agent, api } = useEditorEnv();
  const [initial] = useState(() => initialHookForm(agent, detail?.hook));
  const [form, setForm] = useState<HookForm>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const submit = useProfileSubmit();
  const validation = validateHookForm(agent, form, detail?.hook.event);
  useReportDirty(hookFormSignature(form) !== hookFormSignature(initial));

  const change = useCallback(
    (patch: Partial<HookForm>) => {
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
    const hook = hookDraftFromForm(form);
    void submit.run((onConflict) =>
      detail
        ? api.updateAgentProfileItem(agent, detail.item.id, { revision: detail.item.revision, draft: { kind: "hook", hook } })
        : api.createAgentProfileItem(agent, { draft: { kind: "hook", hook }, onConflict })
    );
  };

  return (
    <EditorShell
      title={kindTitle(detail ? "edit" : "create", "hook")}
      status={<SubmitStatus state={submit} onResolveConflict={submit.resolveConflict} onDismiss={submit.clear} onReload={onReload} />}
      primary={{ label: detail ? "Save" : "Add hook", busy: submit.busy, onClick: save }}
    >
      <HookFormView form={form} onChange={change} validation={validation} showErrors={showErrors} originalEvent={detail?.hook.event} />
    </EditorShell>
  );
};

export const HookFormView: React.FC<{
  form: HookForm;
  onChange: (patch: Partial<HookForm>) => void;
  validation: HookValidation;
  showErrors: boolean;
  originalEvent?: string;
}> = ({ form, onChange, validation, showErrors, originalEvent }) => {
  const { agent } = useEditorEnv();
  const ids = useId();
  const touch = useTouch();
  const wide = useEditorWide();
  const errors = showErrors ? validation.errors : { timeout: form.timeout.trim() !== "" ? validation.errors.timeout : undefined };
  const withMatcher = eventTakesMatcher(form.event);
  const matcherHint = "A tool name or a regex; empty runs it for every tool.";

  return (
    <>
      <div className={wide && withMatcher ? "grid grid-cols-2 gap-3" : "space-y-4"}>
        <Field id={`${ids}-event`} label="Event" required error={errors.event}>
          <SelectInput
            id={`${ids}-event`}
            value={form.event}
            invalid={Boolean(errors.event)}
            options={hookEvents(agent, originalEvent).map((event) => ({ value: event, label: event }))}
            onChange={(event) => onChange({ event })}
          />
        </Field>
        {withMatcher ? (
          <Field id={`${ids}-matcher`} label="Matcher" optional hint={matcherHint}>
            <TextInput
              id={`${ids}-matcher`}
              mono
              value={form.matcher}
              placeholder={HOOK_MATCHER_PLACEHOLDER}
              aria-describedby={`${ids}-matcher-hint`}
              onChange={(event) => onChange({ matcher: event.target.value })}
            />
          </Field>
        ) : null}
      </div>
      {!withMatcher ? <p className="text-[11px] text-neutral-500">{form.event} hooks run every time; they take no matcher.</p> : null}
      <Field
        id={`${ids}-command`}
        label="Command"
        required
        error={errors.command}
        hint="Runs in a shell with the event's JSON on stdin. Several lines are fine."
      >
        <TextArea
          id={`${ids}-command`}
          mono
          rows={4}
          spellCheck={false}
          value={form.command}
          placeholder="~/.claude/hooks/check.sh"
          autoFocus={!touch}
          invalid={Boolean(errors.command)}
          aria-required
          aria-describedby={describedBy(`${ids}-command`, errors.command, true)}
          onChange={(event) => onChange({ command: event.target.value })}
        />
      </Field>
      <Field id={`${ids}-timeout`} label="Timeout (seconds)" optional error={errors.timeout} className="max-w-[12rem]">
        <TextInput
          id={`${ids}-timeout`}
          inputMode="numeric"
          value={form.timeout}
          placeholder="60"
          invalid={Boolean(errors.timeout)}
          aria-describedby={describedBy(`${ids}-timeout`, errors.timeout)}
          onChange={(event) => onChange({ timeout: event.target.value })}
        />
      </Field>
    </>
  );
};
