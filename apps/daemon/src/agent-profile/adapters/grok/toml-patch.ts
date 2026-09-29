/**
 * Grok's `config.toml` — comment-preserving edits (spec §4.1 `toml-patch.ts`).
 *
 * Grok's own CLI rewrites the whole file when it writes (`grok mcp disable`,
 * `grok plugin disable`, … drop every comment and turn inline tables into
 * sub-tables — observed with 1.0.34), so the adapter makes its own edits here:
 *
 * - a value that already exists is changed, and a key or table is deleted,
 *   through `@decimalturn/toml-patch`'s `patch()` — it keeps comments,
 *   whitespace, indentation and the array layout (verified on a copy of this
 *   host's `~/.grok/config.toml`: the indented `[[marketplace.sources]]`, the
 *   multi-line `[plugins] enabled` array and `[compat.claude]` survive);
 * - a NEW key or table is inserted by a targeted text edit, because the
 *   library places additions badly in two cases seen on that copy: a new key
 *   of an existing table lands after the comment lines that introduce the NEXT
 *   table, and a new `[mcp_servers.<name>]` becomes a root dotted key
 *   (`mcp_servers.x = {…}`) above `[cli]`. A new key goes right after the last
 *   key of its table (same indentation); a new table is appended at the end.
 *
 * Every edit is checked: the text it produces must parse to exactly the
 * object the edit describes. A targeted insert that does not (a parent defined
 * inline or by dotted keys) falls back to the library; a library result that
 * does not throws, and nothing is written.
 */

import { parse, parseDocument, patch, stringify } from "@decimalturn/toml-patch";
import { stableStringify } from "../../infra/index.ts";

export type TomlTable = Record<string, unknown>;

export type TomlEdit =
  | { op: "set"; path: readonly string[]; value: unknown }
  | { op: "delete"; path: readonly string[] };

/**
 * The document as plain objects (the library's null-prototype tables copied
 * into ordinary ones; dates kept). Throws an `Error` naming the problem when
 * the text is not valid TOML.
 */
export function parseToml(text: string): TomlTable {
  const parsed = toPlain(parse(text, { integersAsBigInt: false }));
  if (!isTable(parsed)) {
    throw new Error("The document is not a TOML table.");
  }
  return parsed;
}

function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (isTable(value)) {
    const out: TomlTable = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = toPlain(entry);
    }
    return out;
  }
  return value;
}

