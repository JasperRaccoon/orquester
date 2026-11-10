/**
 * Editing a manual trigger's typed inputs (spec 2026-11-10 §4.1, §4.3): the
 * pure steps the inspector's inputs editor (desktop and phone alike) takes —
 * add one with a free name, move, remove, change its type (keeping what still
 * fits: a default that converts, `values` only on a choice, `multiline` only
 * on text), and write the list back (an emptied list removes `inputs`, so the
 * trigger takes any JSON again). Rules the validator reports (unique names,
 * value counts) are not enforced here: the editor shows its problems in place.
 */

import type { WorkflowInputDecl, WorkflowInputType } from "@orquester/api";
import { WORKFLOW_INPUT_TYPES } from "@orquester/config";

export const INPUT_TYPE_LABELS: Readonly<Record<WorkflowInputType, string>> = {
  string: "Text",
  number: "Number",
  boolean: "Yes / no",
  enum: "Choice"
};

export const INPUT_TYPES: readonly WorkflowInputType[] = WORKFLOW_INPUT_TYPES;

/** A name no input has yet: input1, input2, … */
export function freeInputName(inputs: readonly WorkflowInputDecl[]): string {
  const taken = new Set(inputs.map((decl) => decl.name));
  let n = inputs.length + 1;
  while (taken.has(`input${n}`)) n += 1;
  return `input${n}`;
}

export function addInputDecl(inputs: readonly WorkflowInputDecl[]): WorkflowInputDecl[] {
  return [...inputs, { name: freeInputName(inputs), type: "string" }];
}

export function removeInputDecl(inputs: readonly WorkflowInputDecl[], index: number): WorkflowInputDecl[] {
  return inputs.filter((_, i) => i !== index);
}

/** Swap with its neighbour (`delta` -1 or 1); out of range changes nothing. */
export function moveInputDecl(inputs: readonly WorkflowInputDecl[], index: number, delta: number): WorkflowInputDecl[] {
  const target = index + delta;
  if (index < 0 || index >= inputs.length || target < 0 || target >= inputs.length) return [...inputs];
  const next = [...inputs];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Set fields of one input; `undefined` removes a field. */
export function patchInputDecl(decl: WorkflowInputDecl, patch: Partial<Record<keyof WorkflowInputDecl, unknown>>): WorkflowInputDecl {
  const next: Record<string, unknown> = { ...decl };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as WorkflowInputDecl;
}

/** A default carried over to another type, when it converts exactly; else none. */
function convertedDefault(value: WorkflowInputDecl["default"], type: WorkflowInputType, values: readonly string[] | undefined): WorkflowInputDecl["default"] {
  if (value === undefined) return undefined;
  switch (type) {
    case "string":
      return String(value);
    case "number": {
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
      return undefined;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      return value === "true" ? true : value === "false" ? false : undefined;
    case "enum": {
      const text = String(value);
      return values?.includes(text) ? text : undefined;
    }
  }
}

/**
 * The input as another type: `values` kept only for a choice (seeded with the
 * text default, if there was one), `multiline` only for text, and the default
 * converted when it can be.
 */
export function retypeInputDecl(decl: WorkflowInputDecl, type: WorkflowInputType): WorkflowInputDecl {
  if (decl.type === type) return decl;
  const values = type === "enum" ? (decl.values ?? (typeof decl.default === "string" && decl.default !== "" ? [decl.default] : [])) : undefined;
  return patchInputDecl(decl, {
    type,
    values,
    multiline: type === "string" ? decl.multiline : undefined,
    default: convertedDefault(decl.default, type, values)
  });
}

/** An enum's values from its editor's text: one per line, trimmed, blank lines dropped. */
export function valuesFromLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A choice's new values: its default dropped when it is no longer one of them. */
export function withEnumValues(decl: WorkflowInputDecl, values: string[]): WorkflowInputDecl {
  const keepDefault = typeof decl.default === "string" && values.includes(decl.default);
  return patchInputDecl(decl, { values, default: keepDefault ? decl.default : undefined });
}

/** The trigger config with this inputs list; an empty list removes `inputs` (any JSON input again). */
export function withInputs<C extends { inputs?: WorkflowInputDecl[] }>(config: C, inputs: readonly WorkflowInputDecl[]): C {
  const next: C = { ...config };
  if (inputs.length === 0) delete next.inputs;
  else next.inputs = [...inputs];
  return next;
}

/** One line for a collapsed input: its type and what sets it apart. */
export function inputDeclSummary(decl: WorkflowInputDecl): string {
  const parts: string[] = [INPUT_TYPE_LABELS[decl.type]];
  if (decl.type === "enum") parts[0] = `${INPUT_TYPE_LABELS.enum} (${(decl.values ?? []).length})`;
  if (decl.multiline && decl.type === "string") parts.push("multi-line");
  if (decl.required) parts.push("required");
  if (decl.default !== undefined) parts.push(`default ${typeof decl.default === "string" ? `“${decl.default.slice(0, 24)}”` : String(decl.default)}`);
  return parts.join(" · ");
}
