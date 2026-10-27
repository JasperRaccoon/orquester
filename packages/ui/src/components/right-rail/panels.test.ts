import assert from "node:assert/strict";
import test from "node:test";

import { MOBILE_SECTION_ORDER, RIGHT_RAIL_PANEL_ORDER, visibleRailPanels } from "./panels.ts";

test("the Device panel is offered on desktop and phone only while its plugin is on", () => {
  for (const panels of [RIGHT_RAIL_PANEL_ORDER, MOBILE_SECTION_ORDER]) {
    assert.equal(visibleRailPanels(panels, false).includes("device"), false);
    assert.equal(visibleRailPanels(panels, true).includes("device"), true);
  }
});
