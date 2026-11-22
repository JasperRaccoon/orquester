import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { androidProbeProblems, boxAndroidCapacity, boxGpuModes, gpuSignature, parseAndroidProbe, rendersInSoftware, usableHostGpu } from "./android-remote.ts";

const GiB = 1024 ** 3;

/** A probe's output for an own Linux machine (what `ANDROID_PROBE_SCRIPT` prints), with `lines` added or replacing. */
function probe(lines: readonly string[] = []) {
  const base = new Map([
    ["os", "Linux"],
    ["user", "jasper"],
    ["node", "/usr/bin/node"],
    ["node_version", "v22.11.0"],
    ["kvm", "direct"],
    ["ffmpeg", "libx264"],
    ["cpus", "24"],
    ["groups", "jasper sudo kvm"],
    ["kvm_mode", "660"],
    ["linger", "1"]
  ]);
  const render: string[] = [];
  for (const line of lines) {
    const [key, value] = [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)];
    if (key === "render") render.push(line);
    else base.set(key, value);
  }
  return parseAndroidProbe([...[...base].map(([key, value]) => `${key}=${value}`), ...render].join("\n"));
}

describe("GPU modes of an own machine's golden snapshot", () => {
  it("tries -gpu host first only where the probe found a GPU it can render on, then the software modes", () => {
    const nvidia = usableHostGpu(probe(["nvidia=550.54.14", "nvidia_dev=1"]).gpu);
    assert.equal(nvidia?.kind, "nvidia");
    assert.deepEqual(boxGpuModes("byo", nvidia, null, "37.2.12"), ["host", "swangle_indirect", "swiftshader_indirect"]);
    const mesa = usableHostGpu(probe(["render=renderD128:amdgpu:1"]).gpu);
    assert.equal(mesa?.kind, "mesa");
    // A driver loaded whose device nodes the account cannot open, or a virtual GPU: no host mode.
    const closed = usableHostGpu(probe(["nvidia=550.54.14", "nvidia_dev=0", "render=renderD128:virtio_gpu:1", "render=renderD129:amdgpu:0"]).gpu);
    assert.equal(closed, null);
    assert.deepEqual(boxGpuModes("byo", closed, null, "37.2.12"), ["swangle_indirect", "swiftshader_indirect"]);
  });

  it("rented runners keep the device cache's order whatever their GPU", () => {
    const gpu = usableHostGpu(probe(["nvidia=550.54.14", "nvidia_dev=1"]).gpu);
    assert.ok(!boxGpuModes("box", gpu, null, "37.2.12").includes("host"));
  });

  it("after host mode failed on a GPU and emulator, goes straight to software until either changes", () => {
    const gpu = usableHostGpu(probe(["nvidia=550.54.14", "nvidia_dev=1"]).gpu)!;
    const failedOn = gpuSignature(gpu, "37.2.12");
    assert.deepEqual(boxGpuModes("byo", gpu, failedOn, "37.2.12"), ["swangle_indirect", "swiftshader_indirect"]);
    assert.equal(boxGpuModes("byo", gpu, failedOn, "37.3.1")[0], "host");
    const newDriver = usableHostGpu(probe(["nvidia=560.35.03", "nvidia_dev=1"]).gpu)!;
    assert.equal(boxGpuModes("byo", newDriver, failedOn, "37.2.12")[0], "host");
  });

  it("a boot that fell back to a software rasterizer does not count as host rendering", () => {
    assert.equal(rendersInSoftware("RenderEngine\nGLES: Google (Google Inc.), Android Emulator OpenGL ES Translator (Google SwiftShader), OpenGL ES 3.0\n"), true);
    assert.equal(rendersInSoftware("GLES: Google (NVIDIA Corporation), Android Emulator OpenGL ES Translator (NVIDIA GeForce RTX 3080 Ti/PCIe/SSE2), OpenGL ES 3.0\n"), false);
    // No renderer line: nothing to go on, the boot stands.
    assert.equal(rendersInSoftware("Display 0 HWC layers:\n"), false);
  });
});

describe("an own Linux machine's probe problems", () => {
  it("names /dev/kvm reached only through the desktop login, with the kvm group fix", () => {
    const [problem] = androidProbeProblems(probe(["groups=jasper sudo"]), "jasper");
    assert.equal(problem?.code, "kvm-permission");
    assert.match(problem?.fix ?? "", /sudo usermod -aG kvm jasper/);
    assert.match(problem?.fix ?? "", /log out and back in/);
    assert.deepEqual(androidProbeProblems(probe(), "jasper"), []);
    // A udev rule that opens /dev/kvm to everyone needs no group.
    assert.deepEqual(androidProbeProblems(probe(["groups=jasper", "kvm_mode=666"]), "jasper"), []);
    assert.equal(androidProbeProblems(probe(["kvm=denied"]), "jasper")[0]?.code, "kvm-permission");
  });

  it("names linger off with its fix", () => {
    const [problem] = androidProbeProblems(probe(["linger=0"]), "jasper");
    assert.equal(problem?.code, "linger-off");
    assert.equal(problem?.fix, "sudo loginctl enable-linger jasper");
  });
});

describe("a Linux host's capacity", () => {
  it("is the least of CPUs, memory, free disk and the hard cap", () => {
    assert.equal(boxAndroidCapacity({ cpus: 24, memAvailableBytes: 90 * GiB, running: 0 }), 12);
    assert.equal(boxAndroidCapacity({ cpus: 24, memAvailableBytes: 90 * GiB, running: 0, freeDiskBytes: 10 * GiB }), 3);
    assert.equal(boxAndroidCapacity({ cpus: 8, memAvailableBytes: 11.5 * GiB, running: 0 }), 2);
    assert.equal(boxAndroidCapacity({ cpus: 64, memAvailableBytes: 512 * GiB, running: 0 }), 16);
  });
});
