import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deviceProfile } from "@orquester/api";

import { evaluateReadiness } from "../../android/readiness.ts";
import { profileHash } from "../../toolchain/android-sdk.ts";
import { macAndroidBlocker, macAndroidCapacity, macAndroidChecks, macProfile, parseMacAndroidProbe } from "./android-darwin.ts";
import { boxGpuModes, gpuSignature, usableHostGpu } from "./android-remote.ts";

// `MAC_ANDROID_PROBE_SCRIPT` on an M4 Max (macOS 26.2, Homebrew ffmpeg, no Java), the user redacted.
const M4_MAX = `path=/Users/owner/.orquester/devices/android/ffmpeg/bin:/Users/owner/.local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/owner/.nvm/versions/node/v22.21.1/bin:/usr/bin:/bin:/usr/sbin:/sbin
os=Darwin
arch=arm64
user=owner
node=/Users/owner/.nvm/versions/node/v22.21.1/bin/node
node_version=v22.21.1
npm=/Users/owner/.nvm/versions/node/v22.21.1/bin/npm
hvf=1
vm=0
chip=Apple M4 Max
cpus=14
mem_total_bytes=38654705664
mem_available_bytes=27725021184
ffmpeg_path=/opt/homebrew/bin/ffmpeg
ffmpeg=libx264
java=0
java_home=
unzip=1
disk_free_kb=482922216
`;

const GiB = 1024 ** 3;

describe("Android on an Apple Silicon Mac", () => {
  it("reads the Mac's probe: Hypervisor.framework, its Metal GPU first for golden snapshots, the software modes after a failed host boot", () => {
    const probe = parseMacAndroidProbe(M4_MAX);
    assert.equal(macAndroidBlocker(probe, "Studio"), null);
    assert.deepEqual(
      { cpus: probe.cpus, memTotal: probe.memTotalBytes, memFree: probe.memAvailableBytes, disk: probe.diskFreeBytes, ffmpeg: probe.ffmpeg, java: probe.java, kvm: probe.kvm.access },
      { cpus: 14, memTotal: 36 * GiB, memFree: 27725021184, disk: 482922216 * 1024, ffmpeg: "libx264", java: false, kvm: "direct" }
    );
    const gpu = usableHostGpu(probe.gpu);
    assert.deepEqual(gpu, { kind: "apple", detail: "Apple M4 Max (Metal)", env: {} });
    assert.deepEqual(boxGpuModes("byo", gpu, null, "37.3.10"), ["host", "swangle_indirect", "swiftshader_indirect"]);
    assert.deepEqual(boxGpuModes("byo", gpu, gpuSignature(gpu!, "37.3.10"), "37.3.10"), ["swangle_indirect", "swiftshader_indirect"]);
    // A newer emulator tries Metal again.
    assert.equal(boxGpuModes("byo", gpu, gpuSignature(gpu!, "37.3.10"), "37.4.1")[0], "host");
  });

  it("refuses a virtual Mac, which has no Hypervisor.framework to give an emulator", () => {
    const vm = parseMacAndroidProbe(M4_MAX.replace("hvf=1", "hvf=0").replace("vm=0", "vm=1"));
    assert.match(macAndroidBlocker(vm, "Mac host (Blacksmith)") ?? "", /virtual Mac/);
    assert.equal(macAndroidChecks(evaluateReadiness(readinessOf()), vm).find((check) => check.id === "hvf")?.state, "error");
  });

  it("names Hypervisor.framework in its checklist and installs ffmpeg and Java itself", () => {
    const checks = macAndroidChecks(evaluateReadiness({ ...readinessOf(), ffmpeg: "missing", java: false }), parseMacAndroidProbe(M4_MAX));
    assert.equal(checks.find((check) => check.id === "kvm"), undefined);
    assert.deepEqual(checks.find((check) => check.id === "hvf")?.state, "ok");
    for (const id of ["ffmpeg", "java"]) {
      const check = checks.find((entry) => entry.id === id)!;
      assert.equal(check.state, "missing");
      assert.ok(check.fixActionId, `${id} is fixed by preparing the host`);
    }
  });

  it("runs arm64-v8a images: a profile's AVD and golden identity differ from its x86_64 one", () => {
    const pixel = deviceProfile("pixel-9")!;
    const mac = macProfile(pixel);
    assert.equal(mac.systemImage, "system-images;android-35;google_apis;arm64-v8a");
    assert.notEqual(profileHash(mac), profileHash(pixel));
  });

  it("shares the Mac with its simulators: what they hold comes off the emulators' room", () => {
    const base = { cpus: 14, hostBytes: 36 * GiB, memAvailableBytes: 30 * GiB, freeDiskBytes: 400 * GiB, running: 0 };
    assert.equal(macAndroidCapacity({ ...base, ios: { devices: 0, bytes: 0 } }), 6);
    // Three stock simulators leased (5 GiB budget each): the ceiling drops to 3, even before they show in free memory.
    assert.equal(macAndroidCapacity({ ...base, ios: { devices: 3, bytes: 15 * GiB } }), 3);
    // A Mac full of simulators leaves no room.
    assert.equal(macAndroidCapacity({ ...base, ios: { devices: 8, bytes: 28 * GiB } }), 0);
  });
});

function readinessOf() {
  return {
    kvm: { access: "direct" as const },
    nodeVersion: "v22.21.1",
    ffmpeg: "libx264" as const,
    java: true,
    packages: { cmdlineTools: false, platformTools: false, emulator: false, systemImage: false },
    avds: [],
    tools: []
  };
}
