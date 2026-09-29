/**
 * The MCP server editor's rules (agent profile spec §7.4, §8): the form it
 * edits, the draft it sends, and what makes a form unsaveable.
 *
 * Secrets. An env or header entry already on disk arrives as `{key, set}` —
 * never its value — and stays `{key, keep: true}` until the owner replaces
 * it (`{key, value}`) or removes it (absent from the draft). A value is never
 * prefilled, and nothing here logs one.
 */

import {
  isValidMcpServerName,
  MCP_ADVANCED_FIELDS,
  MCP_TRANSPORTS,
  PROFILE_MCP_NAME_MAX,
  type AgentProfileAgentId,
  type McpServerDraft,
  type McpServerView,
  type McpTransport,
  type ProfileFieldSpec,
  type SecretEntryDraft,
  type SecretEntryView
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Secret rows
// ---------------------------------------------------------------------------

/**
 * One env or header row.
 * - `existing` — set on disk, untouched: sent as `keep`.
 * - `replace` — set on disk, a new value typed: sent as `{key, value}`.
 * - `new` — added here: sent as `{key, value}`.
 * A removed row is simply gone from the list, and so absent from the draft.
 */
export interface SecretRow {
  /** Row identity for rendering only. */
  id: string;
  key: string;
  value: string;
  state: "existing" | "replace" | "new";
}

let rowSeq = 0;
function nextRowId(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

function secretRowsFromView(entries: readonly SecretEntryView[] | undefined): SecretRow[] {
  return (entries ?? []).map((entry) => ({ id: nextRowId(), key: entry.key, value: "", state: "existing" }));
}

export function newSecretRow(key = "", value = ""): SecretRow {
  return { id: nextRowId(), key, value, state: "new" };
}

/** A new row with nothing typed in it is not an entry (the empty row the "+ Add" button leaves). */
const blankRow = (row: SecretRow): boolean => row.state === "new" && row.key.trim() === "" && row.value === "";

export function secretDrafts(rows: readonly SecretRow[]): SecretEntryDraft[] {
  const out: SecretEntryDraft[] = [];
  for (const row of rows) {
    if (blankRow(row)) continue;
    const key = row.key.trim();
    out.push(row.state === "existing" ? { key, keep: true } : { key, value: row.value });
  }
  return out;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An HTTP header name: an RFC 9110 token. */
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type SecretRowsKind = "env" | "headers";

/** The first problem with a row, by row id. */
export function validateSecretRows(kind: SecretRowsKind, rows: readonly SecretRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (blankRow(row)) continue;
    const key = row.key.trim();
    const identity = kind === "headers" ? key.toLowerCase() : key;
    if (key === "") {
      errors[row.id] = kind === "env" ? "Name the variable" : "Name the header";
    } else if (!(kind === "env" ? ENV_KEY : HEADER_KEY).test(key)) {
      errors[row.id] =
        kind === "env"
          ? "Letters, digits and _ only, not starting with a digit"
          : "Letters, digits and - only (no spaces or colons)";
    } else if (seen.has(identity)) {
      errors[row.id] = `${key} is listed twice`;
    } else if (row.state === "replace" && row.value === "") {
      errors[row.id] = "Type the new value, or keep the current one";
    }
    seen.add(identity);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Command lines
// ---------------------------------------------------------------------------

/**
 * Split a command line the way a POSIX shell would split its words: blanks
 * separate, `'…'` is literal, `"…"` keeps blanks and honours `\"`, `\\`, `\$`
 * and `` \` ``, a backslash outside quotes escapes the next character, and a
 * backslash-newline joins lines. An unterminated quote runs to the end. No
 * expansion of any kind happens — `$HOME` stays `$HOME`.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) {
        i += 1;
        if (line[i] !== "\n") word += line[i];
      } else {
        word += ch;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < line.length) {
        i += 1;
        if (line[i] !== "\n") {
          word += line[i];
          inWord = true;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

interface ParsedCommandLine {
  command: string;
  args: string[];
  /** Leading `NAME=value` words (`FOO=1 npx server`): they belong in env. */
  env: { key: string; value: string }[];
}

/**
 * A pasted command line, split into the command, its arguments and any leading
 * env assignments; `null` when there is nothing to split (one word — let the
 * paste land as typed).
 */
export function parsePastedCommandLine(text: string): ParsedCommandLine | null {
  const words = splitCommandLine(text.trim());
  const env: { key: string; value: string }[] = [];
  let index = 0;
  for (; index < words.length; index += 1) {
    const match = ASSIGNMENT.exec(words[index]!);
    if (!match) break;
    env.push({ key: match[1]!, value: match[2]! });
  }
  const rest = words.slice(index);
  if (rest.length === 0) return null;
  if (rest.length === 1 && env.length === 0) return null;
  return { command: rest[0]!, args: rest.slice(1), env };
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/** An advanced field's value as edited: text for number/string/string-list (one per line), or a switch. */
type AdvancedValue = string | boolean;

export interface McpForm {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  cwd: string;
  url: string;
  env: SecretRow[];
  headers: SecretRow[];
  advanced: Record<string, AdvancedValue>;
}

/** What the form started from, for the draft's merge rules. */
interface McpFormOrigin {
  /** The server's name on disk (edit), else `null`. */
  name: string | null;
  /** Its advanced values on disk, including keys the editor does not show (kept as they are). */
  advanced: Record<string, unknown>;
}

export function mcpTransports(agent: AgentProfileAgentId): readonly McpTransport[] {
  return MCP_TRANSPORTS[agent];
}

export function mcpAdvancedFields(agent: AgentProfileAgentId): readonly ProfileFieldSpec[] {
  return MCP_ADVANCED_FIELDS[agent];
}

function advancedFormValue(spec: ProfileFieldSpec, value: unknown): AdvancedValue {
  switch (spec.type) {
    case "boolean":
      return value === true;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : "";
    case "string-list":
      if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").join("\n");
      return typeof value === "string" ? value : "";
    default:
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  }
}

export function initialMcpForm(agent: AgentProfileAgentId, view?: McpServerView): McpForm {
  const transports = mcpTransports(agent);
  const transport = view && view.transport ? view.transport : transports[0] ?? "stdio";
  const advanced: Record<string, AdvancedValue> = {};
  for (const spec of mcpAdvancedFields(agent)) {
    advanced[spec.key] = advancedFormValue(spec, view?.advanced?.[spec.key]);
  }
  return {
    name: view?.name ?? "",
    transport,
    command: view?.command ?? "",
    args: [...(view?.args ?? [])],
    cwd: view?.cwd ?? "",
    url: view?.url ?? "",
    env: secretRowsFromView(view?.env),
    headers: secretRowsFromView(view?.headers),
    advanced
  };
}

export function mcpFormOrigin(view?: McpServerView): McpFormOrigin {
  return { name: view?.name ?? null, advanced: { ...(view?.advanced ?? {}) } };
}

/** The advanced fields worth opening the disclosure for: any with a value. */
export function hasAdvancedValues(agent: AgentProfileAgentId, form: McpForm): boolean {
  return mcpAdvancedFields(agent).some((spec) => {
    const value = form.advanced[spec.key];
    return typeof value === "boolean" ? value : (value ?? "").trim() !== "";
  });
}

function splitListText(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * The advanced part of the draft: every key on disk the editor does not show,
 * as it is; each shown field coerced to its type — a blank one left out, a
 * switch sent when on or when it was on disk.
 */
export function advancedDraft(
  agent: AgentProfileAgentId,
  values: Record<string, AdvancedValue>,
  origin: McpFormOrigin
): Record<string, unknown> {
  const specs = mcpAdvancedFields(agent);
  const shown = new Set(specs.map((spec) => spec.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(origin.advanced)) {
    if (!shown.has(key)) out[key] = value;
  }
  for (const spec of specs) {
    const value = values[spec.key];
    if (spec.type === "boolean") {
      const on = value === true;
      if (on || spec.key in origin.advanced) out[spec.key] = on;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (spec.type === "number") {
      const parsed = parseNumber(text);
      if (parsed !== null) out[spec.key] = parsed;
    } else if (spec.type === "string-list") {
      const list = splitListText(text);
      if (list.length > 0) out[spec.key] = list;
    } else if (text.trim() !== "") {
      out[spec.key] = text.trim();
    }
  }
  return out;
}

export function mcpDraftFromForm(agent: AgentProfileAgentId, form: McpForm, origin: McpFormOrigin): McpServerDraft {
  const draft: McpServerDraft = { name: form.name.trim(), transport: form.transport };
  if (form.transport === "stdio") {
    draft.command = form.command.trim();
    const args = form.args.filter((arg) => arg !== "");
    if (args.length > 0) draft.args = args;
    if (form.cwd.trim() !== "") draft.cwd = form.cwd.trim();
    const env = secretDrafts(form.env);
    if (env.length > 0) draft.env = env;
  } else {
    draft.url = form.url.trim();
    const headers = secretDrafts(form.headers);
    if (headers.length > 0) draft.headers = headers;
  }
  const advanced = advancedDraft(agent, form.advanced, origin);
  if (Object.keys(advanced).length > 0) draft.advanced = advanced;
  return draft;
}

export interface McpValidation {
  valid: boolean;
  errors: {
    name?: string;
    command?: string;
    url?: string;
    /** By advanced field key. */
    advanced: Record<string, string>;
    /** By row id. */
    env: Record<string, string>;
    headers: Record<string, string>;
  };
}

function mcpNameError(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "Name the server";
  if (trimmed.length > PROFILE_MCP_NAME_MAX) return `At most ${PROFILE_MCP_NAME_MAX} characters`;
  if (!isValidMcpServerName(trimmed)) {
    return "Letters, digits, - and _ only; start with a letter or _, and don't end with _";
  }
  return undefined;
}

function urlError(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "") return "Enter the server's URL";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Use an http:// or https:// URL";
  } catch {
    return "Enter a full URL, like https://example.com/mcp";
  }
  return undefined;
}

export function validateMcpForm(agent: AgentProfileAgentId, form: McpForm): McpValidation {
  const errors: McpValidation["errors"] = { advanced: {}, env: {}, headers: {} };
  errors.name = mcpNameError(form.name);
  if (!mcpTransports(agent).includes(form.transport)) {
    // Only reachable from a server on disk with a transport this agent does not list.
    errors.url = `${form.transport} is not a transport this agent accepts`;
  }
  if (form.transport === "stdio") {
    if (form.command.trim() === "") errors.command = "Enter the command that starts the server";
    errors.env = validateSecretRows("env", form.env);
  } else {
    errors.url = errors.url ?? urlError(form.url);
    errors.headers = validateSecretRows("headers", form.headers);
  }
  for (const spec of mcpAdvancedFields(agent)) {
    if (spec.type !== "number") continue;
    const value = form.advanced[spec.key];
    if (typeof value === "string" && value.trim() !== "" && parseNumber(value) === null) {
      errors.advanced[spec.key] = "Enter a whole or decimal number";
    }
  }
  const valid =
    errors.name === undefined &&
    errors.command === undefined &&
    errors.url === undefined &&
    Object.keys(errors.advanced).length === 0 &&
    Object.keys(errors.env).length === 0 &&
    Object.keys(errors.headers).length === 0;
  return { valid, errors };
}

/** The form minus row identities, for "has anything changed". */
export function mcpFormSignature(form: McpForm): string {
  const rows = (list: SecretRow[]) => list.map(({ key, value, state }) => [key, value, state]);
  return JSON.stringify({ ...form, env: rows(form.env), headers: rows(form.headers) });
}
