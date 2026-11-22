import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { androidLayoutAt } from "../../android/env.ts";
import {
  buildWindowsAndroidEnv,
  NoDesktopSessionError,
  parseAccelCheck,
  parseWindowsProbe,
  patchWindowsAvdConfig,
  hasWindowsAvdRam,
  powershellCommand,
  POWERSHELL_PRELUDE,
  tryGpuModes,
  whpxReady,
  WIN_PROBE_SCRIPT,
  windowsAndroidCapacity,
  windowsCommandLine,
  windowsGpuPlan,
  windowsGpuSignature,
  windowsHostGpu,
  windowsLaunchSession,
  windowsLeaseLaunch,
  windowsProbeProblems,
  windowsRendersInSoftware,
  type WindowsAndroidProbe,
  type WindowsGpuAttempt
} from "./win32-remote.ts";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/win32/${name}`, import.meta.url), "utf8");
const GB = 1024 ** 3;

/** The mini PC as its probe printed it. */
const miniPc = (): WindowsAndroidProbe => parseWindowsProbe(fixture("probe-minipc.txt"));

describe("Windows probe", () => {
  it("reads the mini PC's probe: the device root in the user's profile, WHPX on, the Radeon as the GPU", () => {
    const probe = miniPc();
    assert.equal(probe.root, "C:/Users/user/.orquester/devices");
    assert.equal(probe.consoleUser, "DESKTOP-EXAMPLE\\user");
    assert.deepEqual(probe.desktopSessions, [1]);
    assert.equal(probe.cpus, 16);
    assert.equal(probe.node, null);
    assert.equal(probe.accel, null);
    assert.equal(whpxReady(probe), true);
    // The USB monitor's virtual adapter is no GPU to render on.
    assert.equal(windowsHostGpu(probe.gpus)?.name, "AMD Radeon(TM) Graphics");
    assert.deepEqual(windowsProbeProblems(probe, { machine: "minipc", desktopSession: true, goldenGpu: null }), []);
  });

  it("takes the JSON line among PowerShell's other output", () => {
    const probe = parseWindowsProbe(`#< CLIXML\r\n${fixture("probe-minipc.txt")}<Objs Version="1.1.0.1"></Objs>\r\n`);
    assert.equal(probe.build, "19045");
    assert.throws(() => parseWindowsProbe("#< CLIXML\r\n<Objs/>"), /no result/);
  });

  it("reads emulator -accel-check: usable, or the reason it is not", () => {
    assert.deepEqual(parseAccelCheck(fixture("accel-check-kvm.txt")), { status: 0, message: "KVM (version 12) is installed and usable.", hypervisor: "kvm" });
    const off = parseAccelCheck("accel:\r\n4\r\nWHPX is not installed or not enabled.\r\naccel\r\n");
    assert.equal(off.status, 4);
    assert.equal(off.hypervisor, "whpx");
    assert.equal(whpxReady({ ...miniPc(), accel: off }), false);
  });

  it("names WHPX being off with the exact fix, and a hypervisor not running yet with a restart", () => {
    const disabled = windowsProbeProblems({ ...miniPc(), hypervisorPlatform: 2, hypervisorPresent: false }, { machine: "minipc", desktopSession: true, goldenGpu: null });
    assert.equal(disabled[0]?.code, "whpx-off");
    assert.match(disabled[0]!.fix!, /Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All, then restart minipc/);
    const pending = windowsProbeProblems({ ...miniPc(), hypervisorPresent: false }, { machine: "minipc", desktopSession: true, goldenGpu: null });
    assert.match(pending[0]!.fix!, /^Restart minipc/);
  });

  it("names a missing desktop session with its fix, unless the GPU already renders from the service session", () => {
    const signedIn = windowsProbeProblems(miniPc(), { machine: "minipc", desktopSession: false, goldenGpu: null });
    assert.equal(signedIn[0]?.code, "no-desktop-session");
    assert.match(signedIn[0]!.fix!, /Sign out of minipc and back in/);
    const nobody = windowsProbeProblems({ ...miniPc(), consoleUser: null }, { machine: "minipc", desktopSession: false, goldenGpu: null });
    assert.match(nobody[0]!.fix!, /automatic sign-in for user on minipc: run Sysinternals Autologon/);
    assert.deepEqual(windowsProbeProblems(miniPc(), { machine: "minipc", desktopSession: false, goldenGpu: "angle_indirect" }), []);
  });
});

