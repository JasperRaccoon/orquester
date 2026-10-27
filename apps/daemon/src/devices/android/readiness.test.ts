import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReadiness, ffmpegHasLibx264, FIX_ACTIONS, groupMembers, nodeMajor, type ReadinessProbe } from "./readiness.ts";

const ready: ReadinessProbe = {
  kvm: { access: "direct" },
  nodeVersion: "v24.22.1",
  ffmpeg: "libx264",
  java: true,
  packages: { cmdlineTools: true, platformTools: true, emulator: true, systemImage: true },
  avds: [{ profile: "pixel-9", label: "Pixel 9", created: true, snapshot: false }],
  tools: [
    { name: "expo-device-hub", version: "1", installed: true },
    { name: "agent-device", version: "2", installed: true }
  ]
};

const byId = (probe: ReadinessProbe) => new Map(evaluateReadiness(probe).map((check) => [check.id, check]));

test("readiness: everything installed is ready (golden snapshots are not a check; java only while installing)", () => {
  const checks = evaluateReadiness(ready);
  assert.ok(checks.every((check) => check.state === "ok"));
  assert.deepEqual(
    checks.map((check) => check.id),
    ["kvm", "node", "ffmpeg", "android-sdk", "system-image", "avd:pixel-9", "tool:expo-device-hub", "tool:agent-device"]
  );
  assert.match(byId(ready).get("avd:pixel-9")!.detail!, /first use/);
  assert.equal(byId({ ...ready, avds: [{ ...ready.avds[0]!, snapshot: true }] }).get("avd:pixel-9")!.detail, "Ready");
});

test("readiness: installable items carry their fix action; machine items do not", () => {
  const checks = byId({
    ...ready,
    kvm: { access: "denied", detail: "add the user to kvm" },
    nodeVersion: "v20.1.0",
    ffmpeg: "no-libx264",
    java: false,
    packages: { cmdlineTools: false, platformTools: true, emulator: false, systemImage: false },
    avds: [{ profile: "pixel-9", label: "Pixel 9", created: false, snapshot: false }],
    tools: [{ name: "agent-device", version: "2", installed: false }]
  });
  assert.equal(checks.get("kvm")!.state, "error");
  assert.equal(checks.get("kvm")!.fixActionId, undefined);
  assert.equal(checks.get("node")!.state, "error");
  assert.equal(checks.get("ffmpeg")!.state, "error");
  assert.equal(checks.get("java")!.state, "missing");
  assert.equal(checks.get("java")!.fixActionId, undefined);
  assert.equal(checks.get("android-sdk")!.fixActionId, FIX_ACTIONS.sdk);
  assert.match(checks.get("android-sdk")!.detail!, /command-line tools, emulator/);
  assert.equal(checks.get("system-image")!.fixActionId, "install-system-image");
  assert.equal(checks.get("avd:pixel-9")!.fixActionId, "create-avd:pixel-9");
  assert.equal(checks.get("tool:agent-device")!.fixActionId, "install-tool:agent-device");
});

test("readiness: kvm through sg is usable; a missing /dev/kvm is an error", () => {
  assert.equal(byId({ ...ready, kvm: { access: "sg" } }).get("kvm")!.state, "ok");
  assert.match(byId({ ...ready, kvm: { access: "sg" } }).get("kvm")!.detail!, /sg kvm/);
  assert.equal(byId({ ...ready, kvm: { access: "missing" } }).get("kvm")!.state, "error");
  assert.equal(byId({ ...ready, ffmpeg: "missing" }).get("ffmpeg")!.state, "missing");
});

test("probe parsers: node major, ffmpeg encoders, /etc/group members", () => {
  assert.equal(nodeMajor("v22.3.0"), 22);
  assert.equal(nodeMajor("garbage"), 0);
  assert.equal(ffmpegHasLibx264(" V....D libx264              libx264 H.264"), true);
  assert.equal(ffmpegHasLibx264(" V..... h264_vaapi"), false);
  const etc = "root:x:0:\nkvm:x:994:orquester,alice\ndocker:x:114:orquester\n";
  assert.deepEqual(groupMembers(etc, "kvm"), ["orquester", "alice"]);
  assert.deepEqual(groupMembers(etc, "video"), []);
});
