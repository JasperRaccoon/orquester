import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendLog,
  applyCarriageReturns,
  droppedLinesText,
  EMPTY_LOG,
  formatBytes,
  logFileName,
  splitIncompleteEscape,
  stripAnsi,
  utf8Length,
  visibleLogLines
} from "./log-buffer.ts";

const ESC = "\u001b";

describe("ANSI stripping", () => {
  it("drops colours, cursor moves, OSC titles and links", () => {
    assert.equal(stripAnsi(`${ESC}[1;32mok${ESC}[0m done`), "ok done");
    assert.equal(stripAnsi(`${ESC}[2K${ESC}[1Gprogress`), "progress");
    assert.equal(stripAnsi(`${ESC}]0;title${ESC}\\text`), "text");
    assert.equal(stripAnsi(`${ESC}]8;;https://x.dev\u0007link${ESC}]8;;\u0007`), "link");
    assert.equal(stripAnsi(`${ESC}(Bplain`), "plain");
    assert.equal(stripAnsi("a\u0007b\u0000c"), "abc");
    assert.equal(stripAnsi("tabs\tand\nnewlines\r"), "tabs\tand\nnewlines\r");
    assert.equal(stripAnsi("nothing to do"), "nothing to do");
  });

  it("carries an escape sequence split across chunks", () => {
    assert.deepEqual(splitIncompleteEscape(`red ${ESC}[3`), ["red ", `${ESC}[3`]);
    assert.deepEqual(splitIncompleteEscape(`red ${ESC}[31m`), [`red ${ESC}[31m`, ""]);
    assert.deepEqual(splitIncompleteEscape(`t ${ESC}]0;tit`), ["t ", `${ESC}]0;tit`]);
    assert.deepEqual(splitIncompleteEscape(`end ${ESC}`), ["end ", ESC]);
    assert.deepEqual(splitIncompleteEscape("plain"), ["plain", ""]);
    let state = appendLog(EMPTY_LOG, `${ESC}[3`);
    state = appendLog(state, `1mred${ESC}[0m\n`);
    assert.deepEqual(visibleLogLines(state), ["red"]);
  });
});

describe("carriage returns", () => {
  it("keeps what a terminal would show", () => {
    assert.equal(applyCarriageReturns("10%\r50%\r100%"), "100%");
    assert.equal(applyCarriageReturns("plain"), "plain");
    assert.equal(applyCarriageReturns("done\r"), "done");
    let state = appendLog(EMPTY_LOG, "10%\r");
    state = appendLog(state, "60%\r");
    assert.deepEqual(visibleLogLines(state), ["60%"]);
    state = appendLog(state, "100%\nnext\r\n");
    assert.deepEqual(visibleLogLines(state), ["100%", "next"]);
  });
});

describe("the buffer", () => {
  it("splits chunks into lines and keeps the line in progress", () => {
    let state = appendLog(EMPTY_LOG, "one\ntw");
    assert.deepEqual(state.lines, ["one"]);
    assert.equal(state.partial, "tw");
    assert.deepEqual(visibleLogLines(state), ["one", "tw"]);
    state = appendLog(state, "o\nthree\n");
    assert.deepEqual(visibleLogLines(state), ["one", "two", "three"]);
    assert.equal(appendLog(state, ""), state);
  });

  it("caps the lines it keeps and counts the ones it dropped", () => {
    const text = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const state = appendLog(EMPTY_LOG, text, { maxLines: 10 });
    assert.equal(state.lines.length, 10);
    assert.equal(state.lines[0], "line 16");
    assert.equal(state.dropped, 15);
    assert.equal(droppedLinesText(state.dropped), "15 earlier lines are not shown here.");
    assert.equal(droppedLinesText(1), "1 earlier line is not shown here.");
    assert.equal(droppedLinesText(0), null);
    // With a line in progress, it takes one of the slots.
    const partial = appendLog(state, "tail", { maxLines: 10 });
    assert.equal(visibleLogLines(partial).length, 10);
    assert.equal(partial.dropped, 16);
  });

  it("clips a huge line", () => {
    const state = appendLog(EMPTY_LOG, `${"x".repeat(100)}\n`, { maxLineChars: 20 });
    assert.equal(state.lines[0], `${"x".repeat(20)} … [80 more characters]`);
  });

  it("counts UTF-8 bytes, for resuming a stream", () => {
    assert.equal(utf8Length("héllo"), 6);
    const state = appendLog(appendLog(EMPTY_LOG, "ab\n"), "é\n");
    assert.equal(state.bytes, 6);
  });

  it("formats sizes and file names", () => {
    assert.equal(formatBytes(812), "812 B");
    assert.equal(formatBytes(14_540), "14 KB");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3.1 * 1024 * 1024), "3.1 MB");
    assert.equal(logFileName("Build app", "stderr"), "Build_app-stderr.log");
    assert.equal(logFileName("  ", "stdout"), "block-stdout.log");
  });
});
