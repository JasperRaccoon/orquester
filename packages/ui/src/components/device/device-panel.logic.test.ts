import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, DEVICE_PROFILES, type DeviceHostSummary, type DeviceLeaseSummary, type DevicesSettings } from "@orquester/api";

import {
  activeLeaseOf,
  bootElapsed,
  bootSteps,
  controllerPill,
  deviceFoldRequest,
  deviceKeyOf,
  devicePanelView,
  deviceStreamUrls,
  deviceToolbarLayout,
  formatElapsed,
  hostStreamCaps,
  inputTakesOver,
  leaseName,
  lostDeviceText,
  NO_TRANSPORT_MESSAGE,
  nextRotation,
  pickerGroups,
  railToolbarHeight,
  rotateControl,
  streamAvailability,
  takeOverToast
} from "./device-panel.logic.ts";
import { chooseTransport } from "./stream/capabilities.ts";
import { effectiveDeviceViewMode } from "../../lib/devices/device-view-prefs.ts";

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
  it("lost-device reasons, names and keys", () => {
    // The daemon's reasons are sentences: one full stop, not two.
    assert.equal(lostDeviceText("Its host is gone."), "Its host is gone. Open a fresh one to keep going.");
    assert.equal(lostDeviceText("box destroyed"), "box destroyed. Open a fresh one to keep going.");
    assert.equal(lostDeviceText(null), "Its host or emulator stopped. Open a fresh one to keep going.");
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
  it("null off HTTP or without a stream", () => {
    const off = { deviceSocketUrl: () => null, deviceHttpRequest: () => null };
    assert.equal(deviceStreamUrls(off, lease()), null);
    assert.equal(deviceStreamUrls(api, lease({ stream: undefined })), null);
  });
});

describe("rotate", () => {
  it("asks for landscape from portrait and portrait from anything else", () => {
    assert.equal(nextRotation("portrait"), "landscape");
    for (const current of ["landscape_left", "landscape_right", "portrait_upside_down"] as const) assert.equal(nextRotation(current), "portrait");
  });
  it("iOS needs the input socket; Android (the daemon's user action) the live video; never twice at once", () => {
    assert.deepEqual(rotateControl("ios", { inputReady: true, live: false, pending: false }), { enabled: true, reason: null });
    assert.equal(rotateControl("ios", { inputReady: false, live: true, pending: false }).enabled, false);
    assert.deepEqual(rotateControl("android", { inputReady: false, live: true, pending: false }), { enabled: true, reason: null });
    assert.deepEqual(rotateControl("android", { inputReady: true, live: false, pending: false }), { enabled: false, reason: "Waiting for video" });
    assert.deepEqual(rotateControl("android", { inputReady: true, live: true, pending: true }), { enabled: false, reason: "Rotating…" });
  });
});

describe("host stream capabilities", () => {
  const full = { webCodecs: true, h264Baseline: true, h264High: true };
  const hosts = [
    { id: "box:mac", stream: { iosH264: true } },
    { id: "box:vm", stream: { iosH264: false } },
    { id: "box:old" }
  ];
  it("a physical Mac streams H.264 in 3D; an Apple VM or a host that says nothing streams MJPEG, flat", () => {
    assert.deepEqual(hostStreamCaps(hosts, "box:mac"), { h264: true });
    const mac = chooseTransport({ platform: "ios", hostCaps: hostStreamCaps(hosts, "box:mac"), browserCaps: full });
    assert.equal(mac, "serve-sim-h264");
    assert.equal(effectiveDeviceViewMode({ mode: null }, mac), "3d");
    for (const hostId of ["box:vm", "box:old", "box:gone"]) {
      assert.deepEqual(hostStreamCaps(hosts, hostId), { h264: false }, hostId);
      const vm = chooseTransport({ platform: "ios", hostCaps: hostStreamCaps(hosts, hostId), browserCaps: full });
      assert.equal(vm, "serve-sim-mjpeg", hostId);
      assert.equal(effectiveDeviceViewMode({ mode: null }, vm), "flat", hostId);
    }
  });
});

