/**
 * Automated workflows — the JSON tree viewer's rules (a block's input, output
 * and error detail in the run view, workflows spec §7.3): what kind a value
 * is, its one-line preview, its children one page at a time, the expression
 * path of a child (`nodes.Review.output.items[0]["a key"]` — the `{{…}}`
 * grammar of §3.3, so a copied path pastes straight into a prompt), and the
 * text a copy puts on the clipboard.
 *
 * Every function is bounded: a preview reads a few keys, a page reads its own
 * children, so a 16 MiB output costs what is on screen, not its size.
 */

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null" | "undefined" | "other";

export function jsonKind(value: unknown): JsonKind {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "other";
  }
}

/** Objects and arrays open; everything else is a leaf. */
export function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  const kind = jsonKind(value);
  return kind === "object" || kind === "array";
}

/** How many children a container has (0 for a leaf). */
export function jsonChildCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (jsonKind(value) === "object") return Object.keys(value as object).length;
  return 0;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** One step of a path: `.key`, `["odd key"]` or `[3]`. */
function jsonPathSegment(key: string | number): string {
  if (typeof key === "number") return `[${key}]`;
  return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** `parent` extended by `key`; a root path of "" starts bare (`items[0]`, not `.items[0]`). */
function jsonChildPath(parent: string, key: string | number): string {
  const segment = jsonPathSegment(key);
  if (parent === "" && segment.startsWith(".")) return segment.slice(1);
  return `${parent}${segment}`;
}

export interface JsonEntry {
  key: string | number;
  path: string;
  value: unknown;
}

/** Children `[offset, offset + limit)` of a container, with their paths. */
export function jsonChildren(value: unknown, path: string, offset = 0, limit = 100): JsonEntry[] {
  const start = Math.max(0, Math.floor(offset));
  const end = start + Math.max(0, Math.floor(limit));
  if (Array.isArray(value)) {
    const out: JsonEntry[] = [];
    for (let index = start; index < Math.min(end, value.length); index += 1) {
      out.push({ key: index, path: jsonChildPath(path, index), value: value[index] });
    }
    return out;
  }
  if (jsonKind(value) === "object") {
    const keys = Object.keys(value as object).slice(start, end);
    return keys.map((key) => ({ key, path: jsonChildPath(path, key), value: (value as Record<string, unknown>)[key] }));
  }
  return [];
}

/** A string for a preview: quoted, one line, cut at `max` characters. */
export function previewString(text: string, max = 80): string {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ");
  const cut = flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
  return JSON.stringify(cut).replace(/\\"/g, '"');
}

/**
 * A value in one short line: `"text"`, `42`, `true`, `null`, `{3 keys}`,
 * `[12 items]`, `{ a, b, c, … }` when there is room for key names.
 */
export function jsonPreview(value: unknown, max = 80): string {
  switch (jsonKind(value)) {
    case "string":
      return previewString(value as string, max);
    case "number":
    case "boolean":
      return String(value);
    case "null":
      return "null";
    case "undefined":
      return "—";
    case "array": {
      const length = (value as unknown[]).length;
      return length === 0 ? "[]" : `[${length} ${length === 1 ? "item" : "items"}]`;
    }
    case "object": {
      const keys: string[] = [];
      let count = 0;
      for (const key in value as object) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        count += 1;
        if (keys.length < 6) keys.push(key);
        if (count > 200) break;
      }
      if (count === 0) return "{}";
      const total = count > 200 ? Object.keys(value as object).length : count;
      const names = keys.join(", ");
      const more = total > keys.length ? ", …" : "";
      const text = `{ ${names}${more} }`;
      return text.length <= max ? text : `{${total} ${total === 1 ? "key" : "keys"}}`;
    }
    default:
      return String(value);
  }
}

/** What "Copy value" puts on the clipboard: a string as-is, anything else as pretty JSON. */
export function jsonCopyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Open by default: the root and — when small — its first level. */
export function jsonDefaultExpanded(depth: number, value: unknown, maxDepth = 1): boolean {
  if (!isJsonContainer(value)) return false;
  if (depth === 0) return true;
  return depth <= maxDepth && jsonChildCount(value) <= 20;
}

/** Strings longer than this show their head and a "Show all" (a 2 MiB agent reply must not freeze the view). */
export const JSON_STRING_CLIP = 2_000;

/** A long string's head for display, and whether it was cut. */
export function clipString(text: string, max = JSON_STRING_CLIP): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  return { text: text.slice(0, max), clipped: true };
}
