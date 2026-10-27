import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DEVICES_SETTINGS, type DeviceHostSummary } from "@orquester/api";

import {
  fixLabel,
  macHosts,
  macHostView,
  parseSettingNumber,
  profilesPatch,
  readinessSummary,
  toolRows
} from "./devices-settings.logic.ts";

test("number fields: limits, whole numbers and junk", () => {
  const limits = { min: 1, max: 32 };
  assert.deepEqual(parseSettingNumber(" 12 ", limits, { integer: true }), { ok: true, value: 12 });
  for (const text of ["0", "33", "2.5", "", "6abc"]) assert.equal(parseSettingNumber(text, limits, { integer: true }).ok, false, text);
  assert.deepEqual(parseSettingNumber("99.5", { min: 0, max: 1000 }), { ok: true, value: 99.5 });
});

test("profiles keep the catalogue's order and drop unknown ids", () => {
  const settings = structuredClone(DEFAULT_DEVICES_SETTINGS);
  settings.android.profiles = ["pixel-from-the-future", "pixel-fold"];
  settings.ios.profiles = ["iphone-17-pro", "iphone-duo"];
  assert.deepEqual(profilesPatch(settings, "android", "pixel-9", true), { android: { profiles: ["pixel-9", "pixel-fold"] } });
  assert.deepEqual(profilesPatch(settings, "android", "iphone-17-pro", true), { android: { profiles: ["pixel-fold"] } });
  assert.deepEqual(profilesPatch(settings, "ios", "iphone-duo", false), { ios: { profiles: ["iphone-17-pro"] } });
});

test("enables actionable setup repairs from readiness state", () => {
  const summary = readinessSummary([{ state: "ok" }, { state: "missing" }, { state: "error" }]);
  assert.equal(summary.canInstall, true);
  assert.equal(summary.canRepair, true);
  assert.equal(summary.working, false);
  assert.equal(readinessSummary([{ state: "working" }]).working, true);
  const complete = readinessSummary([{ state: "ok" }]);
  assert.equal(complete.canInstall, false);
  assert.equal(complete.canRepair, false);
  assert.equal(fixLabel({ state: "error", fixActionId: "repair" }), "Repair");
  assert.equal(fixLabel({ state: "error" }), null);
  assert.equal(fixLabel({ state: "ok", fixActionId: "x" }), null);
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

test("selects rented Mac hosts and derives cost from actual uptime", () => {
  const local = host({ id: "local", kind: "local", platforms: ["android"] });
  const mac = host({ box: { boxId: "b1", provider: "blacksmith", hourlyUsd: 4.8, startedAt: "2026-10-27T10:00:00.000Z", deadlineAt: "2026-10-27T14:00:00.000Z" } });
  assert.deepEqual(macHosts([local, mac]).map((item) => item.id), ["box:b1"]);
  const view = macHostView(mac, Date.parse("2026-10-27T12:05:00.000Z"));
  assert.equal(view.rate, "$4.80/h");
  assert.equal(view.uptime, "2h 05m");
  assert.equal(view.costSoFar, "$10.00");
  assert.equal(view.countdown, "1h 55m left");
});

test("lists tool versions and readiness under their host", () => {
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
    rows.map((row) => [row.label, row.detail, row.state, row.hostLabel]),
    [
      ["agent-device", "0.21.31", "ok", "This machine"],
      ["expo-device-hub", "0.19.0-canary", "missing", "This machine"]
    ]
  );
});
