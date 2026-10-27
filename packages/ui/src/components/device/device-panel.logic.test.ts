import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, DEVICE_PROFILES, type DeviceHostSummary, type DeviceLeaseSummary, type DevicesSettings } from "@orquester/api";

import {
  activeLeaseOf,
  bootElapsed,
  bootSteps,
  controllerLabel,
  controllerPill,
  deviceFoldUrl,
  deviceKeyOf,
  devicePanelView,
  deviceStreamUrls,
  formatElapsed,
  inputTakesOver,
  leaseName,
  leaseStateLabel,
  leaseSubtitle,
  NO_TRANSPORT_MESSAGE,
  pickerGroups,
  streamAvailability,
  takeOverToast
} from "./device-panel.logic.ts";

function lease(overrides: Partial<DeviceLeaseSummary> = {}): DeviceLeaseSummary {
  return {
    id: "l1",
    key: "local/emulator-5554",
    threadId: "chat-1",
    hostId: "local",
    deviceId: "emulator-5554",
    platform: "android",
    profile: "pixel-9",
    name: "Pixel 9",
    osVersion: "Android 15",
    state: "ready",
    controller: "agent",
    openedBy: "agent",
    createdAt: "2026-10-27T10:00:00.000Z",
    lastUsedAt: "2026-10-27T10:00:00.000Z",
    stream: { kind: "serve-emu", deviceParam: "emulator-5554" },
    ...overrides
  };
}

function host(overrides: Partial<DeviceHostSummary> = {}): DeviceHostSummary {
  return {
    id: "local",
    kind: "local",
    label: "This machine",
    platforms: ["android"],
    status: "ready",
    statusDetail: null,
    readiness: { ready: true, checks: [], checkedAt: null },
    capacity: { used: 1, total: 4 },
    ...overrides
  };
}

const settings = (patch: (s: DevicesSettings) => void = () => {}): DevicesSettings => {
  const s = structuredClone(DEFAULT_DEVICES_SETTINGS) as DevicesSettings;
  s.android.enabled = true;
  s.ios.enabled = true;
  patch(s);
  return s;
};

describe("lease words", () => {
  it("states, controller pill, subtitle and names", () => {
    assert.equal(leaseStateLabel({ state: "starting" }), "Starting…");
    assert.equal(leaseStateLabel({ state: "starting", progress: { step: "rent-host", label: "Renting Mac host", startedAt: "x" } }), "Renting Mac host…");
    assert.equal(leaseStateLabel({ state: "lost", error: "box destroyed" }), "Lost — box destroyed");
    assert.equal(leaseStateLabel({ state: "ready" }), "Ready");
    assert.equal(controllerLabel({ state: "ready", controller: "user" }), "You have control");
    assert.equal(controllerLabel({ state: "ready", controller: "agent" }, "Claude"), "Claude is controlling");
    assert.equal(controllerLabel({ state: "starting", controller: "agent" }), null);
    assert.equal(leaseSubtitle({ platform: "ios", osVersion: "" }), "iPhone & iPad");
    assert.equal(leaseSubtitle({ platform: "android", osVersion: "Android 15" }), "Android 15");
    assert.equal(leaseName({ name: "", profile: "pixel-9" }, DEVICE_PROFILES), "Pixel 9");
    assert.equal(leaseName({ name: "", profile: "" }), "Device");
    assert.equal(deviceKeyOf({ key: null, id: "l9" }), "l9");
  });
  it("formats elapsed time", () => {
    assert.equal(formatElapsed(-5), "0s");
    assert.equal(formatElapsed(8_400), "8s");
    assert.equal(formatElapsed(65_000), "1m 05s");
    assert.equal(formatElapsed(3_720_000), "1h 02m");
  });
});

