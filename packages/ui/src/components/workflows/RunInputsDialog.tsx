/**
 * Run now with typed inputs (spec 2026-11-10 §4.3): a form built from the
 * manual trigger's declared inputs — text (a textarea when multi-line), a
 * number, a switch for a boolean, a choice for an enum — with the required
 * ones marked, each description as help text and the defaults filled in. The
 * form is checked as the daemon checks a run before it goes; the daemon's own
 * errors land beside their fields too. "Edit as JSON" keeps the raw editor.
 * An overlap skip offers "Run anyway" with the same input.
 *
 * Desktop: a Modal. Phone: a WorkflowSheet (its `wf-touch` sizes the fields;
 * enums are radio cards, buttons at least 40 px).
 */

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Braces, ListChecks, Loader2, Play } from "lucide-react";

import { validateWorkflowInput, type WorkflowInputDecl, type WorkflowInputError } from "@orquester/api";

import { cn } from "../../lib/cn";
import {
  checkRunInputValues,
  initialRunInputValues,
  placeInputErrors,
  runInputFromValues,
  runInputJson,
  runInputValuesFromJson,
  type RunInputValue
} from "../../lib/workflows/run-inputs";
import { Modal, ModalCloseButton } from "../ui/modal";
import { WorkflowSheet } from "./phone/WorkflowSheet";
import type { RunNowResult } from "./RunNowPopover";
import {
  Callout,
  Field,
  NumberInput,
  RadioCards,
  Segmented,
  SelectInput,
  SmallButton,
  TextArea,
  TextInput,
  ToggleRow
} from "./ui/controls";

export interface RunInputsDialogProps {
  open: boolean;
  onClose: () => void;
  workflowName: string;
  /** The manual trigger's declared inputs (non-empty). */
  inputs: readonly WorkflowInputDecl[];
  /** Errors the daemon will refuse the run for (validation). */
  blockingErrors?: number;
  /** A phone's sheet instead of the desktop modal. */
  phone: boolean;
  onRun: (input: unknown, options: { force: boolean }) => Promise<RunNowResult>;
}

/** Short enough to sit side by side as a segmented control (desktop). */
function fitsSegmented(values: readonly string[]): boolean {
  return values.length <= 5 && values.reduce((sum, value) => sum + value.length, 0) <= 40;
}

const NONE = "";

