/**
 * OpenCode's config files are JSONC (comments, trailing commas). They are
 * parsed with `jsonc-parser` — the library OpenCode itself uses — and edited
 * so that only the edited region changes: comments, formatting and unknown
 * keys elsewhere survive byte for byte.
 *
 * `jsonc-parser`'s `modify` is used as it is to replace an existing value in
 * place. Adding and removing members is done here on its syntax tree instead,
 * because `modify` (3.3) reformats the neighbouring lines, drops the comment
 * above a removed first member, moves a same-line comment onto an appended
 * member, and leaves `{ , }` behind when it removes the only member before a
 * trailing comma.
 */

import {
  type JSONPath,
  type Node,
  type ParseError,
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode
} from "jsonc-parser";
import { AgentProfileError } from "../../errors.ts";
import { stableStringify } from "../../infra/index.ts";

/** A UTF-8 byte-order mark: {@link parseJsoncObject} reads past it; editors strip it first and put it back. */
export const BOM = "﻿";

/** OpenCode's own formatting for the text it inserts (`opencode mcp add`, `updateGlobal`). */
const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type JsoncParseResult = { ok: true; value: JsonObject } | { ok: false; error: string };

/** Line and column (1-based) of `offset` in `text`, for an error message. */
function position(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}

/**
 * Parses a config file's text the way OpenCode reads it: JSONC with trailing
 * commas. An empty file is `{}` (OpenCode skips it). Any syntax error, or a
 * root that is not an object, is a failure with a message naming where.
 */
export function parseJsoncObject(input: string): JsoncParseResult {
  // A leading byte-order mark is not JSON, but OpenCode reads past it.
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  if (text.length === 0) {
    return { ok: true, value: {} };
  }
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : "";
    return { ok: false, error: `${printParseErrorCode(first.error)} at ${position(text, first.offset)}${more}` };
  }
  if (!isJsonObject(value)) {
    return { ok: false, error: "the file is not a JSON object" };
  }
  return { ok: true, value };
}

/** The verifier for `writeProfileFileVerified`: throws unless the text parses as a JSONC object. */
export function assertJsoncObject(text: string): JsonObject {
  const result = parseJsoncObject(text);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** A text edit: replace `length` characters at `offset` with `content`. */
interface TextEdit {
  offset: number;
  length: number;
  content: string;
}

function apply(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, edit.offset) + edit.content + out.slice(edit.offset + edit.length);
  }
  return out;
}

function treeOf(text: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (root === undefined || errors.length > 0) {
    const detail = errors.length > 0 ? printParseErrorCode(errors[0]!.error) : "empty";
    throw new Error(`cannot edit text that does not parse (${detail})`);
  }
  return root;
}

/**
 * Refuses a path through an object key that is set twice: the tree edits the
 * FIRST one while OpenCode (like `JSON.parse`) keeps the LAST, so the edit
 * would change nothing OpenCode sees.
 */
