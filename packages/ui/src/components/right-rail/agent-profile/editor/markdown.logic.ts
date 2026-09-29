/**
 * The skill and command editor's "Write" rules (agent profile spec §7.4): the
 * frontmatter fields it shows for the agent and kind, the form, and the draft.
 *
 * A skill's name is its directory name and its frontmatter `name`, one input.
 * A command's name is its path under `commands/` without `.md`.
 *
 * Frontmatter keys the editor does not show — and a shown key whose value on
 * disk is not the field's type (a YAML list in a text field) — are not sent,
 * so the daemon keeps them exactly as they are ("Other keys kept: …"). A shown
 * key the owner clears is sent as `null` (removed); one never set stays unset.
 */

import {
  isValidCommandName,
  isValidSkillName,
  PROFILE_FRONTMATTER_FIELDS,
  PROFILE_SKILL_NAME_MAX,
  type AgentProfileAgentId,
  type MarkdownDocumentDraft,
  type MarkdownDocumentView,
  type ProfileFieldSpec
} from "@orquester/api";

export type MarkdownKind = "skill" | "command";

type FieldValue = string | boolean;

export interface MarkdownForm {
  name: string;
  /** By frontmatter key: text for string/text/number/string-list (one per line), a switch for boolean. */
  values: Record<string, FieldValue>;
  body: string;
}

export interface MarkdownEditorModel {
  /** The fields rendered as inputs (the name field excluded: it is the name input). */
  fields: ProfileFieldSpec[];
  /** Frontmatter keys on disk the editor keeps untouched, in file order. */
  keptKeys: string[];
  /** The frontmatter as it is on disk (`{}` for a new item). */
  original: Record<string, unknown>;
  /**
   * Commands are flat files (Grok loads only the top of `~/.grok/commands`):
   * a command name takes no folder.
   */
  flatCommands: boolean;
}

/** The agents whose commands cannot live in a folder (the daemon refuses one with `INVALID_NAME`). */
const FLAT_COMMAND_AGENTS: readonly AgentProfileAgentId[] = ["grok"];

/**
 * What a switch means when the frontmatter does not set it: `user-invocable`
 * is on unless a skill turns it off, so a new skill shows it on.
 */
const BOOLEAN_DEFAULTS: Readonly<Record<string, boolean>> = { "user-invocable": true };

function booleanDefault(key: string): boolean {
  return BOOLEAN_DEFAULTS[key] ?? false;
}

function frontmatterFields(agent: AgentProfileAgentId, kind: MarkdownKind): readonly ProfileFieldSpec[] {
  return PROFILE_FRONTMATTER_FIELDS[agent][kind] ?? [];
}

/** Can the field show this value from disk without changing its type on save? */
function fits(spec: ProfileFieldSpec, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string-list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    default:
      return typeof value === "string";
  }
}

function formValue(spec: ProfileFieldSpec, value: unknown): FieldValue {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? value : booleanDefault(spec.key);
    case "number":
      return typeof value === "number" ? String(value) : "";
    case "string-list":
      return Array.isArray(value) ? value.join("\n") : "";
    default:
      return typeof value === "string" ? value : "";
  }
}

export function markdownEditorModel(
  agent: AgentProfileAgentId,
  kind: MarkdownKind,
  document?: MarkdownDocumentView
): MarkdownEditorModel {
  const original = { ...(document?.frontmatter ?? {}) };
  const specs = frontmatterFields(agent, kind);
  const fields: ProfileFieldSpec[] = [];
  const unfit = new Set<string>();
  for (const spec of specs) {
    if (kind === "skill" && spec.key === "name") continue;
    if (fits(spec, original[spec.key])) fields.push(spec);
    else unfit.add(spec.key);
  }
  const shown = new Set(fields.map((spec) => spec.key));
  const keptKeys = Object.keys(original).filter((key) => {
    if (kind === "skill" && key === "name") return false;
    return !shown.has(key) || unfit.has(key);
  });
  return { fields, keptKeys, original, flatCommands: FLAT_COMMAND_AGENTS.includes(agent) };
}

export function initialMarkdownForm(
  model: MarkdownEditorModel,
  name = "",
  body = ""
): MarkdownForm {
  const values: Record<string, FieldValue> = {};
  for (const spec of model.fields) values[spec.key] = formValue(spec, model.original[spec.key]);
  return { name, values, body };
}

