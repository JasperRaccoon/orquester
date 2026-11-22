/**
 * What a Linux box Android host runs and decides in its box (constants and pure functions; the host
 * is `android-host.ts`): the probe (Node, KVM directly or through `sg kvm`, ffmpeg with libx264,
 * Java, unzip, passwordless sudo, CPUs, free memory and disk, the GPU, the kvm group and systemd
 * linger), the GPU modes a golden snapshot tries, the environment problems an own machine's probe
 * names with their fixes, the ffmpeg install, the box's device layout (the Blacksmith device caches
 * restore `android-sdk`, `avd` and `tools` under {@link BOX_DEVICES_DIR}), whether a profile's AVD
 * and golden snapshot came from the cache or were made here, the rental spec of a Linux device host,
 * and its capacity.
 */

import { posix } from "node:path";

import type { BoxSizeOffer, DeviceCapacityBasis, DeviceProfile, DevicesSettings, DeviceScreen, MachineProblem } from "@orquester/api";

import { ANDROID_CACHE_SOURCE, ANDROID_GOLDEN_SNAPSHOT, ANDROID_RENTED_GPU_MODES, BOX_DEVICES_DIR, BOX_GOLDEN_MARKER } from "../../../boxes/github/device-cache.ts";
import { BLACKSMITH_LINUX_IMAGES, BLACKSMITH_LINUX_SIZES, blacksmithRunnerLabel } from "../../../boxes/github/workflow-template.ts";
import { avdName, avdScreen, parseIni } from "../../android/avd-config.ts";
import { localCapacity } from "../../android/capacity.ts";
import type { DeviceExecutor } from "../../android/executor.ts";
import type { KvmProbe } from "../../android/readiness.ts";
import { type AvdMarker, avdDir, profileHash } from "../../toolchain/android-sdk.ts";
import type { DeviceHostRentalSpec } from "./rental.ts";

/** Where a Linux box keeps its device state: the device caches' dir on rented boxes, `~/.orquester/devices` on an owner's own machine. */
export function boxAndroidRoot(input: { provider: string; home: string }): string {
  return input.provider === "byo" ? posix.join(input.home, ".orquester", "devices") : BOX_DEVICES_DIR;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** `key=value` lines about the box (constant text; no secrets); `$1`: the device dir, whose disk is measured. */
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
printf 'groups=%s\\n' "$(id -nG 2> /dev/null)"
if [ -e /dev/kvm ]; then printf 'kvm_mode=%s\\n' "$(stat -c %a /dev/kvm 2> /dev/null)"; fi
awk '/^MemAvailable:/ { print "mem_available_kb=" $2 }' /proc/meminfo 2> /dev/null
d=\${1:-$HOME}
while [ ! -d "$d" ] && [ "$d" != / ]; do d=$(dirname "$d"); done
df -Pk "$d" 2> /dev/null | awk 'NR == 2 { print "disk_free_kb=" $4 }'
if [ -e "/var/lib/systemd/linger/$user" ]; then echo linger=1; elif command -v loginctl > /dev/null 2>&1; then echo linger=0; fi
if [ -r /proc/driver/nvidia/version ]; then
  printf 'nvidia=%s\\n' "$(awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+[.][0-9]+([.][0-9]+)?$/) { print $i; exit } }' /proc/driver/nvidia/version)"
  if [ -r /dev/nvidiactl ] && [ -w /dev/nvidiactl ] && [ -r /dev/nvidia0 ] && [ -w /dev/nvidia0 ]; then echo nvidia_dev=1; else echo nvidia_dev=0; fi
fi
for node in /dev/dri/renderD*; do
  [ -e "$node" ] || continue
  name=$(basename "$node")
  driver=$(basename "$(readlink -f "/sys/class/drm/$name/device/driver" 2> /dev/null)" 2> /dev/null)
  if [ -r "$node" ] && [ -w "$node" ]; then access=1; else access=0; fi
  printf 'render=%s:%s:%s\\n' "$name" "\${driver:-unknown}" "$access"
done
xcheck=
if command -v xset > /dev/null 2>&1; then xcheck="xset q"; elif command -v xdpyinfo > /dev/null 2>&1; then xcheck=xdpyinfo; elif command -v xhost > /dev/null 2>&1; then xcheck=xhost; fi
limit=
if command -v timeout > /dev/null 2>&1; then limit="timeout 5"; fi
if [ -n "$xcheck" ]; then
  uid=$(id -u)
  for sock in /tmp/.X11-unix/X*; do
    [ -S "$sock" ] || continue
    display=":\${sock##*/X}"
    found=
    for auth in /dev/null "\${XAUTHORITY:-}" "$HOME/.Xauthority" "/run/user/$uid/.Xauthority" "/run/user/$uid/gdm/Xauthority" /run/user/$uid/xauth_* /run/user/$uid/.mutter-Xwaylandauth.*; do
      [ "$auth" = /dev/null ] || [ -f "$auth" -a -r "$auth" ] || continue
      if DISPLAY="$display" XAUTHORITY="$auth" $limit $xcheck > /dev/null 2>&1; then found=$auth; break; fi
    done
    [ -n "$found" ] || continue
    printf 'x_display=%s\\n' "$display"
    if [ "$found" != /dev/null ]; then printf 'x_auth=%s\\n' "$found"; fi
    break
  done
fi
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
  /** The account's groups (`id -nG`). */
  groups: string[];
  /** `/dev/kvm`'s octal mode (`660`), when it exists. */
  kvmMode: string | null;
  /** `MemAvailable` when probed; null when unknown. */
  memAvailableBytes: number | null;
  /** Free disk under the device dir (or the nearest existing parent); null when unknown. */
  diskFreeBytes: number | null;
  /** systemd linger for the account: off means user services stop at logout; null without systemd. */
  linger: boolean | null;
  gpu: AndroidGpuProbe;
}

