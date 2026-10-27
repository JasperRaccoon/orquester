import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DEVICES_SETTINGS, DEVICES_SETTINGS_LIMITS, parseDevicesSettingsPatch, type DeviceHostSummary, type DeviceSetupJob } from "@orquester/api";

import {
  fixLabel,
  formatUptime,
  macHosts,
  macHostView,
  noMacHostText,
  nullableText,
  parseSettingNumber,
  PLACEMENT_LABELS,
  profilesPatch,
  readinessSummary,
  setupJobView,
  toggledProfiles,
  toolRows
} from "./devices-settings.logic.ts";

const accepted = (patch: unknown) => {
  const parsed = parseDevicesSettingsPatch(patch);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
};

test("number fields: limits, whole numbers and junk", () => {
  const L = DEVICES_SETTINGS_LIMITS.maxLocalDevices;
  assert.deepEqual(parseSettingNumber("6", L, { integer: true }), { ok: true, value: 6 });
  assert.deepEqual(parseSettingNumber(" 12 ", L, { integer: true }), { ok: true, value: 12 });
  assert.deepEqual(parseSettingNumber("0", L, { integer: true }), { ok: false, message: "Between 1 and 32." });
  assert.deepEqual(parseSettingNumber("33", L, { integer: true }), { ok: false, message: "Between 1 and 32." });
  assert.deepEqual(parseSettingNumber("2.5", L, { integer: true }), { ok: false, message: "Enter a whole number." });
  assert.deepEqual(parseSettingNumber("", L), { ok: false, message: "Enter a number." });
  assert.deepEqual(parseSettingNumber("6abc", L), { ok: false, message: "Enter a number." });
  assert.deepEqual(parseSettingNumber("1e3", L), { ok: false, message: "Enter a number." });
  assert.deepEqual(parseSettingNumber("99.5", DEVICES_SETTINGS_LIMITS.monthlyCapUsd), { ok: true, value: 99.5 });
  for (const [key, limits] of Object.entries(DEVICES_SETTINGS_LIMITS)) {
    const min = parseSettingNumber(String(limits.min), limits, { integer: key !== "monthlyCapUsd" && key !== "maxHourlyUsd" });
    assert.ok(min.ok, key);
  }
});

test("every patch the page builds is one the daemon accepts", () => {
  const settings = structuredClone(DEFAULT_DEVICES_SETTINGS);
  accepted({ android: { enabled: true } });
  accepted({ android: { maxLocalDevices: 4 } });
  accepted(profilesPatch(settings, "android", "pixel-fold", false));
  accepted(profilesPatch(settings, "ios", "iphone-duo", false));
  accepted({ ios: { size: "blacksmith-6vcpu-macos-26", lifetimeMinutes: 240, idleTeardownMinutes: 20, maxSimulatorsPerHost: 3 } });
  accepted({ ios: { rentWithoutAsking: true, monthlyCapUsd: 150.5 } });
  accepted({ agents: { enabled: false, followAgentDevices: false } });
  accepted({ leaseIdleMinutes: 30, maxLeasesPerChat: 2 });
  accepted({ pool: { placement: "pool-only", provider: nullableText("  "), androidSize: nullableText("ccx23"), iosSize: null } });
  accepted({ pool: { androidLifetimeMinutes: 90 } });
  accepted({ pool: { maxHosts: 0, maxHourlyUsd: 12.5, idleTeardownMinutes: 10, capacityWaitSeconds: 60, rentWithoutAsking: true } });
  accepted({ pool: { minWarmHosts: { android: 1 } } });
});

test("profiles keep the catalogue's order and drop unknown ids", () => {
  assert.deepEqual(toggledProfiles(["pixel-fold"], "pixel-9", true, "android"), ["pixel-9", "pixel-fold"]);
  assert.deepEqual(toggledProfiles(["pixel-9", "pixel-fold"], "pixel-9", false, "android"), ["pixel-fold"]);
  assert.deepEqual(toggledProfiles(["pixel-from-the-future", "pixel-9"], "pixel-tablet", true, "android"), ["pixel-9", "pixel-tablet"]);
  assert.deepEqual(toggledProfiles([], "iphone-17-pro", true, "android"), []);
});

test("readiness summary and per-check fixes", () => {
  assert.equal(readinessSummary([]).label, "Not checked yet");
  const s = readinessSummary([{ state: "ok" }, { state: "ok" }, { state: "missing" }, { state: "error" }]);
  assert.deepEqual(s, { ok: 2, total: 4, label: "2 of 4 ready", canInstall: true, canRepair: true, working: false });
  assert.equal(readinessSummary([{ state: "ok" }, { state: "ok" }]).label, "All 2 ready");
  assert.equal(readinessSummary([{ state: "working" }]).working, true);
  assert.equal(fixLabel({ state: "missing", fixActionId: "install-sdk" }), "Install");
  assert.equal(fixLabel({ state: "error", fixActionId: "repair" }), "Repair");
  assert.equal(fixLabel({ state: "error" }), null);
  assert.equal(fixLabel({ state: "ok", fixActionId: "x" }), null);
});