describe("Windows capacity", () => {
  it("fits exactly one emulator on the mini PC (6.9 GB usable, 4.6 GB free at idle), and keeps it while it runs", () => {
    const basis = { cpus: 16, freeDiskBytes: 213 * GB };
    assert.equal(windowsAndroidCapacity({ ...basis, freeMemBytes: 4.6 * GB, running: 0 }), 1);
    assert.equal(windowsAndroidCapacity({ ...basis, freeMemBytes: miniPc().freeMemBytes, running: 0 }), 1);
    // Its own emulator's memory is out of the free figure: still one, never two.
    assert.equal(windowsAndroidCapacity({ ...basis, freeMemBytes: 2.4 * GB, running: 1 }), 1);
    assert.equal(windowsAndroidCapacity({ ...basis, freeMemBytes: 1.2 * GB, running: 0 }), 0);
  });

  it("grows with free memory, bounded by CPUs and disk", () => {
    assert.equal(windowsAndroidCapacity({ cpus: 16, freeMemBytes: 20 * GB, running: 0, freeDiskBytes: 500 * GB }), 8);
    assert.equal(windowsAndroidCapacity({ cpus: 4, freeMemBytes: 20 * GB, running: 0, freeDiskBytes: 500 * GB }), 2);
    assert.equal(windowsAndroidCapacity({ cpus: 16, freeMemBytes: 20 * GB, running: 0, freeDiskBytes: 7 * GB }), 1);
  });
});

describe("Windows GPU modes", () => {
  const radeon = { name: "AMD Radeon(TM) Graphics", driver: "31.0.12027.9001", status: "OK" };
  const modes = (plan: WindowsGpuAttempt[]) => plan.map((attempt) => `${attempt.gpu}@${attempt.session}`);

  it("tries -gpu host in the desktop session only with the helper, then ANGLE from the service session, then software", () => {
    assert.deepEqual(modes(windowsGpuPlan({ desktopSession: true, gpu: radeon, failed: {}, emulatorRevision: "37.3.10" })), ["host@desktop", "angle_indirect@service", "swiftshader_indirect@service"]);
    assert.deepEqual(modes(windowsGpuPlan({ desktopSession: false, gpu: radeon, failed: {}, emulatorRevision: "37.3.10" })), ["angle_indirect@service", "swiftshader_indirect@service"]);
    assert.deepEqual(modes(windowsGpuPlan({ desktopSession: true, gpu: null, failed: {}, emulatorRevision: "37.3.10" })), ["swiftshader_indirect@service"]);
  });

  it("skips a remembered failure until the driver or the emulator changes", () => {
    const failed = { host: windowsGpuSignature(radeon, "37.3.10") };
    assert.deepEqual(modes(windowsGpuPlan({ desktopSession: true, gpu: radeon, failed, emulatorRevision: "37.3.10" })), ["angle_indirect@service", "swiftshader_indirect@service"]);
    assert.deepEqual(modes(windowsGpuPlan({ desktopSession: true, gpu: { ...radeon, driver: "32.0.1" }, failed, emulatorRevision: "37.3.10" }))[0], "host@desktop");
    assert.deepEqual(modes(windowsGpuPlan({ desktopSession: true, gpu: radeon, failed, emulatorRevision: "37.4.1" }))[0], "host@desktop");
  });

  it("falls back in order, remembering a hardware mode that rendered in software but not a missing desktop session", async () => {
    const plan = windowsGpuPlan({ desktopSession: true, gpu: radeon, failed: {}, emulatorRevision: "37.3.10" });
    const remembered: string[] = [];
    const worked = await tryGpuModes(
      plan,
      async (attempt) => {
        if (attempt.gpu === "host") throw new NoDesktopSessionError();
        if (attempt.gpu === "angle_indirect") throw new Error("-gpu angle_indirect rendered in software");
      },
      async (attempt, failed) => void remembered.push(`${attempt.gpu}:${failed}`),
      new AbortController().signal
    );
    assert.equal(worked.gpu, "swiftshader_indirect");
    assert.deepEqual(remembered, ["angle_indirect:true"]);
    await assert.rejects(
      tryGpuModes(plan, async () => Promise.reject(new Error("no boot")), async () => undefined, new AbortController().signal),
      /host: no boot; angle_indirect: no boot; swiftshader_indirect: no boot/
    );
  });

  it("boots a lease from a -gpu host snapshot only with a desktop session, else cold with the service session's best mode", () => {
    const golden = { gpu: "host", snapshot: "orq-golden" };
    const service = windowsGpuPlan({ desktopSession: false, gpu: radeon, failed: {}, emulatorRevision: "37.3.10" });
    assert.deepEqual(windowsLeaseLaunch(golden, windowsGpuPlan({ desktopSession: true, gpu: radeon, failed: {}, emulatorRevision: "37.3.10" }), true), { gpu: "host", snapshot: "orq-golden" });
    assert.deepEqual(windowsLeaseLaunch(golden, service, false), { gpu: "angle_indirect", coldBoot: true });
    assert.deepEqual(windowsLeaseLaunch({ gpu: "angle_indirect", snapshot: "orq-golden" }, service, false), { gpu: "angle_indirect", snapshot: "orq-golden" });
    assert.equal(windowsLaunchSession(["-avd", "orq-pixel-9", "-gpu", "host"]), "desktop");
    assert.equal(windowsLaunchSession(["-avd", "orq-pixel-9", "-gpu", "angle_indirect"]), "service");
  });

  it("tells hardware rendering from software in SurfaceFlinger's GLES line, else in the emulator's log", () => {
    const hardware = "GLES: Google (Google Inc.), Android Emulator OpenGL ES Translator (ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)), OpenGL ES 3.0";
    assert.equal(windowsRendersInSoftware(`Display 0\n${hardware}\n`), false);
    assert.equal(windowsRendersInSoftware("GLES: Google (Google Inc.), Android Emulator OpenGL ES Translator (ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)), OpenGL ES 3.0"), true);
    assert.equal(windowsRendersInSoftware("", "INFO | Graphics Adapter Android Emulator OpenGL ES Translator (Google SwiftShader)"), true);
    assert.equal(windowsRendersInSoftware("", ""), null);
  });
});

