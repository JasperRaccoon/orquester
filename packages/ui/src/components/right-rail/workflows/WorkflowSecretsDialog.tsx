/**
 * Workflow secrets: the NAMES this daemon holds — global, or one workflow's
 * own (which shadow a global one of the same name) — with set / replace and
 * delete. Values are write-only: typed here, sent once, never read back
 * (spec §5.7). A value under 4 characters is not redacted from logs, so the
 * form and the list both warn about it.
 */

import React, { useId, useMemo, useState } from "react";
import { AlertTriangle, Eye, EyeOff, KeyRound, Loader2, Pencil, Trash2 } from "lucide-react";

import type { WorkflowSecretName, WorkflowSummary } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { useIsDesktop } from "../../../hooks/use-media-query";
import { cn } from "../../../lib/cn";
import { KEYBOARD_SURFACE_PROPS } from "../../../lib/keyboard-surfaces";
import { formatAgo } from "../../../lib/workflows/format";
import { useWorkflowSecrets } from "../../../lib/workflows/hooks";
import { isValidSecretName, normalizeSecretName } from "../../../lib/workflows/new-workflow";
import { deleteWorkflowSecret, setWorkflowSecret } from "../../../lib/workflows/store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Modal } from "../../ui/modal";
import { RailChip, RailSectionLabel, RailSegmented } from "../primitives";
import { DialogHeader, Field, SelectField } from "./dialog-parts";

/** Values under this many characters are not redacted (spec §5.7). */
export const SHORT_SECRET_CHARS = 4;
const MAX_VALUE_BYTES = 64 * 1024;

export interface WorkflowSecretsDialogProps {
  /** Workflows a secret can belong to; the first one in `initialWorkflowId` is preselected. */
  workflows: readonly WorkflowSummary[];
  initialWorkflowId?: string | null;
  onClose: () => void;
}

type Scope = "global" | "workflow";

