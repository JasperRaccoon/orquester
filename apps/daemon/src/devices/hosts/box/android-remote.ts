/**
 * What a Linux box Android host runs and decides in its box (constants and pure functions; the host
 * is `android-host.ts`): the probe (Node, KVM directly or through `sg kvm`, ffmpeg with libx264,
 * Java, unzip, passwordless sudo, CPUs), the ffmpeg install, the box's device layout (the Blacksmith
 * device caches restore `android-sdk`, `avd` and `tools` under {@link BOX_DEVICES_DIR}), whether a
 * profile's AVD and golden snapshot came from the cache or were made here, the rental spec of a
 * Linux device host, and its capacity.
 */

import { posix } from "node:path";

import type { BoxSizeOffer, DeviceProfile, DevicesSettings, DeviceScreen } from "@orquester/api";

import { ANDROID_EMULATOR_GPU, ANDROID_GOLDEN_SNAPSHOT, BOX_DEVICES_DIR } from "../../../boxes/github/device-cache.ts";
import { BLACKSMITH_LINUX_IMAGES, BLACKSMITH_LINUX_SIZES, blacksmithRunnerLabel } from "../../../boxes/github/workflow-template.ts";
import { avdName, avdScreen, parseIni } from "../../android/avd-config.ts";
import { localCapacity } from "../../android/capacity.ts";
import type { DeviceExecutor } from "../../android/executor.ts";
import type { KvmProbe } from "../../android/readiness.ts";
import { avdDir, avdReady, profileHash } from "../../toolchain/android-sdk.ts";
import type { DeviceHostRentalSpec } from "./rental.ts";

