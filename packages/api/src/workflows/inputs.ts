// Automated workflows — typed manual-trigger inputs (spec 2026-11-10 §4). One module for the daemon
// (every run's input, a sub-workflow block's input), the editor (the Run now form, the inputs
// editor) and the MCP (`run_workflow`'s errors): the declaration rules `validateWorkflow` reports,
// and the check that turns a run's raw input into the validated, defaulted one.
//
// The check applies defaults, refuses a missing required input, a wrong type, an enum value not
// among its values and an unknown key, and coerces only "42" → 42 (numbers) and "true"/"false"
// (booleans) — agents often send every value as a string. Every problem is returned at once, each
// naming the input and the fix.

import type { WorkflowEdge, WorkflowInputDecl, WorkflowNode, WorkflowNodeOf } from "@orquester/config";

import type { TemplateReference } from "./expressions.ts";
import { WORKFLOW_LIMITS, type WorkflowInputError, type WorkflowProblem } from "./types.ts";

/** The type and allowed values of a typed value: an input (§4.1) or an agent output (§5.1). */
export interface WorkflowTypedValueSpec {
  type: "string" | "number" | "boolean" | "enum" | "json";
  values?: readonly string[];
}

export type WorkflowCoercion = { ok: true; value: unknown } | { ok: false; expected: string };

/** A JSON number as text: digits with an optional sign, fraction and exponent (no hex, no Infinity). */
const NUMBER_TEXT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** "must be one of: a, b" — the values listed, at most 20. */
function oneOf(values: readonly string[] | undefined): string {
  const list = values ?? [];
  if (list.length === 0) return "has no allowed values (declare its values)";
  const shown = list.slice(0, 20).join(", ");
  return `must be one of: ${shown}${list.length > 20 ? `, … (${list.length - 20} more)` : ""}`;
}

/** What a type expects, as the end of "input `x` …". */
export function typedValueExpectation(spec: WorkflowTypedValueSpec): string {
  switch (spec.type) {
    case "string":
      return "must be text";
    case "number":
      return "must be a number";
    case "boolean":
      return "must be true or false";
    case "enum":
      return oneOf(spec.values);
    case "json":
      return "must be JSON";
  }
}

/**
 * One value against its type: the value to store, or what was expected. Only "42" → 42 for a
 * number and "true" / "false" for a boolean are coerced; an enum value must be one of `values`
 * exactly; `json` takes any JSON value.
 */
export function coerceTypedValue(spec: WorkflowTypedValueSpec, raw: unknown): WorkflowCoercion {
  const fail = (): WorkflowCoercion => ({ ok: false, expected: typedValueExpectation(spec) });
  switch (spec.type) {
    case "string":
      return typeof raw === "string" ? { ok: true, value: raw } : fail();
    case "number": {
      if (typeof raw === "number") return Number.isFinite(raw) ? { ok: true, value: raw } : fail();
      if (typeof raw === "string") {
        const text = raw.trim();
        if (NUMBER_TEXT.test(text)) {
          const value = Number(text);
          if (Number.isFinite(value)) return { ok: true, value };
        }
      }
      return fail();
    }
    case "boolean":
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return fail();
    case "enum":
      return typeof raw === "string" && (spec.values ?? []).includes(raw) ? { ok: true, value: raw } : fail();
    case "json":
      return raw === undefined ? fail() : { ok: true, value: raw };
  }
}

/** A value quoted in an error, short. */
export function describeTypedValue(raw: unknown): string {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "a list";
  if (typeof raw === "object") return "an object";
  if (typeof raw === "string") {
    const shown = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
    return JSON.stringify(shown);
  }
  return String(raw);
}

/** The declared inputs when there are any; `undefined` for none (any JSON input, as before inputs existed). */
export function declaredInputs(inputs: readonly WorkflowInputDecl[] | undefined | null): readonly WorkflowInputDecl[] | undefined {
  return Array.isArray(inputs) && inputs.length > 0 ? inputs : undefined;
}

/**
 * The manual trigger whose inputs a run is checked against: `triggerNodeId` when it names a manual
 * trigger, else (no id given) the first enabled one — the one a run without a named trigger
 * starts from.
 */
export function manualTriggerFor(
  workflow: { nodes: readonly WorkflowNode[] },
  triggerNodeId?: string
): WorkflowNodeOf<"trigger.manual"> | undefined {
  if (triggerNodeId !== undefined) {
    const named = workflow.nodes.find((node) => node.id === triggerNodeId);
    return named?.type === "trigger.manual" ? named : undefined;
  }
  return workflow.nodes.find((node): node is WorkflowNodeOf<"trigger.manual"> => node.type === "trigger.manual" && !node.disabled);
}

