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

test("streaming code keeps unchanged highlighted lines by identity", async () => {
  const parser = await loadLanguageParser("javascript");
  assert.ok(parser);
  const highlight = createIncrementalTreeHighlighter(parser);
  const before = highlight("const a = 1;\n\nconst b = 2");
  const after = highlight("const a = 1;\n\nconst b = 23;\n");
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1], "empty unchanged lines are stable too");
  assert.notEqual(after[2], before[2]);
  assert.deepEqual(after, highlightCode("const a = 1;\n\nconst b = 23;\n", parser));
});

test("appended delimiters may change the preceding line's token classes", async () => {
  const parser = await loadLanguageParser("javascript");
  assert.ok(parser);
  const highlight = createIncrementalTreeHighlighter(parser);
  const before = highlight("const a = 1;\n/");
  const code = "const a = 1;\n/* comment\ncontinued */";
  const after = highlight(code);
  assert.equal(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  assert.equal(after[1]?.[0]?.cls, "comment");
  assert.deepEqual(after, highlightCode(code, parser));
});

test("incremental results match a fresh highlight through syntax changes and edits", async () => {
  const parser = await loadLanguageParser("javascript");
  assert.ok(parser);
  const highlight = createIncrementalTreeHighlighter(parser);
  for (const code of [
    "const a = 1;\nconst text = `one\n",
    "const a = 1;\nconst text = `one\n${",
    "const a = 1;\nconst text = `one\n${a}\ntwo`;\n",
    "/* const a = 1;\nconst text = `one\n${a}\ntwo`;\n */",
    "const a = 2;\nconst b = 3;\n",
    "const a = 2;\nconst b = 3;\n"
  ]) {
    assert.deepEqual(highlight(code), highlightCode(code, parser));
  }
});
