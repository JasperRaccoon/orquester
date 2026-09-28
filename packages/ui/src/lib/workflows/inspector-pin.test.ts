import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pinnableOutputOf } from "./inspector-data.ts";

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
    const value = await pinnableOutputOf({ output: { preview: "…" }, outputTruncated: true }, async () => ({ output: { full: "x".repeat(10) } }));
    assert.deepEqual(value, { full: "xxxxxxxxxx" });
  });

  it("refuses a malformed answer rather than pinning the preview", async () => {
    await assert.rejects(pinnableOutputOf({ output: "p", outputTruncated: true }, async () => null));
  });
});
