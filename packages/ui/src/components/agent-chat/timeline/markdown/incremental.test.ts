import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createIncrementalMarkdownParser,
  createIncrementalMarkdownPlugin,
  hasDefinitions,
  shiftPositions,
  type MdNode,
  type MdRoot
} from "./incremental";

/**
 * A deterministic stand-in for remark's block parser.
 *
 * `remark-parse` is bundled inside `react-markdown` and is not importable
 * here, and the thing under test is the *cache*, not remark. This splits on
 * blank lines, marks a block that opens with a fence as `code` and stamps real
 * offsets and line numbers, which is everything the boundary scan reads.
 */
function blockParser(source: string): MdRoot {
  const children: MdNode[] = [];
  // Anchored on a non-space so a block never absorbs the blank line before it.
  const blockRe = /[^\s][^\n]*(?:\n(?!\s*\n)[^\n]*)*/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(source)) !== null) {
    const text = match[0];
    if (blockRe.lastIndex === match.index) blockRe.lastIndex += 1;
    if (text.trim().length === 0) continue;
    const start = match.index;
    const end = start + text.length;
    const startLine = source.slice(0, start).split("\n").length;
    const endLine = source.slice(0, end).split("\n").length;
    const type = /^ {0,3}(?:`{3,}|~{3,})/.test(text)
      ? "code"
      : /^\[[^\]]+\]:\s/.test(text)
        ? "definition"
        : "paragraph";
    children.push({
      type,
      position: {
        start: { line: startLine, column: 1, offset: start },
        end: { line: endLine, column: text.length + 1, offset: end }
      },
      children: []
    });
  }
  return { type: "root", children, position: undefined };
}

function instrumented(): { parse: (source: string, file: unknown) => MdRoot; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    parse: (source: string) => {
      calls.push(source);
      return blockParser(source);
    }
  };
}

const CLOSED_FENCE = "```ts\nconst a = 1;\n```\n\n";

test("the first parse sees the whole document", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  const source = `${CLOSED_FENCE}tail`;
  const root = incremental(source, null);
  assert.deepEqual(calls, [source]);
  assert.deepEqual(
    root.children.map((child) => child.type),
    ["code", "paragraph"]
  );
});

test("a growing suffix re-parses only past the last closed fence", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental(`${CLOSED_FENCE}tail`, null);
  calls.length = 0;
  const root = incremental(`${CLOSED_FENCE}tail and more`, null);
  assert.deepEqual(calls, ["tail and more"]);
  // The cached prefix is prepended, so the projection is still the whole doc.
  assert.deepEqual(
    root.children.map((child) => child.type),
    ["code", "paragraph"]
  );
});

test("suffix nodes are re-based onto document coordinates", () => {
  const { parse } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental(`${CLOSED_FENCE}tail`, null);
  const root = incremental(`${CLOSED_FENCE}tail and more`, null);
  const full = blockParser(`${CLOSED_FENCE}tail and more`);
  assert.deepEqual(
    root.children.map((child) => child.position?.start.offset),
    full.children.map((child) => child.position?.start.offset)
  );
  assert.deepEqual(
    root.children.map((child) => child.position?.start.line),
    full.children.map((child) => child.position?.start.line)
  );
});

test("the cached prefix is cloned, so a mutating transform cannot poison it", () => {
  const { parse } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental(`${CLOSED_FENCE}tail`, null);
  const first = incremental(`${CLOSED_FENCE}tail a`, null);
  const codeNode = first.children[0];
  assert.ok(codeNode);
  codeNode.type = "MUTATED";
  const second = incremental(`${CLOSED_FENCE}tail ab`, null);
  assert.equal(second.children[0]?.type, "code");
});

test("a text that no longer shares the cached prefix falls back to a full parse", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental(`${CLOSED_FENCE}tail`, null);
  calls.length = 0;
  incremental("completely different", null);
  assert.deepEqual(calls, ["completely different"]);
});

test("an unclosed fence is not a boundary", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental("```ts\nconst a = 1;\n\nmore", null);
  calls.length = 0;
  incremental("```ts\nconst a = 1;\n\nmore text", null);
  assert.deepEqual(calls, ["```ts\nconst a = 1;\n\nmore text"]);
});

test("a closed fence with no blank line after it is not a boundary", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental("```ts\nconst a = 1;\n```\ntail", null);
  calls.length = 0;
  incremental("```ts\nconst a = 1;\n```\ntail!", null);
  assert.deepEqual(calls, ["```ts\nconst a = 1;\n```\ntail!"]);
});

