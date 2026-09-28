import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitBufferedText } from "./text-boundary.ts";

describe("splitBufferedText (§5.6 'a flush never splits a code block')", () => {

  it("a fence indented past a list marker still opens and closes", () => {
    const split = splitBufferedText("- item\n  ```\n  code\n  ```\nafter");
    assert.equal(split.openFence, false);
    assert.ok(split.ready.endsWith("  ```\n"));
  });

  it("a closing fence with an info string does not close the block", () => {
    const split = splitBufferedText("```\ncode\n```ts\nmore\n");
    assert.equal(split.openFence, true);
  });

  it("a tight list breaks on each item start, including the partial last line", () => {
    const split = splitBufferedText("intro\n- one\n- two");
    assert.equal(split.ready, "intro\n- one\n");
    assert.equal(split.rest, "- two");
  });

  it("a no-break space is paragraph content, not a blank line", () => {
    const split = splitBufferedText("one\n \ntwo\n");
    assert.equal(split.ready, "");
    assert.equal(split.rest, "one\n \ntwo\n");
  });
});