describe("the toolbar's place", () => {
  it("the rail's height follows DeviceToolbar's buttons: 7 on iOS, 8 on Android, Fold/Unfold beside on foldables", () => {
    assert.equal(railToolbarHeight({ platform: "ios", foldable: false, foldError: false }), 16 + 10 + 7 * 34 + 5);
    assert.equal(railToolbarHeight({ platform: "android", foldable: false, foldError: false }), 303);
    // As measured in the harness: a Pixel Fold's rail is 371 px tall, plus the rail's 16 px padding.
    assert.equal(railToolbarHeight({ platform: "android", foldable: true, foldError: false }), 387);
    assert.ok(railToolbarHeight({ platform: "android", foldable: true, foldError: true }) > 387);
  });
  it("a rail taller than the room beside the device becomes the bar below it (never over the activity drawer)", () => {
    const fold = railToolbarHeight({ platform: "android", foldable: true, foldError: false });
    // A narrow rail at 577 px tall leaves 362 px beside the device: the bar.
    assert.equal(deviceToolbarLayout("rail", 362, fold), "bar");
    assert.equal(deviceToolbarLayout("rail", 362, railToolbarHeight({ platform: "android", foldable: false, foldError: false })), "rail");
    assert.equal(deviceToolbarLayout("rail", fold, fold), "rail");
    // Unmeasured (no layout yet, or a DOM without one): the panel's choice; a phone keeps its bar.
    assert.equal(deviceToolbarLayout("rail", null, fold), "rail");
    assert.equal(deviceToolbarLayout("rail", 0, fold), "rail");
    assert.equal(deviceToolbarLayout("bar", 2000, fold), "bar");
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
  it("explains disabled rows: platform off, host needs setup, a host the pool can never use, chat limit", () => {
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
    // Kept on this host, which has no room at all: the pool can never place it.
    const never = pickerGroups({ profiles, hosts: [host({ capacity: { used: 0, total: 0 } })], settings: settings((s) => (s.pool.placement = "local-only")), chatLeases: 0, macHourlyUsd: null });
    assert.ok(never[0]!.rows.every((row) => !row.enabled && row.badge === "No room" && row.action === "open"));
    assert.match(never[0]!.rows[0]!.reason!, /no room/);
    const limit = pickerGroups({ profiles, hosts: [host()], settings: settings(), chatLeases: 3, macHourlyUsd: null });
    assert.ok(limit.every((g) => g.rows.every((row) => !row.enabled && row.badge === "Limit reached")));
  });
  it("a full host queues: Open answers at once with a stand-in the pool places when a slot frees up (or on a rented host)", () => {
    const full = pickerGroups({ profiles, hosts: [host({ capacity: { used: 4, total: 4 } })], settings: settings(), chatLeases: 0, macHourlyUsd: null });
    const android = full[0]!;
    assert.ok(android.rows.every((row) => row.enabled && row.reason === null && row.badge === "Full" && row.action === "queue"));
    assert.equal(android.rows[0]!.hint, "All 4 slots are in use — it opens when one frees up, or on a rented host if the fleet allows.");
    assert.equal(android.note, "Runs on this host · 4 of 4 in use — a new device waits for a slot");
    // Kept on this host: only a freed slot opens it.
    const local = pickerGroups({ profiles, hosts: [host({ capacity: { used: 1, total: 1 } })], settings: settings((s) => (s.pool.placement = "local-only")), chatLeases: 0, macHourlyUsd: null });
    assert.equal(local[0]!.rows[0]!.hint, "All 1 slot is in use — it opens when one frees up.");
    // A host with no room that may rent: it waits for a rented host.
    const none = pickerGroups({ profiles, hosts: [host({ capacity: { used: 0, total: 0 } })], settings: settings(), chatLeases: 0, macHourlyUsd: null });
    assert.ok(none[0]!.rows.every((row) => row.enabled && row.action === "queue"));
    assert.match(none[0]!.rows[0]!.hint!, /rented host/);
    // A ready host with room opens at once, no tooltip; the chat's limit still wins over queueing.
    const ready = pickerGroups({ profiles, hosts: [host()], settings: settings(), chatLeases: 0, macHourlyUsd: null });
    assert.ok(ready[0]!.rows.every((row) => row.action === "open" && row.hint === null));
    const limit = pickerGroups({ profiles, hosts: [host({ capacity: { used: 4, total: 4 } })], settings: settings(), chatLeases: 3, macHourlyUsd: null });
    assert.ok(limit[0]!.rows.every((row) => !row.enabled && row.badge === "Limit reached" && row.action === "open" && row.hint === null));
  });
  it("lists only the profiles Settings offers, and a running Mac host opens in seconds", () => {
    const mac = host({ id: "box:b1", kind: "box", platforms: ["ios"], capacity: { used: 1, total: 3 } });
    const groups = pickerGroups({ profiles, hosts: [mac], settings: settings((s) => (s.ios.profiles = ["iphone-17-pro"])), chatLeases: 0, macHourlyUsd: null });
    const ios = groups.find((g) => g.platform === "ios")!;
    assert.deepEqual(ios.rows.map((row) => row.profile.id), ["iphone-17-pro"]);
    assert.match(ios.note!, /A Mac host is running/);
  });
});
