// Ported from T3 Code (MIT): apps/web/src/markdown-incremental.ts

/**
 * The incremental markdown prefix cache (spec §7.3).
 *
 * A streaming assistant message re-parses its whole text on every token. For a
 * long, code-heavy answer that is the single most expensive thing the timeline
 * does. The fix is not a different parser: it is noticing that **a closed
 * top-level fence followed by a blank line is a parsing boundary**. Everything
 * before it can never change again, so it is parsed once, kept as pristine
 * mdast, and only the suffix is re-parsed per token.
 *
 * Three bail-outs are load-bearing:
 *
 *  - a bare `\r` — a streamed CR can become half of a CRLF on the next chunk,
 *    so the boundary would have been computed against text that no longer
 *    exists;
 *  - a BOM — a BOM at the suffix boundary would be stripped by the fresh
 *    parse although it sits *inside* the full document;
 *  - any link or footnote **definition**, which is document-wide: a definition
 *    in the suffix must be visible to references in the prefix and vice versa.
 *
 * Types are structural on purpose. `mdast` and `unified` are transitive
 * dependencies of `react-markdown`, not direct ones, so their type packages are
 * not resolvable from this workspace package; naming the shapes locally keeps
 * the file typechecking without adding a dependency.
 */

export interface MdPoint {
  line: number;
  column: number;
  offset?: number | undefined;
}

export interface MdPosition {
  start: MdPoint;
  end: MdPoint;
}

export interface MdNode {
  type: string;
  position?: MdPosition | undefined;
  children?: MdNode[] | undefined;
}

export interface MdRoot extends MdNode {
  type: "root";
  children: MdNode[];
}

/** What `remark-parse` installs on the processor, structurally. */
export type MarkdownParser = (source: string, file: unknown) => MdRoot;

/** The subset of a unified processor this plugin touches. */
export interface MarkdownProcessorLike {
  parser?: MarkdownParser | undefined;
}

interface ParsedPrefix {
  source: string;
  offset: number;
  line: number;
  children: MdNode[];
}

/** Definitions are document-wide, so their presence forces a full parse. */
export function hasDefinitions(node: MdNode): boolean {
  if (node.type === "definition" || node.type === "footnoteDefinition") return true;
  return node.children?.some((child) => hasDefinitions(child)) ?? false;
}

/** Re-bases a suffix parse onto the document's coordinates. */
export function shiftPositions(node: MdNode, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if (node.children) {
    for (const child of node.children) shiftPositions(child, offset, lines);
  }
}

function cloneNodes(nodes: readonly MdNode[]): MdNode[] {
  // Remark transforms mutate their input: the cache owns pristine nodes and
  // each render receives its own copy, including source positions.
  return structuredClone(nodes) as MdNode[];
}

/**
 * Wraps a parser with the prefix cache. One cache per streaming renderer —
 * the returned function is stateful and must not be shared between messages.
 */
export function createIncrementalMarkdownParser(parse: MarkdownParser): MarkdownParser {
  let cached: ParsedPrefix | undefined;

  return (source, file) => {
    if (source.includes("\r") || source.includes("﻿")) return parse(source, file);

    const prefix = cached && source.startsWith(cached.source) ? cached : undefined;
    let root: MdRoot;
    if (prefix) {
      root = parse(source.slice(prefix.offset), file);
      if (hasDefinitions(root)) return parse(source, file);
      shiftPositions(root, prefix.offset, prefix.line - 1);
      if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
      root.children.unshift(...cloneNodes(prefix.children));
    } else {
      root = parse(source, file);
      if (hasDefinitions(root)) return root;
    }

    for (let index = root.children.length - 1; index >= 0; index -= 1) {
      const node = root.children[index];
      if (node?.type !== "code") continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (prefix && end < prefix.offset) break;
      const value = source.slice(start, end);
      const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(value)?.[1];
      if (opening === undefined) continue;
      const lastLine = value.slice(value.lastIndexOf("\n") + 1);
      const closing = new RegExp(`^ {0,3}${opening[0] as string}{${opening.length},}[ \\t]*$`);
      const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
      if (!closing.test(lastLine) || separator === undefined) continue;
      const offset = end + separator.length;
      cached = {
        source: source.slice(0, offset),
        offset,
        line: (node.position?.end.line ?? 1) + 2,
        children: cloneNodes(root.children.slice(0, index + 1))
      };
      break;
    }
    return root;
  };
}

/**
 * The remark plugin form. `react-markdown` builds a fresh processor per
 * render, and its transforms can parse synthetic text on that same processor
 * afterwards — those parses must not read or replace the document's cache, so
 * only the first parse of each processor goes through the incremental path.
 */
export function createIncrementalMarkdownPlugin(): (this: MarkdownProcessorLike) => void {
  let parser: MarkdownParser | undefined;
  return function incrementalMarkdown(this: MarkdownProcessorLike): void {
    const original = this.parser;
    if (!original) return;
    parser ??= createIncrementalMarkdownParser((source, file) => original(source, file));
    const parseDocument = parser;
    let documentParsed = false;
    this.parser = (source, file) => {
      if (documentParsed) return original(source, file);
      documentParsed = true;
      return parseDocument(source, file);
    };
  };
}
