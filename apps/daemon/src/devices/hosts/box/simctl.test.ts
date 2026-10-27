import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deviceProfile } from "@orquester/api";

import {
  leaseIdOfSimulator,
  leaseSimulatorName,
  newestIphoneTarget,
  parseSimCatalog,
  parseSimDevices,
  pickSimulatorTarget,
  simDeviceSummary
} from "./simctl.ts";
import { FAKE_SIM_CATALOG } from "./testing.ts";

const catalog = parseSimCatalog(JSON.stringify(FAKE_SIM_CATALOG));

describe("simctl", () => {
  it("maps each iOS profile to a simctl device type on the newest runtime that has it", () => {
    assert.deepEqual(pickSimulatorTarget(catalog, deviceProfile("iphone-17-pro")!), {
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      deviceTypeName: "iPhone 17 Pro",
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
      osVersion: "27.0",
      runtimeName: "iOS 27.0"
    });
    // The M5 iPad is not in this Xcode: the profile's next choice is.
    assert.equal(pickSimulatorTarget(catalog, deviceProfile("ipad-pro-13")!)?.deviceTypeName, "iPad Pro 13-inch (M4)");
    assert.equal(pickSimulatorTarget(catalog, deviceProfile("iphone-duo")!), null);
  });

  it("honours a pinned runtime and skips unavailable or non-iOS ones", () => {
    assert.equal(pickSimulatorTarget(catalog, deviceProfile("iphone-17-pro")!, "26")?.runtimeId, "com.apple.CoreSimulator.SimRuntime.iOS-26-2");
    // iPhone 17 Pro Max only exists on 27.0.
    assert.equal(pickSimulatorTarget(catalog, deviceProfile("iphone-17-pro-max")!, "26.2"), null);
    const odd = parseSimCatalog(
      JSON.stringify({
        devicetypes: FAKE_SIM_CATALOG.devicetypes,
        runtimes: [
          { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-28-0", version: "28.0", platform: "iOS", isAvailable: false, supportedDeviceTypes: FAKE_SIM_CATALOG.devicetypes },
          { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-12-0", version: "12.0", platform: "watchOS", isAvailable: true },
          // Old simctl JSON: no supportedDeviceTypes.
          { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2", version: "26.2", isAvailable: true }
        ]
      })
    );
    assert.equal(pickSimulatorTarget(odd, deviceProfile("iphone-17-pro")!)?.runtimeId, "com.apple.CoreSimulator.SimRuntime.iOS-26-2");
  });

  it("picks the newest iPhone for the runner warm-up", () => {
    assert.equal(newestIphoneTarget(catalog)?.deviceTypeName, "iPhone 17 Pro Max");
    assert.equal(newestIphoneTarget({ deviceTypes: [], runtimes: [] }), null);
  });

  it("reads devices and names lease simulators", () => {
    const devices = parseSimDevices(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
            { udid: "A", name: "orq-L1", state: "Booted", isAvailable: true },
            { udid: "B", name: "orq-warm-runner", state: "Booted", isAvailable: true },
            { udid: "C", name: "Gone", state: "Shutdown", isAvailable: false }
          ],
          "com.apple.CoreSimulator.SimRuntime.watchOS-12-0": [{ udid: "W", name: "Watch", state: "Shutdown", isAvailable: true }]
        }
      })
    );
    assert.deepEqual(
      devices.map((device) => [device.udid, device.osVersion]),
      [
        ["A", "27.0"],
        ["B", "27.0"]
      ]
    );
    assert.equal(leaseSimulatorName("L1"), "orq-L1");
    assert.equal(leaseIdOfSimulator("orq-L1"), "L1");
    assert.equal(leaseIdOfSimulator("orq-warm-runner"), null);
    assert.equal(leaseIdOfSimulator("iPhone 17"), null);
    const summary = simDeviceSummary("box:m", devices[0]!, () => "iphone-17-pro")!;
    assert.equal(summary.key, "box:m/A");
    assert.equal(summary.profile, "iphone-17-pro");
    assert.equal(summary.platform, "ios");
    assert.equal(summary.booted, true);
    assert.equal(simDeviceSummary("box:m", devices[1]!, () => null), null);
  });


});
