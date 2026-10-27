import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, DEVICE_PROFILES, type DeviceHostSummary, type DeviceLeaseSummary, type DevicesSettings } from "@orquester/api";

import {
  activeLeaseOf,
  bootSteps,
  deviceFoldRequest,
  devicePanelView,
  deviceStreamUrls,
  hostStreamCaps,
  inputTakesOver,
  nextRotation,
  pickerGroups,
  rotateControl,
  streamAvailability,
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

describe("panel state machine", () => {
  const base = { sessionId: "chat-1", loaded: true, leases: [] as DeviceLeaseSummary[], streamsAvailable: true };
  it("shows placeholders without a chat or data and honors explicit picking", () => {
    assert.deepEqual(devicePanelView({ ...base, sessionId: null }), { kind: "no-chat" });
    assert.deepEqual(devicePanelView({ ...base, loaded: false }), { kind: "loading" });
    assert.deepEqual(devicePanelView({ ...base, leases: [lease()], picking: true }), { kind: "picker" });
  });
  it("preserves failed boot and suspended connection states", () => {
    const failed = devicePanelView({ ...base, leases: [lease({ state: "starting", error: "no KVM" })] });
    assert.ok(failed.kind === "booting" && failed.failed);
    assert.equal(devicePanelView({ ...base, leases: [lease({ state: "suspended" })] }).kind, "suspended");
  });
  it("distinguishes waiting video from an unsupported stream", () => {
    const waiting = streamAvailability({}, true);
    assert.ok(!waiting.ok && waiting.reason === "no-stream");
    const unsupported = streamAvailability({ stream: { kind: "vphone", deviceParam: "x" } }, true);
    assert.ok(!unsupported.ok && unsupported.reason === "unsupported");
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
    assert.match(steps[0]!.detail ?? "", /4\.80.*h/);
    assert.equal(steps[1]!.elapsed, "12s");
    assert.equal(steps[2]!.elapsed, null);
  });
  it("Android skips the rental; without progress the first step is active since the lease started", () => {
    const steps = bootSteps(lease({ state: "starting" }), now);
    assert.equal(steps[0]!.id, "prepare-host");
    assert.equal(steps[0]!.state, "active");
    assert.equal(steps[0]!.elapsed, "1m 10s");
  });
  it("shows provider preparation failure with its supplied step", () => {
    const steps = bootSteps(lease({ state: "starting", error: "boom", progress: { step: "install-tools", label: "Installing tools", startedAt: "2026-10-27T10:01:00.000Z" } }), now);
    assert.equal(steps[0]!.id, "install-tools");
    assert.equal(steps[0]!.label, "Installing tools");
    assert.equal(steps[0]!.state, "failed");
    assert.ok(steps.slice(1).every((step) => step.state === "pending"));
  });
  it("iOS on a running host skips the rental", () => {
    assert.equal(bootSteps(lease({ platform: "ios", state: "starting" }), now, { rentingNeeded: false })[0]!.id, "prepare-host");
  });
});

describe("controller handoff rules", () => {
  it("the first input on an agent-driven ready device takes over", () => {
    assert.equal(inputTakesOver(lease()), true);
    assert.equal(inputTakesOver(lease({ controller: "user" })), false);
    assert.equal(inputTakesOver(lease({ state: "suspended" })), false);
    assert.equal(inputTakesOver(null), false);
  });
});

describe("stream URLs", () => {
  const api = {
    deviceSocketUrl: (path: string) => `ws://d.test${path}?token=t`,
    deviceHttpRequest: (path: string) => ({ url: `http://d.test${path}`, headers: { Authorization: "Bearer t" } })
  };
  const auth = { Authorization: "Bearer t" };
  it("Android: the serve-emu socket (token in the URL) and the fetched screenshot route (bearer header) with the device", () => {
    assert.deepEqual(deviceStreamUrls(api, lease()), {
      video: "ws://d.test/ws-device/local/vendor/serve-emu/ws?token=t&device=emulator-5554",
      screenshot: "http://d.test/api/devices/hosts/local/hub/vendor/serve-emu/api/screenshot?device=emulator-5554",
      headers: auth
    });
    assert.deepEqual(deviceFoldRequest(api, lease()), { url: "http://d.test/api/devices/hosts/local/hub/vendor/serve-emu/api/fold?device=emulator-5554", headers: auth });
  });
  it("iOS: serve-sim stream.avcc and the input socket", () => {
    const ios = lease({ platform: "ios", hostId: "box:b1", stream: { kind: "serve-sim", deviceParam: "UD ID" } });
    assert.deepEqual(deviceStreamUrls(api, ios), {
      video: "http://d.test/api/devices/hosts/box%3Ab1/hub/vendor/serve-sim/helper/UD%20ID/stream.avcc",
      input: "ws://d.test/ws-device/box%3Ab1/vendor/serve-sim/helper/ws?token=t&device=UD+ID",
      headers: auth
    });
    assert.equal(deviceFoldRequest(api, ios), null);
  });
});

describe("rotate", () => {
  it("rotates between portrait and landscape", () => {
    assert.equal(nextRotation("portrait"), "landscape");
    assert.equal(nextRotation("landscape_left"), "portrait");
  });
  it("iOS needs the input socket; Android (the daemon's user action) the live video; never twice at once", () => {
    assert.equal(rotateControl("ios", { inputReady: true, live: false, pending: false }).enabled, true);
    assert.equal(rotateControl("ios", { inputReady: false, live: true, pending: false }).enabled, false);
    assert.equal(rotateControl("android", { inputReady: false, live: true, pending: false }).enabled, true);
    assert.equal(rotateControl("android", { inputReady: true, live: false, pending: false }).enabled, false);
    assert.equal(rotateControl("android", { inputReady: true, live: true, pending: true }).enabled, false);
  });
});

describe("host stream capabilities", () => {
  const hosts = [
    { id: "box:mac", stream: { iosH264: true } },
    { id: "box:vm", stream: { iosH264: false } },
    { id: "box:old" }
  ];
  it("honors explicit host H264 capability and defaults older hosts to false", () => {
    assert.deepEqual(hostStreamCaps(hosts, "box:mac"), { h264: true });
    assert.deepEqual(hostStreamCaps(hosts, "box:vm"), { h264: false });
    assert.deepEqual(hostStreamCaps(hosts, "box:old"), { h264: false });
  });
});

describe("picker", () => {
  const profiles = DEVICE_PROFILES;
  it("offers available platforms and explains the quoted iOS rental", () => {
    const groups = pickerGroups({ profiles, hosts: [host()], settings: settings(), chatLeases: 0, macHourlyUsd: 4.8 });
    assert.deepEqual(groups.map((group) => group.platform), ["android", "ios"]);
    assert.ok(groups.every((group) => group.rows.every((row) => row.enabled)));
    assert.match(groups[1]!.note ?? "", /rent.*4\.80/i);
  });
  it("blocks missing prerequisites, impossible local capacity and chat limit", () => {
    const setup = pickerGroups({
      profiles, hosts: [host({ status: "needs-setup", readiness: { ready: false, checkedAt: null, checks: [{ id: "kvm", label: "KVM", state: "missing", detail: null }] } })],
      settings: settings(), chatLeases: 0, macHourlyUsd: null
    });
    assert.ok(setup[0]!.rows.every((row) => !row.enabled));
    assert.match(setup[0]!.rows[0]!.reason ?? "", /KVM/);
    const never = pickerGroups({ profiles, hosts: [host({ capacity: { used: 0, total: 0 } })], settings: settings((s) => (s.pool.placement = "local-only")), chatLeases: 0, macHourlyUsd: null });
    assert.ok(never[0]!.rows.every((row) => !row.enabled));
    const limit = pickerGroups({ profiles, hosts: [host()], settings: settings(), chatLeases: 3, macHourlyUsd: null });
    assert.ok(limit.every((group) => group.rows.every((row) => !row.enabled)));
  });
  it("keeps capacity queueing within placement policy and chat limit", () => {
    const local = pickerGroups({ profiles, hosts: [host({ capacity: { used: 1, total: 1 } })], settings: settings((s) => (s.pool.placement = "local-only")), chatLeases: 0, macHourlyUsd: null });
    assert.ok(local[0]!.rows.every((row) => row.enabled && row.action === "queue"));
    assert.doesNotMatch(local[0]!.rows[0]!.hint ?? "", /rent/i);
    const none = pickerGroups({ profiles, hosts: [host({ capacity: { used: 0, total: 0 } })], settings: settings(), chatLeases: 0, macHourlyUsd: null });
    assert.ok(none[0]!.rows.every((row) => row.enabled && row.action === "queue"));
    assert.match(none[0]!.rows[0]!.hint ?? "", /rent/i);
    const limit = pickerGroups({ profiles, hosts: [host({ capacity: { used: 4, total: 4 } })], settings: settings(), chatLeases: 3, macHourlyUsd: null });
    assert.ok(limit[0]!.rows.every((row) => !row.enabled));
  });
  it("limits the picker to configured profiles", () => {
    const mac = host({ id: "box:b1", kind: "box", platforms: ["ios"], capacity: { used: 1, total: 3 } });
    const groups = pickerGroups({ profiles, hosts: [mac], settings: settings((s) => (s.ios.profiles = ["iphone-17-pro"])), chatLeases: 0, macHourlyUsd: null });
    const ios = groups.find((g) => g.platform === "ios")!;
    assert.deepEqual(ios.rows.map((row) => row.profile.id), ["iphone-17-pro"]);
  });
});
