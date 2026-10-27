import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  DEFAULT_DEVICES_SETTINGS,
  DEVICES_ACTION_EVENT,
  DEVICES_HOSTS_EVENT,
  DEVICES_LEASE_CLOSED_EVENT,
  DEVICES_LEASE_EVENT,
  DEVICES_SETTINGS_EVENT,
  DEVICES_SETUP_EVENT,
  DEVICE_PROFILES,
  type DeviceActionEntry,
  type DeviceHostSummary,
  type DeviceLeaseSummary,
  type DevicesStateResponse
} from "@orquester/api";

import {
  applyDevicesEvent,
  devicesStore,
  leasesOfThread,
  loadDeviceActions,
  loadDevices,
  openDevice,
  releaseDevice,
  resetDevices,
  setDeviceController,
  setDevicesPluginOn,
  startDeviceSetup,
  updateDevicesSettings,
  type DevicesApi
} from "./store.ts";
import { sanitizeDeviceHost, sanitizeDeviceLease, sanitizeDevicesState } from "./validate.ts";

const host = (over: Partial<DeviceHostSummary> = {}): DeviceHostSummary => ({
  id: "local",
  kind: "local",
  label: "This machine",
  platforms: ["android"],
  status: "ready",
  statusDetail: null,
  readiness: { ready: true, checks: [{ id: "kvm", label: "KVM", state: "ok", detail: null }], checkedAt: null },
  capacity: { used: 0, total: 4 },
  ...over
});

const lease = (id: string, over: Partial<DeviceLeaseSummary> = {}): DeviceLeaseSummary => ({
  id,
  key: `local/${id}`,
  threadId: "t1",
  hostId: "local",
  deviceId: id,
  platform: "android",
  profile: "pixel-9",
  name: "Pixel 9",
  osVersion: "Android 15",
  state: "ready",
  controller: "agent",
  openedBy: "agent",
  createdAt: `2026-10-27T10:0${id.length}:00.000Z`,
  lastUsedAt: "2026-10-27T10:00:00.000Z",
  ...over
});

const state = (over: Partial<DevicesStateResponse> = {}): DevicesStateResponse => ({
  enabled: true,
  hosts: [host()],
  leases: [lease("a")],
  profiles: [...DEVICE_PROFILES],
  settings: structuredClone(DEFAULT_DEVICES_SETTINGS),
  setupJobs: [],
  ...over
});

const entry = (id: string, leaseId = "a"): DeviceActionEntry => ({ id, leaseId, at: "2026-10-27T10:00:00.000Z", actor: "agent", kind: "tap", summary: "Tapped", ok: true, point: { x: 1, y: 2 } });

function fakeApi(over: Partial<DevicesApi> = {}, connection = "c1"): DevicesApi {
  return {
    connection: { id: connection },
    devicesState: async () => state(),
    deviceLeaseActions: async (leaseId) => ({ leaseId, actions: [entry("x1", leaseId)] }),
    openDeviceLease: async (req) => ({ lease: lease("new", { threadId: req.threadId, state: "starting", key: null, deviceId: null, openedBy: "user", controller: "user" }) }),
    releaseDeviceLease: async (leaseId) => ({ lease: lease(leaseId, { state: "released" }) }),
    setDeviceController: async (leaseId, controller) => ({ lease: lease(leaseId, { controller }) }),
    updateDevicesSettings: async (patch) => ({ settings: { ...structuredClone(DEFAULT_DEVICES_SETTINGS), android: { ...DEFAULT_DEVICES_SETTINGS.android, enabled: patch.android?.enabled ?? false } } }),
    startDeviceSetup: async (platform) => ({ job: { id: "j", platform, hostId: "local", state: "running", steps: [], percent: 5, logLine: null, error: null, startedAt: "x", finishedAt: null } }),
    ...over
  };
}

