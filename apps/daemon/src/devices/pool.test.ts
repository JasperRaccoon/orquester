import assert from "node:assert/strict";
import test from "node:test";

import { defaultDevicesSettings, type DevicesSettings } from "@orquester/config";

import { choosePlacement, type PlacementHost } from "./pool.ts";

const settings = (patch: (s: DevicesSettings) => void = () => undefined): DevicesSettings => {
  const s = defaultDevicesSettings();
  s.android.enabled = true;
  s.ios.enabled = true;
  patch(s);
  return s;
};

const host = (id: string, extra: Partial<PlacementHost> = {}): PlacementHost => ({
  id,
  kind: id === "local" ? "local" : "box",
  platforms: id === "local" ? ["android"] : ["ios"],
  status: "ready",
  checks: [],
  used: 0,
  total: 2,
  ...extra
});

test("a platform that is off is disabled", () => {
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [host("local")], settings: settings((s) => void (s.android.enabled = false)), canProvision: false }), { kind: "disabled" });
});

test("local first, then the busiest box host with room (best fit)", () => {
  const hosts = [host("box:a", { used: 0, total: 3 }), host("box:b", { used: 2, total: 3 }), host("box:c", { used: 3, total: 3 })];
  assert.deepEqual(choosePlacement({ platform: "ios", hosts, settings: settings(), canProvision: true }), { kind: "host", hostId: "box:b" });
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [host("local")], settings: settings(), canProvision: false }), { kind: "host", hostId: "local" });
});

test("no room: wait for a starting host, set up a fixable one, rent one, or report full / not ready", () => {
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [host("box:a", { status: "starting" })], settings: settings(), canProvision: true }), { kind: "wait", hostId: "box:a" });
  const fixable = host("local", {
    status: "needs-setup",
    checks: [
      { id: "kvm", label: "KVM", state: "ok", detail: null },
      { id: "android-sdk", label: "SDK", state: "missing", detail: null, fixActionId: "install-android-sdk" }
    ]
  });
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [fixable], settings: settings(), canProvision: false }), { kind: "setup", hostId: "local", actions: ["install-android-sdk"] });
  const unfixable = host("local", { status: "needs-setup", checks: [{ id: "kvm", label: "KVM", state: "missing", detail: null }] });
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [unfixable], settings: settings(), canProvision: false }), {
    kind: "not-ready",
    hostId: "local",
    missing: [{ id: "kvm", label: "KVM", state: "missing", detail: null }]
  });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [host("box:a", { used: 2 })], settings: settings(), canProvision: true }), { kind: "provision", platform: "ios" });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [host("box:a", { used: 2 })], settings: settings(), canProvision: false }), { kind: "full", hostIds: ["box:a"] });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [], settings: settings(), canProvision: false }), { kind: "not-ready", hostId: null, missing: [] });
});

test("placement modes and a named host", () => {
  const hosts = [host("local", { platforms: ["android"] }), host("box:l", { platforms: ["android"] })];
  assert.deepEqual(choosePlacement({ platform: "android", hosts, settings: settings((s) => void (s.pool.placement = "pool-only")), canProvision: false }), { kind: "host", hostId: "box:l" });
  assert.deepEqual(
    choosePlacement({ platform: "android", hosts: [host("local", { used: 2 })], settings: settings((s) => void (s.pool.placement = "local-only")), canProvision: true }),
    { kind: "full", hostIds: ["local"] }
  );
  assert.deepEqual(choosePlacement({ platform: "android", hosts, settings: settings(), canProvision: true, hostId: "box:l" }), { kind: "host", hostId: "box:l" });
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [host("local", { draining: true })], settings: settings(), canProvision: false }), { kind: "not-ready", hostId: "local", missing: [] });
});

test("a research host (vphone) takes only a request that names it", () => {
  const research = host("vphone:mac1", { kind: "byo", research: true });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [research], settings: settings(), canProvision: false }), { kind: "not-ready", hostId: null, missing: [] });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [research, host("box:a", { used: 1 })], settings: settings(), canProvision: false }), { kind: "host", hostId: "box:a" });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [research], settings: settings(), canProvision: false, hostId: "vphone:mac1" }), { kind: "host", hostId: "vphone:mac1" });
});
