/**
 * The Run now form built from a manual trigger's typed inputs (spec
 * 2026-11-10 §4.3): its starting values (the defaults), the input a run sends
 * from them, the errors placed beside their fields, and the round trip to and
 * from the "Edit as JSON" editor. The same `validateWorkflowInput` the daemon
 * runs checks the form before it goes, so what the form says is what the
 * daemon would say; the daemon's own answer (a definition changed meanwhile)
 * lands in the same places.
 */

import {
  coerceTypedValue,
  validateWorkflowInput,
  type WorkflowInputDecl,
  type WorkflowInputError,
  type WorkflowTriggerSummary
} from "@orquester/api";

/** One field's value: text and enum choices as strings (an enum with nothing picked is `undefined`), numbers as numbers, booleans as booleans. */
export type RunInputValue = string | number | boolean | undefined;
export type RunInputValues = Readonly<Record<string, RunInputValue>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The form's empty value for an input (what an absent input shows). */
function emptyValue(decl: WorkflowInputDecl): RunInputValue {
  switch (decl.type) {
    case "string":
      return "";
    case "boolean":
      return false;
    default:
      return undefined;
  }
}

/** What the form starts with: each input's default, else its empty value. */
export function initialRunInputValues(inputs: readonly WorkflowInputDecl[]): Record<string, RunInputValue> {
  const values: Record<string, RunInputValue> = {};
  for (const decl of inputs) {
    const fallback = decl.default !== undefined ? coerceTypedValue(decl, decl.default) : null;
    values[decl.name] = fallback?.ok ? (fallback.value as RunInputValue) : emptyValue(decl);
  }
  return values;
}

/**
 * The input the form sends: every field the user set. An empty text, an empty
 * number and an enum with nothing picked are left out (the daemon applies the
 * default, or names a required input as missing) — except an emptied text
 * whose input has a default: the empty text is what the user chose.
 */
export function runInputFromValues(inputs: readonly WorkflowInputDecl[], values: RunInputValues): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const decl of inputs) {
    const value = values[decl.name];
    switch (decl.type) {
      case "string":
        if (typeof value === "string" && (value !== "" || decl.default !== undefined)) input[decl.name] = value;
        break;
      case "number":
        if (typeof value === "number" && Number.isFinite(value)) input[decl.name] = value;
        break;
      case "boolean":
        input[decl.name] = value === true;
        break;
      case "enum":
        if (typeof value === "string" && value !== "") input[decl.name] = value;
        break;
    }
  }
  return input;
}

/** Errors split for the form: beside a declared input's field, or above the form (unknown keys, the input as a whole). */
export interface PlacedInputErrors {
  byInput: Readonly<Record<string, string>>;
  general: readonly string[];
}

/** The message without its "input `x` " lead, which the field's label already says. */
function fieldText(message: string, name: string): string {
  const lead = `input \`${name}\` `;
  const text = message.startsWith(lead) ? message.slice(lead.length) : message;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function placeInputErrors(inputs: readonly WorkflowInputDecl[], errors: readonly WorkflowInputError[]): PlacedInputErrors {
  const names = new Set(inputs.map((decl) => decl.name));
  const byInput: Record<string, string> = {};
  const general: string[] = [];
  for (const error of errors) {
    if (error.input !== undefined && names.has(error.input)) {
      if (!(error.input in byInput)) byInput[error.input] = fieldText(error.message, error.input);
    } else general.push(error.message);
  }
  return { byInput, general };
}

/** The form checked as the daemon checks a run (all required inputs present). */
export function checkRunInputValues(inputs: readonly WorkflowInputDecl[], values: RunInputValues): WorkflowInputError[] {
  return validateWorkflowInput(inputs, runInputFromValues(inputs, values)).errors;
}

/** The JSON editor's text for the form's values. */
export function runInputJson(inputs: readonly WorkflowInputDecl[], values: RunInputValues): string {
  return JSON.stringify(runInputFromValues(inputs, values), null, 2);
}

export type JsonToFormResult = { ok: true; values: Record<string, RunInputValue> } | { ok: false; problems: string[] };

/**
 * Back from the JSON editor to the form: the JSON's values in the fields.
 * Refused, with what is in the way, when the JSON is not an object or holds
 * something the form cannot show (an unknown key, a value of the wrong type)
 * — the user fixes it there, or runs the JSON as it is.
 */
export function runInputValuesFromJson(inputs: readonly WorkflowInputDecl[], text: string): JsonToFormResult {
  let parsed: unknown;
  if (text.trim() === "") parsed = {};
  else {
    try {
      parsed = JSON.parse(text);
    } catch (reason) {
      return { ok: false, problems: [`Not valid JSON: ${reason instanceof Error ? reason.message : String(reason)}`] };
    }
  }
  if (parsed === null) parsed = {};
  if (!isRecord(parsed)) return { ok: false, problems: ["The input must be a JSON object of named inputs."] };
  const problems: string[] = [];
  const names = new Set(inputs.map((decl) => decl.name));
  for (const key of Object.keys(parsed)) if (!names.has(key)) problems.push(`“${key.slice(0, 40)}” is not one of the inputs.`);
  const values: Record<string, RunInputValue> = {};
  for (const decl of inputs) {
    const raw = Object.hasOwn(parsed, decl.name) ? parsed[decl.name] : undefined;
    if (raw === undefined || raw === null) {
      values[decl.name] = emptyValue(decl);
      continue;
    }
    const coerced = coerceTypedValue(decl, raw);
    if (coerced.ok) values[decl.name] = coerced.value as RunInputValue;
    else problems.push(`${decl.name} ${coerced.expected}.`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, values };
}

/** The declared inputs a Run now from the rail uses: the first manual trigger summary with inputs. */
export function summaryRunInputs(triggers: readonly WorkflowTriggerSummary[]): readonly WorkflowInputDecl[] | undefined {
  const typed = triggers.find((trigger) => trigger.type === "trigger.manual" && Array.isArray(trigger.inputs) && trigger.inputs.length > 0);
  return typed?.inputs;
}