/** What the probe found of the machine's GPU. */
export interface AndroidGpuProbe {
  /** The NVIDIA kernel driver is loaded (`/proc/driver/nvidia/version`); `usable`: its device nodes open for the account. */
  nvidia: { version: string | null; usable: boolean } | null;
  /** DRM render nodes, their kernel driver, and whether the account can open them. */
  render: { node: string; driver: string; usable: boolean }[];
  /**
   * An X display the account can open (`xset q`, `xdpyinfo` or `xhost` answered on it), with the
   * cookie file that opened it (null: the server lets the account in without one, e.g.
   * `xhost +SI:localuser:<user>`). Null: none, or no X client to check with.
   */
  display: { display: string; xauthority: string | null } | null;
}

export function parseAndroidProbe(stdout: string): AndroidBoxProbe {
  const values = new Map<string, string>();
  const render: AndroidGpuProbe["render"] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    if (key === "render") {
      const [node, driver, access] = value.split(":");
      if (node) render.push({ node, driver: driver || "unknown", usable: access === "1" });
      continue;
    }
    values.set(key, value);
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
    cpus: Math.max(1, Number(values.get("cpus")) || 1),
    groups: (text("groups") ?? "").split(/\s+/).filter(Boolean),
    kvmMode: text("kvm_mode"),
    memAvailableBytes: kilobytes(values.get("mem_available_kb")),
    diskFreeBytes: kilobytes(values.get("disk_free_kb")),
    linger: values.get("linger") === "1" ? true : values.get("linger") === "0" ? false : null,
    gpu: {
      nvidia: values.has("nvidia") ? { version: text("nvidia"), usable: values.get("nvidia_dev") === "1" } : null,
      render,
      display: text("x_display") ? { display: text("x_display")!, xauthority: text("x_auth") } : null
    }
  };
}

