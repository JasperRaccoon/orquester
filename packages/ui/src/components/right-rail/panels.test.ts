import assert from "node:assert/strict";
import test from "node:test";

import { MOBILE_SECTION_ORDER, RIGHT_RAIL_PANEL_ORDER, visibleRailPanels } from "./panels.ts";

test("the Device panel is offered on desktop and phone only while its plugin is on", () => {
  assert.deepEqual(visibleRailPanels(RIGHT_RAIL_PANEL_ORDER, false), ["prompts", "history"]);
  assert.deepEqual(visibleRailPanels(RIGHT_RAIL_PANEL_ORDER, true), ["prompts", "history", "device"]);
  assert.deepEqual(visibleRailPanels(MOBILE_SECTION_ORDER, false), ["prompts", "history", "workflows", "profile"]);
  assert.deepEqual(visibleRailPanels(MOBILE_SECTION_ORDER, true), ["prompts", "history", "device", "workflows", "profile"]);
});