export function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** The value at `path`, or `undefined` when any segment is missing or not a table. */
export function getTomlPath(doc: TomlTable, path: readonly string[]): unknown {
  let node: unknown = doc;
  for (const segment of path) {
    if (!isTable(node) || !Object.hasOwn(node, segment)) {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

/**
 * Applies `edits` in order to `text` and answers the new text. Setting a key
 * creates missing parent tables; deleting a missing key is a no-op; deleting
 * a table removes its sub-tables and comments it owns. Throws when an edit
 * cannot be expressed (a parent path that is not a table) or when the result
 * does not parse to the expected object.
 */
export function editToml(text: string, edits: readonly TomlEdit[]): string {
  let current = text;
  for (const edit of edits) {
    const expected = parseToml(current);
    const before = stableStringify(expected);
    applyEdit(expected, edit);
    const want = stableStringify(expected);
    if (want === before) {
      continue;
    }
    const exists = edit.op === "set" && getTomlPath(parseToml(current), edit.path) !== undefined;
    let next: string | null = null;
    if (edit.op === "set" && !exists) {
      const inserted = insertTargeted(current, edit.path, edit.value);
      if (inserted !== null && matches(inserted, want)) {
        next = inserted;
      }
    }
    if (next === null) {
      let patched = patch(current, expected);
      // Deleting the first root key (one this module put above the first
      // table) leaves the blank line that separated them at the very top.
      if (/^\r?\n/.test(patched) && !/^\r?\n/.test(current)) {
        patched = patched.replace(/^(?:\r?\n)+/, "");
      }
      if (!matches(patched, want)) {
        throw new Error(`Editing ${edit.path.join(".")} did not produce the expected document.`);
      }
      next = patched;
    }
    current = next;
  }
  return current;
}

function matches(text: string, want: string): boolean {
  try {
    return stableStringify(parseToml(text)) === want;
  } catch {
    return false;
  }
}

function applyEdit(doc: TomlTable, edit: TomlEdit): void {
  if (edit.path.length === 0) {
    throw new Error("An edit needs a key.");
  }
  const parentPath = edit.path.slice(0, -1);
  const key = edit.path[edit.path.length - 1] as string;
  let parent: TomlTable = doc;
  for (const segment of parentPath) {
    const next = parent[segment];
    if (next === undefined) {
      if (edit.op === "delete") {
        return;
      }
      const created: TomlTable = {};
      parent[segment] = created;
      parent = created;
    } else if (isTable(next)) {
      parent = next;
    } else {
      throw new Error(`${edit.path.join(".")}: ${segment} is not a table.`);
    }
  }
  if (edit.op === "delete") {
    delete parent[key];
  } else {
    parent[key] = edit.value;
  }
}

// ---------------------------------------------------------------------------
// Targeted inserts
// ---------------------------------------------------------------------------

/** A key segment as TOML writes it: bare when it can be, else a basic string. */
function renderTomlKey(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

/** A value as the right-hand side of `key = …`, on one line (tables inline). */
function renderTomlValue(value: unknown): string {
  const text = stringify({ t: { v: value } });
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith("v = "));
  if (line === undefined) {
    throw new Error("The value cannot be written as TOML.");
  }
  return line.slice("v = ".length);
}

interface CstNode {
  type: string;
  loc: { start: { line: number; column: number }; end: { line: number; column: number } };
  key?: { item?: { value?: string[] } };
  items?: CstNode[];
}

function samePath(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/**
 * The text with `path = value` inserted where a person would put it, or
 * `null` when there is no obvious place (the caller then uses the library).
 */
function insertTargeted(text: string, path: readonly string[], value: unknown): string | null {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1] as string;
  if (isTable(value)) {
    const header = `[${path.map(renderTomlKey).join(".")}]`;
    const lines = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([entryKey, entry]) => `${renderTomlKey(entryKey)} = ${renderTomlValue(entry)}`);
    return appendBlock(text, [header, ...lines], newline);
  }
  const line = `${renderTomlKey(key)} = ${renderTomlValue(value)}`;
  const lines = text.split(/\r?\n/);
  const blocks = parseDocument(text).cst as unknown as CstNode[];
  if (parentPath.length === 0) {
    const rootKeys = blocks.filter((block) => block.type === "KeyValue");
    const last = rootKeys[rootKeys.length - 1];
    if (last !== undefined) {
      return insertAfterLine(lines, last.loc.end.line, indentOf(lines, last.loc.start.line) + line, newline);
    }
    return text.length === 0 ? `${line}${newline}` : `${line}${newline}${newline}${text}`;
  }
  const table = blocks.find((block) => block.type === "Table" && samePath(block.key?.item?.value, parentPath));
  if (table !== undefined) {
    const keys = (table.items ?? []).filter((item) => item.type === "KeyValue");
    const anchor = keys[keys.length - 1];
    const anchorLine = anchor === undefined ? table.loc.start.line : anchor.loc.end.line;
    const indent = indentOf(lines, anchor === undefined ? table.loc.start.line : anchor.loc.start.line);
    return insertAfterLine(lines, anchorLine, indent + line, newline);
  }
  if (getTomlPath(parseToml(text), parentPath) === undefined) {
    return appendBlock(text, [`[${parentPath.map(renderTomlKey).join(".")}]`, line], newline);
  }
  return null;
}

/** Leading whitespace of the 1-based line `lineNumber`. */
function indentOf(lines: readonly string[], lineNumber: number): string {
  return /^[ \t]*/.exec(lines[lineNumber - 1] ?? "")?.[0] ?? "";
}

function insertAfterLine(lines: readonly string[], lineNumber: number, line: string, newline: string): string {
  const next = [...lines];
  next.splice(lineNumber, 0, line);
  return next.join(newline);
}

/** `block` appended after one blank line (the text's final newline kept or added). */
function appendBlock(text: string, block: readonly string[], newline: string): string {
  const body = block.join(newline) + newline;
  if (text.trim().length === 0) {
    return body;
  }
  const trimmed = text.replace(/(?:\r?\n)+$/, "");
  return `${trimmed}${newline}${newline}${body}`;
}