describe("devices store", () => {
  beforeEach(() => {
    setDevicesPluginOn(true);
    resetDevices();
  });

  it("loads the state and follows events, ignoring malformed ones", async () => {
    await loadDevices(fakeApi());
    assert.equal(devicesStore.getState().enabled, true);
    assert.deepEqual(devicesStore.getState().leases?.map((l) => l.id), ["a"]);

    applyDevicesEvent({ type: DEVICES_LEASE_EVENT, payload: { lease: lease("bb", { threadId: "t2" }) } });
    applyDevicesEvent({ type: DEVICES_LEASE_EVENT, payload: { lease: { id: "broken" } } });
    assert.deepEqual(devicesStore.getState().leases?.map((l) => l.id), ["a", "bb"]);
    assert.deepEqual(leasesOfThread(devicesStore.getState().leases, "t2").map((l) => l.id), ["bb"]);
    assert.equal(leasesOfThread(devicesStore.getState().leases, "none"), leasesOfThread(null, "x"), "a stable empty list");

    applyDevicesEvent({ type: DEVICES_ACTION_EVENT, payload: { leaseId: "a", threadId: "t1", entry: entry("e1") } });
    applyDevicesEvent({ type: DEVICES_ACTION_EVENT, payload: { leaseId: "a", threadId: "t1", entry: entry("e1") } });
    applyDevicesEvent({ type: DEVICES_ACTION_EVENT, payload: { leaseId: "a", threadId: "t1", entry: { ...entry("e2"), kind: "explode" } } });
    assert.deepEqual(devicesStore.getState().actions.a?.map((row) => row.id), ["e1"]);

    applyDevicesEvent({ type: DEVICES_HOSTS_EVENT, payload: { hosts: [host({ status: "failed" }), { id: "weird", kind: "mainframe" }] } });
    assert.deepEqual(devicesStore.getState().hosts?.map((h) => h.status), ["failed"]);

    applyDevicesEvent({ type: DEVICES_SETUP_EVENT, payload: { job: { id: "j", platform: "android", hostId: "local", state: "running", steps: [], percent: 140, logLine: "x", error: null, startedAt: "s", finishedAt: null } } });
    assert.equal(devicesStore.getState().setupJobs.android?.percent, 100);

    applyDevicesEvent({ type: DEVICES_SETTINGS_EVENT, payload: { settings: { android: { enabled: true } } } });
    assert.equal(devicesStore.getState().settings?.android.enabled, true);
    assert.equal(devicesStore.getState().settings?.leaseIdleMinutes, DEFAULT_DEVICES_SETTINGS.leaseIdleMinutes);

    applyDevicesEvent({ type: DEVICES_LEASE_CLOSED_EVENT, payload: { leaseId: "a", threadId: "t1", reason: "agent" } });
    assert.deepEqual(devicesStore.getState().leases?.map((l) => l.id), ["bb"]);
    assert.equal(devicesStore.getState().actions.a, undefined);
  });

  it("a load never undoes an event that landed while it was in flight", async () => {
    let answer!: (value: DevicesStateResponse) => void;
    const pending = loadDevices(fakeApi({ devicesState: () => new Promise((resolve) => (answer = resolve)) }));
    applyDevicesEvent({ type: DEVICES_LEASE_EVENT, payload: { lease: lease("late") } });
    answer(state({ leases: [], hosts: [host({ label: "From the load" })] }));
    await pending;
    assert.deepEqual(devicesStore.getState().leases?.map((l) => l.id), ["late"]);
    assert.equal(devicesStore.getState().hosts?.[0]?.label, "From the load");
  });

  it("mutations apply their answers; action logs merge with events; a connection switch resets", async () => {
    const api = fakeApi();
    await loadDevices(api);
    const opened = await openDevice(api, { threadId: "t3", platform: "android" });
    assert.equal(opened.state, "starting");
    assert.ok(devicesStore.getState().leases?.some((l) => l.id === "new"));
    assert.equal((await setDeviceController(api, "a", "user")).controller, "user");
    assert.equal(devicesStore.getState().leases?.find((l) => l.id === "a")?.controller, "user");
    await releaseDevice(api, "new");
    assert.ok(!devicesStore.getState().leases?.some((l) => l.id === "new"));
    assert.equal((await updateDevicesSettings(api, { android: { enabled: true } })).android.enabled, true);
    assert.equal((await startDeviceSetup(api, "android"))?.state, "running");

    applyDevicesEvent({ type: DEVICES_ACTION_EVENT, payload: { leaseId: "a", threadId: "t1", entry: entry("live") } });
    await loadDeviceActions(api, "a");
    assert.deepEqual(devicesStore.getState().actions.a?.map((row) => row.id), ["x1", "live"]);

    await loadDevices(fakeApi({}, "c2"));
    assert.equal(devicesStore.getState().actions.a, undefined);
  });

  it("the plugin off empties the store and drops events", async () => {
    await loadDevices(fakeApi());
    setDevicesPluginOn(false);
    assert.equal(devicesStore.getState().leases, null);
    applyDevicesEvent({ type: DEVICES_LEASE_EVENT, payload: { lease: lease("x") } });
    assert.equal(devicesStore.getState().leases, null);
  });
});

describe("devices validation", () => {
  it("reads what it knows and drops the rest", () => {
    assert.equal(sanitizeDevicesState({ enabled: true }), null);
    assert.equal(sanitizeDevicesState(state())?.leases.length, 1);
    assert.equal(sanitizeDeviceHost({ ...host(), kind: "mainframe" }), null);
    const parsed = sanitizeDeviceHost({ ...host(), box: { boxId: "b", provider: "blacksmith", hourlyUsd: "x", startedAt: "s" }, readiness: "nope" });
    assert.deepEqual(parsed?.box, { boxId: "b", provider: "blacksmith", hourlyUsd: null, startedAt: "s", deadlineAt: null });
    assert.deepEqual(parsed?.readiness, { ready: false, checks: [], checkedAt: null });
    assert.equal(sanitizeDeviceLease({ ...lease("a"), state: "parked" }), null);
    assert.deepEqual(sanitizeDeviceLease({ ...lease("a"), stream: { kind: "webrtc", deviceParam: "x" } })?.stream, undefined);
  });
});
