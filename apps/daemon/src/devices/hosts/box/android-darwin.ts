/**
 * Android emulators on an owner's Apple Silicon Mac (tailnet machines spec §4.4 item 2): the
 * macOS side of `android-host.ts` (constants and pure functions; the Linux side is
 * `android-remote.ts`). The Mac runs arm64-v8a system images under Hypervisor.framework (`hvf`),
 * beside its iOS simulators (`host.ts`):
 *
 * - its own device root `~/.orquester/devices/android` (the iOS host keeps `~/.orquester/devices`:
 *   separate tools, hub and agent-device state, so neither host touches the other's processes);
 * - the probe: macOS and arm64, Node, `kern.hv_support` (and not a VM: Apple's VMs offer no nested
 *   Hypervisor.framework), the chip (its GPU renders `-gpu host` through Metal), CPUs, RAM, free
 *   memory (`vm_stat`), free disk, ffmpeg with libx264 (Homebrew's or the pinned one), Java 17+
 *   (the pinned JRE, `JAVA_HOME`, or `/usr/libexec/java_home`), unzip;
 * - capacity from the probe and what the Mac's iOS simulators hold ({@link macAndroidCapacity});
 * - the readiness checks in Mac words (Hypervisor.framework, ffmpeg and Java installed by the host).
 */

import { posix } from "node:path";

import { ANDROID_SYSTEM_IMAGE, androidSystemImageFor, type DeviceCapacityBasis, type DeviceProfile, type DeviceReadinessCheck } from "@orquester/api";

import { localCapacity } from "../../android/capacity.ts";
import { FIX_ACTIONS } from "../../android/readiness.ts";
import { FFMPEG_MAC_ARM64, macFfmpegBinDir, macJreHome, TEMURIN_JRE_MAC_ARM64 } from "../../toolchain/macos.ts";
import type { AndroidBoxProbe } from "./android-remote.ts";
import { ANDROID_HOST_HARD_CAP, BOX_DISK_RESERVED_BYTES, BOX_EMULATOR_BYTES, BOX_EMULATOR_DISK_BYTES, VCPUS_PER_EMULATOR } from "./android-remote.ts";
import { IOS_SIM_CPUS, type MachineDeviceLoad } from "./shared-load.ts";

/** A Mac's Android device root: beside the iOS host's `~/.orquester/devices`, never inside its files. */
export function macAndroidRoot(home: string): string {
  return posix.join(home, ".orquester", "devices", "android");
}

/** A profile as an Apple Silicon Mac runs it: its system image's arm64-v8a build. */
export function macProfile(profile: DeviceProfile): DeviceProfile {
  return { ...profile, systemImage: androidSystemImageFor(profile, "arm64-v8a") };
}

/** The system image a Mac installs (every phase 1 profile shares one). */
export const MAC_ANDROID_SYSTEM_IMAGE = androidSystemImageFor({ systemImage: ANDROID_SYSTEM_IMAGE }, "arm64-v8a");

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * `key=value` lines about the Mac; `$1` is the device root (its pinned ffmpeg and JRE are looked
 * for there first, its disk is measured). Constant text (the JRE dir comes from the pin); no
 * secrets. `java -version` is never run through `/usr/bin/java`: without a JDK that stub offers an
 * install dialog on the Mac's screen.
 */
