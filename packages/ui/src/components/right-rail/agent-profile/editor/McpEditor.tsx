/**
 * The MCP server editor (agent profile spec §7.4): name, transport, the
 * command and its arguments (a pasted command line is split into them), or
 * the URL; env and headers as key/value rows whose values on disk show only
 * as "••• set" with Replace and Remove; and an Advanced disclosure of the
 * agent's own extra fields. The rules are `mcp.logic.ts`.
 */

import React, { useCallback, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";

import type { ProfileItemDetail } from "@orquester/api";

import { cn } from "../../../../lib/cn";
import { useEditorEnv, useEditorWide, useReportDirty, useTouch } from "./env";
import { EditorShell } from "./EditorShell";
import {
  Field,
  FOCUS_RING,
  IconAction,
  RemoveIcon,
  SectionHeading,
  Segmented,
  SmallButton,
  SpecInput,
  TextInput,
  describedBy
} from "./fields";
import { kindTitle } from "./layout.logic";
import {
  hasAdvancedValues,
  initialMcpForm,
  mcpAdvancedFields,
  mcpDraftFromForm,
  mcpFormOrigin,
  mcpFormSignature,
  mcpTransports,
  newSecretRow,
  parsePastedCommandLine,
  validateMcpForm,
  type McpForm,
  type McpValidation,
  type SecretRow,
  type SecretRowsKind
} from "./mcp.logic";
import { SubmitStatus, useProfileSubmit } from "./use-submit";

type McpDetail = Extract<ProfileItemDetail, { kind: "mcp" }>;

const TRANSPORT_LABELS: Record<string, string> = { stdio: "Command (stdio)", http: "HTTP", sse: "SSE" };
const TRANSPORT_SHORT: Record<string, string> = { stdio: "stdio", http: "HTTP", sse: "SSE" };

export const McpEditor: React.FC<{ detail?: McpDetail; onReload?: () => void }> = ({ detail, onReload }) => {
  const env = useEditorEnv();
  const { agent, api } = env;
  const origin = useMemo(() => mcpFormOrigin(detail?.mcp), [detail]);
  const [initial] = useState(() => initialMcpForm(agent, detail?.mcp));
  const [form, setForm] = useState<McpForm>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const submit = useProfileSubmit();
  const validation = validateMcpForm(agent, form);
  useReportDirty(mcpFormSignature(form) !== mcpFormSignature(initial));

  const change = useCallback(
    (patch: Partial<McpForm>) => {
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
    const mcp = mcpDraftFromForm(agent, form, origin);
    void submit.run((onConflict) =>
      detail
        ? api.updateAgentProfileItem(agent, detail.item.id, { revision: detail.item.revision, draft: { kind: "mcp", mcp } })
        : api.createAgentProfileItem(agent, { draft: { kind: "mcp", mcp }, onConflict })
    );
  };

  return (
    <EditorShell
      title={kindTitle(detail ? "edit" : "create", "mcp")}
      status={
        <SubmitStatus state={submit} onResolveConflict={submit.resolveConflict} onDismiss={submit.clear} onReload={onReload} />
      }
      primary={{ label: detail ? "Save" : "Add server", busy: submit.busy, onClick: save }}
    >
      <McpFormView
        mode={detail ? "edit" : "create"}
        form={form}
        onChange={change}
        validation={validation}
        showErrors={showErrors}
        nameError={submit.nameError}
      />
    </EditorShell>
  );
};

export interface McpFormViewProps {
  mode: "create" | "edit";
  form: McpForm;
  onChange: (patch: Partial<McpForm>) => void;
  validation: McpValidation;
  /** Show every problem (after a Save), not just those in fields already typed in. */
  showErrors: boolean;
  /** The daemon refused the name. */
  nameError?: string;
  /** Checks: draw the Advanced disclosure open. */
  advancedOpen?: boolean;
}

export const McpFormView: React.FC<McpFormViewProps> = ({
  mode,
  form,
  onChange,
  validation,
  showErrors,
  nameError,
  advancedOpen
}) => {
  const { agent } = useEditorEnv();
  const touch = useTouch();
  const ids = useId();
  const errors = validation.errors;
  const shown = (error: string | undefined, typed: string) => (showErrors || typed.trim() !== "" ? error : undefined);
  const nameMessage = nameError ?? shown(errors.name, form.name);
  const transports = mcpTransports(agent);
  const advancedFields = mcpAdvancedFields(agent);
  const [advanced, setAdvanced] = useState(() => advancedOpen ?? hasAdvancedValues(agent, form));

  const onCommandPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const parsed = parsePastedCommandLine(event.clipboardData.getData("text"));
    if (!parsed) return;
    event.preventDefault();
    onChange({
      command: parsed.command,
      args: parsed.args,
      env: [...form.env, ...parsed.env.map((entry) => newSecretRow(entry.key, entry.value))]
    });
  };

  return (
    <>
      <Field
        id={`${ids}-name`}
        label="Name"
        required
        error={nameMessage}
        hint={mode === "edit" ? "Renaming moves the server to the new name." : "How the agent names its tools: mcp__<name>__…"}
      >
        <TextInput
          id={`${ids}-name`}
          mono
          value={form.name}
          placeholder="jira-cloud"
          autoFocus={!touch && mode === "create"}
          invalid={Boolean(nameMessage)}
          aria-required
          aria-describedby={describedBy(`${ids}-name`, nameMessage, true)}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>

      {transports.length > 1 ? (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-neutral-300" id={`${ids}-transport`}>
            Transport
          </div>
          <Segmented
            label="Transport"
            options={transports.map((transport) => ({
              id: transport,
              label: TRANSPORT_LABELS[transport] ?? transport,
              shortLabel: TRANSPORT_SHORT[transport]
            }))}
            value={form.transport}
            onChange={(transport) => onChange({ transport })}
          />
        </div>
      ) : null}

      {form.transport === "stdio" ? (
        <>
          <Field
            id={`${ids}-command`}
            label="Command"
            required
            error={shown(errors.command, form.command)}
            hint="Paste a whole command line to split it into the command and its arguments."
          >
            <TextInput
              id={`${ids}-command`}
              mono
              value={form.command}
              placeholder="npx"
              invalid={Boolean(shown(errors.command, form.command))}
              aria-required
              aria-describedby={describedBy(`${ids}-command`, shown(errors.command, form.command), true)}
              onPaste={onCommandPaste}
              onChange={(event) => onChange({ command: event.target.value })}
            />
          </Field>
          <ArgsEditor idPrefix={`${ids}-arg`} args={form.args} onChange={(args) => onChange({ args })} />
          <Field id={`${ids}-cwd`} label="Working directory" optional>
            <TextInput
              id={`${ids}-cwd`}
              mono
              value={form.cwd}
              placeholder="/path/the/server/runs/in"
              onChange={(event) => onChange({ cwd: event.target.value })}
            />
          </Field>
          <SecretRowsEditor
            kind="env"
            idPrefix={`${ids}-env`}
            rows={form.env}
            errors={errors.env}
            showErrors={showErrors}
            onChange={(rows) => onChange({ env: rows })}
          />
        </>
      ) : (
        <>
          <Field id={`${ids}-url`} label="URL" required error={shown(errors.url, form.url)}>
            <TextInput
              id={`${ids}-url`}
              mono
              type="url"
              inputMode="url"
              value={form.url}
              placeholder="https://mcp.example.com/mcp"
              invalid={Boolean(shown(errors.url, form.url))}
              aria-required
              aria-describedby={describedBy(`${ids}-url`, shown(errors.url, form.url))}
              onChange={(event) => onChange({ url: event.target.value })}
            />
          </Field>
          <SecretRowsEditor
            kind="headers"
            idPrefix={`${ids}-header`}
            rows={form.headers}
            errors={errors.headers}
            showErrors={showErrors}
            onChange={(rows) => onChange({ headers: rows })}
          />
        </>
      )}

      {advancedFields.length > 0 ? (
        <div className="rounded-md border border-neutral-800">
          <button
            type="button"
            aria-expanded={advanced}
            aria-controls={`${ids}-advanced`}
            onClick={() => setAdvanced((open) => !open)}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md px-3 text-left text-xs font-medium text-neutral-300 hover:text-neutral-100",
              FOCUS_RING,
              touch ? "h-11" : "h-9"
            )}
          >
            {advanced ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            Advanced
            <span className="ml-auto truncate font-normal text-neutral-500">
              {advancedFields.map((spec) => spec.label.replace(/ \(.*\)$/, "")).join(", ")}
            </span>
          </button>
          {advanced ? (
            <div id={`${ids}-advanced`} className="space-y-3 border-t border-neutral-800 p-3">
              {advancedFields.map((spec) => (
                <SpecInput
                  key={spec.key}
                  id={`${ids}-adv-${spec.key}`}
                  spec={spec}
                  value={form.advanced[spec.key] ?? (spec.type === "boolean" ? false : "")}
                  error={errors.advanced[spec.key]}
                  onChange={(value) => onChange({ advanced: { ...form.advanced, [spec.key]: value } })}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
};

const ArgsEditor: React.FC<{ idPrefix: string; args: string[]; onChange: (args: string[]) => void }> = ({
  idPrefix,
  args,
  onChange
}) => (
  <div className="space-y-1.5">
    <SectionHeading
      aside={
        <SmallButton onClick={() => onChange([...args, ""])}>
          <Plus size={13} aria-hidden /> Add argument
        </SmallButton>
      }
    >
      Arguments
    </SectionHeading>
    {args.length === 0 ? <p className="text-[11px] text-neutral-500">No arguments.</p> : null}
    <ol className="space-y-1.5">
      {args.map((arg, index) => (
        <li key={index} className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="w-5 shrink-0 text-right text-[11px] tabular-nums text-neutral-600">
            {index + 1}
          </span>
          <TextInput
            id={`${idPrefix}-${index}`}
            mono
            aria-label={`Argument ${index + 1}`}
            value={arg}
            onChange={(event) => onChange(args.map((entry, at) => (at === index ? event.target.value : entry)))}
          />
          <IconAction label={`Remove argument ${index + 1}`} tone="danger" onClick={() => onChange(args.filter((_, at) => at !== index))}>
            <RemoveIcon />
          </IconAction>
        </li>
      ))}
    </ol>
  </div>
);

const SECRET_COPY: Record<SecretRowsKind, { heading: string; add: string; keyLabel: string; keyPlaceholder: string; empty: string }> = {
  env: {
    heading: "Environment",
    add: "Add variable",
    keyLabel: "Variable name",
    keyPlaceholder: "API_KEY",
    empty: "No environment variables."
  },
  headers: {
    heading: "Headers",
    add: "Add header",
    keyLabel: "Header name",
    keyPlaceholder: "Authorization",
    empty: "No headers."
  }
};

/**
 * Key/value rows. A value on disk is never shown or prefilled: its row says
 * "••• set" and offers Replace (an empty input for the new value) and Remove.
 * Side by side when the editor is wide, stacked when narrow.
 */
export const SecretRowsEditor: React.FC<{
  kind: SecretRowsKind;
  idPrefix: string;
  rows: SecretRow[];
  errors: Record<string, string>;
  showErrors: boolean;
  onChange: (rows: SecretRow[]) => void;
}> = ({ kind, idPrefix, rows, errors, showErrors, onChange }) => {
  const wide = useEditorWide();
  const copy = SECRET_COPY[kind];
  const update = (id: string, patch: Partial<SecretRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id));

  return (
    <div className="space-y-1.5">
      <SectionHeading
        aside={
          <SmallButton onClick={() => onChange([...rows, newSecretRow()])}>
            <Plus size={13} aria-hidden /> {copy.add}
          </SmallButton>
        }
      >
        {copy.heading}
      </SectionHeading>
      {rows.length === 0 ? <p className="text-[11px] text-neutral-500">{copy.empty}</p> : null}
      <ul className="space-y-2">
        {rows.map((row) => {
          const rowId = `${idPrefix}-${row.id}`;
          const error = row.state === "new" && !showErrors && row.key.trim() === "" ? undefined : errors[row.id];
          const keyCell =
            row.state === "new" ? (
              <TextInput
                id={`${rowId}-key`}
                mono
                aria-label={copy.keyLabel}
                placeholder={copy.keyPlaceholder}
                value={row.key}
                invalid={Boolean(error)}
                onChange={(event) => update(row.id, { key: event.target.value })}
              />
            ) : (
              <span className="block min-w-0 truncate font-mono text-[13px] text-neutral-100" title={row.key}>
                {row.key}
              </span>
            );
          const valueCell =
            row.state === "existing" ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
                <span aria-hidden className="tracking-widest">
                  •••
                </span>
                set
              </span>
            ) : (
              <TextInput
                id={`${rowId}-value`}
                mono
                autoComplete="off"
                autoFocus={row.state === "replace"}
                aria-label={row.state === "replace" ? `New value for ${row.key}` : `Value for ${row.key.trim() || copy.keyLabel.toLowerCase()}`}
                placeholder={row.state === "replace" ? "New value" : "Value"}
                value={row.value}
                invalid={Boolean(error) && row.state === "replace"}
                onChange={(event) => update(row.id, { value: event.target.value })}
              />
            );
          const actions = (
            <div className="flex shrink-0 items-center gap-1">
              {row.state === "existing" ? (
                <SmallButton aria-label={`Replace ${row.key}`} onClick={() => update(row.id, { state: "replace", value: "" })}>
                  Replace
                </SmallButton>
              ) : null}
              {row.state === "replace" ? (
                <SmallButton aria-label={`Keep the current value of ${row.key}`} onClick={() => update(row.id, { state: "existing", value: "" })}>
                  Keep
                </SmallButton>
              ) : null}
              <IconAction label={`Remove ${row.key.trim() || "this row"}`} tone="danger" onClick={() => remove(row.id)}>
                <RemoveIcon />
              </IconAction>
            </div>
          );
          return (
            <li key={row.id} data-secret-row={row.state} className="min-w-0">
              {wide ? (
                <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
                  <div className="min-w-0">{keyCell}</div>
                  <div className="min-w-0">{valueCell}</div>
                  {actions}
                </div>
              ) : (
                <div className="min-w-0 space-y-1.5 rounded-md border border-neutral-800 p-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="min-w-0 flex-1">{keyCell}</div>
                    {actions}
                  </div>
                  <div className="min-w-0">{valueCell}</div>
                </div>
              )}
              {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
