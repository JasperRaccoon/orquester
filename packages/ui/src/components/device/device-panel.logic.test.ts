import assert from "node:assert/strict";
import test from "node:test";

import { controllerLabel, leaseStateLabel, leaseSubtitle } from "./device-panel.logic.ts";

test("lease words: state, controller pill and subtitle", () => {
  assert.equal(leaseStateLabel({ state: "starting" }), "Starting…");
  assert.equal(leaseStateLabel({ state: "starting", progress: { step: "rent-host", label: "Renting Mac host", startedAt: "x" } }), "Renting Mac host…");
  assert.equal(leaseStateLabel({ state: "lost", error: "box destroyed" }), "Lost — box destroyed");
  assert.equal(leaseStateLabel({ state: "ready" }), "Ready");
  assert.equal(controllerLabel({ state: "ready", controller: "user" }), "You have control");
  assert.equal(controllerLabel({ state: "ready", controller: "agent" }), "The agent is controlling");
  assert.equal(controllerLabel({ state: "starting", controller: "agent" }), null);
  assert.equal(leaseSubtitle({ platform: "ios", osVersion: "" }), "iPhone & iPad");
  assert.equal(leaseSubtitle({ platform: "android", osVersion: "Android 15" }), "Android 15");
});
