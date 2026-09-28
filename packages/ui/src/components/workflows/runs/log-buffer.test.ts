import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appendLog, EMPTY_LOG, visibleLogLines } from "./log-buffer.ts";

const ESC = "\u001b";

// Failure modes: terminal controls leak into output, split chunks lose text,
// CR progress is duplicated, or an unbounded log consumes the viewer's memory.
describe("the log buffer", () => {
  it("drops colours, cursor moves, OSC titles and links", () => {
    const state = appendLog(EMPTY_LOG, [
      `${ESC}[1;32mok${ESC}[0m done`,
      `${ESC}[2K${ESC}[1Gprogress`,
      `${ESC}]0;title${ESC}\\text`,
      `${ESC}]8;;https://x.dev\u0007link${ESC}]8;;\u0007`,
      `${ESC}(Bplain`,
      "a\u0007b\u0000c",
      "tabs\tand",
      "nothing to do"
    ].join("\n"));
    assert.deepEqual(visibleLogLines(state), ["ok done", "progress", "text", "link", "plain", "abc", "tabs\tand", "nothing to do"]);
  });

  it("carries an escape sequence split across chunks", () => {
    let state = appendLog(EMPTY_LOG, `${ESC}[3`);
    state = appendLog(state, `1mred${ESC}[0m\n`);
    assert.deepEqual(visibleLogLines(state), ["red"]);
  });

  it("keeps what a terminal would show", () => {
    let state = appendLog(EMPTY_LOG, "10%\r");
    state = appendLog(state, "60%\r");
    assert.deepEqual(visibleLogLines(state), ["60%"]);
    state = appendLog(state, "100%\nnext\r\n");
    assert.deepEqual(visibleLogLines(state), ["100%", "next"]);
  });

  it("splits chunks into lines and keeps the line in progress", () => {
    let state = appendLog(EMPTY_LOG, "one\ntw");
    assert.deepEqual(visibleLogLines(state), ["one", "tw"]);
    state = appendLog(state, "o\nthree\n");
    assert.deepEqual(visibleLogLines(state), ["one", "two", "three"]);
  });

  it("caps the lines it keeps and counts the ones it dropped", () => {
    const text = Array.from({ length: 5_015 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const state = appendLog(EMPTY_LOG, text);
    const lines = visibleLogLines(state);
    assert.equal(lines.length, 5_000);
    assert.equal(lines[0], "line 16");
    assert.equal(lines.at(-1), "line 5015");
    assert.equal(state.dropped, 15);
    const partial = appendLog(state, "tail");
    assert.equal(visibleLogLines(partial).length, 5_000);
    assert.equal(visibleLogLines(partial).at(-1), "tail");
    assert.equal(partial.dropped, 16);
  });

  it("clips a huge line", () => {
    const state = appendLog(EMPTY_LOG, `${"x".repeat(100_000)}\n`);
    const line = visibleLogLines(state)[0]!;
    assert.ok(line.startsWith("x".repeat(4_000)));
    assert.ok(line.length < 4_100);
  });
});
