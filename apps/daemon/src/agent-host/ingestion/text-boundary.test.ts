import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitBufferedText, truncateDetail } from "./text-boundary.ts";

describe("splitBufferedText (§5.6 'a flush never splits a code block')", () => {
  it("has no boundary before the first terminated line", () => {
    assert.deepEqual(splitBufferedText("hello wor"), {
      ready: "",
      rest: "hello wor",
      openFence: false
    });
  });

  it("cuts at a blank line", () => {
    const { ready, rest } = splitBufferedText("one\n\ntwo");
    assert.equal(ready, "one\n\n");
    assert.equal(rest, "two");
  });

  it("never cuts inside an open fence and reports it", () => {
    const split = splitBufferedText("intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n");
    assert.equal(split.ready, "intro\n\n");
    assert.equal(split.openFence, true);
    assert.ok(split.rest.startsWith("```ts"));
  });

  it("cuts right after the closing fence", () => {
    const split = splitBufferedText("```\ncode\n```\ntrailing");
    assert.equal(split.ready, "```\ncode\n```\n");
    assert.equal(split.rest, "trailing");
    assert.equal(split.openFence, false);
  });

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

describe("truncateDetail", () => {
  it("leaves short values alone", () => {
    assert.equal(truncateDetail("short"), "short");
  });

  it("elides at the limit", () => {
    assert.equal(truncateDetail("abcdefghij", 5), "ab...");
  });
});
