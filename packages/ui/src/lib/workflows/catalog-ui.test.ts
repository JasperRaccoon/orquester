import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterPalette } from "./catalog-ui.ts";

describe("the palette", () => {
  it("from an output it offers no triggers and no notes", () => {
    const types = filterPalette("", { allowTriggers: false, allowNotes: false }).flatMap((g) => g.types);
    assert.ok(types.includes("code"));
    assert.ok(!types.some((type) => type.startsWith("trigger.")));
    assert.ok(!types.includes("note"));
  });
});
