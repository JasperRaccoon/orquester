import assert from "node:assert/strict";
import test from "node:test";

import { MOBILE_SECTION_ORDER, RIGHT_RAIL_PANEL_ORDER, RIGHT_RAIL_PANEL_REGISTRY, visibleRailPanels } from "./panels.ts";

test("the Device panel is registered, docked and a phone section, and listed only while its plugin is on", () => {
  assert.equal(RIGHT_RAIL_PANEL_REGISTRY.device.title, "Devices");
  assert.ok(RIGHT_RAIL_PANEL_ORDER.includes("device"));
  assert.ok(MOBILE_SECTION_ORDER.includes("device"));
  assert.deepEqual(visibleRailPanels(RIGHT_RAIL_PANEL_ORDER, { devices: false }), ["prompts", "history"]);
  assert.equal(visibleRailPanels(RIGHT_RAIL_PANEL_ORDER, { devices: true }), RIGHT_RAIL_PANEL_ORDER);
  assert.deepEqual(visibleRailPanels(MOBILE_SECTION_ORDER, { devices: false }), ["prompts", "history", "workflows", "profile"]);
  for (const id of MOBILE_SECTION_ORDER) assert.equal(RIGHT_RAIL_PANEL_REGISTRY[id].id, id);
});