function kilobytes(value: string | undefined): number | null {
  const kb = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

/** DRM drivers of real GPUs (Mesa renders on them with direct rendering); virtual and display-only ones are left out. */
const HARDWARE_DRM_DRIVERS = new Set(["amdgpu", "radeon", "i915", "xe", "nouveau", "nvidia", "msm", "panfrost", "v3d"]);

/**
 * A GPU `-gpu host` can render on: NVIDIA's driver with its device nodes open, or a hardware render
 * node the account can open, and an X display to reach it through. The Linux emulator's host
 * renderer is GLX: without a display it logs "Failed to open display" / "Could not start renderer"
 * and QEMU stays up without ever booting (emulator 37.3, measured on an RTX 3080 Ti); its EGL path
 * (`ANDROID_EGL_ON_EGL=1`) boots but its shaders fail and it crashes once booted.
 */
export interface HostGpu {
  kind: "nvidia" | "mesa";
  /** "NVIDIA 550.54.14", "amdgpu (renderD128)": also what a failed `host` attempt is remembered by. */
  detail: string;
  /** What a `-gpu host` emulator adds to its environment: `DISPLAY`, and `XAUTHORITY` when the display needs a cookie. */
  env: Record<string, string>;
}

export function usableHostGpu(gpu: AndroidGpuProbe): HostGpu | null {
  if (!gpu.display) return null;
  const env = { DISPLAY: gpu.display.display, ...(gpu.display.xauthority ? { XAUTHORITY: gpu.display.xauthority } : {}) };
  if (gpu.nvidia?.usable) return { kind: "nvidia", detail: `NVIDIA ${gpu.nvidia.version ?? "driver"}`, env };
  const node = gpu.render.find((entry) => entry.usable && HARDWARE_DRM_DRIVERS.has(entry.driver));
  return node ? { kind: "mesa", detail: `${node.driver} (${node.node})`, env } : null;
}

/** The hardware GPU mode: the emulator renders with the host's OpenGL driver. */
export const HOST_GPU_MODE = "host";

/**
 * The GPU modes a golden snapshot made in the box tries, in order: rented runners the device
 * cache's order; an own machine `host` first when its probe found a usable GPU and `host` did not
 * already fail on that same GPU and emulator (`hostFailedOn` is what it failed on), then the
 * software modes.
 */
export function boxGpuModes(kind: "box" | "byo", gpu: HostGpu | null, hostFailedOn: string | null, emulatorRevision: string | null): string[] {
  if (kind === "box") return [...ANDROID_RENTED_GPU_MODES];
  const software = ["swangle_indirect", "swiftshader_indirect"];
  return gpu && hostFailedOn !== gpuSignature(gpu, emulatorRevision) ? [HOST_GPU_MODE, ...software] : software;
}

/** What a failed `host` attempt is remembered by: a new driver or emulator tries `host` again. */
export function gpuSignature(gpu: HostGpu, emulatorRevision: string | null): string {
  return `${gpu.detail} · emulator ${emulatorRevision ?? "unknown"}`;
}

/**
 * The guest command a `host` golden boot's frame is measured with: the screen woken (a display that
 * timed out captures black), a second to draw, then the PNG size of one frame.
 */
export const FRAME_BYTES_SCRIPT = "input keyevent KEYCODE_WAKEUP; sleep 1; screencap -p | wc -c";

/**
 * Below this a frame's PNG is one flat colour. Measured at 720×1616: a black frame (screen off) is
 * 7,980 bytes, the home screen about 779,000; the largest profile has fewer than twice the pixels.
 */
export const BLANK_FRAME_PNG_BYTES = 32 * 1024;

/**
 * Why a `host` golden boot does not render on the GPU, or null when it does: `dumpsys
 * SurfaceFlinger`'s `GLES:` line must be there (no line, or a failed dump, confirms nothing) and
 * name no software rasterizer (the emulator falls back to SwiftShader for a GPU it blocklists), and
 * a frame must not be blank (`frameBytes`: the {@link FRAME_BYTES_SCRIPT} output).
 */
export function hostRenderProblem(surfaceFlingerDump: string, frameBytes: string): string | null {
  const line = surfaceFlingerDump
    .split(/\r?\n/)
    .find((entry) => /^\s*GLES:/.test(entry))
    ?.trim();
  if (!line) return "-gpu host could not be confirmed (dumpsys SurfaceFlinger names no GLES renderer)";
  if (/swiftshader|llvmpipe|softpipe|lavapipe/i.test(line)) return `-gpu host fell back to software rendering (${line})`;
  const bytes = /^\d+$/.test(frameBytes.trim()) ? Number(frameBytes.trim()) : null;
  if (bytes === null) return "-gpu host could not be confirmed (no frame could be captured)";
  if (bytes < BLANK_FRAME_PNG_BYTES) return `-gpu host renders a blank screen (a ${bytes}-byte frame)`;
  return null;
}

// ---------------------------------------------------------------------------
// Environment problems (an own machine's probe)
// ---------------------------------------------------------------------------

/**
 * What an own Linux machine's probe found wrong for devices, each with its fix (tailnet machines
 * spec §4.4.8): `/dev/kvm` closed to the account, or open only through the desktop login's ACL
 * (gone when nobody is logged in), and systemd linger off (orq-agent's user services, and the
 * emulators with them, stop at logout).
 */
export function androidProbeProblems(probe: AndroidBoxProbe, machine: string): MachineProblem[] {
  const problems: MachineProblem[] = [];
  const kvmFix = `sudo usermod -aG kvm ${probe.user}, then log out and back in on ${machine} (or restart orq-agent there)`;
  if (probe.kvm.access === "denied") {
    problems.push({ code: "kvm-permission", message: `${machine} can't open /dev/kvm for ${probe.user}, so it can't run Android emulators.`, fix: kvmFix });
  } else if (probe.kvm.access === "direct" && !probe.groups.includes("kvm") && probe.kvmMode !== null && !worldReadWrite(probe.kvmMode)) {
    problems.push({ code: "kvm-permission", message: `${machine} opens /dev/kvm only while someone is logged in at its desktop: emulators stop working after logout.`, fix: kvmFix });
  }
  if (probe.linger === false) {
    problems.push({ code: "linger-off", message: `${machine} stops orq-agent and its emulators when ${probe.user} logs out (systemd linger is off).`, fix: `sudo loginctl enable-linger ${probe.user}` });
  }
  return problems;
}

function worldReadWrite(mode: string): boolean {
  const other = Number.parseInt(mode.slice(-1), 8);
  return Number.isFinite(other) && (other & 6) === 6;
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
/** `<avd>/orq-<profile>.avd/orq-box-golden.json` ({@link BOX_GOLDEN_MARKER}): a box golden snapshot, made in the box or by the device cache's script. */
export interface BoxGoldenMarker {
  snapshot: string;
  /** The GPU mode it was saved with (a snapshot loads only with it). */
  gpu: string;
  configHash: string;
  emulatorRevision: string | null;
  createdAt: string;
  /** `"cache"`: made by the device-cache workflow (`boxes/github/device-cache.ts`). */
  source?: string;
}

export { BOX_GOLDEN_MARKER };

/**
 * A profile's AVD in the box: from the device cache (`cache`), made here (`built`) — both current —,
 * made for an older config or without a marker (`outdated`: an untuned AVD of an older cache), or none.
 */
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
  // The device cache's AVDs carry the same marker as ours (its script makes them the same way), with `source: "cache"`.
  const marker = await readMarker<AvdMarker>(x, posix.join(dir, "orq-avd.json"));
  if (marker?.configHash !== profileHash(profile)) return "outdated";
  return marker.source === ANDROID_CACHE_SOURCE ? "cache" : "built";
}

async function readMarker<T>(x: DeviceExecutor, path: string): Promise<Partial<T> | null> {
  try {
    const value: unknown = JSON.parse((await x.readText(path)) ?? "");
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Partial<T>) : null;
  } catch {
    return null;
  }
}

