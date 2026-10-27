import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ANDROID_SDK_STEP_SCRIPT, APPLE_RUNNER_STEP_SCRIPT, DEVICE_TOOLS_STEP_SCRIPT, KVM_STEP_SCRIPT } from "./device-cache.ts";

test("device tool installation uses the lockfile without dependency lifecycle scripts", () => {
  assert.match(DEVICE_TOOLS_STEP_SCRIPT, /npm ci[^\n]*--ignore-scripts/);
});

test("the Android cache installs the x86_64 API 35 image and SDK tools", () => {
  for (const pkg of ["platform-tools", "emulator", "system-images;android-35;google_apis;x86_64"]) {
    assert.ok(ANDROID_SDK_STEP_SCRIPT.includes(`'${pkg}'`));
  }
});

test("the KVM step installs the udev rule that opens /dev/kvm to every user", () => {
  const dir = mkdtempSync(join(tmpdir(), "orq-kvm-step-"));
  try {
    const rule = join(dir, "rule");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "sudo"), '#!/bin/sh\nif [ "$1" = tee ]; then cat > "$RULE"; elif [ "$1" != udevadm ]; then exit 1; fi\n');
    chmodSync(join(bin, "sudo"), 0o755);
    const result = spawnSync("bash", ["-c", KVM_STEP_SCRIPT], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RULE: rule } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(rule, "utf8").trim(), 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the iOS runner build picks the newest available iOS runtime and its newest iPhone", () => {
  const dir = mkdtempSync(join(tmpdir(), "orq-apple-step-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const created = join(dir, "created");
    const data = join(dir, "runtimes.json");
    // Stop at the native creation boundary; no simulator or agent-device is started on this host.
    writeFileSync(join(bin, "xcrun"), '#!/bin/sh\nif [ "$*" = "simctl list -j runtimes" ]; then cat "$RUNTIMES"; elif [ "$1 $2" = "simctl create" ]; then printf "%s\\n" "$@" > "$CREATED"; exit 1; else exit 7; fi\n');
    chmodSync(join(bin, "xcrun"), 0o755);
    const phone = (id: string) => ({ identifier: `com.apple.CoreSimulator.SimDeviceType.${id}`, productFamily: "iPhone" });
    const runtime = (version: string, extra: Record<string, unknown> = {}) => ({
      identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(/\./g, "-")}`,
      version,
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [phone("iPhone-16"), phone("iPhone-17-Pro"), { identifier: "iPad-Pro", productFamily: "iPad" }],
      ...extra
    });
    writeFileSync(data, JSON.stringify({ runtimes: [runtime("26.4.1"), runtime("27.0"), runtime("26.10"), runtime("28.0", { isAvailable: false }), { platform: "watchOS", version: "30.0", isAvailable: true }] }));
    const run = () => spawnSync("bash", ["-c", APPLE_RUNNER_STEP_SCRIPT], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNTIMES: data, CREATED: created } });
    assert.equal(run().status, 1, "the fixture stops after recording the selected simulator");
    assert.deepEqual(readFileSync(created, "utf8").trim().split("\n").slice(-2), ["com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "com.apple.CoreSimulator.SimRuntime.iOS-27-0"]);
    rmSync(created);
    writeFileSync(data, JSON.stringify({ runtimes: [] }));
    assert.notEqual(run().status, 0);
    assert.throws(() => readFileSync(created), { code: "ENOENT" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
