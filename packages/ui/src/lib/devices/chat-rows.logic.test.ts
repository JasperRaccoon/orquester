import assert from "node:assert/strict";
import test from "node:test";

import { completeDeviceReference, deviceSummaryWords, deviceToolRowLabel } from "./chat-rows.logic.ts";

const ref = { device: "local/emulator-5554", leaseId: "l1" };

test("open, close and install name the device, with a fallback", () => {
  assert.equal(deviceToolRowLabel("open_device", { ...ref, name: "Pixel 9" }), "Opened Pixel 9");
  assert.equal(deviceToolRowLabel("open_device", ref), "Opened a device");
  assert.equal(deviceToolRowLabel("open_device", ref, () => "Pixel Fold"), "Opened Pixel Fold");
  assert.equal(deviceToolRowLabel("open_device", { ...ref, name: "iPhone 17 Pro" }, () => "Other"), "Opened iPhone 17 Pro");
  assert.equal(deviceToolRowLabel("close_device", { ...ref, name: "Pixel 9" }), "Closed Pixel 9");
  assert.equal(deviceToolRowLabel("close_device", ref), "Closed a device");
  assert.equal(deviceToolRowLabel("device_install", { ...ref, name: "Pixel 9" }), "Installed a build on Pixel 9");
  assert.equal(deviceToolRowLabel("device_install", ref, () => "  "), "Installed a build on a device");
});

test("list_devices, other tools and rows without a reference keep their generic words", () => {
  assert.equal(deviceToolRowLabel("list_devices", { ...ref, name: "Pixel 9" }), undefined);
  assert.equal(deviceToolRowLabel("box_exec", { ...ref, name: "Pixel 9" }), undefined);
  assert.equal(deviceToolRowLabel("open_device", undefined), undefined);
  assert.equal(deviceToolRowLabel("device_action", ref), undefined);
});

test("device_action: screenshots and snapshots say so; input reads its summary, ref stripped", () => {
  assert.equal(deviceToolRowLabel("device_action", { ...ref, name: "Pixel 9", action: "screenshot", summary: "Took a screenshot" }), "Took a screenshot of Pixel 9");
  assert.equal(deviceToolRowLabel("device_action", { ...ref, action: "snapshot" }, () => "iPhone 17 Pro"), "Read the screen of iPhone 17 Pro");
  assert.equal(deviceToolRowLabel("device_action", { ...ref, action: "screenshot" }), "Took a screenshot of a device");
  assert.equal(deviceToolRowLabel("device_action", { ...ref, action: "tap", summary: "Tapped @e7 “Search”" }), "Tapped “Search”");
  assert.equal(deviceToolRowLabel("device_action", { ...ref, action: "tap", summary: "Tapped @e7" }), "Tapped @e7");
  assert.equal(deviceToolRowLabel("device_action", { ...ref, summary: "Typed 12 characters" }), "Typed 12 characters");
});

test("device_action without a summary: a verb from the action kind", () => {
  const named = { ...ref, name: "Pixel 9" };
  const cases = [
    ["tap", "Tapped on Pixel 9"],
    ["long_press", "Long-pressed on Pixel 9"],
    ["fill", "Filled a field on Pixel 9"],
    ["type", "Typed on Pixel 9"],
    ["press", "Pressed a key on Pixel 9"],
    ["swipe", "Swiped on Pixel 9"],
    ["scroll", "Scrolled on Pixel 9"],
    ["open_app", "Opened an app on Pixel 9"],
    ["close_app", "Closed an app on Pixel 9"],
    ["open_url", "Opened a link on Pixel 9"],
    ["logs", "Read logs of Pixel 9"],
    ["rotate", "Rotated Pixel 9"],
    ["appearance", "Changed the appearance of Pixel 9"],
    ["location", "Set the location of Pixel 9"],
    ["permissions", "Changed permissions on Pixel 9"],
    ["wait", "Waited on Pixel 9"]
  ] as const;
  for (const [action, words] of cases) assert.equal(deviceToolRowLabel("device_action", { ...named, action }), words);
  assert.equal(deviceToolRowLabel("device_action", named), "Used Pixel 9");
  assert.equal(deviceToolRowLabel("device_action", { ...ref, action: "swipe" }), "Swiped on a device");
});

test("summary words: only a ref before a quoted label is dropped", () => {
  assert.equal(deviceSummaryWords("Tapped @e7 “Search”"), "Tapped “Search”");
  assert.equal(deviceSummaryWords('Filled @e12 "Email" with 5 characters'), 'Filled "Email" with 5 characters');
  assert.equal(deviceSummaryWords("Tapped @e7 at 120, 300"), "Tapped @e7 at 120, 300");
  assert.equal(deviceSummaryWords("  Pressed home "), "Pressed home");
});

test("a live row's action and summary complete the reference; a slimmed one keeps it as is", () => {
  const deviceRef = { device: "local/e", leaseId: "l1" };
  const result = { content: [{ type: "text", text: JSON.stringify({ device: "local/e", action: "tap", summary: "Tapped @e3 “OK”", deviceRef }) }] };
  assert.deepEqual(completeDeviceReference(deviceRef, { sessionTool: { name: "device_action" }, result }), {
    ...deviceRef,
    action: "tap",
    summary: "Tapped @e3 “OK”"
  });
  // Invalid words are dropped, the reference survives.
  const bad = { content: [{ type: "text", text: JSON.stringify({ action: "hack", summary: "a\nb", deviceRef }) }] };
  assert.deepEqual(completeDeviceReference(deviceRef, { sessionTool: { name: "device_action" }, result: bad }), deviceRef);
  // The reference's own words win.
  const own = { ...deviceRef, action: "swipe" as const, summary: "Swiped up" };
  assert.equal(completeDeviceReference(own, { result }), own);
  // A slimmed row: only the kept reference.
  assert.deepEqual(completeDeviceReference(deviceRef, { sessionTool: { name: "device_action", references: { deviceRef } }, result: "summary" }), deviceRef);
});
