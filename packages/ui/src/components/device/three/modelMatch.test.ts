import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveDeviceModelId, type DeviceModelId } from "./model.ts";

it("matches simulator device names exactly and case-insensitively", () => {
  const cases: [string, DeviceModelId | null][] = [
    ["iPhone 18 Pro", "iphone-18-pro"],
    ["iphone 18 pro max", "iphone-18-pro-max"],
    ["iPhone Duo", "iphone-duo"],
    ["iPhone 17", "iphone-17"],
    ["IPHONE AIR", "iphone-air"],
    ["iPhone 17e", "iphone-17e"],
    ["iPad Pro 13-inch (M5)", "ipad-pro-13-m5"],
    ["iPhone 17 Pro", "iphone-18-pro"],
    ["iPhone 17 Pro Max", "iphone-18-pro-max"],
    ["iPad Air 13-inch (M3)", "ipad-air"],
    ["iPad Air 13-inch (M4)", "ipad-air"],
    ["iPad Air 11-inch (M3)", "ipad-a16"],
    ["iPad Air 11-inch (M4)", "ipad-a16"],
    ["iPad (A16)", "ipad-a16"],
    // Not prefixes or near names: those keep the procedural body.
    ["iPhone 17 Plus", null],
    ["iPhone 18 Pro (2nd generation)", null],
    [" iPhone 17", null],
    ["iPad Air 11-inch (M2)", null],
    ["iPad Pro 11-inch (M5)", null],
    ["iPad mini (A17 Pro)", null],
    ["", null],
  ];
  for (const [name, id] of cases) assert.equal(resolveDeviceModelId("ios", name), id, name);
});

it("never gives an Android device an Apple model", () => {
  assert.equal(resolveDeviceModelId("android", "iPhone 17"), null);
  assert.equal(resolveDeviceModelId("android", "Pixel 9"), null);
});

it("matches Samsung emulator names and AVD profiles exactly and case-insensitively", () => {
  const cases: [string, DeviceModelId | null][] = [
    ["Galaxy S26", "galaxy-s26"],
    ["galaxy s26+", "galaxy-s26-plus"],
    ["GALAXY S26 ULTRA", "galaxy-s26-ultra"],
    ["Galaxy Z Fold8", "galaxy-z-fold8"],
    ["galaxy z flip8", "galaxy-z-flip8"],
    ["orq-galaxy-s26", "galaxy-s26"],
    ["galaxy-s26-plus", "galaxy-s26-plus"],
    ["orq-galaxy-z-fold8", "galaxy-z-fold8"],
    ["orq-galaxy-z-flip8", "galaxy-z-flip8"],
    // Pixels and near names keep the procedural body.
    ["orq-pixel-9", null],
    ["orq-pixel-fold", null],
    ["Galaxy S26 Plus", null],
    ["Galaxy S26 FE", null],
    ["Galaxy Z Fold7", null],
    ["Galaxy Z Fold8 ", null],
    ["Samsung Galaxy S26", null],
  ];
  for (const [name, id] of cases) assert.equal(resolveDeviceModelId("android", name), id, name);
  assert.equal(resolveDeviceModelId("ios", "Galaxy S26"), null);
});
