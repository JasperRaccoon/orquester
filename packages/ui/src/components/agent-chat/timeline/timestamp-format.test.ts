import assert from "node:assert/strict";
import { test } from "node:test";

import * as pure from "./timestamp-format.ts";
import * as component from "./timestamp.tsx";

test("fix round 1 (6): the row timestamp formatters have ONE definition, in a pure module", () => {
  // The component module re-exports them for its existing importers; it does
  // not define a second copy.
  assert.equal(component.formatRowTimestamp, pure.formatRowTimestamp);
  assert.equal(component.formatRowTimestampTooltip, pure.formatRowTimestampTooltip);
});