/**
 * The profile's golden snapshot when it is usable now, else null: its marker names this config, the
 * installed emulator and the GPU mode it was saved with (the cache's or the box's own probing).
 */
export async function boxGolden(x: DeviceExecutor, avdHome: string, profile: DeviceProfile, state: BoxAvdState, emulatorRevision: string | null): Promise<BoxGolden | null> {
  if (state !== "cache" && state !== "built") return null;
  const dir = avdDir(avdHome, profile.id);
  if (!(await x.exists(posix.join(dir, "snapshots", BOX_GOLDEN_SNAPSHOT, "snapshot.pb")))) return null;
  const marker = await readMarker<BoxGoldenMarker>(x, posix.join(dir, BOX_GOLDEN_MARKER));
  if (!marker || marker.snapshot !== BOX_GOLDEN_SNAPSHOT || marker.configHash !== profileHash(profile) || marker.emulatorRevision !== emulatorRevision || typeof marker.gpu !== "string" || !marker.gpu) return null;
  return { snapshot: marker.snapshot, gpu: marker.gpu, source: marker.source === ANDROID_CACHE_SOURCE ? "cache" : "built" };
}

/** A lease's screen from the AVD's own `config.ini` (what it really runs, whoever made it). */
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
/** Disk one read-only emulator instance may write (its overlays, the app under test, logs). */
export const BOX_EMULATOR_DISK_BYTES = 2 * GB;
/** Disk kept free on an own machine. */
export const BOX_DISK_RESERVED_BYTES = 4 * GB;

