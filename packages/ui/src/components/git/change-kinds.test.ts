import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changeKindRows, shouldShowChangeKindSplit } from "./change-kinds";

describe("shouldShowChangeKindSplit", () => {
  it("stays quiet when the change is all code or empty", () => {
    assert.equal(shouldShowChangeKindSplit(changeKindRows([])), false);
    assert.equal(shouldShowChangeKindSplit(changeKindRows([{ path: "a.ts" }, { path: "b.ts" }])), false);
  });

  it("shows a mix, or a change that is all one non-code kind", () => {
    assert.equal(shouldShowChangeKindSplit(changeKindRows([{ path: "a.ts" }, { path: "a.test.ts" }])), true);
    assert.equal(shouldShowChangeKindSplit(changeKindRows([{ path: "docs/a.md" }])), true);
  });
});