/** One input's control. `phone` sizes it for touch. */
const InputControl: React.FC<{
  decl: WorkflowInputDecl;
  value: RunInputValue;
  onValue: (value: RunInputValue) => void;
  invalid: boolean;
  phone: boolean;
  autoFocus: boolean;
}> = ({ decl, value, onValue, invalid, phone, autoFocus }) => {
  switch (decl.type) {
    case "string":
      return decl.multiline ? (
        <TextArea
          value={typeof value === "string" ? value : ""}
          onValue={onValue}
          invalid={invalid}
          aria-invalid={invalid || undefined}
          rows={3}
          autosize
          autoFocus={autoFocus}
        />
      ) : (
        <TextInput
          value={typeof value === "string" ? value : ""}
          onValue={onValue}
          invalid={invalid}
          aria-invalid={invalid || undefined}
          autoFocus={autoFocus}
        />
      );
    case "number":
      return (
        <NumberInput
          value={typeof value === "number" ? value : undefined}
          onValue={onValue}
          invalid={invalid}
          className={phone ? undefined : "max-w-[12rem]"}
        />
      );
    case "boolean":
      // Rendered by the caller as a ToggleRow (its label is the switch's).
      return null;
    case "enum": {
      const values = decl.values ?? [];
      const optional = decl.required !== true && decl.default === undefined;
      const current = typeof value === "string" ? value : NONE;
      // A few choices: radio cards on a phone (finger-sized) or when too long to sit side by side;
      // many: the native picker.
      if (values.length <= 8 && (phone || !fitsSegmented(values))) {
        const options = [
          ...(optional ? [{ value: NONE, label: "None" }] : []),
          ...values.map((option) => ({ value: option, label: option }))
        ];
        return (
          <RadioCards
            ariaLabel={decl.name}
            value={current}
            options={options}
            onValue={(next) => onValue(next === NONE ? undefined : next)}
          />
        );
      }
      if (!phone && fitsSegmented(values)) {
        return (
          <Segmented
            label={decl.name}
            wrap
            value={current}
            options={[...(optional ? [{ id: NONE, label: "None" }] : []), ...values.map((option) => ({ id: option, label: option }))]}
            onChange={(next) => onValue(next === NONE ? undefined : next)}
          />
        );
      }
      return (
        <SelectInput value={current} onValue={(next) => onValue(next === NONE ? undefined : next)} aria-invalid={invalid || undefined}>
          <option value={NONE}>{optional ? "None" : "Choose…"}</option>
          {values.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SelectInput>
      );
    }
  }
};

/** The label: the input's name, marked when required. */
const InputLabel: React.FC<{ decl: WorkflowInputDecl }> = ({ decl }) => (
  <span className="font-mono">
    {decl.name}
    {decl.required === true ? (
      <>
        <span aria-hidden className="ml-0.5 text-danger">
          *
        </span>
        <span className="sr-only"> (required)</span>
      </>
    ) : null}
  </span>
);

export const RunInputsDialog: React.FC<RunInputsDialogProps> = ({ open, onClose, workflowName, inputs, blockingErrors = 0, phone, onRun }) => {
  const [values, setValues] = useState<Record<string, RunInputValue>>(() => initialRunInputValues(inputs));
  const [mode, setMode] = useState<"form" | "json">("form");
  const [json, setJson] = useState("");
  const [errors, setErrors] = useState<readonly WorkflowInputError[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The last run was skipped (overlap), with why in the daemon's words; null when it was not. */
  const [skipped, setSkipped] = useState<{ detail?: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const formId = useId();

  // A fresh form on every open, from the current declaration; while open, a declaration that
  // changes (saved meanwhile, another client) keeps what was typed for the inputs still there.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open) return;
    if (opening) {
      setValues(initialRunInputValues(inputs));
      setMode("form");
      setJson("");
      setErrors([]);
      setProblem(null);
      setSkipped(null);
      setDirty(false);
      return;
    }
    setValues((current) => {
      const next = initialRunInputValues(inputs);
      for (const name of Object.keys(next)) if (Object.hasOwn(current, name)) next[name] = current[name];
      return next;
    });
  }, [open, inputs]);

  const placed = useMemo(() => placeInputErrors(inputs, errors), [inputs, errors]);
  const required = inputs.some((decl) => decl.required === true);

  const setValue = (name: string, value: RunInputValue): void => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => current.filter((error) => error.input !== name));
    setSkipped(null);
    setDirty(true);
  };

  const toJson = (): void => {
    setJson(runInputJson(inputs, values));
    setMode("json");
    setProblem(null);
  };

  const toForm = (): void => {
    const back = runInputValuesFromJson(inputs, json);
    if (!back.ok) {
      setProblem(`The form cannot show this input: ${back.problems.join(" ")}`);
      return;
    }
    setValues(back.values);
    setMode("form");
    setProblem(null);
    setErrors([]);
  };

  /** The input to send, or null when the form (or the JSON) is refused here first. */
  const prepare = (): { input: unknown } | null => {
    if (mode === "form") {
      const found = checkRunInputValues(inputs, values);
      if (found.length > 0) {
        setErrors(found);
        return null;
      }
      return { input: runInputFromValues(inputs, values) };
    }
    let parsed: unknown;
    if (json.trim() === "") parsed = undefined;
    else {
      try {
        parsed = JSON.parse(json);
      } catch (reason) {
        setProblem(`Not valid JSON: ${reason instanceof Error ? reason.message : String(reason)}`);
        return null;
      }
    }
    const found = validateWorkflowInput(inputs, parsed).errors;
    if (found.length > 0) {
      setErrors(found);
      return null;
    }
    return { input: parsed };
  };

  const run = async (force: boolean): Promise<void> => {
    if (busy) return;
    setProblem(null);
    const prepared = prepare();
    if (prepared === null) return;
    setErrors([]);
    setBusy(true);
    const result = await onRun(prepared.input, { force });
    setBusy(false);
    if (!result.ok) {
      if (result.inputErrors && result.inputErrors.length > 0) setErrors(result.inputErrors);
      else setProblem(result.error);
    } else if (result.skipped === "overlap") setSkipped(result.skipDetail ? { detail: result.skipDetail } : {});
    else onClose();
  };

  // In JSON mode every error is listed above the editor (no field to sit beside).
  const listed = mode === "json" ? errors.map((error) => error.message) : placed.general;

  const body = (
    <form
      id={formId}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void run(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          void run(false);
        } else if (event.target instanceof HTMLInputElement) {
          // A plain Enter in a field never starts a run by accident (⌘/Ctrl Enter or the Run button do).
          event.preventDefault();
        }
      }}
      className={cn("space-y-4", phone ? "px-4 pb-4 pt-1" : "p-4")}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={cn("leading-4 text-neutral-500", phone ? "text-[13px] leading-5" : "text-[11.5px]")}>
          Read as <code className="text-neutral-400">{"{{ trigger.input.<name> }}"}</code>. Runs even while the workflow is disabled.
          {required ? (
            <>
              {" "}
              <span aria-hidden className="text-danger">
                *
              </span>{" "}
              required
            </>
          ) : null}
        </p>
        <SmallButton
          variant="ghost"
          icon={mode === "form" ? <Braces size={12} /> : <ListChecks size={12} />}
          onClick={mode === "form" ? toJson : toForm}
          aria-pressed={mode === "json"}
          className={cn("shrink-0", phone && "h-10 px-3 text-[13px]")}
        >
          {mode === "form" ? "Edit as JSON" : "Edit as form"}
        </SmallButton>
      </div>

      {listed.length > 0 ? (
        <Callout tone="danger" title="The run needs a fix">
          <ul className="list-disc space-y-0.5 pl-4">
            {listed.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {mode === "form" ? (
        <div className="space-y-4">
          {inputs.map((decl, index) => {
            const error = placed.byInput[decl.name] ?? null;
            const value = values[decl.name];
            if (decl.type === "boolean") {
              return (
                <div key={decl.name} className={cn("space-y-1", phone && "flex min-h-10 flex-col justify-center")} data-field-error={error ? "" : undefined}>
                  <ToggleRow
                    checked={value === true}
                    onChange={(checked) => setValue(decl.name, checked)}
                    label={<InputLabel decl={decl} />}
                    description={decl.description}
                  />
                  {error ? <p className="text-[11px] leading-4 text-danger">{error}</p> : null}
                </div>
              );
            }
            return (
              <Field key={decl.name} label={<InputLabel decl={decl} />} hint={decl.description} error={error}>
                <InputControl
                  decl={decl}
                  value={value}
                  onValue={(next) => setValue(decl.name, next)}
                  invalid={error !== null}
                  phone={phone}
                  autoFocus={!phone && index === 0}
                />
              </Field>
            );
          })}
        </div>
      ) : (
        <Field label="Input as JSON" hint="An object of the declared inputs; the daemon checks it either way.">
          <TextArea
            value={json}
            onValue={(next) => {
              setJson(next);
              setProblem(null);
              setErrors([]);
              setSkipped(null);
              setDirty(true);
            }}
            mono
            rows={8}
            autosize
            maxRows={18}
            invalid={problem !== null || errors.length > 0}
            autoFocus={!phone}
          />
        </Field>
      )}

      {problem ? <p className="text-[11px] leading-4 text-danger">{problem}</p> : null}
      {blockingErrors > 0 ? (
        <p className="flex items-start gap-1.5 text-[11px] leading-4 text-warn">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {blockingErrors === 1 ? "1 problem" : `${blockingErrors} problems`} may stop the run — see the red badges.
        </p>
      ) : null}
      {skipped ? (
        <Callout
          tone="warn"
          action={
            <SmallButton onClick={() => void run(true)} disabled={busy} className={cn(phone && "h-10 px-3")}>
              Run anyway
            </SmallButton>
          }
        >
          {skipped.detail ? `This run was skipped: ${skipped.detail}.` : "It is already running, so this run was skipped (overlap: skip)."}
        </Callout>
      ) : null}
    </form>
  );

  const runButton = (
    <SmallButton
      type="submit"
      form={formId}
      variant="solid"
      icon={busy ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <Play size={12} />}
      disabled={busy}
      className={cn(phone && "h-10 flex-1 text-[14px]")}
    >
      Run
    </SmallButton>
  );

  if (phone) {
    return (
      <WorkflowSheet
        open={open}
        onClose={onClose}
        label={`Run ${workflowName}`}
        title="Run now"
        subtitle={workflowName}
        level={1}
        footer={<div className="flex gap-2">{runButton}</div>}
      >
        {body}
      </WorkflowSheet>
    );
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      onBackdropClick={dirty ? () => undefined : onClose}
      ariaLabel={`Run ${workflowName}`}
      className="max-h-[calc(100dvh-1.5rem)] max-w-lg flex-col sm:max-h-[88vh]"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-neutral-100">Run now</div>
          <div className="truncate text-xs text-neutral-500">{workflowName}</div>
        </div>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-keyboard-surface="">
        {body}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-800 px-4 py-3">
        <span className="text-[10.5px] text-neutral-600">⌘/Ctrl Enter</span>
        <div className="flex items-center gap-2">
          <SmallButton variant="ghost" onClick={onClose}>
            Cancel
          </SmallButton>
          {runButton}
        </div>
      </div>
    </Modal>
  );
};
