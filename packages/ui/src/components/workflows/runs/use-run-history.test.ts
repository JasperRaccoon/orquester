import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { firstPageReplaced } from "./use-run-history.ts";

describe("run history: older pages follow the first page", () => {
  it("starts the older pages over when the first page's cursor moved (a reload)", () => {
    assert.equal(firstPageReplaced(undefined, "c1"), false, "the first load");
    assert.equal(firstPageReplaced("c1", "c1"), false, "an event on the same page");
    assert.equal(firstPageReplaced("c1", "c2"), true, "a reload shifted the page");
    assert.equal(firstPageReplaced(null, "c2"), true);
  });
});