describe("panel state machine", () => {
  const base = { sessionId: "chat-1", loaded: true, leases: [] as DeviceLeaseSummary[], streamsAvailable: true };
  it("no chat, loading and the empty picker", () => {
    assert.deepEqual(devicePanelView({ ...base, sessionId: null }), { kind: "no-chat" });
    assert.deepEqual(devicePanelView({ ...base, loaded: false }), { kind: "loading" });
    assert.deepEqual(devicePanelView(base), { kind: "picker" });
    assert.deepEqual(devicePanelView({ ...base, leases: [lease()], picking: true }), { kind: "picker" });
  });
  it("booting, failed boot, live, suspended and lost", () => {
    assert.equal(devicePanelView({ ...base, leases: [lease({ state: "starting" })] }).kind, "booting");
    const failed = devicePanelView({ ...base, leases: [lease({ state: "starting", error: "no KVM" })] });
    assert.ok(failed.kind === "booting" && failed.failed);
    const live = devicePanelView({ ...base, leases: [lease()] });
    assert.ok(live.kind === "live" && live.stream.ok);
    assert.equal(devicePanelView({ ...base, leases: [lease({ state: "suspended" })] }).kind, "suspended");
    assert.equal(devicePanelView({ ...base, leases: [lease({ state: "lost" })] }).kind, "lost");
  });
  it("a live device off HTTP says it needs a server connection; no stream yet waits; vphone is unsupported", () => {
    const view = devicePanelView({ ...base, leases: [lease()], streamsAvailable: false });
    assert.ok(view.kind === "live" && !view.stream.ok && view.stream.message === NO_TRANSPORT_MESSAGE);
    assert.deepEqual(streamAvailability({}, true), { ok: false, reason: "no-stream", message: "Waiting for the device's video…" });
    assert.equal((streamAvailability({ stream: { kind: "vphone", deviceParam: "x" } }, true) as { reason: string }).reason, "unsupported");
  });
  it("selects the picked lease, else the newest live one, else the newest", () => {
    const a = lease({ id: "a" });
    const b = lease({ id: "b" });
    const lost = lease({ id: "c", state: "lost" });
    assert.equal(activeLeaseOf([a, b, lost], null)?.id, "b");
    assert.equal(activeLeaseOf([a, b, lost], "a")?.id, "a");
    assert.equal(activeLeaseOf([a, b], "gone")?.id, "b");
    assert.equal(activeLeaseOf([lost], null)?.id, "c");
    assert.equal(activeLeaseOf([], "a"), null);
  });
});

describe("booting steps", () => {
  const now = Date.parse("2026-10-27T10:01:10.000Z");
  it("iOS rents a host first, with its cost; the active step shows its elapsed time", () => {
    const steps = bootSteps(
      lease({ platform: "ios", state: "starting", progress: { step: "prepare-host", label: "Preparing host", startedAt: "2026-10-27T10:00:58.000Z" } }),
      now,
      { hourlyUsd: 4.8 }
    );
    assert.deepEqual(steps.map((s) => [s.id, s.state]), [
      ["rent-host", "done"],
      ["prepare-host", "active"],
      ["start-device", "pending"],
      ["connect-video", "pending"]
    ]);
    assert.equal(steps[0]!.detail, "~$4.80/h while it runs");
    assert.equal(steps[1]!.elapsed, "12s");
    assert.equal(steps[2]!.elapsed, null);
  });
  it("Android skips the rental; without progress the first step is active since the lease started", () => {
    const steps = bootSteps(lease({ state: "starting" }), now);
    assert.equal(steps[0]!.id, "prepare-host");
    assert.equal(steps[0]!.state, "active");
    assert.equal(steps[0]!.elapsed, "1m 10s");
    assert.equal(bootElapsed(lease(), now), "1m 10s");
  });
  it("a host's own step stands in for the preparation; a failed boot marks the active step", () => {
    const steps = bootSteps(lease({ state: "starting", error: "boom", progress: { step: "install-tools", label: "Installing tools", startedAt: "2026-10-27T10:01:00.000Z" } }), now);
    assert.deepEqual(steps.map((s) => [s.id, s.label, s.state]), [
      ["install-tools", "Installing tools", "failed"],
      ["start-device", "Starting device", "pending"],
      ["connect-video", "Connecting video", "pending"]
    ]);
  });
  it("iOS on a running host skips the rental", () => {
    assert.equal(bootSteps(lease({ platform: "ios", state: "starting" }), now, { rentingNeeded: false })[0]!.id, "prepare-host");
  });
});

describe("controller handoff rules", () => {
  it("agent control offers Take over; user control offers Give back; nothing before ready", () => {
    assert.deepEqual(controllerPill(lease(), "Claude"), { tone: "agent", text: "Claude is controlling", action: { label: "Take over", controller: "user" } });
    assert.deepEqual(controllerPill(lease({ controller: "user" }), "Claude"), { tone: "user", text: "You have control", action: { label: "Give back", controller: "agent" } });
    assert.equal(controllerPill(lease({ state: "starting" }), "Claude"), null);
  });
  it("the first input on an agent-driven ready device takes over", () => {
    assert.equal(inputTakesOver(lease()), true);
    assert.equal(inputTakesOver(lease({ controller: "user" })), false);
    assert.equal(inputTakesOver(lease({ state: "suspended" })), false);
    assert.equal(inputTakesOver(null), false);
    assert.match(takeOverToast("Codex"), /took control from Codex/);
  });
});

