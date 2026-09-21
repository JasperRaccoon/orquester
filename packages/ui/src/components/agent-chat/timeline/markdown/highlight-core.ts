/**
 * Syntax highlighting for chat code blocks — Lezer, not Shiki (spec §7.3).
 *
 * T3 forces Shiki onto its Oniguruma **WASM** engine, because the JS regex
 * engine can backtrack catastrophically and hang tokenisation. WASM is not an
 * option here: the production SPA's CSP is `script-src 'self'` with no
 * `'wasm-unsafe-eval'`, and `/etc/caddy/Caddyfile` is reconciled by hand, so a
 * WASM highlighter would fail *silently* after a deploy. The Lezer parsers
 * `@codemirror/language-data` already ships are plain JS, incremental, and
 * already in the bundle for the file editor — no new dependency, no CSP
 * change, and an unknown fence name simply renders unhighlighted.
 *
 * This module is the DOM-free half: token model, the incremental parse cache,
 * the size-aware LRU and the fence-name resolver. It imports nothing from
 * `@codemirror/*`, so it runs (and is tested) under plain node.
 */

import { highlightTree, tagHighlighter, tags, type Highlighter } from "@lezer/highlight";
import { TreeFragment, type Parser, type Tree } from "@lezer/common";

// ---------------------------------------------------------------------------
// Token model
// ---------------------------------------------------------------------------

/**
 * One styled run inside a line. `cls` is a **token class name of ours**, never
 * a colour: the row picks the colour from the resolved light/dark palette, so
 * one highlighted document renders correctly in either mode.
 */
export interface HighlightToken {
  text: string;
  cls: TokenClass | null;
}

/** A line is a list of runs. An empty line is an empty list. */
export type HighlightedLine = HighlightToken[];

export type TokenClass =
  | "keyword"
  | "control"
  | "operator"
  | "name"
  | "definition"
  | "type"
  | "property"
  | "number"
  | "string"
  | "regexp"
  | "escape"
  | "comment"
  | "meta"
  | "punctuation"
  | "bracket"
  | "heading"
  | "link"
  | "emphasis"
  | "strong"
  | "invalid";

/**
 * Tag → our token class. Order matters: `@lezer/highlight` resolves the most
 * specific matching rule, so the broad families come last.
 */
export const CHAT_HIGHLIGHTER: Highlighter = tagHighlighter([
  { tag: tags.comment, class: "comment" },
  { tag: tags.lineComment, class: "comment" },
  { tag: tags.blockComment, class: "comment" },
  { tag: tags.docComment, class: "comment" },
  { tag: tags.controlKeyword, class: "control" },
  { tag: tags.moduleKeyword, class: "control" },
  { tag: tags.definitionKeyword, class: "keyword" },
  { tag: tags.operatorKeyword, class: "keyword" },
  { tag: tags.modifier, class: "keyword" },
  { tag: tags.keyword, class: "keyword" },
  { tag: tags.self, class: "keyword" },
  { tag: tags.null, class: "keyword" },
  { tag: tags.atom, class: "keyword" },
  { tag: tags.bool, class: "keyword" },
  { tag: tags.unit, class: "number" },
  { tag: tags.number, class: "number" },
  { tag: tags.integer, class: "number" },
  { tag: tags.float, class: "number" },
  { tag: tags.string, class: "string" },
  { tag: tags.special(tags.string), class: "string" },
  { tag: tags.character, class: "string" },
  { tag: tags.regexp, class: "regexp" },
  { tag: tags.escape, class: "escape" },
  { tag: tags.typeName, class: "type" },
  { tag: tags.namespace, class: "type" },
  { tag: tags.className, class: "type" },
  { tag: tags.labelName, class: "property" },
  { tag: tags.propertyName, class: "property" },
  { tag: tags.attributeName, class: "property" },
  { tag: tags.definition(tags.propertyName), class: "definition" },
  { tag: tags.definition(tags.variableName), class: "definition" },
  { tag: tags.function(tags.variableName), class: "name" },
  { tag: tags.function(tags.propertyName), class: "name" },
  { tag: tags.variableName, class: "name" },
  { tag: tags.tagName, class: "type" },
  { tag: tags.attributeValue, class: "string" },
  { tag: tags.heading, class: "heading" },
  { tag: tags.link, class: "link" },
  { tag: tags.url, class: "link" },
  { tag: tags.emphasis, class: "emphasis" },
  { tag: tags.strong, class: "strong" },
  { tag: tags.meta, class: "meta" },
  { tag: tags.processingInstruction, class: "meta" },
  { tag: tags.annotation, class: "meta" },
  { tag: tags.operator, class: "operator" },
  { tag: tags.derefOperator, class: "operator" },
  { tag: tags.compareOperator, class: "operator" },
  { tag: tags.logicOperator, class: "operator" },
  { tag: tags.arithmeticOperator, class: "operator" },
  { tag: tags.bracket, class: "bracket" },
  { tag: tags.paren, class: "bracket" },
  { tag: tags.brace, class: "bracket" },
  { tag: tags.squareBracket, class: "bracket" },
  { tag: tags.angleBracket, class: "bracket" },
  { tag: tags.punctuation, class: "punctuation" },
  { tag: tags.separator, class: "punctuation" },
  { tag: tags.invalid, class: "invalid" }
]);