/** The declared inputs a run of `workflow` is checked against (see `manualTriggerFor`); `undefined` for none. */
export function workflowRunInputs(
  workflow: { nodes: readonly WorkflowNode[] },
  triggerNodeId?: string
): readonly WorkflowInputDecl[] | undefined {
  return declaredInputs(manualTriggerFor(workflow, triggerNodeId)?.config.inputs);
}

export interface ValidateWorkflowInputOptions {
  /**
   * False for a test run or "Test one block" (§7.5): defaults still apply, but a required input
   * that is missing is not an error. Default true.
   */
  requireAll?: boolean;
}

export interface WorkflowInputCheck {
  /** The validated input with its defaults (declared order); the raw input itself when nothing is declared. */
  value: unknown;
  /** Every problem, in declared order, then the unknown keys. Empty = the input is good. */
  errors: WorkflowInputError[];
}

/** At most this many unknown keys are named one by one; the rest are counted. */
const MAX_UNKNOWN_NAMED = 10;

/**
 * A run's input against its trigger's declared inputs (§4.2). Without declarations the input
 * passes through untouched. With them it must be an object (`null` / absent counts as `{}`);
 * `null` for one key counts as absent.
 */
export function validateWorkflowInput(
  inputs: readonly WorkflowInputDecl[] | undefined | null,
  input: unknown,
  options: ValidateWorkflowInputOptions = {}
): WorkflowInputCheck {
  const declared = declaredInputs(inputs);
  if (declared === undefined) return { value: input, errors: [] };
  const names = declared.map((decl) => decl.name);
  const raw = input === undefined || input === null ? {} : input;
  if (!isRecord(raw)) {
    return {
      value: input,
      errors: [
        {
          message: `The input must be a JSON object of named inputs, e.g. {${names
            .slice(0, 3)
            .map((name) => `"${name}": …`)
            .join(", ")}} (got ${describeTypedValue(raw)})`
        }
      ]
    };
  }
  const requireAll = options.requireAll !== false;
  const errors: WorkflowInputError[] = [];
  const value: Record<string, unknown> = {};
  for (const decl of declared) {
    const given = Object.hasOwn(raw, decl.name) ? raw[decl.name] : undefined;
    if (given === undefined || given === null) {
      if (decl.default !== undefined) {
        const fallback = coerceTypedValue(decl, decl.default);
        if (fallback.ok) value[decl.name] = fallback.value;
        else errors.push({ input: decl.name, message: `input \`${decl.name}\`'s default ${typedValueExpectation(decl)}: fix the trigger's default` });
      } else if (decl.required === true && requireAll) {
        errors.push({ input: decl.name, message: `input \`${decl.name}\` is required: ${requiredHint(decl)}` });
      }
      continue;
    }
    if (decl.required === true && requireAll && given === "") {
      errors.push({ input: decl.name, message: `input \`${decl.name}\` is required: it cannot be empty` });
      continue;
    }
    const coerced = coerceTypedValue(decl, given);
    if (coerced.ok) value[decl.name] = coerced.value;
    else errors.push({ input: decl.name, message: `input \`${decl.name}\` ${coerced.expected} (got ${describeTypedValue(given)})` });
  }
  const known = new Set(names);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  for (const key of unknown.slice(0, MAX_UNKNOWN_NAMED)) {
    const shown = key.length > 40 ? `${key.slice(0, 40)}…` : key;
    const near = names.find((name) => name.toLowerCase() === key.toLowerCase());
    errors.push({
      input: key,
      message: near
        ? `unknown input \`${shown}\`: did you mean \`${near}\`?`
        : `unknown input \`${shown}\`: remove it (this workflow takes ${names.join(", ")})`
    });
  }
  if (unknown.length > MAX_UNKNOWN_NAMED) {
    errors.push({ message: `${unknown.length - MAX_UNKNOWN_NAMED} more unknown inputs: this workflow takes only ${names.join(", ")}` });
  }
  return { value, errors };
}

function requiredHint(decl: WorkflowInputDecl): string {
  switch (decl.type) {
    case "string":
      return "pass some text";
    case "number":
      return "pass a number";
    case "boolean":
      return "pass true or false";
    case "enum":
      return `pass one of: ${(decl.values ?? []).slice(0, 20).join(", ") || "(no values declared)"}`;
  }
}

/** The errors as one sentence for a refusal's message ("…; …"), at most `max` named. */
export function workflowInputErrorsText(errors: readonly WorkflowInputError[], max = 10): string {
  const shown = errors.slice(0, max).map((error) => error.message);
  return `${shown.join("; ")}${errors.length > max ? `; … (${errors.length - max} more)` : ""}`;
}

// ---------------------------------------------------------------------------
// Declaration rules (validateWorkflow)
// ---------------------------------------------------------------------------

/** Whether a declared default fits its input: the exact JSON type (no coercion), an enum's among its values. */
function defaultFits(decl: WorkflowInputDecl): boolean {
  const value = decl.default;
  switch (decl.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (decl.values ?? []).includes(value);
  }
}

