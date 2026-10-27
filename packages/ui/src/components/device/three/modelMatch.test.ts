import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

it("has a recorded source for every model id it can return", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../models/sources.json", import.meta.url), "utf8"),
  ) as { models: { id: string; file: string }[] };
  const recorded = new Set(manifest.models.map((model) => model.id));
  const names = [
    "iPhone 18 Pro",
    "iPhone 18 Pro Max",
    "iPhone Duo",
    "iPhone 17",
    "iPhone Air",
    "iPhone 17e",
    "iPad Pro 13-inch (M5)",
    "iPhone 17 Pro",
    "iPad Air 13-inch (M4)",
    "iPad Air 11-inch (M3)",
    "iPad (A16)",
  ];
  for (const name of names) {
    const id = resolveDeviceModelId("ios", name);
    assert.ok(id && recorded.has(id), `${name} -> ${id} has no sources.json entry`);
  }
  for (const model of manifest.models)
    assert.doesNotThrow(() => readFileSync(new URL(`../models/${model.file}`, import.meta.url)));
});
