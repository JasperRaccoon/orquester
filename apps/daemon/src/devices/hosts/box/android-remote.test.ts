import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { androidProbeProblems, boxAndroidCapacity, boxGpuModes, gpuSignature, hostRenderProblem, parseAndroidProbe, usableHostGpu } from "./android-remote.ts";

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

/** The GPU lines of a probe on an RTX 3080 Ti desktop (driver 595.99.02, KDE on X11 at :0 letting the account in through `xhost +SI:localuser`). */
const NVIDIA_DESKTOP = ["nvidia=595.99.02", "nvidia_dev=1", "render=renderD128:nvidia:1", "x_display=:0"];

describe("GPU modes of an own machine's golden snapshot", () => {
  it("tries -gpu host first only where the probe found a GPU it can render on and an X display, then the software modes", () => {
    const nvidia = usableHostGpu(probe(NVIDIA_DESKTOP).gpu);
    assert.equal(nvidia?.kind, "nvidia");
    assert.deepEqual(nvidia?.env, { DISPLAY: ":0" });
    assert.deepEqual(boxGpuModes("byo", nvidia, null, "37.3.10"), ["host", "swangle_indirect", "swiftshader_indirect"]);
    const mesa = usableHostGpu(probe(["render=renderD128:amdgpu:1", "x_display=:1", "x_auth=/run/user/1000/gdm/Xauthority"]).gpu);
    assert.equal(mesa?.kind, "mesa");
    assert.deepEqual(mesa?.env, { DISPLAY: ":1", XAUTHORITY: "/run/user/1000/gdm/Xauthority" });
    // The emulator's host renderer is GLX: without a display it never boots (a headless server, a logged-out desktop).
    assert.equal(usableHostGpu(probe(NVIDIA_DESKTOP.filter((line) => !line.startsWith("x_display="))).gpu), null);
    // A driver loaded whose device nodes the account cannot open, or a virtual GPU: no host mode.
    const closed = usableHostGpu(probe(["nvidia=550.54.14", "nvidia_dev=0", "render=renderD128:virtio_gpu:1", "render=renderD129:amdgpu:0", "x_display=:0"]).gpu);
    assert.equal(closed, null);
    assert.deepEqual(boxGpuModes("byo", closed, null, "37.3.10"), ["swangle_indirect", "swiftshader_indirect"]);
  });

  it("rented runners keep the device cache's order whatever their GPU", () => {
    const gpu = usableHostGpu(probe(NVIDIA_DESKTOP).gpu);
    assert.ok(!boxGpuModes("box", gpu, null, "37.2.12").includes("host"));
  });

  it("after host mode failed on a GPU and emulator, goes straight to software until either changes", () => {
    const gpu = usableHostGpu(probe(NVIDIA_DESKTOP).gpu)!;
    const failedOn = gpuSignature(gpu, "37.2.12");
    assert.deepEqual(boxGpuModes("byo", gpu, failedOn, "37.2.12"), ["swangle_indirect", "swiftshader_indirect"]);
    assert.equal(boxGpuModes("byo", gpu, failedOn, "37.3.1")[0], "host");
    const newDriver = usableHostGpu(probe([...NVIDIA_DESKTOP, "nvidia=600.10.01"]).gpu)!;
    assert.equal(boxGpuModes("byo", newDriver, failedOn, "37.2.12")[0], "host");
  });

  it("a host boot counts only with a GPU renderer named and a frame that is not blank", () => {
    // `dumpsys SurfaceFlinger` and frame sizes of emulator 37.3.10 booted on that desktop.
    const nvidia = " ------------RE GLES------------\nGLES: Google (NVIDIA Corporation), Android Emulator OpenGL ES Translator (NVIDIA GeForce RTX 3080 Ti/PCIe/SSE2), OpenGL ES 3.1 (4.5.0 NVIDIA 595.99.02)\n";
    const swangle =
      " ------------RE GLES------------\nGLES: Google (Google Inc. (Google)), Android Emulator OpenGL ES Translator (ANGLE (Google, Vulkan 1.2.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver-5.0.0)), OpenGL ES 3.1 (OpenGL ES 3.1.0 (ANGLE 2.1.17841 git hash: 5fa2e61da947))\n";
    const homeScreen = "779404\n";
    assert.equal(hostRenderProblem(nvidia, homeScreen), null);
    assert.match(hostRenderProblem(swangle, homeScreen) ?? "", /fell back to software rendering \(GLES: .*SwiftShader/);
    assert.match(hostRenderProblem(nvidia, "7980\n") ?? "", /blank screen \(a 7980-byte frame\)/);
    // Nothing to confirm it by (a failed dump or capture, another dump format): it does not count.
    assert.match(hostRenderProblem("Display 0 HWC layers:\n", homeScreen) ?? "", /could not be confirmed/);
    assert.match(hostRenderProblem(nvidia, "") ?? "", /could not be confirmed/);
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
