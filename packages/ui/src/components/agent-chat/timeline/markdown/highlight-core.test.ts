import assert from "node:assert/strict";
import { test } from "node:test";
import type { Parser } from "@lezer/common";
import { createIncrementalTreeHighlighter, highlightCode, type HighlightedLine } from "./highlight-core";
import { loadLanguageParser } from "./languages";

function text(lines: readonly HighlightedLine[]): string {
  return lines.map((line) => line.map((token) => token.text).join("")).join("\n");
}

test("highlighting preserves source bytes across styled, empty and trailing lines", async () => {
  const parser = await loadLanguageParser("javascript");
  assert.ok(parser);
  for (const code of ['const x = "hi";\nconst y = 2;\n', 'const text = `one\ntwo`;\n', "a\n\nb\n"]) {
    assert.equal(text(highlightCode(code, parser)), code);
  }
});

test("an oversized block preserves the source without running the grammar", () => {
  let calls = 0;
  const parser = { parse: () => { calls += 1; throw new Error("must not parse"); } } as unknown as Parser;
  const code = "x".repeat(120_001);
  assert.equal(text(highlightCode(code, parser)), code);
  assert.equal(text(createIncrementalTreeHighlighter(parser)(code)), code);
  assert.equal(calls, 0);
});

test("a grammar failure preserves the source instead of killing the row", () => {
  const parser = { parse: () => { throw new Error("grammar failed"); } } as unknown as Parser;
  assert.equal(text(highlightCode("a\nb\n", parser)), "a\nb\n");
  assert.equal(text(createIncrementalTreeHighlighter(parser)("a\nb\n")), "a\nb\n");
});

test("an unknown grammar preserves the source", () => {
  assert.equal(text(highlightCode("a\n\nb\n", null)), "a\n\nb\n");
});
