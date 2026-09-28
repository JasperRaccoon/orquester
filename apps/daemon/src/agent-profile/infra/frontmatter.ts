/**
 * Agent profile — YAML frontmatter of the markdown items every agent shares
 * (`SKILL.md`, commands). A document is an optional `---` block of YAML
 * mapping at the very top, then the body:
 *
 *     ---
 *     name: review
 *     description: "Review: the current diff"
 *     ---
 *     Body text…
 *
 * Parsing is byte-faithful for the body (its line endings and leading blank
 * lines are kept), so parse → serialize of an unchanged document only
 * normalizes the YAML block. Frontmatter is validated before any write
 * (spec §4.5: OpenCode loses its whole config over a bad command frontmatter).
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface MarkdownDocument {
  /** The YAML mapping; `{}` when there is none or it is empty. */
  frontmatter: Record<string, unknown>;
  body: string;
  /** Whether the text opened with a (possibly empty) `---` block. */
  hadFrontmatter: boolean;
}

const BOM = "﻿";
/** The opening fence: `---` alone on the first line. */
const OPEN_RE = /^---[ \t]*\r?\n/;
/** A closing fence line: `---` alone, then a line ending or the end of the text. */
const CLOSE_RE = /^---[ \t]*(?:\r?\n|$)/m;

/**
 * Splits `text` into frontmatter and body. A leading BOM is dropped; CRLF is
 * accepted. An opening `---` with no closing fence is not frontmatter — the
 * whole text is the body. Throws an `Error` naming the problem when the block
 * is not valid YAML or not a mapping (a list, a bare string).
 */
export function parseMarkdownDocument(text: string): MarkdownDocument {
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const open = OPEN_RE.exec(source);
  if (open === null) {
    return { frontmatter: {}, body: source, hadFrontmatter: false };
  }
  const rest = source.slice(open[0].length);
  const close = CLOSE_RE.exec(rest);
  if (close === null) {
    return { frontmatter: {}, body: source, hadFrontmatter: false };
  }
  const block = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  let parsed: unknown;
  try {
    parsed = block.trim().length === 0 ? null : parseYaml(block);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML frontmatter: ${message}`);
  }
  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body, hadFrontmatter: true };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid YAML frontmatter: it must be a mapping of keys to values.");
  }
  return { frontmatter: parsed as Record<string, unknown>, body, hadFrontmatter: true };
}

/**
 * The document text: a `---` block with `frontmatter` in its own key order
 * (values that need quoting are quoted; long strings are never folded), then
 * `body` as it is. An empty frontmatter writes no block — unless the body
 * itself starts with a `---` line, which would read back as a fence, and so
 * gets an empty block in front of it.
 */
export function serializeMarkdownDocument(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter).filter((key) => frontmatter[key] !== undefined);
  if (keys.length === 0) {
    return OPEN_RE.test(body) ? `---\n---\n${body}` : body;
  }
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 });
  return `---\n${yaml}${yaml.endsWith("\n") ? "" : "\n"}---\n${body}`;
}

/**
 * The frontmatter an edit writes (spec: unknown keys on disk survive an
 * edit): `existing` in its order, each key the draft sets overridden in place,
 * new keys appended, keys the draft sets to `null` removed. Keys the draft
 * does not mention (or leaves `undefined`) are kept.
 */
export function mergeFrontmatter(
  existing: Record<string, unknown>,
  draft: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(draft)) {
    if (value === null) {
      delete merged[key];
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
