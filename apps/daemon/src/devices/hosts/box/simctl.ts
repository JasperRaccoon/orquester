/**
 * `xcrun simctl` on a Mac device host, pure: reading its `list -j` output, choosing the device type
 * and runtime for a profile, naming Orquester's simulators, and the boot-frame heuristic.
 */

import type { DeviceProfile, DeviceSummary } from "@orquester/api";

/** Every simulator Orquester creates is named with this prefix (a lease's is `orq-<leaseId>`). */
export const ORQ_SIM_PREFIX = "orq-";
/** The scratch simulator that warms agent-device's XCTest runner. */
export const WARM_SIM_NAME = "orq-warm-runner";
/** A pool simulator being made (created, slimmed): deleted as a leftover if the daemon stops meanwhile. */
export const POOL_PREP_SIM_PREFIX = "orq-poolprep-";
/** A ready pool simulator: `orq-pool-<profileId>.<n>`, slim and shut down; renamed `orq-<leaseId>` when leased. */
export const POOL_SIM_PREFIX = "orq-pool-";

export function leaseSimulatorName(leaseId: string): string {
  return `${ORQ_SIM_PREFIX}${leaseId}`;
}

/** Whether a simulator is one of the pool's (ready or being made), not a lease's. */
export function isPoolSimulator(name: string): boolean {
  return name.startsWith(POOL_SIM_PREFIX) || name.startsWith(POOL_PREP_SIM_PREFIX);
}

/** The lease id an Orquester simulator was made for, or null (not ours, the warm-up one, or a pool one). */
export function leaseIdOfSimulator(name: string): string | null {
  if (!name.startsWith(ORQ_SIM_PREFIX) || name === WARM_SIM_NAME || isPoolSimulator(name)) return null;
  const id = name.slice(ORQ_SIM_PREFIX.length);
  return id.length > 0 ? id : null;
}

interface SimDeviceType {
  name: string;
  identifier: string;
  productFamily?: string;
}

interface SimRuntime {
  identifier: string;
  name: string;
  version: string;
  platform?: string;
  isAvailable?: boolean;
  supportedDeviceTypes?: SimDeviceType[];
}