function assertNoDuplicateOnPath(root: Node, path: JSONPath): void {
  let node: Node | undefined = root;
  for (const [depth, segment] of path.entries()) {
    if (node === undefined) return;
    if (node.type === "object" && typeof segment === "string") {
      const members: Node[] = (node.children ?? []).filter((member) => member.children?.[0]?.value === segment);
      if (members.length > 1) {
        const where = path.slice(0, depth + 1).join(".");
        throw new AgentProfileError(
          409,
          "CONFIG_UNREADABLE",
          `"${where}" is set ${members.length} times in the config; OpenCode uses the last one. Remove the duplicates by hand first.`
        );
      }
      node = members[0]?.children?.[1];
    } else if (node.type === "array" && typeof segment === "number") {
      node = node.children?.[segment];
    } else {
      return;
    }
  }
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function blank(value: string): boolean {
  return /^[ \t]*$/.test(value);
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * What follows a value at `offset` on its line: blanks, an optional comma,
 * then blanks and comments. `restEnd` is where that stops; `atLineEnd` whether
 * it stopped at the end of the line (or of the text).
 */
function scanAfter(text: string, offset: number): { comma: number | null; restEnd: number; atLineEnd: boolean } {
  let p = offset;
  const blanks = (): void => {
    while (p < text.length && (text[p] === " " || text[p] === "\t")) p += 1;
  };
  blanks();
  // `"a": 1 /* note */,` — the comma may follow a comment on the same line.
  for (let q = p; text.startsWith("/*", q); ) {
    const close = text.indexOf("*/", q + 2);
    if (close === -1 || text.slice(q, close).includes("\n")) break;
    q = close + 2;
    while (q < text.length && (text[q] === " " || text[q] === "\t")) q += 1;
    if (text[q] === ",") {
      p = q;
      break;
    }
  }
  let comma: number | null = null;
  if (text[p] === ",") {
    comma = p;
    p += 1;
  }
  for (;;) {
    blanks();
    if (text.startsWith("//", p)) {
      const nl = text.indexOf("\n", p);
      p = nl === -1 ? text.length : text[nl - 1] === "\r" ? nl - 1 : nl;
      break;
    }
    if (text.startsWith("/*", p)) {
      const close = text.indexOf("*/", p + 2);
      if (close === -1 || text.slice(p, close).includes("\n")) break;
      p = close + 2;
      continue;
    }
    break;
  }
  const atLineEnd = p >= text.length || text[p] === "\n" || text.startsWith("\r\n", p);
  return { comma, restEnd: p, atLineEnd };
}

/** The offset of the next character after `offset` that is neither whitespace nor inside a comment. */
function nextSignificant(text: string, offset: number): number {
  let p = offset;
  for (;;) {
    while (p < text.length && /\s/.test(text[p]!)) p += 1;
    if (text.startsWith("//", p)) {
      const nl = text.indexOf("\n", p);
      p = nl === -1 ? text.length : nl;
    } else if (text.startsWith("/*", p)) {
      const close = text.indexOf("*/", p + 2);
      p = close === -1 ? text.length : close + 2;
    } else {
      return p;
    }
  }
}

/** Past the line break at `offset` (`\n` or `\r\n`); `offset` itself at the end of the text. */
function pastLineBreak(text: string, offset: number): number {
  if (text.startsWith("\r\n", offset)) return offset + 2;
  if (text[offset] === "\n") return offset + 1;
  return offset;
}

/**
 * Removes the object member or array element `target` with its comma. A
 * member alone on its line(s) takes those whole lines (a comment on the same
 * line included); comments on other lines and every other member stay exactly
 * as they are.
 */
function removeNode(text: string, target: Node): string {
  const siblings = target.parent?.children ?? [];
  const index = siblings.indexOf(target);
  const end = target.offset + target.length;
  const start = lineStart(text, target.offset);
  const ownLine = blank(text.slice(start, target.offset));
  const after = scanAfter(text, end);
  const wholeLines = (): TextEdit => ({ offset: start, length: pastLineBreak(text, after.restEnd) - start, content: "" });
  const edits: TextEdit[] = [];
  const next = nextSignificant(text, end);
  if (after.comma === null && text[next] === ",") {
    // Leading-comma layout (`"a": 1` then `, "b": 2`): the separator after it goes too.
    edits.push(ownLine && after.atLineEnd ? wholeLines() : { offset: target.offset, length: target.length, content: "" });
    let stop = next + 1;
    while (text[stop] === " " || text[stop] === "\t") stop += 1;
    edits.push({ offset: next, length: stop - next, content: "" });
  } else if (after.comma !== null) {
    if (ownLine && after.atLineEnd) {
      edits.push(wholeLines());
    } else {
      let stop = after.comma + 1;
      while (text[stop] === " " || text[stop] === "\t") stop += 1;
      edits.push({ offset: target.offset, length: stop - target.offset, content: "" });
    }
  } else if (index > 0) {
    // The last member without a trailing comma: the one before gives up its comma.
    const previous = siblings[index - 1]!;
    const before = scanAfter(text, previous.offset + previous.length);
    if (ownLine && after.atLineEnd && before.comma !== null) {
      edits.push(wholeLines());
      edits.push({ offset: before.comma, length: 1, content: "" });
    } else {
      const from = before.comma ?? previous.offset + previous.length;
      edits.push({ offset: from, length: end - from, content: "" });
    }
  } else if (ownLine && after.atLineEnd) {
    edits.push(wholeLines());
  } else {
    edits.push({ offset: target.offset, length: target.length, content: "" });
  }
  return apply(text, edits);
}

function render(value: unknown, indent: string, eol: string): string {
  return JSON.stringify(value, null, FORMATTING.tabSize).split("\n").join(`${eol}${indent}`);
}

/**
 * Adds a member (`key` set) to an object node, or an element to an array node
 * before `index` (default: at the end), in the layout around it: on a line of
 * its own after the last member's line (whose same-line comment stays with
 * it), or inline. Nothing else in the text moves.
 */
function insertNode(
  text: string,
  path: JSONPath,
  container: Node,
  key: string | null,
  value: unknown,
  index?: number,
  raw?: string
): string {
  const children = container.children ?? [];
  const eol = eolOf(text);
  // `raw`: the value's own text from before (a turned-off entry put back), used as it was.
  const valueText = raw !== undefined && sameValue(raw, value) ? raw : undefined;
  const member = (indent: string, pretty: boolean): string =>
    `${key === null ? "" : `${JSON.stringify(key)}: `}${valueText ?? (pretty ? render(value, indent, eol) : JSON.stringify(value))}`;
  if (children.length === 0) {
    // `{}` / `[]`: jsonc-parser's own insert reformats only this empty container.
    const at = key === null ? [...path, 0] : [...path, key];
    return applyEdits(text, modify(text, at, value, { formattingOptions: FORMATTING, isArrayInsertion: key === null }));
  }
  if (index !== undefined && index < children.length) {
    const next = children[Math.max(0, index)]!;
    const start = lineStart(text, next.offset);
    const indent = text.slice(start, next.offset);
    if (blank(indent)) {
      return apply(text, [{ offset: start, length: 0, content: `${indent}${member(indent, true)},${eol}` }]);
    }
    return apply(text, [{ offset: next.offset, length: 0, content: `${member("", false)}, ` }]);
  }
  const last = children[children.length - 1]!;
  const lastEnd = last.offset + last.length;
  const start = lineStart(text, last.offset);
  const indent = text.slice(start, last.offset);
  const after = scanAfter(text, lastEnd);
  if (blank(indent) && after.atLineEnd) {
    const edits: TextEdit[] = [
      {
        offset: after.restEnd,
        length: 0,
        content: `${eol}${indent}${member(indent, true)}${after.comma !== null ? "," : ""}`
      }
    ];
    if (after.comma === null) {
      edits.push({ offset: lastEnd, length: 0, content: "," });
    }
    return apply(text, edits);
  }
  if (after.comma !== null) {
    return apply(text, [{ offset: after.comma + 1, length: 0, content: ` ${member("", false)},` }]);
  }
  return apply(text, [{ offset: lastEnd, length: 0, content: `, ${member("", false)}` }]);
}

/**
 * Sets (or, with `undefined`, removes) the value at `path`, creating missing
 * parent objects. Only the edited region changes: an existing value is
 * replaced in place, a new member goes after the last one in the same layout,
 * a removed member takes only its own line(s).
 */
export function setJsonc(text: string, path: JSONPath, value: unknown): string {
  const root = treeOf(text);
  assertNoDuplicateOnPath(root, path);
  const node = findNodeAtLocation(root, path);
  if (value === undefined) {
    if (node === undefined || path.length === 0) return text;
    return removeNode(text, node.parent?.type === "property" ? node.parent : node);
  }
  if (node !== undefined) {
    return applyEdits(text, modify(text, path, value, { formattingOptions: FORMATTING }));
  }
  // The deepest ancestor that exists gets the missing part as one new member.
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const parentPath = path.slice(0, depth);
    const parent = depth === 0 ? root : findNodeAtLocation(root, parentPath);
    if (parent === undefined) continue;
    const key = path[depth];
    const rest = path.slice(depth + 1);
    if (parent.type !== "object" || typeof key !== "string" || rest.some((segment) => typeof segment !== "string")) {
      break;
    }
    let nested: unknown = value;
    for (const segment of [...rest].reverse()) {
      nested = { [segment as string]: nested };
    }
    return insertNode(text, parentPath, parent, key, nested);
  }
  return applyEdits(text, modify(text, path, value, { formattingOptions: FORMATTING }));
}

/** Inserts `value` into the array at `path` before `index` (`index` = length appends); creates the array if missing. */
export function insertJsoncArrayItem(text: string, path: JSONPath, index: number, value: unknown, raw?: string): string {
  const root = treeOf(text);
  assertNoDuplicateOnPath(root, path);
  const array = findNodeAtLocation(root, path);
  if (array === undefined) {
    return setJsonc(text, path, [value]);
  }
  if (array.type !== "array") {
    throw new Error(`${path.join(".")} is not a list`);
  }
  return insertNode(text, path, array, null, value, index, raw);
}

/**
 * Adds `key` to the object at `path` before its `index`-th member (past the
 * end appends); creates the object when missing. `raw` is the value's former
 * text, reused when it still reads as `value`. The key must not exist yet.
 */
export function insertJsoncMember(text: string, path: JSONPath, key: string, index: number, value: unknown, raw?: string): string {
  const root = treeOf(text);
  assertNoDuplicateOnPath(root, path);
  const object = findNodeAtLocation(root, path);
  if (object === undefined) {
    return setJsonc(text, [...path, key], value);
  }
  if (object.type !== "object") {
    throw new Error(`${path.join(".")} is not an object`);
  }
  return insertNode(text, path, object, key, value, index, raw);
}

/** The text of the value at `path` as it is written; `undefined` when there is none. */
export function jsoncValueText(text: string, path: JSONPath): string | undefined {
  const node = findNodeAtLocation(treeOf(text), path);
  return node === undefined ? undefined : text.slice(node.offset, node.offset + node.length);
}

function sameValue(raw: string, value: unknown): boolean {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 && deepEqual(parsed, value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Rewrites the object at `path` from `before` to `after` with the fewest
 * edits: keys whose value did not change are not touched (their comments
 * survive), removed keys are deleted, changed keys are replaced, and nested
 * objects on both sides are diffed the same way. New keys are appended.
 */
export function replaceJsoncObject(text: string, path: JSONPath, before: unknown, after: JsonObject): string {
  if (!isJsonObject(before)) {
    return setJsonc(text, path, after);
  }
  let next = text;
  for (const key of Object.keys(before)) {
    if (!(key in after) || after[key] === undefined) {
      next = setJsonc(next, [...path, key], undefined);
    }
  }
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) {
      continue;
    }
    const old = before[key];
    if (deepEqual(old, value)) {
      continue;
    }
    if (isJsonObject(old) && isJsonObject(value)) {
      next = replaceJsoncObject(next, [...path, key], old, value);
    } else {
      next = setJsonc(next, [...path, key], value);
    }
  }
  return next;
}