/**
 * How many emulators a Linux box host may run: the least of the CPU formula (one per two vCPUs),
 * the memory formula (running ones plus what fits in `MemAvailable` above a 4 GB reserve), the disk
 * formula when `freeDiskBytes` is given (an own machine: running ones plus what fits above a 4 GB
 * reserve) and the hard cap of 16.
 */
export function boxAndroidCapacity(input: { cpus: number; memAvailableBytes: number | null; running: number; freeDiskBytes?: number | null }): number {
  const byCpu = Math.max(1, Math.floor(input.cpus / VCPUS_PER_EMULATOR));
  const disk = input.freeDiskBytes;
  const byDisk = disk === undefined || disk === null ? ANDROID_HOST_HARD_CAP : input.running + Math.max(0, Math.floor((disk - BOX_DISK_RESERVED_BYTES) / BOX_EMULATOR_DISK_BYTES));
  const { total } = localCapacity({
    maxLocalDevices: Math.min(ANDROID_HOST_HARD_CAP, byCpu, byDisk),
    memAvailableBytes: input.memAvailableBytes,
    running: input.running,
    threads: input.cpus,
    reservedBytes: BOX_RESERVED_BYTES,
    emulatorBytes: BOX_EMULATOR_BYTES
  });
  return total;
}

/** What a Linux box host's capacity was measured from (`DeviceCapacity.basis`). */
export function androidCapacityBasis(probe: AndroidBoxProbe, memAvailableBytes: number | null, probedAt: string): DeviceCapacityBasis {
  return {
    cpus: probe.cpus,
    freeMemBytes: memAvailableBytes ?? probe.memAvailableBytes ?? 0,
    freeDiskBytes: probe.diskFreeBytes,
    accel: probe.kvm.access === "direct" || probe.kvm.access === "sg" ? "kvm" : null,
    probedAt
  };
}

/** A Blacksmith Linux device host's default size (spikes §3: 8 emulators on 16 vCPU). */
export const DEFAULT_ANDROID_HOST_SIZE = "blacksmith-16vcpu-ubuntu-2404";

/**
 * What renting one Linux device host means from Settings → Devices: `pool.provider` (default
 * Blacksmith), `pool.androidSize` (a Blacksmith runner label or size id; default
 * {@link DEFAULT_ANDROID_HOST_SIZE}), the Linux host time limit (`pool.androidLifetimeMinutes`;
 * Mac hosts keep `ios.lifetimeMinutes`), and its price.
 */
export function androidRentalSpec(settings: DevicesSettings, offers: readonly BoxSizeOffer[] = []): DeviceHostRentalSpec {
  const provider = settings.pool.provider ?? "blacksmith";
  const lifetimeMinutes = settings.pool.androidLifetimeMinutes;
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