/** Where a Linux box keeps its device state: the device caches' dir on rented boxes, `~/.orquester/devices` on an owner's own machine. */
export function boxAndroidRoot(input: { provider: string; home: string }): string {
  return input.provider === "byo" ? posix.join(input.home, ".orquester", "devices") : BOX_DEVICES_DIR;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** `key=value` lines about the box (constant text; no secrets). */
export const ANDROID_PROBE_SCRIPT = `PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
export PATH
printf 'path=%s\\n' "$PATH"
printf 'os=%s\\n' "$(uname -s)"
user=$(id -un)
printf 'user=%s\\n' "$user"
node=$(command -v node 2> /dev/null || true)
printf 'node=%s\\n' "$node"
if [ -n "$node" ]; then printf 'node_version=%s\\n' "$("$node" --version 2> /dev/null)"; fi
printf 'npm=%s\\n' "$(command -v npm 2> /dev/null || true)"
if [ ! -e /dev/kvm ]; then
  echo kvm=missing
elif [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  echo kvm=direct
elif grep -Eq "^kvm:[^:]*:[^:]*:(.*,)?$user(,|\\$)" /etc/group 2> /dev/null && sg kvm -c 'test -r /dev/kvm -a -w /dev/kvm' 2> /dev/null; then
  echo kvm=sg
else
  echo kvm=denied
fi
if command -v ffmpeg > /dev/null 2>&1; then
  if ffmpeg -hide_banner -encoders 2> /dev/null | grep -q libx264; then echo ffmpeg=libx264; else echo ffmpeg=no-libx264; fi
else
  echo ffmpeg=missing
fi
if java -version > /dev/null 2>&1; then echo java=1; else echo java=0; fi
printf 'java_home=%s\\n' "\${JAVA_HOME:-}"
if command -v unzip > /dev/null 2>&1; then echo unzip=1; else echo unzip=0; fi
if sudo -n true > /dev/null 2>&1; then echo sudo=1; else echo sudo=0; fi
printf 'cpus=%s\\n' "$(nproc 2> /dev/null)"
`;

export interface AndroidBoxProbe {
  path: string;
  os: string;
  user: string;
  nodePath: string | null;
  nodeVersion: string | null;
  nodeMajor: number | null;
  npmPath: string | null;
  kvm: KvmProbe;
  ffmpeg: "libx264" | "no-libx264" | "missing";
  java: boolean;
  javaHome: string | null;
  unzip: boolean;
  sudo: boolean;
  cpus: number;
}

export function parseAndroidProbe(stdout: string): AndroidBoxProbe {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const text = (key: string) => {
    const value = values.get(key);
    return value === undefined || value === "" ? null : value;
  };
  const nodeVersion = text("node_version");
  const major = nodeVersion ? Number(/^v?(\d+)\./.exec(nodeVersion)?.[1]) : NaN;
  const kvmValue = values.get("kvm");
  const kvm: KvmProbe =
    kvmValue === "direct"
      ? { access: "direct" }
      : kvmValue === "sg"
        ? { access: "sg" }
        : kvmValue === "missing"
          ? { access: "missing" }
          : { access: "denied", detail: "/dev/kvm exists but the box user cannot open it: add it to the kvm group (or a udev rule with mode 0666)." };
  const ffmpeg = values.get("ffmpeg");
  return {
    path: text("path") ?? "/usr/local/bin:/usr/bin:/bin",
    os: text("os") ?? "unknown",
    user: text("user") ?? "orquester",
    nodePath: text("node"),
    nodeVersion,
    nodeMajor: Number.isFinite(major) ? major : null,
    npmPath: text("npm"),
    kvm,
    ffmpeg: ffmpeg === "libx264" || ffmpeg === "no-libx264" ? ffmpeg : "missing",
    java: values.get("java") === "1",
    javaHome: text("java_home"),
    unzip: values.get("unzip") === "1",
    sudo: values.get("sudo") === "1",
    cpus: Math.max(1, Number(values.get("cpus")) || 1)
  };
}

/** The base environment of the box's Android tools (`buildAndroidEnv` adds the rest): the probed PATH with Node's dir first. */
export function boxBaseEnv(probe: Pick<AndroidBoxProbe, "path" | "nodePath" | "javaHome">): NodeJS.ProcessEnv {
  const nodeDir = probe.nodePath ? posix.dirname(probe.nodePath) : null;
  return {
    PATH: nodeDir ? `${nodeDir}:${probe.path}` : probe.path,
    LANG: "C.UTF-8",
    ...(probe.javaHome ? { JAVA_HOME: probe.javaHome } : {})
  };
}

/**
 * Install ffmpeg (Ubuntu/Debian, passwordless sudo: Blacksmith runners). The lists are refreshed
 * only when the first try fails (a fresh runner's lists are often current). Constant text.
 */
export const FFMPEG_INSTALL_SCRIPT = `set -eu
apt() { sudo -n env DEBIAN_FRONTEND=noninteractive apt-get "$@"; }
if ! apt install -y -q --no-install-recommends ffmpeg; then
  apt update -q
  apt install -y -q --no-install-recommends ffmpeg
fi
ffmpeg -hide_banner -encoders 2> /dev/null | grep -q libx264
`;

// ---------------------------------------------------------------------------
// AVDs and golden snapshots in the box
// ---------------------------------------------------------------------------

/** Every box golden snapshot is this named one (the device cache's layout too). */
export const BOX_GOLDEN_SNAPSHOT = ANDROID_GOLDEN_SNAPSHOT;
/** GPU modes tried for a golden made in the box, in order: rented runners first the device cache's mode; own machines the fastest one. */
export const BOX_GPU_MODES: Readonly<Record<"box" | "byo", readonly string[]>> = {
  box: [ANDROID_EMULATOR_GPU, "swangle_indirect"],
  byo: ["swangle_indirect", ANDROID_EMULATOR_GPU]
};

/** `<avd>/orq-<profile>.avd/orq-box-golden.json`: a golden snapshot made in the box. */
export interface BoxGoldenMarker {
  snapshot: string;
  /** The GPU mode it was saved with (a snapshot loads only with it). */
  gpu: string;
  configHash: string;
  emulatorRevision: string | null;
  createdAt: string;
}

export const BOX_GOLDEN_MARKER = "orq-box-golden.json";

/** A profile's AVD in the box: from the device cache (`cache`), made here and current (`built`), made for an older config (`outdated`), or none. */
export type BoxAvdState = "cache" | "built" | "outdated" | "missing";

/** A usable golden snapshot: its name, the GPU mode leases boot with, and where it came from. */
export interface BoxGolden {
  snapshot: string;
  gpu: string;
  source: "cache" | "built";
}

export async function boxAvdState(x: DeviceExecutor, avdHome: string, profile: DeviceProfile): Promise<BoxAvdState> {
  const dir = avdDir(avdHome, profile.id);
  if (!(await x.exists(posix.join(avdHome, `${avdName(profile.id)}.ini`))) || !(await x.exists(posix.join(dir, "config.ini")))) return "missing";
  // The device cache's AVDs carry no Orquester marker (made by its workflow script).
  if (!(await x.exists(posix.join(dir, "orq-avd.json")))) return "cache";
  return (await avdReady(avdHome, profile, x)) ? "built" : "outdated";
}

/** The profile's golden snapshot when it is usable now, else null. */
export async function boxGolden(x: DeviceExecutor, avdHome: string, profile: DeviceProfile, state: BoxAvdState, emulatorRevision: string | null): Promise<BoxGolden | null> {
  const dir = avdDir(avdHome, profile.id);
  if (!(await x.exists(posix.join(dir, "snapshots", BOX_GOLDEN_SNAPSHOT, "snapshot.pb")))) return null;
  if (state === "cache") {
    // Restored with the SDK it was made with (one cache entry): the cache's GPU mode.
    return (await x.exists(posix.join(dir, BOX_GOLDEN_MARKER))) ? null : { snapshot: BOX_GOLDEN_SNAPSHOT, gpu: ANDROID_EMULATOR_GPU, source: "cache" };
  }
  if (state !== "built") return null;
  const text = await x.readText(posix.join(dir, BOX_GOLDEN_MARKER));
  try {
    const marker = JSON.parse(text ?? "") as BoxGoldenMarker;
    if (marker.snapshot !== BOX_GOLDEN_SNAPSHOT || marker.configHash !== profileHash(profile) || marker.emulatorRevision !== emulatorRevision || typeof marker.gpu !== "string") return null;
    return { snapshot: marker.snapshot, gpu: marker.gpu, source: "built" };
  } catch {
    return null;
  }
}

/** A lease's screen from the AVD's own `config.ini` (a cache AVD keeps its device's full resolution). */
export function screenOfConfig(configText: string): DeviceScreen | null {
  const config = parseIni(configText);
  const width = Number(config.get("hw.lcd.width"));
  const height = Number(config.get("hw.lcd.height"));
  const density = Number(config.get("hw.lcd.density"));
  if (!(width > 0 && height > 0 && density > 0)) return null;
  return avdScreen({ device: "", width, height, density });
}

// ---------------------------------------------------------------------------
// Capacity and rental
// ---------------------------------------------------------------------------

/** No host runs more than this many emulators (spikes §3: the 17th aborts and may take others down). */
export const ANDROID_HOST_HARD_CAP = 16;
const GB = 1024 ** 3;
/** Spikes §3: a box emulator holds ≈3.5–3.6 GB; the box itself needs little beyond the hub and ffmpeg. */
export const BOX_EMULATOR_BYTES = 3.6 * GB;
export const BOX_RESERVED_BYTES = 4 * GB;
/** vCPUs per emulator a box plans for (spikes §3: 8 on 16 vCPU; ~1.8 cores each while swiped). */
export const VCPUS_PER_EMULATOR = 2;

/**
 * How many emulators a Linux box host may run: the least of the CPU formula (one per two vCPUs),
 * the memory formula (running ones plus what fits in `MemAvailable` above a 4 GB reserve), an
 * owner's cap (an own machine: Settings' `maxLocalDevices`) and the hard cap of 16.
 */
export function boxAndroidCapacity(input: { cpus: number; memAvailableBytes: number | null; running: number; cap?: number }): number {
  const byCpu = Math.max(1, Math.floor(input.cpus / VCPUS_PER_EMULATOR));
  const { total } = localCapacity({
    maxLocalDevices: Math.min(ANDROID_HOST_HARD_CAP, byCpu, input.cap ?? ANDROID_HOST_HARD_CAP),
    memAvailableBytes: input.memAvailableBytes,
    running: input.running,
    threads: input.cpus,
    reservedBytes: BOX_RESERVED_BYTES,
    emulatorBytes: BOX_EMULATOR_BYTES
  });
  return total;
}

/** A Blacksmith Linux device host's default size (spikes §3: 8 emulators on 16 vCPU). */
export const DEFAULT_ANDROID_HOST_SIZE = "blacksmith-16vcpu-ubuntu-2404";

/**
 * What renting one Linux device host means from Settings → Devices: `pool.provider` (default
 * Blacksmith), `pool.androidSize` (a Blacksmith runner label or size id; default
 * {@link DEFAULT_ANDROID_HOST_SIZE}), the device-host time limit (`ios.lifetimeMinutes`, the one
 * lifetime setting device hosts have), and its price.
 */
export function androidRentalSpec(settings: DevicesSettings, offers: readonly BoxSizeOffer[] = []): DeviceHostRentalSpec {
  const provider = settings.pool.provider ?? "blacksmith";
  const lifetimeMinutes = settings.ios.lifetimeMinutes;
  const size = settings.pool.androidSize ?? (provider === "blacksmith" ? DEFAULT_ANDROID_HOST_SIZE : "");
  if (provider === "blacksmith") {
    for (const candidate of BLACKSMITH_LINUX_SIZES) {
      for (const image of [null, ...BLACKSMITH_LINUX_IMAGES.map((entry) => entry.id)]) {
        const label = image === null ? candidate.id : blacksmithRunnerLabel(candidate.id, image);
        if (label !== size) continue;
        return { provider, size: candidate.id, sizeLabel: candidate.label, image: image ?? "ubuntu-2404", hourlyUsd: Math.round(candidate.perMinuteUsd * 60 * 100) / 100, lifetimeMinutes };
      }
    }
  }
  const offer = offers.find((entry) => entry.id === size);
  return { provider, size, sizeLabel: offer?.label ?? size, image: null, hourlyUsd: offer?.hourlyUsd ?? null, lifetimeMinutes };
}
