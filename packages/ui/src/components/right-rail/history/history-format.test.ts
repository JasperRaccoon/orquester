import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { previewText } from "./history-format";

describe("previewText", () => {
  it("cuts a long one — a pasted 200 KB log becomes a few hundred characters", () => {
    const log = "x".repeat(200_000);
    const preview = previewText(log);
    assert.ok(preview.length <= 501);
    assert.ok(preview.endsWith("…"));
  });

  it("never ends on half a surrogate pair", () => {
    const text = `${"a".repeat(499)}😀${"b".repeat(10)}`;
    const preview = previewText(text);
    assert.equal(preview, `${"a".repeat(499)}…`);
  });
});