export const WorkflowSecretsDialog: React.FC<WorkflowSecretsDialogProps> = ({
  workflows,
  initialWorkflowId,
  onClose
}) => {
  const api = useApi();
  const ids = useId();
  const touch = !useIsDesktop();
  const [scope, setScope] = useState<Scope>(initialWorkflowId ? "workflow" : "global");
  const [workflowId, setWorkflowId] = useState<string>(initialWorkflowId ?? workflows[0]?.id ?? "");
  const scopedId = scope === "workflow" && workflowId ? workflowId : null;
  const view = useWorkflowSecrets(scopedId);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // A workflow's list holds the globals too; this dialog shows the scope it is on.
  const listed = useMemo(
    () => view.secrets.filter((secret) => (scopedId ? secret.scope === "workflow" : secret.scope === "global")),
    [view.secrets, scopedId]
  );
  const shadowed = useMemo(() => {
    if (!scopedId) return new Set<string>();
    return new Set(view.secrets.filter((s) => s.scope === "global").map((s) => s.name));
  }, [view.secrets, scopedId]);

  const nameValid = isValidSecretName(name);
  const short = value.length > 0 && value.length < SHORT_SECRET_CHARS;
  const tooLong = new TextEncoder().encode(value).length > MAX_VALUE_BYTES;
  const replacing = listed.some((secret) => secret.name === name);
  const canSave = nameValid && value.length > 0 && !tooLong && !saving && (scope === "global" || !!workflowId);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setFormError(null);
    const result = await setWorkflowSecret(api, name, value, scopedId);
    setSaving(false);
    if (result.ok) {
      setName("");
      setValue("");
      setReveal(false);
    } else {
      setFormError(result.error);
    }
  };

  const remove = async (secret: WorkflowSecretName) => {
    setRowError(null);
    const result = await deleteWorkflowSecret(api, secret.name, scopedId);
    setConfirming(null);
    if (!result.ok) setRowError(`Couldn't delete ${secret.name}: ${result.error}`);
  };

  const scopeTitle = scopedId ? (workflows.find((w) => w.id === scopedId)?.name ?? "This workflow") : "Global";

  return (
    <Modal open onClose={onClose} className="max-h-[calc(100dvh-1.5rem)] max-w-lg sm:max-h-[90vh]">
      <div {...KEYBOARD_SURFACE_PROPS} className="flex min-h-0 w-full flex-col">
        <DialogHeader
          title="Workflow secrets"
          subtitle="Read by blocks as {{secrets.NAME}} — values are never shown again."
          onClose={onClose}
        />
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div className="space-y-2">
            <RailSegmented
              label="Which secrets"
              options={[
                { id: "global", label: "Global", title: "Every workflow can read these" },
                {
                  id: "workflow",
                  label: "One workflow",
                  title: workflows.length ? "Only this workflow — shadows a global of the same name" : "No workflows yet",
                  disabled: workflows.length === 0
                }
              ]}
              value={scope}
              onChange={(next) => {
                setScope(next);
                setConfirming(null);
              }}
            />
            {scope === "workflow" ? (
              <SelectField
                aria-label="Workflow"
                touch={touch}
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
              >
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </SelectField>
            ) : null}
          </div>

          <section aria-label={`${scopeTitle} secrets`} className="space-y-1.5">
            <RailSectionLabel>{scopeTitle}</RailSectionLabel>
            {listed.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-800 px-3 py-4 text-center text-xs text-neutral-500">
                {view.status === "loading"
                  ? "Loading…"
                  : view.status === "error"
                    ? view.error
                    : "No secrets here yet."}
              </div>
            ) : (
              <ul className="divide-y divide-neutral-800 overflow-hidden rounded-lg border border-neutral-800">
                {listed.map((secret) => (
                  <li key={secret.name} className="flex min-w-0 items-center gap-2 bg-neutral-900/40 px-3 py-2">
                    <KeyRound size={13} aria-hidden className="shrink-0 text-neutral-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-[13px] text-neutral-100">{secret.name}</span>
                        {secret.short ? (
                          <span title="Under 4 characters: not redacted from logs" className="shrink-0 text-warn">
                            <AlertTriangle size={12} aria-hidden />
                            <span className="sr-only">(short value, not redacted)</span>
                          </span>
                        ) : null}
                        {shadowed.has(secret.name) ? (
                          <RailChip title="Shadows the global secret of the same name">shadows global</RailChip>
                        ) : null}
                      </div>
                      {secret.updatedAt ? (
                        <div className="text-[11px] text-neutral-500">
                          Updated {formatAgo(secret.updatedAt, Date.now()) || "—"}
                        </div>
                      ) : null}
                    </div>
                    {confirming === secret.name ? (
                      <div role="group" aria-label={`Delete ${secret.name}?`} className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirming(null)}
                          className={cn(touch && "h-10")}
                        >
                          Keep
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void remove(secret)}
                          className={cn("bg-danger-600 text-white hover:bg-danger-500", touch && "h-10")}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          title={`Replace ${secret.name}`}
                          onClick={() => {
                            setName(secret.name);
                            setValue("");
                            setFormError(null);
                            document.getElementById(`${ids}-value`)?.focus();
                          }}
                          className={cn(
                            "inline-flex items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
                            touch ? "h-10 w-10" : "h-7 w-7"
                          )}
                        >
                          <Pencil size={13} aria-hidden />
                          <span className="sr-only">Replace {secret.name}</span>
                        </button>
                        <button
                          type="button"
                          title={`Delete ${secret.name}`}
                          onClick={() => setConfirming(secret.name)}
                          className={cn(
                            "inline-flex items-center justify-center rounded-md text-neutral-400 hover:bg-danger-500/10 hover:text-danger",
                            touch ? "h-10 w-10" : "h-7 w-7"
                          )}
                        >
                          <Trash2 size={13} aria-hidden />
                          <span className="sr-only">Delete {secret.name}</span>
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {rowError ? (
              <p role="alert" className="break-words text-xs text-danger">
                {rowError}
              </p>
            ) : null}
          </section>

          <form
            className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <RailSectionLabel>{replacing ? `Replace ${name}` : "Add a secret"}</RailSectionLabel>
            <Field
              id={`${ids}-name`}
              label="Name"
              hint="Capitals, digits and underscores, starting with a letter."
              error={name.length > 0 && !nameValid ? "Use A–Z, 0–9 and _, starting with a letter." : null}
            >
              <Input
                id={`${ids}-name`}
                value={name}
                spellCheck={false}
                autoCapitalize="characters"
                autoComplete="off"
                placeholder="JIRA_TOKEN"
                onChange={(event) => {
                  setName(normalizeSecretName(event.target.value));
                  setFormError(null);
                }}
                className={cn("font-mono", touch && "h-10")}
              />
            </Field>
            <Field
              id={`${ids}-value`}
              label="Value"
              error={tooLong ? "Values are limited to 64 KiB." : null}
              hint={
                short ? (
                  <span className="flex items-start gap-1 text-warn">
                    <AlertTriangle size={12} aria-hidden className="mt-0.5 shrink-0" />
                    Under 4 characters, this value is not redacted from run logs and outputs.
                  </span>
                ) : (
                  "Write-only: it is stored on the server and never sent back."
                )
              }
            >
              <div className="relative">
                <Input
                  id={`${ids}-value`}
                  type={reveal ? "text" : "password"}
                  value={value}
                  spellCheck={false}
                  autoComplete="new-password"
                  autoCapitalize="off"
                  placeholder={replacing ? "New value" : "Value"}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setFormError(null);
                  }}
                  className={cn("pr-10 font-mono", touch && "h-10")}
                />
                <button
                  type="button"
                  aria-pressed={reveal}
                  aria-label={reveal ? "Hide the value" : "Show the value while typing"}
                  title={reveal ? "Hide" : "Show while typing"}
                  onClick={() => setReveal((current) => !current)}
                  className={cn(
                    "absolute right-0.5 top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-md text-neutral-500 hover:text-neutral-200",
                    touch ? "h-9 w-9" : "h-7 w-8"
                  )}
                >
                  {reveal ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                </button>
              </div>
            </Field>
            {formError ? (
              <p role="alert" className="break-words text-xs text-danger">
                {formError}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={!canSave} className={cn(touch && "h-10 w-full")}>
                {saving ? <Loader2 size={14} aria-hidden className="animate-spin" /> : null}
                {replacing ? "Replace" : "Save secret"}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </Modal>
  );
};