test("a tilde fence is a boundary too, and a shorter closer is not", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  const tilde = "~~~~py\nx = 1\n~~~~\n\n";
  incremental(`${tilde}tail`, null);
  calls.length = 0;
  incremental(`${tilde}tail!`, null);
  assert.deepEqual(calls, ["tail!"]);

  const { parse: parse2, calls: calls2 } = instrumented();
  const incremental2 = createIncrementalMarkdownParser(parse2);
  const short = "~~~~py\nx = 1\n~~~\n\n";
  incremental2(`${short}tail`, null);
  calls2.length = 0;
  incremental2(`${short}tail!`, null);
  assert.deepEqual(calls2, [`${short}tail!`]);
});

test("a bare CR bails out — a streamed CR can become half a CRLF", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental(`${CLOSED_FENCE}tail`, null);
  calls.length = 0;
  const withCr = `${CLOSED_FENCE}tail\r`;
  incremental(withCr, null);
  assert.deepEqual(calls, [withCr]);
});

test("a BOM bails out", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental(`${CLOSED_FENCE}tail`, null);
  calls.length = 0;
  const withBom = `${CLOSED_FENCE}tail﻿x`;
  incremental(withBom, null);
  assert.deepEqual(calls, [withBom]);
});

test("a definition anywhere forces a full parse and arms no cache", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  const withDefinition = `${CLOSED_FENCE}[ref]: https://example.com\n\ntail`;
  incremental(withDefinition, null);
  assert.deepEqual(calls, [withDefinition]);
  calls.length = 0;
  incremental(`${withDefinition} more`, null);
  assert.deepEqual(calls, [`${withDefinition} more`]);
});

test("a definition arriving in the SUFFIX re-parses the whole document", () => {
  const { parse, calls } = instrumented();
  const incremental = createIncrementalMarkdownParser(parse);
  incremental(`${CLOSED_FENCE}tail`, null);
  calls.length = 0;
  const grown = `${CLOSED_FENCE}tail\n\n[ref]: https://example.com`;
  const root = incremental(grown, null);
  assert.deepEqual(calls, ["tail\n\n[ref]: https://example.com", grown]);
  assert.deepEqual(
    root.children.map((child) => child.type),
    ["code", "paragraph", "definition"]
  );
});

test("hasDefinitions walks children", () => {
  assert.ok(hasDefinitions({ type: "root", children: [{ type: "definition" }] }));
  assert.ok(
    hasDefinitions({ type: "root", children: [{ type: "list", children: [{ type: "footnoteDefinition" }] }] })
  );
  assert.ok(!hasDefinitions({ type: "root", children: [{ type: "paragraph" }] }));
});

test("shiftPositions moves offsets and lines on the whole subtree", () => {
  const node: MdNode = {
    type: "paragraph",
    position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 4, offset: 3 } },
    children: [
      {
        type: "text",
        position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 4, offset: 3 } }
      }
    ]
  };
  shiftPositions(node, 10, 2);
  assert.equal(node.position?.start.offset, 10);
  assert.equal(node.position?.start.line, 3);
  assert.equal(node.children?.[0]?.position?.end.offset, 13);
});

test("the plugin only routes a processor's FIRST parse through the cache", () => {
  const { parse, calls } = instrumented();
  const plugin = createIncrementalMarkdownPlugin();
  const processor: { parser?: (source: string, file: unknown) => MdRoot } = { parser: parse };
  plugin.call(processor);
  const wrapped = processor.parser;
  assert.ok(wrapped);
  wrapped(`${CLOSED_FENCE}tail`, null);
  calls.length = 0;
  // A transform's synthetic parse on the same processor must bypass the cache.
  wrapped("synthetic recovery text", null);
  assert.deepEqual(calls, ["synthetic recovery text"]);

  // A fresh processor (next render) reuses the same cache.
  const next: { parser?: (source: string, file: unknown) => MdRoot } = { parser: parse };
  plugin.call(next);
  calls.length = 0;
  next.parser?.(`${CLOSED_FENCE}tail!`, null);
  assert.deepEqual(calls, ["tail!"]);
});

test("the plugin is a no-op when no parser is installed", () => {
  const plugin = createIncrementalMarkdownPlugin();
  const processor: { parser?: (source: string, file: unknown) => MdRoot } = {};
  plugin.call(processor);
  assert.equal(processor.parser, undefined);
});