export const MAC_ANDROID_PROBE_SCRIPT = `root=\${1:-$HOME/.orquester/devices/android}
PATH="${macFfmpegBinDir("$root")}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
printf 'path=%s\\n' "$PATH"
printf 'os=%s\\n' "$(uname -s)"
printf 'arch=%s\\n' "$(uname -m)"
user=$(id -un)
printf 'user=%s\\n' "$user"
node=$(command -v node 2> /dev/null || true)
printf 'node=%s\\n' "$node"
if [ -n "$node" ]; then printf 'node_version=%s\\n' "$("$node" --version 2> /dev/null)"; fi
printf 'npm=%s\\n' "$(command -v npm 2> /dev/null || true)"
printf 'hvf=%s\\n' "$(sysctl -n kern.hv_support 2> /dev/null)"
printf 'vm=%s\\n' "$(sysctl -n kern.hv_vmm_present 2> /dev/null)"
printf 'chip=%s\\n' "$(sysctl -n machdep.cpu.brand_string 2> /dev/null)"
printf 'cpus=%s\\n' "$(sysctl -n hw.ncpu 2> /dev/null)"
printf 'mem_total_bytes=%s\\n' "$(sysctl -n hw.memsize 2> /dev/null)"
vm_stat 2> /dev/null | awk '/page size of/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) size = $i } /^Pages (free|inactive|speculative):/ { gsub(/[.]/, "", $NF); pages += $NF } END { if (size > 0) print "mem_available_bytes=" pages * size }'
ffmpeg=$(command -v ffmpeg 2> /dev/null || true)
printf 'ffmpeg_path=%s\\n' "$ffmpeg"
if [ -z "$ffmpeg" ]; then
  echo ffmpeg=missing
elif "$ffmpeg" -hide_banner -encoders 2> /dev/null | grep -q libx264; then
  echo ffmpeg=libx264
else
  echo ffmpeg=no-libx264
fi
jre="${macJreHome("$root")}"
java_home=
if [ -x "$jre/bin/java" ] && "$jre/bin/java" -version > /dev/null 2>&1; then
  java_home=$jre
elif [ -n "\${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ] && "$JAVA_HOME/bin/java" -version > /dev/null 2>&1; then
  java_home=$JAVA_HOME
elif [ -x /usr/libexec/java_home ] && /usr/libexec/java_home -v 17+ > /dev/null 2>&1; then
  java_home=$(/usr/libexec/java_home -v 17+ 2> /dev/null)
fi
if [ -n "$java_home" ]; then echo java=1; else echo java=0; fi
printf 'java_home=%s\\n' "$java_home"
if command -v unzip > /dev/null 2>&1; then echo unzip=1; else echo unzip=0; fi
d=$root
while [ ! -d "$d" ] && [ "$d" != / ]; do d=$(dirname "$d"); done
df -Pk "$d" 2> /dev/null | awk 'NR == 2 { print "disk_free_kb=" $4 }'
`;

/** A Mac's probe: the Linux probe's shape (what the shared host code reads) plus what only a Mac reports. */
export interface MacAndroidProbe extends AndroidBoxProbe {
  /** `uname -m`: `arm64` on Apple Silicon. */
  arch: string | null;
  /** `kern.hv_support`: Hypervisor.framework is available. */
  hvf: boolean;
  /** `kern.hv_vmm_present`: the Mac is itself a VM; null when unknown. */
  vm: boolean | null;
  /** "Apple M4 Max"; null when unknown. */
  chip: string | null;
  /** `hw.memsize`; null when unknown. */
  memTotalBytes: number | null;
  ffmpegPath: string | null;
}