/** `simctl list -j devicetypes runtimes`, narrowed to what is used. */
export interface SimCatalog {
  deviceTypes: SimDeviceType[];
  runtimes: SimRuntime[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function deviceTypeOf(value: unknown): SimDeviceType | null {
  const entry = record(value);
  if (!entry || typeof entry.name !== "string" || typeof entry.identifier !== "string") return null;
  return { name: entry.name, identifier: entry.identifier, ...(typeof entry.productFamily === "string" ? { productFamily: entry.productFamily } : {}) };
}

export function parseSimCatalog(stdout: string): SimCatalog {
  const data = record(JSON.parse(stdout)) ?? {};
  const deviceTypes = (Array.isArray(data.devicetypes) ? data.devicetypes : []).flatMap((entry) => deviceTypeOf(entry) ?? []);
  const runtimes: SimRuntime[] = [];
  for (const raw of Array.isArray(data.runtimes) ? data.runtimes : []) {
    const entry = record(raw);
    if (!entry || typeof entry.identifier !== "string" || typeof entry.version !== "string") continue;
    runtimes.push({
      identifier: entry.identifier,
      name: typeof entry.name === "string" ? entry.name : entry.identifier,
      version: entry.version,
      ...(typeof entry.platform === "string" ? { platform: entry.platform } : {}),
      isAvailable: entry.isAvailable !== false,
      ...(Array.isArray(entry.supportedDeviceTypes) ? { supportedDeviceTypes: entry.supportedDeviceTypes.flatMap((type) => deviceTypeOf(type) ?? []) } : {})
    });
  }
  return { deviceTypes, runtimes };
}

function compareVersions(a: string, b: string): number {
  const x = a.split(".").map((part) => Number(part) || 0);
  const y = b.split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isIosRuntime(runtime: SimRuntime): boolean {
  return runtime.platform === "iOS" || runtime.identifier.includes(".iOS-");
}

export interface SimTarget {
  deviceTypeId: string;
  deviceTypeName: string;
  runtimeId: string;
  /** "26.2". */
  osVersion: string;
  /** "iOS 26.2". */
  runtimeName: string;
}

/**
 * The device type and runtime a profile's simulator is created from: the newest available iOS
 * runtime (or the newest matching `pinnedRuntime`, a version prefix like "26" or a runtime id)
 * that supports one of the profile's `simDeviceTypes`, in the profile's order of preference. Null
 * when this Mac's Xcode has none of them.
 */
export function pickSimulatorTarget(catalog: SimCatalog, profile: Pick<DeviceProfile, "simDeviceTypes">, pinnedRuntime?: string): SimTarget | null {
  const wanted = profile.simDeviceTypes ?? [];
  if (wanted.length === 0) return null;
  const runtimes = catalog.runtimes
    .filter((runtime) => runtime.isAvailable !== false && isIosRuntime(runtime))
    .filter(
      (runtime) =>
        pinnedRuntime === undefined ||
        runtime.identifier === pinnedRuntime ||
        runtime.version === pinnedRuntime ||
        runtime.version.startsWith(`${pinnedRuntime}.`)
    )
    .sort((a, b) => compareVersions(b.version, a.version));
  for (const runtime of runtimes) {
    // Older simctl JSON lacks `supportedDeviceTypes`: every listed type is then a candidate.
    const supported = runtime.supportedDeviceTypes ?? catalog.deviceTypes;
    for (const name of wanted) {
      const type = supported.find((candidate) => candidate.name === name);
      if (type) return { deviceTypeId: type.identifier, deviceTypeName: type.name, runtimeId: runtime.identifier, osVersion: runtime.version, runtimeName: runtime.name };
    }
  }
  return null;
}

/** The newest iPhone type of the newest iOS runtime (the runner warm-up's scratch simulator). */
export function newestIphoneTarget(catalog: SimCatalog): SimTarget | null {
  const runtime = catalog.runtimes
    .filter((entry) => entry.isAvailable !== false && isIosRuntime(entry))
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!runtime) return null;
  const phones = (runtime.supportedDeviceTypes ?? catalog.deviceTypes).filter((type) => type.productFamily === "iPhone");
  const type = phones[phones.length - 1];
  return type ? { deviceTypeId: type.identifier, deviceTypeName: type.name, runtimeId: runtime.identifier, osVersion: runtime.version, runtimeName: runtime.name } : null;
}

/** One simulator from `simctl list -j devices`. */
export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtimeId: string;
  /** "26.2", from the runtime id (`…SimRuntime.iOS-26-2`). */
  osVersion: string;
}

/** iOS simulators from `simctl list -j devices` (unavailable ones left out). */
export function parseSimDevices(stdout: string): SimDevice[] {
  const data = record(JSON.parse(stdout)) ?? {};
  const byRuntime = record(data.devices) ?? {};
  const devices: SimDevice[] = [];
  for (const [runtimeId, list] of Object.entries(byRuntime)) {
    const ios = /\.iOS-(\d+(?:-\d+)*)$/.exec(runtimeId);
    if (!ios || !Array.isArray(list)) continue;
    for (const raw of list) {
      const entry = record(raw);
      if (!entry || typeof entry.udid !== "string" || typeof entry.name !== "string" || entry.isAvailable === false) continue;
      devices.push({ udid: entry.udid, name: entry.name, state: typeof entry.state === "string" ? entry.state : "Unknown", runtimeId, osVersion: ios[1]!.replace(/-/g, ".") });
    }
  }
  return devices;
}

/** A simulator as `listDevices` shows it (the warm-up and pool simulators are left out). */
export function simDeviceSummary(hostId: string, device: SimDevice, profileOf: (leaseId: string) => string | null): DeviceSummary | null {
  if (device.name === WARM_SIM_NAME || isPoolSimulator(device.name)) return null;
  const leaseId = leaseIdOfSimulator(device.name);
  return {
    key: `${hostId}/${device.udid}`,
    hostId,
    id: device.udid,
    platform: "ios",
    name: device.name,
    osVersion: `iOS ${device.osVersion}`,
    profile: leaseId ? profileOf(leaseId) : null,
    booted: device.state === "Booted",
    leaseId: null
  };
}

/**
 * Whether a screenshot is the home screen rather than the boot logo. `bootstatus -b` returns while
 * the Apple logo still shows (spike: 31 s vs 37.7 s to the home screen). A PNG of the black logo
 * screen is tens of KB; the wallpaper and icons of a rendered home screen are well over a MB at the
 * simulators' native sizes. A frame above this size counts as real.
 */
export const REAL_FRAME_MIN_PNG_BYTES = 300 * 1024;

export function isRealFrame(pngBytes: number): boolean {
  return Number.isFinite(pngBytes) && pngBytes >= REAL_FRAME_MIN_PNG_BYTES;
}

/**
 * `/bin/sh -c` text (constant) that takes a screenshot of `$1` into `$2` and prints its size in
 * bytes (the image itself never crosses the box link).
 */
export const FRAME_SIZE_SCRIPT = `xcrun simctl io "$1" screenshot --type=png "$2" > /dev/null 2>&1 || { echo 0; exit 0; }
wc -c < "$2" | tr -d ' '
rm -f "$2"
`;