describe("stream URLs", () => {
  const api = {
    deviceSocketUrl: (path: string) => `ws://d.test${path}?token=t`,
    deviceMediaUrl: (path: string) => `http://d.test${path}?token=t`
  };
  it("Android: the serve-emu socket and screenshot route with the device", () => {
    assert.deepEqual(deviceStreamUrls(api, lease()), {
      video: "ws://d.test/ws-device/local/vendor/serve-emu/ws?token=t&device=emulator-5554",
      screenshot: "http://d.test/api/devices/hosts/local/hub/vendor/serve-emu/api/screenshot?token=t&device=emulator-5554"
    });
    assert.equal(deviceFoldUrl(api, lease()), "http://d.test/api/devices/hosts/local/hub/vendor/serve-emu/api/fold?token=t&device=emulator-5554");
  });
  it("iOS: serve-sim stream.avcc and the input socket", () => {
    const ios = lease({ platform: "ios", hostId: "box:b1", stream: { kind: "serve-sim", deviceParam: "UD ID" } });
    assert.deepEqual(deviceStreamUrls(api, ios), {
      video: "http://d.test/api/devices/hosts/box%3Ab1/hub/vendor/serve-sim/helper/UD%20ID/stream.avcc?token=t",
      input: "ws://d.test/ws-device/box%3Ab1/vendor/serve-sim/helper/ws?token=t&device=UD+ID"
    });
    assert.equal(deviceFoldUrl(api, ios), null);
  });
  it("null off HTTP or without a stream", () => {
    const off = { deviceSocketUrl: () => null, deviceMediaUrl: () => null };
    assert.equal(deviceStreamUrls(off, lease()), null);
    assert.equal(deviceStreamUrls(api, lease({ stream: undefined })), null);
  });
});

describe("picker", () => {
  const profiles = DEVICE_PROFILES;
  it("offers ready Android profiles and iPhones that rent a Mac with the quote", () => {
    const groups = pickerGroups({ profiles, hosts: [host()], settings: settings(), chatLeases: 0, macHourlyUsd: 4.8 });
    assert.deepEqual(groups.map((g) => g.platform), ["android", "ios"]);
    assert.ok(groups[0]!.rows.every((row) => row.enabled && row.badge === "Ready"));
    assert.equal(groups[0]!.note, "Runs on this host · 1 of 4 in use");
    assert.equal(groups[1]!.note, "No Mac host — opening an iPhone rents one (~$4.80/h)");
    assert.ok(groups[1]!.rows.every((row) => row.enabled && row.badge === "Asks to rent"));
  });
  it("explains disabled rows: platform off, host needs setup, full host, chat limit", () => {
    const off = pickerGroups({ profiles, hosts: [host()], settings: settings((s) => (s.android.enabled = false)), chatLeases: 0, macHourlyUsd: null });
    assert.match(off[0]!.rows[0]!.reason!, /Android is off/);
    const setup = pickerGroups({
      profiles,
      hosts: [host({ status: "needs-setup", readiness: { ready: false, checkedAt: null, checks: [{ id: "kvm", label: "KVM", state: "missing", detail: null }] } })],
      settings: settings(),
      chatLeases: 0,
      macHourlyUsd: null
    });
    assert.match(setup[0]!.rows[0]!.reason!, /needs setup: KVM/);
    assert.equal(setup[0]!.rows[0]!.badge, "Needs setup");
    const full = pickerGroups({ profiles, hosts: [host({ capacity: { used: 4, total: 4 } })], settings: settings(), chatLeases: 0, macHourlyUsd: null });
    assert.match(full[0]!.rows[0]!.reason!, /full/);
    const limit = pickerGroups({ profiles, hosts: [host()], settings: settings(), chatLeases: 3, macHourlyUsd: null });
    assert.ok(limit.every((g) => g.rows.every((row) => !row.enabled && row.badge === "Limit reached")));
  });
  it("lists only the profiles Settings offers, and a running Mac host opens in seconds", () => {
    const mac = host({ id: "box:b1", kind: "box", platforms: ["ios"], capacity: { used: 1, total: 3 } });
    const groups = pickerGroups({ profiles, hosts: [mac], settings: settings((s) => (s.ios.profiles = ["iphone-17-pro"])), chatLeases: 0, macHourlyUsd: null });
    const ios = groups.find((g) => g.platform === "ios")!;
    assert.deepEqual(ios.rows.map((row) => row.profile.id), ["iphone-17-pro"]);
    assert.match(ios.note!, /A Mac host is running/);
  });
});