export function parseMacAndroidProbe(stdout: string): MacAndroidProbe {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const text = (key: string) => {
    const value = values.get(key);
    return value === undefined || value === "" ? null : value;
  };
  const count = (key: string) => {
    const value = Number(values.get(key));
    return values.get(key) !== undefined && values.get(key) !== "" && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const nodeVersion = text("node_version");
  const major = nodeVersion ? Number(/^v?(\d+)\./.exec(nodeVersion)?.[1]) : NaN;
  const hvf = values.get("hvf") === "1";
  const vm = values.get("vm") === "1" ? true : values.get("vm") === "0" ? false : null;
  const chip = text("chip");
  const arch = text("arch");
  const ffmpeg = values.get("ffmpeg");
  const diskKb = count("disk_free_kb");
  return {
    path: text("path") ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    os: text("os") ?? "unknown",
    user: text("user") ?? "orquester",
    nodePath: text("node"),
    nodeVersion,
    nodeMajor: Number.isFinite(major) ? major : null,
    npmPath: text("npm"),
    // The shared code's "hypervisor reachable": Hypervisor.framework needs no group or device node.
    kvm: hvf && vm !== true ? { access: "direct" } : { access: "missing" },
    ffmpeg: ffmpeg === "libx264" || ffmpeg === "no-libx264" ? ffmpeg : "missing",
    java: values.get("java") === "1",
    javaHome: text("java_home"),
    unzip: values.get("unzip") === "1",
    sudo: false,
    cpus: Math.max(1, count("cpus") ?? 1),
    groups: [],
    kvmMode: null,
    memAvailableBytes: count("mem_available_bytes"),
    diskFreeBytes: diskKb === null ? null : diskKb * 1024,
    linger: null,
    gpu: { nvidia: null, render: [], apple: chip && arch === "arm64" ? { chip } : null },
    arch,
    hvf,
    vm,
    chip,
    memTotalBytes: count("mem_total_bytes"),
    ffmpegPath: text("ffmpeg_path")
  };
}

/**
 * Why this Mac cannot run Android emulators, or null when it can: macOS on Apple Silicon (arm64
 * images; an Intel Mac is not supported here), Hypervisor.framework outside a VM, Node 22+.
 */
export function macAndroidBlocker(probe: MacAndroidProbe, label: string): string | null {
  if (probe.os !== "Darwin") return `${label} is not a Mac.`;
  if (probe.arch !== "arm64") return `${label} is not an Apple Silicon Mac: Android emulators on a Mac need Apple Silicon (arm64 system images).`;
  if (probe.vm === true) return `${label} is a virtual Mac: Android emulators need Hypervisor.framework, which macOS VMs do not offer.`;
  if (!probe.hvf) return `${label} reports no Hypervisor.framework (kern.hv_support is 0), so it cannot run Android emulators.`;
  if (probe.nodePath === null || probe.nodeMajor === null || probe.nodeMajor < 22) {
    return `${label} needs Node.js 22 or newer${probe.nodeVersion ? ` (it has ${probe.nodeVersion})` : ""}: install it there, then try again.`;
  }
  return null;
}

/** The first check's line once the Mac passed it. */
export function macBasicsDetail(probe: MacAndroidProbe): string {
  return `Node ${probe.nodeVersion}, Hypervisor.framework on ${probe.chip ?? "Apple Silicon"}, ${probe.cpus} CPUs`;
}

/** The base environment of the Mac's Android tools (`buildAndroidEnv` adds the rest): the probed PATH with Node's dir first, a UTF-8 locale macOS has, the JRE. */
export function macBaseEnv(probe: Pick<AndroidBoxProbe, "path" | "nodePath" | "javaHome">): NodeJS.ProcessEnv {
  const nodeDir = probe.nodePath ? posix.dirname(probe.nodePath) : null;
  const javaBin = probe.javaHome ? posix.join(probe.javaHome, "bin") : null;
  return {
    PATH: [nodeDir, javaBin, probe.path].filter(Boolean).join(":"),
    LANG: "en_US.UTF-8",
    ...(probe.javaHome ? { JAVA_HOME: probe.javaHome } : {})
  };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

const GiB = 1024 ** 3;
/** Kept free on the owner's Mac for macOS and its apps (as the iOS host keeps: `simslim-capacity.ts`). */
export const MAC_ANDROID_RESERVED_BYTES = 8 * GiB;

export interface MacAndroidCapacityInput {
  cpus: number;
  /** `hw.memsize`; null when unknown. */
  hostBytes: number | null;
  /** Free memory now (`vm_stat`): what the Mac's running simulators and emulators already took is out of it. */
  memAvailableBytes: number | null;
  freeDiskBytes: number | null;
  /** This host's emulators running now. */
  running: number;
  /** What the Mac's iOS simulators hold (their active leases and memory budget). */
  ios: MachineDeviceLoad;
}

/**
 * How many emulators a Mac may run beside its simulators: the least of
 * - CPU: one per two cores after a core per leased simulator;
 * - memory, as a ceiling: RAM minus an 8 GB reserve and the simulators' budget, per 3.6 GB emulator;
 * - memory now: running ones plus what fits in free memory above the reserve (a simulator still
 *   booting is not out of free memory yet: the ceiling covers it);
 * - disk: running ones plus what fits above a 4 GB reserve, 2 GB each;
 * - the hard cap of 16.
 */
export function macAndroidCapacity(input: MacAndroidCapacityInput): number {
  const byCpu = Math.max(0, Math.floor((input.cpus - input.ios.devices * IOS_SIM_CPUS) / VCPUS_PER_EMULATOR));
  const byCeiling =
    input.hostBytes !== null && input.hostBytes > 0 ? Math.max(0, Math.floor((input.hostBytes - MAC_ANDROID_RESERVED_BYTES - input.ios.bytes) / BOX_EMULATOR_BYTES)) : ANDROID_HOST_HARD_CAP;
  const disk = input.freeDiskBytes;
  const byDisk = disk === null ? ANDROID_HOST_HARD_CAP : input.running + Math.max(0, Math.floor((disk - BOX_DISK_RESERVED_BYTES) / BOX_EMULATOR_DISK_BYTES));
  const { total } = localCapacity({
    maxLocalDevices: Math.min(ANDROID_HOST_HARD_CAP, byCpu, byCeiling, byDisk),
    memAvailableBytes: input.memAvailableBytes,
    running: input.running,
    threads: input.cpus,
    reservedBytes: MAC_ANDROID_RESERVED_BYTES,
    emulatorBytes: BOX_EMULATOR_BYTES
  });
  return total;
}

/** What the Mac's Android capacity was measured from (`DeviceCapacity.basis`). */
export function macAndroidCapacityBasis(probe: MacAndroidProbe, memAvailableBytes: number | null, probedAt: string): DeviceCapacityBasis {
  return {
    cpus: probe.cpus,
    freeMemBytes: memAvailableBytes ?? probe.memAvailableBytes ?? 0,
    freeDiskBytes: probe.diskFreeBytes,
    accel: probe.hvf && probe.vm !== true ? "hvf" : null,
    probedAt
  };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export const MAC_HVF_CHECK_LABEL = "Hardware virtualization (Hypervisor.framework)";

/** The check shown before the first probe. */
export function macUncheckedChecks(): DeviceReadinessCheck[] {
  return [
    { id: "hvf", label: MAC_HVF_CHECK_LABEL, state: "missing", detail: "Not checked yet" },
    { id: "node", label: "Node.js 22 or newer", state: "missing", detail: "Not checked yet" }
  ];
}

/**
 * The shared checklist (`evaluateReadiness`) in a Mac's words: Hypervisor.framework instead of
 * `/dev/kvm`, and ffmpeg and Java as what preparing the host installs (pinned, under its device dir)
 * rather than an `apt install` for the owner.
 */
export function macAndroidChecks(checks: readonly DeviceReadinessCheck[], probe: MacAndroidProbe): DeviceReadinessCheck[] {
  return checks.map((check) => {
    switch (check.id) {
      case "kvm":
        return probe.hvf && probe.vm !== true
          ? { id: "hvf", label: MAC_HVF_CHECK_LABEL, state: "ok", detail: probe.chip ?? "Available" }
          : { id: "hvf", label: MAC_HVF_CHECK_LABEL, state: "error", detail: probe.vm === true ? "This Mac is a VM: macOS VMs offer no Hypervisor.framework." : "Not available on this Mac (kern.hv_support is 0)." };
      case "ffmpeg":
        return check.state === "ok"
          ? { ...check, detail: probe.ffmpegPath ?? check.detail }
          : { ...check, state: "missing", detail: `Installed when the host is prepared (ffmpeg ${FFMPEG_MAC_ARM64.version} with libx264)`, fixActionId: FIX_ACTIONS.sdk };
      case "java":
        return check.state === "ok"
          ? { ...check, detail: probe.javaHome ?? check.detail }
          : { ...check, state: "missing", detail: `Installed when the host is prepared (Temurin ${TEMURIN_JRE_MAC_ARM64.version} JRE)`, fixActionId: FIX_ACTIONS.sdk };
      default:
        return check;
    }
  });
}