const KNOWN_TOKEN_CLASSES = new Set<string>([
  "keyword",
  "control",
  "operator",
  "name",
  "definition",
  "type",
  "property",
  "number",
  "string",
  "regexp",
  "escape",
  "comment",
  "meta",
  "punctuation",
  "bracket",
  "heading",
  "link",
  "emphasis",
  "strong",
  "invalid"
]);

/**
 * `highlightTree` hands back a space-separated class list when several rules
 * matched. Take the first one we know; an unknown list renders unstyled rather
 * than throwing, because this reads grammars from twenty language packages.
 */
export function pickTokenClass(classes: string): TokenClass | null {
  for (const candidate of classes.split(/\s+/)) {
    if (KNOWN_TOKEN_CLASSES.has(candidate)) return candidate as TokenClass;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Splitting a highlighted document into lines
// ---------------------------------------------------------------------------

/** Splits the text into lines, with no parser involved. */
export function plainLines(code: string): HighlightedLine[] {
  return code.split("\n").map((line) => (line.length > 0 ? [{ text: line, cls: null }] : []));
}

/**
 * Cuts a `[from, to)` styled run across line boundaries and appends it.
 *
 * Lines are the unit of DOM identity while a message streams (§7.3): appending
 * a line must never rebuild the lines above it, or the browser re-parses and
 * re-styles thousands of unchanged token spans on every chunk — and the user's
 * text selection dies with them.
 */
function pushRun(lines: HighlightedLine[], code: string, from: number, to: number, cls: TokenClass | null): void {
  let start = from;
  while (start < to) {
    const newline = code.indexOf("\n", start);
    const end = newline === -1 || newline >= to ? to : newline;
    if (end > start) {
      const line = lines[lines.length - 1] as HighlightedLine;
      line.push({ text: code.slice(start, end), cls });
    }
    if (end === to) break;
    lines.push([]);
    start = end + 1;
  }
}

/**
 * Walks a parsed tree into per-line token runs. Everything the highlighter did
 * not claim is emitted as an unstyled run, so the concatenation of every run is
 * always exactly the input — the invariant the tests assert.
 */
export function treeToLines(code: string, tree: Tree): HighlightedLine[] {
  const lines: HighlightedLine[] = [[]];
  let cursor = 0;
  highlightTree(tree, CHAT_HIGHLIGHTER, (from, to, classes) => {
    if (from > cursor) pushRun(lines, code, cursor, from, null);
    pushRun(lines, code, from, to, pickTokenClass(classes));
    cursor = to;
  });
  if (cursor < code.length) pushRun(lines, code, cursor, code.length, null);
  return lines;
}

// ---------------------------------------------------------------------------
// The incremental parse cache
// ---------------------------------------------------------------------------

/**
 * Beyond this, a code block renders unhighlighted. A streaming message
 * re-parses on every chunk; a multi-hundred-kilobyte paste is a log dump, not
 * code, and highlighting it would dominate the frame budget for no benefit.
 */
export const MAX_HIGHLIGHT_CHARS = 120_000;

/**
 * A per-block incremental highlighter.
 *
 * A streaming code block grows by appending, which is the ideal case for
 * Lezer's fragment reuse: the previous tree is handed back as a fragment set
 * with the append described as a change, so the parser only re-parses the tail
 * (plus whatever context the grammar needs). A text that stops sharing the
 * cached prefix — an edit, a different block — drops the cache and re-parses.
 */
export function createIncrementalTreeHighlighter(
  parser: Parser
): (code: string) => HighlightedLine[] {
  let cachedText: string | null = null;
  let cachedTree: Tree | null = null;

  return (code: string) => {
    if (code.length > MAX_HIGHLIGHT_CHARS) {
      cachedText = null;
      cachedTree = null;
      return plainLines(code);
    }
    let tree: Tree;
    try {
      if (cachedText !== null && cachedTree !== null && code.startsWith(cachedText)) {
        const fragments = TreeFragment.applyChanges(TreeFragment.addTree(cachedTree), [
          {
            fromA: cachedText.length,
            toA: cachedText.length,
            fromB: cachedText.length,
            toB: code.length
          }
        ]);
        tree = parser.parse(code, fragments);
      } else {
        tree = parser.parse(code);
      }
    } catch {
      // A grammar that throws must shrink the output, never kill the row.
      cachedText = null;
      cachedTree = null;
      return plainLines(code);
    }
    cachedText = code;
    cachedTree = tree;
    return treeToLines(code, tree);
  };
}

/** One-shot highlight, for a settled block with no streaming history. */
export function highlightCode(code: string, parser: Parser | null): HighlightedLine[] {
  if (parser === null || code.length > MAX_HIGHLIGHT_CHARS) return plainLines(code);
  try {
    return treeToLines(code, parser.parse(code));
  } catch {
    return plainLines(code);
  }
}

// ---------------------------------------------------------------------------
// The settled-result LRU
// ---------------------------------------------------------------------------

// Ported from T3 Code (MIT): apps/web/src/lib/lruCache.ts

/** Size-aware LRU. `set` of an oversized value is a no-op, never an eviction storm. */
export class SizedLruCache<T> {
  private readonly entries = new Map<string, { value: T; size: number }>();
  private totalSize = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalSize;
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, size: number): void {
    if (size > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing) {
      this.totalSize -= existing.size;
      this.entries.delete(key);
    }
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries || this.totalSize + size > this.maxBytes)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.totalSize -= this.entries.get(oldest)?.size ?? 0;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, size });
    this.totalSize += size;
  }

  clear(): void {
    this.entries.clear();
    this.totalSize = 0;
  }
}