/** "Write" on an existing item: its name, fields and body. */
export function markdownFormFromDocument(model: MarkdownEditorModel, name: string, document: MarkdownDocumentView): MarkdownForm {
  return initialMarkdownForm(model, name, document.body);
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** The frontmatter the draft sends: shown fields only (see the file comment for the merge rules). */
export function frontmatterDraft(
  kind: MarkdownKind,
  model: MarkdownEditorModel,
  form: MarkdownForm
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (kind === "skill") out.name = form.name.trim();
  for (const spec of model.fields) {
    const onDisk = spec.key in model.original && model.original[spec.key] !== undefined;
    const value = form.values[spec.key];
    if (spec.type === "boolean") {
      const on = value === true;
      if (onDisk || on !== booleanDefault(spec.key)) out[spec.key] = on;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    let next: unknown = null;
    if (spec.type === "number") {
      next = parseNumber(text);
    } else if (spec.type === "string-list") {
      const list = text
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      next = list.length > 0 ? list : null;
    } else {
      next = text.trim() === "" ? null : text.trim();
    }
    if (next !== null) out[spec.key] = next;
    else if (onDisk) out[spec.key] = null;
  }
  return out;
}

export function markdownDraftFromForm(
  kind: MarkdownKind,
  model: MarkdownEditorModel,
  form: MarkdownForm
): MarkdownDocumentDraft {
  return { name: form.name.trim(), frontmatter: frontmatterDraft(kind, model, form), body: form.body };
}

function markdownNameError(
  kind: MarkdownKind,
  name: string,
  options: { flatCommands?: boolean } = {}
): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return kind === "skill" ? "Name the skill" : "Name the command";
  if (kind === "skill") {
    if (trimmed.length > PROFILE_SKILL_NAME_MAX) return `At most ${PROFILE_SKILL_NAME_MAX} characters`;
    if (!isValidSkillName(trimmed)) return "Lowercase letters and digits, words joined by single hyphens (my-skill)";
    return undefined;
  }
  if (options.flatCommands === true) {
    if (trimmed.includes("/")) return "No folder: this agent loads commands only from the top of its commands folder";
    if (!isValidSkillName(trimmed)) return "Lowercase words joined by hyphens (review or git-pr)";
    return undefined;
  }
  if (!isValidCommandName(trimmed)) {
    return "Lowercase words joined by hyphens, with at most one folder (review or git/pr)";
  }
  return undefined;
}

/** The name field's hint: what the name becomes. */
export function markdownNameHint(kind: MarkdownKind, model: Pick<MarkdownEditorModel, "flatCommands">): string {
  if (kind === "skill") return "Also the skill's folder name: lowercase words joined by hyphens.";
  return model.flatCommands
    ? "Invoked as /name: lowercase words joined by hyphens, no folder."
    : "Invoked as /name. One folder level is allowed (git/pr → /git:pr).";
}

export interface MarkdownValidation {
  valid: boolean;
  errors: { name?: string; body?: string; fields: Record<string, string> };
}

export function validateMarkdownForm(kind: MarkdownKind, model: MarkdownEditorModel, form: MarkdownForm): MarkdownValidation {
  const errors: MarkdownValidation["errors"] = { fields: {} };
  errors.name = markdownNameError(kind, form.name, { flatCommands: model.flatCommands });
  for (const spec of model.fields) {
    const value = form.values[spec.key];
    if (spec.type === "boolean") continue;
    const text = typeof value === "string" ? value : "";
    if (spec.required && text.trim() === "") {
      errors.fields[spec.key] = `${spec.label} is required`;
    } else if (spec.type === "number" && text.trim() !== "" && parseNumber(text) === null) {
      errors.fields[spec.key] = "Enter a number";
    }
  }
  if (form.body.trim() === "") errors.body = kind === "skill" ? "Write the skill's instructions" : "Write the command's prompt";
  const valid = errors.name === undefined && errors.body === undefined && Object.keys(errors.fields).length === 0;
  return { valid, errors };
}

export function markdownFormSignature(form: MarkdownForm): string {
  return JSON.stringify(form);
}

export const SKILL_BODY_PLACEHOLDER =
  "# What this skill does\n\nStep-by-step instructions the agent follows when the skill applies.";
export const COMMAND_BODY_PLACEHOLDER = "Review the staged changes for bugs. Focus on $ARGUMENTS.";
