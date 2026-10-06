import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { previewText } from "./history-format";

describe("previewText", () => {

  it("never ends on half a surrogate pair", () => {
    const text = `${"a".repeat(499)}😀${"b".repeat(10)}`;
    const preview = previewText(text);
    assert.ok(preview.startsWith("a".repeat(499)), "the preview retains the original text");
    assert.doesNotMatch(preview, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});
