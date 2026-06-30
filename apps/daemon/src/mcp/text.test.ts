import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, trimTrailingBlankLines, tailLines, cap, renderText, SCREEN_ROWS, MAX_TEXT } from "./text.ts";

test("stripAnsi removes CSI, private CSI, and OSC", () => {
  assert.equal(stripAnsi("a\x1b[31mb\x1b[0mc"), "abc");
  assert.equal(stripAnsi("x\x1b[?25ly"), "xy");                 // private param
  assert.equal(stripAnsi("t\x1b]0;title\x07u"), "tu");          // OSC (BEL)
  assert.equal(stripAnsi("t\x1b]0;title\x1b\\u"), "tu");        // OSC (ST)
});

test("trimTrailingBlankLines drops trailing empty/whitespace lines only", () => {
  assert.equal(trimTrailingBlankLines("a\nb\n\n  \n"), "a\nb");
  assert.equal(trimTrailingBlankLines("a\n\nb"), "a\n\nb");     // internal blanks kept
});

test("tailLines keeps the last N lines; <=0 returns all", () => {
  assert.equal(tailLines("1\n2\n3\n4", 2), "3\n4");
  assert.equal(tailLines("1\n2", 5), "1\n2");
  assert.equal(tailLines("1\n2\n3", 0), "1\n2\n3");
});

test("cap keeps the tail and prefixes a marker when over the limit", () => {
  const big = "x".repeat(MAX_TEXT + 100);
  const out = cap(big);
  assert.ok(out.startsWith("…[truncated]"));
  assert.ok(out.length < big.length);
  assert.equal(cap("short"), "short");
});

test("renderText prefers the capture; falls back to stripped, bounded ring", () => {
  assert.equal(renderText("clean screen", "ignored", {}), "clean screen");
  // empty capture (exited tmux pane) → strip + tail the ring
  const ring = Array.from({ length: SCREEN_ROWS + 5 }, (_, i) => `line${i}`).join("\n");
  const out = renderText("", `\x1b[32m${ring}\x1b[0m`, {});
  assert.ok(!out.includes("\x1b"));
  assert.equal(out.split("\n").length, SCREEN_ROWS);            // default bound
  assert.equal(renderText("", "1\n2\n3\n4", { lines: 2 }), "3\n4");
});