/** T3's numbers: 500 entries / 50 MB. *T3: `ChatMarkdown.tsx:338-339`.* */
export const HIGHLIGHT_CACHE_MAX_ENTRIES = 500;
export const HIGHLIGHT_CACHE_MAX_BYTES = 50 * 1024 * 1024;

export const highlightCache = new SizedLruCache<HighlightedLine[]>(
  HIGHLIGHT_CACHE_MAX_ENTRIES,
  HIGHLIGHT_CACHE_MAX_BYTES
);

/** FNV-1a, 32-bit. A hash plus the length keeps the key short and collision-shy. */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function highlightCacheKey(code: string, language: string, mode: "light" | "dark"): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${mode}`;
}

/** Rough retained size of a highlighted document: two bytes per source char per run overhead. */
export function estimateHighlightSize(code: string, lines: readonly HighlightedLine[]): number {
  let runs = 0;
  for (const line of lines) runs += line.length;
  return code.length * 2 + runs * 48;
}

// ---------------------------------------------------------------------------
// Fence-name resolution
// ---------------------------------------------------------------------------

/** The subset of `@codemirror/language`'s `LanguageDescription` this reads. */
export interface LanguageEntry {
  name: string;
  alias?: readonly string[] | undefined;
  extensions?: readonly string[] | undefined;
}

/**
 * Extra fence spellings agent CLIs emit that `@codemirror/language-data` does
 * not list as an alias. Checked before the table, so an entry here always wins.
 */
const FENCE_ALIASES: Record<string, string> = {
  sh: "shell",
  zsh: "shell",
  bash: "shell",
  shell: "shell",
  console: "shell",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  "c++": "c++",
  h: "c++",
  hpp: "c++",
  cc: "c++",
  golang: "go",
  dockerfile: "dockerfile",
  "objective-c": "objective-c",
  htm: "html"
};

/**
 * Resolves a fence's info string to a language entry.
 *
 * The info string may carry more than a name (` ```ts title="a.ts" `), so only
 * the first whitespace-delimited word is considered. An unknown name resolves
 * to `null` and the block renders unhighlighted — which is a supported outcome,
 * not a failure.
 */
export function resolveLanguageEntry<T extends LanguageEntry>(
  info: string | undefined,
  entries: readonly T[]
): T | null {
  const name = (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (name.length === 0) return null;
  const canonical = FENCE_ALIASES[name] ?? name;
  for (const entry of entries) {
    if (entry.name.toLowerCase() === canonical) return entry;
  }
  for (const entry of entries) {
    if (entry.alias?.some((alias) => alias.toLowerCase() === canonical) === true) return entry;
  }
  for (const entry of entries) {
    if (entry.extensions?.some((extension) => extension.toLowerCase() === canonical) === true) {
      return entry;
    }
  }
  return null;
}

/** The label shown in the code-block header: the fence's own word, trimmed. */
export function fenceLanguageLabel(info: string | undefined): string {
  return (info ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Pulls `language-xxx` out of react-markdown's `<code className>`. */
export function extractFenceLanguage(className: string | undefined): string {
  return /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1] ?? "";
}
