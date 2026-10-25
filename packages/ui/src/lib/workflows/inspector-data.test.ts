import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { outputReference, parsePinnedText, pinnableOutputOf } from "./inspector-data.ts";

describe("parsePinnedText limits", () => {
  it("refuses JSON over the pinned-data limit", () => {
    const big = JSON.stringify("x".repeat(1_048_576));
    const parsed = parsePinnedText(big);
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.error.length > 0);
  });

  it("refuses null, which set_pinned would read as unpin", () => {
    const parsed = parsePinnedText(" null ");
    assert.equal(parsed.ok, false);

    assert.deepEqual(parsePinnedText("false"), { ok: true, value: false });
    assert.deepEqual(parsePinnedText("0"), { ok: true, value: 0 });
  });

  it("explains a syntax error", () => {
    const parsed = parsePinnedText('{ "a": }');
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.error.length > 0);
  });
});

describe("outputReference", () => {
  it("writes the template reference to a block's output", () => {
    assert.equal(outputReference("Review"), "{{ nodes.Review.output }}");
  });
});

describe("pinnableOutputOf", () => {
  it("pins a whole recorded output as is, without asking the daemon", async () => {
    let asked = 0;
    const value = await pinnableOutputOf({ output: { a: 1 } }, async () => {
      asked += 1;
      return { output: null };
    });
    assert.deepEqual(value, { a: 1 });
    assert.equal(asked, 0);
  });

  it("reads the whole output when the run kept only a preview", async () => {
    const value = await pinnableOutputOf({ output: { preview: "…" }, outputTruncated: true }, async () => ({ output: { full: "complete" } }));
    assert.deepEqual(value, { full: "complete" });
  });

  it("refuses a malformed answer rather than pinning the preview", async () => {
    await assert.rejects(pinnableOutputOf({ output: "p", outputTruncated: true }, async () => null), /whole output/i);
  });
});