/**
 * A manual trigger's `inputs` against the rules the schema does not hold (§4.1): ≤ 30 inputs,
 * unique names, an enum's 1–50 unique non-empty values, a default that fits, a description of at
 * most 300 characters, `multiline` only on text.
 */
export function inputDeclarationProblems(node: WorkflowNodeOf<"trigger.manual">): WorkflowProblem[] {
  const inputs = node.config.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const problems: WorkflowProblem[] = [];
  const at = (index: number, key?: string): string => `config.inputs.${index}${key ? `.${key}` : ""}`;
  const error = (code: string, message: string, field: string): void => {
    problems.push({ severity: "error", code, message: `${node.name}: ${message}`, nodeId: node.id, field });
  };
  if (inputs.length > WORKFLOW_LIMITS.maxInputs) {
    error("too_many_inputs", `at most ${WORKFLOW_LIMITS.maxInputs} inputs (it has ${inputs.length})`, "config.inputs");
  }
  const seen = new Set<string>();
  const { min, max } = WORKFLOW_LIMITS.enumValues;
  inputs.forEach((decl, index) => {
    const name = `input \`${decl.name}\``;
    if (seen.has(decl.name)) error("duplicate_input", `two inputs are named "${decl.name}" — names must be unique`, at(index, "name"));
    seen.add(decl.name);
    if (decl.type === "enum") {
      const values = decl.values ?? [];
      if (values.length < min || values.length > max) {
        error("input_values", `${name} needs ${min}–${max} values to choose from (it has ${values.length})`, at(index, "values"));
      }
      const listed = new Set<string>();
      values.forEach((value, valueIndex) => {
        if (value.trim().length === 0) error("input_values", `${name}: value ${valueIndex + 1} is empty`, at(index, `values.${valueIndex}`));
        else if (listed.has(value)) error("input_values", `${name}: "${value.slice(0, 60)}" is listed twice`, at(index, `values.${valueIndex}`));
        listed.add(value);
      });
    } else if (decl.values !== undefined) {
      problems.push({
        severity: "warning",
        code: "input_values_ignored",
        message: `${node.name}: ${name} is not a choice, so its values are ignored`,
        nodeId: node.id,
        field: at(index, "values")
      });
    }
    if (decl.multiline === true && decl.type !== "string") {
      error("input_multiline", `${name}: only a text input can be multi-line`, at(index, "multiline"));
    }
    if (decl.default !== undefined && !defaultFits(decl)) {
      error("input_default", `${name}: the default ${typedValueExpectation(decl)} (it is ${describeTypedValue(decl.default)})`, at(index, "default"));
    }
    if (decl.description !== undefined && decl.description.length > WORKFLOW_LIMITS.inputDescriptionChars) {
      error("input_description_too_long", `${name}: the description is longer than ${WORKFLOW_LIMITS.inputDescriptionChars} characters`, at(index, "description"));
    }
  });
  return problems;
}

/**
 * For `validateWorkflow`'s reference loop: the input name a reference reads that no manual trigger
 * declares (`{{ trigger.input.x }}`, `{{ nodes.<Manual>.output.input.x }}`, and `{{ input.input.x }}`
 * in a block wired straight from the trigger), with what is declared; null when it reads a
 * declared input, something else, or no manual trigger declares inputs (any input is fine then).
 */
export function createUndeclaredInputCheck(graph: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): (node: WorkflowNode, ref: TemplateReference) => { name: string; declared: readonly string[] } | null {
  const byId = new Map<string, readonly string[]>();
  const byName = new Map<string, readonly string[]>();
  const all = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== "trigger.manual") continue;
    const inputs = declaredInputs(node.config.inputs);
    if (inputs === undefined) continue;
    const names = inputs.map((decl) => decl.name);
    byId.set(node.id, names);
    byName.set(node.name, names);
    for (const name of names) all.add(name);
  }
  if (byId.size === 0) return () => null;
  const verdict = (name: unknown, declared: readonly string[]): { name: string; declared: readonly string[] } | null =>
    typeof name === "string" && !declared.includes(name) ? { name, declared } : null;
  return (node, ref) => {
    const path = ref.path;
    if (ref.root === "trigger") return path[0] === "input" ? verdict(path[1], [...all]) : null;
    if (ref.root === "nodes") {
      const declared = typeof path[0] === "string" ? byName.get(path[0]) : undefined;
      return declared !== undefined && path[1] === "output" && path[2] === "input" ? verdict(path[3], declared) : null;
    }
    if (ref.root === "input" && path[0] === "input") {
      const sources = graph.edges.filter((edge) => edge.target === node.id).map((edge) => byId.get(edge.source));
      const declared = sources.filter((names): names is readonly string[] => names !== undefined);
      if (declared.length === 0) return null;
      return verdict(path[1], [...new Set(declared.flat())]);
    }
    return null;
  };
}