describe("Windows command lines and scripts", () => {
  it("quotes arguments the way CommandLineToArgvW splits them back", () => {
    assert.equal(windowsCommandLine(["-avd", "orq-pixel-9", "-gpu", "host"]), "-avd orq-pixel-9 -gpu host");
    assert.equal(windowsCommandLine(["C:\\Program Files\\x", "", 'say "hi"', "C:\\dir with space\\"]), '"C:\\Program Files\\x" "" "say \\"hi\\"" "C:\\dir with space\\\\"');
  });

  it("runs constant scripts through -EncodedCommand with the execution policy bypassed", () => {
    const { command, args } = powershellCommand(WIN_PROBE_SCRIPT);
    assert.equal(command, "powershell.exe");
    assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    assert.equal(Buffer.from(args.at(-1)!, "base64").toString("utf16le"), `${POWERSHELL_PRELUDE}${WIN_PROBE_SCRIPT}`);
    // Within CreateProcess's command line limit.
    assert.ok(args.join(" ").length < 32_000);
  });

  it("gives the tools a Windows PATH and paths, no XDG variables", () => {
    const root = "C:/Users/user/.orquester/devices";
    const env = buildWindowsAndroidEnv(androidLayoutAt(root), miniPc(), { root, adbPort: 17_000 });
    assert.match(env.PATH!, /^C:\\Users\\user\\\.orquester\\devices\\node;C:\\Users\\user\\\.orquester\\devices\\android-sdk\\platform-tools;.*;C:\\WINDOWS\\system32;/);
    assert.equal(env.JAVA_HOME, `${root}/jre`);
    assert.equal(env.ANDROID_ADB_SERVER_PORT, "17000");
    assert.equal(env.USER, "user");
    assert.deepEqual(Object.keys(env).filter((key) => key.startsWith("XDG_")), []);
  });

  it("gives the AVD 1536 MB of guest RAM", () => {
    const patched = patchWindowsAvdConfig("hw.cpu.ncore=2\nhw.ramSize=2048\n");
    assert.equal(patched, "hw.cpu.ncore=2\nhw.ramSize=1536\n");
    assert.equal(hasWindowsAvdRam(patched), true);
    assert.equal(hasWindowsAvdRam("hw.ramSize=2048\n"), false);
  });
});