const job = (patch: Partial<DeviceSetupJob>): DeviceSetupJob => ({
  id: "j",
  platform: "android",
  hostId: "local",
  state: "running",
  steps: [
    { id: "a", label: "SDK", state: "done", detail: null },
    { id: "b", label: "Image", state: "running", detail: "40%" },
    { id: "c", label: "AVD", state: "pending", detail: null }
  ],
  percent: 42.4,
  logLine: "Downloading…",
  error: null,
  startedAt: "2026-10-27T10:00:00.000Z",
  finishedAt: null,
  ...patch
});

test("setup job view: hidden when done, percent clamped, icons per step", () => {
  assert.equal(setupJobView(undefined), null);
  assert.equal(setupJobView(job({ state: "done" })), null);
  const running = setupJobView(job({}))!;
  assert.equal(running.title, "Setting up… 42%");
  assert.equal(running.percent, 42);
  assert.deepEqual(running.steps.map((step) => step.icon), ["done", "spinner", "pending"]);
  assert.equal(setupJobView(job({ percent: 140 }))!.percent, 100);
  assert.equal(setupJobView(job({ percent: -3 }))!.percent, 0);
  assert.equal(setupJobView(job({ percent: null }))!.title, "Setting up…");
  const failed = setupJobView(job({ state: "failed", error: null }))!;
  assert.equal(failed.title, "Setup failed");
  assert.ok(failed.error);
  assert.equal(setupJobView(job({ state: "cancelled" }))!.title, "Setup cancelled");
});

const host = (patch: Partial<DeviceHostSummary>): DeviceHostSummary => ({
  id: "box:b1",
  kind: "box",
  label: "Mac host 1",
  platforms: ["ios"],
  status: "ready",
  statusDetail: null,
  readiness: { ready: true, checks: [], checkedAt: null },
  capacity: { used: 1, total: 3 },
  ...patch
});

test("Mac hosts: which, and how their cost reads", () => {
  const local = host({ id: "local", kind: "local", platforms: ["android"] });
  const mac = host({ box: { boxId: "b1", provider: "blacksmith", hourlyUsd: 4.8, startedAt: "2026-10-27T10:00:00.000Z", deadlineAt: "2026-10-27T14:00:00.000Z" } });
  assert.deepEqual(macHosts([local, mac]), [mac]);
  const now = Date.parse("2026-10-27T12:05:00.000Z");
  const view = macHostView(mac, now);
  assert.equal(view.rate, "$4.80/h");
  assert.equal(view.uptime, "2h 05m");
  assert.equal(view.costSoFar, "$10.00");
  assert.equal(view.countdown, "1h 55m left");
  assert.equal(view.line, "$4.80/h · up 2h 05m · ~$10.00 so far");
  assert.equal(macHostView(host({ statusDetail: "Renting…" }), now).line, "Renting…");
  assert.equal(formatUptime(45 * 60_000), "45m");
  assert.equal(formatUptime(27 * 3_600_000), "1d 3h");
  assert.equal(noMacHostText(4.8), "No Mac host running — the first iPhone or iPad rents one (~$4.80/h).");
  assert.equal(noMacHostText(null), "No Mac host running — the first iPhone or iPad rents one.");
});

test("tools: tool:* checks of every host", () => {
  const rows = toolRows([
    host({
      id: "local",
      label: "This machine",
      readiness: {
        ready: false,
        checkedAt: null,
        checks: [
          { id: "kvm", label: "KVM", state: "ok", detail: null },
          { id: "tool:agent-device", label: "agent-device", state: "ok", detail: "0.21.31" },
          { id: "tool:expo-device-hub", label: "expo-device-hub", state: "missing", detail: "0.19.0-canary" }
        ]
      }
    })
  ]);
  assert.deepEqual(
    rows.map((row) => [row.id, row.detail, row.state, row.hostLabel]),
    [
      ["local:tool:agent-device", "0.21.31", "ok", "This machine"],
      ["local:tool:expo-device-hub", "0.19.0-canary", "missing", "This machine"]
    ]
  );
});

test("placement labels cover every mode", () => {
  assert.deepEqual(Object.keys(PLACEMENT_LABELS).sort(), ["local-only", "pool-only", "prefer-local"]);
});
